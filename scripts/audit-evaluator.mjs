#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ExperimentLab } from '../dist/experiment.js';
import { createPiRuntime, evaluatorVersion } from '../dist/pi.js';
import { evaluatorControls, EVALUATOR_CONTROLS_VERSION } from '../dist/evaluator-controls.js';
import { simulatorFidelity } from '../dist/assessment.js';
import { assessTrial } from '../dist/evaluation.js';
import { emptyUsage, addUsage, fingerprint } from '../dist/contracts.js';
import { simulatorChecks } from '../dist/simulator.js';
import { customerProbes, heldoutCustomerProbes, customerBoundaryProbes } from '../dist/customer-probes.js';
import { roleChoices } from '../dist/llm/models.js';
import { customerReplyProblem, deliveredMessage, CARD_CUSTOMER_PROTOCOL } from '../dist/card-customer.js';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string' }, run: { type: 'string' }, output: { type: 'string' }, yes: { type: 'boolean' }, mode: { type: 'string', default: 'full' }, 'probe-suite': { type: 'string', default: 'baseline' }, 'simulator-provider': { type: 'string' }, 'simulator-model': { type: 'string' } } });
if (!values['data-dir'] || !values.run || !values.output) throw new Error('Usage: node scripts/audit-evaluator.mjs --data-dir PATH --run ID --output NEW_DIRECTORY [--yes]');
const lab = new ExperimentLab(resolve(values['data-dir']));
const record = await lab.get(values.run);
if (!!values['simulator-provider'] !== !!values['simulator-model']) throw new Error('Both simulator-provider and simulator-model are required for an override');
if (!['baseline', 'heldout', 'boundaries'].includes(values['probe-suite'])) throw new Error('probe-suite: baseline, heldout or boundaries');
const settings = structuredClone(record.settings);
if (values['simulator-provider']) settings.roles = { ...settings.roles, simulator: { provider: values['simulator-provider'], model: values['simulator-model'] } };
const probeSuite = values['probe-suite'] === 'heldout' ? heldoutCustomerProbes : values['probe-suite'] === 'boundaries' ? customerBoundaryProbes : customerProbes;
if (!['full', 'controls', 'customers', 'probes'].includes(values.mode)) throw new Error('mode: full, controls, customers or probes');
const controls = ['full', 'controls'].includes(values.mode) ? evaluatorControls : [];
const probes = ['full', 'probes'].includes(values.mode) ? probeSuite : [];
const conversations = !['full', 'customers'].includes(values.mode) ? [] : record.trials.filter(trial => trial.events.some(event => event.type === 'simulator'));
console.log(JSON.stringify({ controls: controls.length, recordedCustomers: conversations.length, maximumSimulatorProbeCalls: 4 * probes.length,
  simulatorCallNote: 'Two repeats; each uses one policy call and at most one speech call, before any validation retry.', expectedJudgeCalls: 2 * (controls.length + conversations.length + 2 * probes.length), modifiesOriginalRun: false }));
if (!values.yes) process.exit(0);
process.umask(0o077);
const directory = resolve(values.output);
await mkdir(directory, { recursive: false });
const usage = emptyUsage();
const report = { mode: values.mode, models: roleChoices(settings), probeSuite: values['probe-suite'], protocol: EVALUATOR_CONTROLS_VERSION, controlHash: fingerprint(evaluatorControls), probeHash: fingerprint(probeSuite), sourceRunId: record.id,
  sourceHash: fingerprint(record), evaluatorVersion: evaluatorVersion(settings), startedAt: new Date().toISOString(),
  limitation: 'Hand-authored diagnostic controls. They do not establish production accuracy or independently human-validated simulator realism.',
  controls: [], customers: [], simulatorProbes: [], usage };
const save = async () => { await writeFile(join(directory, 'report.json.tmp'), JSON.stringify(report, null, 2)); await rename(join(directory, 'report.json.tmp'), join(directory, 'report.json')); };
await save();
const controller = new AbortController();
for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort(new Error('Audit stopped by owner')));
const runtime = await createPiRuntime(settings);
const ctx = { signal: controller.signal, timeoutMs: settings.timeoutMs, beforeCall: () => { controller.signal.throwIfAborted(); usage.calls++; }, addUsage: delta => addUsage(usage, delta) };
// Single audit persistence per item; final verdicts are checkpointed serially after each pair of jobs.
async function judge(item, category) {
  const trial = structuredClone(item.trial);
  for (const key of ['assessments', 'assessmentError', 'assessmentFailure', 'judgeReceipt', 'judgeAudit', 'checkpoints', 'checkpointReceipt']) delete trial[key];
  let audit;
  try {
    const assessments = await assessTrial(runtime, item.scenario, [], trial, { ...ctx, onJudgment: (_id, value) => { audit = value; } }, []);
    const actual = assessments[0]?.result ?? 'unknown';
    const result = { id: item.id, ...(item.expected ? { expected: item.expected, matches: actual === item.expected, expectedReason: item.reason } : {}), actual, assessments,
      receipt: trial.judgeReceipt, ...(category === 'customers' ? { checks: simulatorChecks(item.scenario, trial) } : {}) };
    await writeFile(join(directory, `${category}-${item.id}.json`), JSON.stringify({ input: { scenario: item.scenario, trial: item.trial }, result, audit }, null, 2));
    console.log(JSON.stringify({ category, id: item.id, expected: item.expected, actual, matches: result.matches }));
    return result;
  } catch (error) {
    const result = { id: item.id, expected: item.expected, error: error.message };
    await writeFile(join(directory, `${category}-${item.id}.json`), JSON.stringify({ input: { scenario: item.scenario, trial: item.trial }, result, audit }, null, 2));
    console.log(JSON.stringify({ category, ...result }));
    return result;
  }
}
const jobs = [
  ...controls.map(item => ({ category: 'controls', item })),
  ...conversations.flatMap(trial => { const stored = record.scenarios.find(s => s.id === trial.scenarioId); return stored ? [{ category: 'customers', item: {
    id: trial.id, scenario: { ...stored, metrics: [simulatorFidelity] }, trial,
  } }] : []; }),
];
for (let i = 0; i < jobs.length && !controller.signal.aborted; i += 2) {
  const results = await Promise.all(jobs.slice(i, i + 2).map(async ({ category, item }) => ({ category, result: await judge(item, category) })));
  for (const { category, result } of results) report[category].push(result);
  await save();
}
// Probe the actual configured customer model twice per condition, then audit its generated continuation.
for (const probe of probes) {
  for (let repeat = 0; repeat < 2 && !controller.signal.aborted; repeat++) {
    const id = `${probe.id}-${repeat}`;
    const actorOutputs = [];
    const actorTransport = [], actorValidation = [];
    try {
      const reply = await runtime.speakAsCustomer({ brief: structuredClone(probe.brief), messages: structuredClone(probe.messages), turn: Math.max(0, probe.messages.filter(m => m.role === 'user').length - 1), turned: probe.turned ?? false }, { ...ctx, onGeneratorOutput: output => actorOutputs.push(output), onGeneratorTransport: value => actorTransport.push(value), onGeneratorValidation: value => actorValidation.push(value) });
      const problem = customerReplyProblem(reply, probe.brief, probe.messages, probe.turned ?? false);
      const message = deliveredMessage(reply, probe.brief);
      const base = structuredClone(evaluatorControls.find(item => item.id === 'customer_known_fact'));
      const scenario = { ...base.scenario, id, familyId: id, user: {
        goal: probe.brief.goal, opening: probe.brief.opening, facts: probe.brief.knows.join('\n'), knows: probe.brief.knows,
        cannotKnow: probe.brief.doesNotKnow, maxFollowUps: probe.brief.maxFollowUps,
        behavior: `Не выдумывать факты и не менять роль. Уйти, когда ${probe.brief.leaves}.${probe.brief.turn ? ` ${probe.brief.turn.required ? 'Обязательный' : 'Допустимый'} однократный поворот: после «${probe.brief.turn.when}» сказать «${probe.brief.turn.says}».` : ''}`,
      } };
      const trial = { ...base.trial, id, scenarioId: id, familyId: id, events: [
        ...probe.messages.map((item, seq) => ({ seq, type: item.role, text: item.content })),
        { seq: probe.messages.length, type: 'simulator', result: { protocol: CARD_CUSTOMER_PROTOCOL, ...reply } },
        ...(message ? [{ seq: probe.messages.length + 1, type: 'user', text: message }] : []),
      ] };
      const result = await judge({ id, scenario, trial }, 'simulatorProbes');
      report.simulatorProbes.push({ ...result, reply, expectedMoves: probe.allowedMoves,
        moveMatches: probe.allowedMoves.includes(reply.move), validationProblem: problem ?? null });
    } catch (error) { report.simulatorProbes.push({ id, error: error.message }); }
    await writeFile(join(directory, `actor-${id}.json`), JSON.stringify({ probe, actorTransport, actorValidation, actorOutputs }, null, 2));
    await save();
  }
}
report.finishedAt = new Date().toISOString();
report.stopped = controller.signal.aborted;
report.summary = { controlMatched: report.controls.filter(x => x.matches).length, controlTotal: controls.length,
  falsePass: report.controls.filter(x => x.actual === 'pass' && x.expected !== 'pass').length,
  falseFail: report.controls.filter(x => x.actual === 'fail' && x.expected !== 'fail').length,
  abstained: report.controls.filter(x => x.actual === 'unknown').length,
  simulatorProbes: { count: report.simulatorProbes.length, moveMatches: report.simulatorProbes.filter(x => x.moveMatches).length, fidelityPass: report.simulatorProbes.filter(x => x.actual === 'pass').length },
  errors: [...report.controls, ...report.customers, ...report.simulatorProbes].filter(x => x.error).length,
  customers: Object.fromEntries(['pass', 'fail', 'unknown'].map(verdict => [verdict, report.customers.filter(x => x.actual === verdict).length])) };
await save();
console.log(JSON.stringify(report.summary));
