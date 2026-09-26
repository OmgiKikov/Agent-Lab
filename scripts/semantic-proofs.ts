/*
 * Deterministic proofs of the semantic contract between DISCOVER and VERIFY and of the connection exam — no model, no
 * key, no network beyond a local HTTP fake: the teaching runtime, a scripted judge in the judge's own answer format and
 * fake agents. Each proof prints PASS or FAIL per claim; the process exits 1 when any claim fails.
 *
 *   A  a criterion DISCOVER found in a logged conversation is the one the check's card carries (same criterion hash),
 *      and the check reads that expectation: the baseline reproduces, the fixed teaching version is «fixed» against it
 *   B  a conversation where the criterion was not decided (UNKNOWN) is no control, and no regression is read off it
 *   C  a tool criterion is never passed by the agent's words: the channel rule and the log's own record decide
 *   D  an adapter that shares one memory between conversations cannot pass the isolation exam
 *
 * Run from the repository: npx tsx scripts/semantic-proofs.ts
 */
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostGrant } from '../src/card/commands.js';
import { judgeLogged, logProtocolHash, type logJudgeInput } from '../src/card/log-judge.js';
import { situationViews } from '../src/card/view.js';
import { createInputSchema, settingsSchema, type Experiment } from '../src/contracts.js';
import { criterionHash, expectationCriterionHash } from '../src/criterion.js';
import { createDemoAnalysisRuntime, demoAnalysisInput, demoTarget } from '../src/demo.js';
import { problemCheck } from '../src/discover/check.js';
import { checkLink, problemConversations, subsetImport } from '../src/discover/verify.js';
import { analysisView, type ProblemView } from '../src/discover/view.js';
import type { LogAnalysis } from '../src/discover/schema.js';
import { examCanVouch, examConnection } from '../src/exam.js';
import { ExperimentLab } from '../src/experiment.js';
import { draftHash } from '../src/lab/record.js';
import { buildResultView } from '../src/result-view.js';
import type { Runtime } from '../src/runtime.js';
import { importBatch, libraryHash } from '../src/scenario-library.js';
import { runnableTargetSchema } from '../src/target-schema.js';

let failed = 0;
const claim = (proof: string, ok: boolean, text: string): void => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'} ${proof}  ${text}`); };
const folders: string[] = [];
const folder = async (name: string) => { const dir = await mkdtemp(join(tmpdir(), `semantic-proofs-${name}-`)); folders.push(dir); return dir; };

/** The teaching agent in one of its versions: the baseline asks again for a number it has, the fixed one does not, the regressed one never asks. */
const version = (exportName: 'createSession' | 'createFixedSession' | 'createRegressedSession') => ({ ...demoTarget(), exportName });

/** A check of the problem, prepared, its questions answered «a» as the teaching owner does, and its ready situations accepted. */
async function preparedCheck(lab: ExperimentLab, analysis: LogAnalysis, link: Experiment['fromAnalysis'], dialogueIds: string[]): Promise<Experiment> {
  const batch = await lab.store.readImport(analysis.logs.importId);
  const draft = await lab.create(createInputSchema.parse({ task: analysis.task, mode: 'demo', materials: analysis.sources.map(({ name, content }) => ({ name, content })),
    scenarioCount: 0, target: version('createSession'), originalImport: subsetImport(batch, dialogueIds), fromAnalysis: link,
    settings: settingsSchema.parse({ repeats: 1, maxTurns: 6, maxCalls: 200, userModes: ['reactive'] }) }), { situations: dialogueIds.length });
  await lab.waitForIdle();
  let context = await lab.cardContext(draft.id);
  for (const view of situationViews(context.experiment, { evidence: context.evidence, maxTurns: 6 })) if (view.question?.id) {
    const answer = await lab.prepareCardCommand(draft.id, { kind: 'answer_question', cardId: view.id, questionId: view.question.id, choice: 'a' }, { via: 'cli-yes' });
    await lab.applyCardCommand(draft.id, answer, hostGrant(answer, 'confirmed'));
  }
  context = await lab.cardContext(draft.id);
  const ready = situationViews(context.experiment, { evidence: context.evidence, maxTurns: 6 }).filter(view => view.status === 'ready');
  await lab.acceptCards(draft.id, libraryHash(context.library), ready.map(view => view.id));
  return lab.get(draft.id);
}
async function run(lab: ExperimentLab, id: string): Promise<Experiment> {
  const draft = await lab.get(id);
  await lab.start(id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft) });
  await lab.waitForIdle();
  return lab.get(id);
}
async function repeatWith(lab: ExperimentLab, of: Experiment, exportName: Parameters<typeof version>[0]): Promise<Experiment> {
  const fresh = await lab.repeat(of.id);
  const updated = await lab.updateDraft(fresh.id, draftHash(fresh), { target: version(exportName) });
  return run(lab, updated.id);
}
const problemWith = (view: ReturnType<typeof analysisView>, start: string): ProblemView => {
  const problem = view.problems.find(item => item.duty.text.startsWith(start));
  if (!problem) throw new Error(`No problem «${start}…» in the teaching analysis`);
  return problem;
};

// ─── A and B: the teaching logs, analysed, and checks of their problems ─────────────────────────────────────────────
async function proofsAB(): Promise<void> {
  const lab = new ExperimentLab(join(await folder('ab'), '.agent-lab'), createDemoAnalysisRuntime());
  await lab.init();
  try {
    const started = await lab.analyze(demoAnalysisInput(), { callCeiling: 100 });
    await lab.waitForIdle();
    const analysis = await lab.getAnalysis(started.id);
    const batch = await lab.store.readImport(analysis.logs.importId);
    const view = analysisView(analysis, batch);

    // A. Criterion X: «не спрашивать номер терминала ещё раз, если клиент его уже назвал», broken in «known».
    const x = problemWith(view, 'не спрашивать номер');
    const found = analysis.findings.filter(finding => finding.dialogueId === 'known' && finding.result === 'fail' && finding.criterionHash === x.key);
    claim('A', x.dialogueIds.includes('known') && found.length === 1 && x.key === criterionHash(x.criterion),
      `DISCOVER found X in «known»: finding criterionHash ${x.key.slice(0, 12)} = criterionHash(X)`);
    const { link, controls } = checkLink(analysis, x);
    claim('A', link.criterionHash === x.key && link.dialogueIds.join() === 'known' && controls.length === 0,
      `fromAnalysis link freezes X (hash ${link.criterionHash?.slice(0, 12)}); conversations ${JSON.stringify(link.dialogueIds)}, controls ${JSON.stringify(controls)}`);
    const draft = await preparedCheck(lab, analysis, link, link.dialogueIds);
    const library = draft.librarySnapshot?.formatVersion === 2 ? draft.librarySnapshot : undefined;
    const card = library?.cards.find(item => item.origin.kind === 'dialogue' && item.origin.dialogueId === 'known');
    const carried = card?.agentMust.find(duty => !duty.appliesWhen && expectationCriterionHash(duty, library!.requirements) === x.key);
    claim('A', !!carried, `VERIFY card №${card?.number} «${card?.title}» has expectation ${carried?.id} with exactly X's criterionHash`);
    const compiled = draft.scenarios.find(scenario => scenario.id === card?.id);
    claim('A', !!compiled && draft.phase !== 'error', `the card is accepted and compiled into the run's sealed definition (${draft.scenarios.length} situation)`);

    const baseline = await run(lab, draft.id);
    const first = buildResultView(baseline).problemCheck;
    claim('A', first?.reproduced === 'yes' && first.broken[0]?.expectationId === carried?.id && first.broken[0]?.outcome === 'fail',
      `baseline (${first?.version}): problemCheck reads expectation ${first?.broken[0]?.expectationId} → ${first?.broken[0]?.outcome}; reproduced = ${first?.reproduced}`);
    const fixed = await repeatWith(lab, baseline, 'createFixedSession');
    const second = buildResultView(fixed, { before: baseline }).problemCheck;
    claim('A', second?.reproduced === 'no' && second.before?.verdict === 'fixed' && second.before.comparable,
      `fixed teaching version (${second?.version}) against the baseline: reproduced = ${second?.reproduced}, verdict = ${second?.before?.verdict}`);
    // A check none of whose situations carries the criterion states nothing.
    const other = structuredClone(baseline);
    other.fromAnalysis = { ...other.fromAnalysis!, criterion: { ...other.fromAnalysis!.criterion!, text: 'назвать сумму возврата' } };
    other.fromAnalysis.criterionHash = criterionHash(other.fromAnalysis.criterion!);
    const refused = problemCheck(other, buildResultView(baseline).cards);
    claim('A', refused?.unbound === 'not_carried' && refused.reproduced === 'unknown' && !refused.broken.length,
      `a link whose criterion no card carries is refused: unbound = ${refused?.unbound}, no found/reproduced/fixed stated`);

    await injected(link, x.key);

    // B. Criterion Y: «объяснить, как оформить возврат», broken in «known»; on «late» the judge found it not exercised.
    const y = problemWith(view, 'объяснить');
    const onLate = analysis.findings.filter(finding => finding.dialogueId === 'late' && finding.criterionHash === y.key);
    claim('B', onLate.length === 1 && onLate[0]!.result === 'unknown', `Y on «late» (same topic): finding ${onLate[0]?.result}, the log never reached the rule`);
    const yCheck = problemConversations(y);
    claim('B', !y.held.includes('late') && !yCheck.controls.includes('late') && yCheck.dialogueIds.join() === 'known',
      `«late» is no control: held ${JSON.stringify(y.held)}, check conversations ${JSON.stringify(yCheck.dialogueIds)}`);
    // The same rule both ways: a pass with evidence makes a control; the owner's «нарушение есть», or a pass without evidence, does not.
    const passed = structuredClone(analysis);
    const late = passed.findings.find(finding => finding.key === onLate[0]!.key)!;
    Object.assign(late, { result: 'pass', complete: true, evidence: [{ seq: 1, quote: 'Уточните номер терминала.' }] });
    claim('B', problemConversations(problemWith(analysisView(passed, batch), 'объяснить')).controls.join() === 'late', 'counter-check: the same finding as a pass with evidence does become a control');
    const doubted = structuredClone(passed);
    doubted.reviews.push({ id: 'review-1', createdAt: new Date().toISOString(), key: late.key, verdict: 'confirmed', note: 'нарушение есть', judgeVerdict: 'pass', via: 'cli-yes' });
    const bare = structuredClone(passed);
    bare.findings.find(finding => finding.key === late.key)!.evidence = [];
    claim('B', !problemWith(analysisView(doubted, batch), 'объяснить').held.length && !problemWith(analysisView(bare, batch), 'объяснить').held.length,
      'a pass the owner overrode, or a pass without evidence, is no control');
    // No regression read off it: a check whose import also holds «late» (as the old bridge made it) against a candidate that fails «late».
    const withLate = await preparedCheck(lab, analysis, checkLink(analysis, y).link, ['known', 'late']);
    const yBaseline = await run(lab, withLate.id);
    const regressed = await repeatWith(lab, yBaseline, 'createRegressedSession');
    const result = buildResultView(regressed, { before: yBaseline });
    const lateFails = result.failures.some(failure => failure.title.includes('по просьбе'));
    claim('B', lateFails && result.problemCheck?.before?.verdict === 'fixed' && !result.problemCheck.before.regressed.length && !result.problemCheck.controls.length,
      `candidate fails the «late» situation (${lateFails}), yet problemCheck: controls ${result.problemCheck?.controls.length}, verdict ${result.problemCheck?.before?.verdict}, regressed ${JSON.stringify(result.problemCheck?.before?.regressed)}`);
  } finally { await lab.close(); }
}

/**
 * A builder that leaves the criterion out of the card: the harness puts it in (discover/verify.ts withCriterion), with its
 * rules in the library — the card carries it all the same.
 */
async function injected(link: NonNullable<Experiment['fromAnalysis']>, hash: string): Promise<void> {
  const base = createDemoAnalysisRuntime();
  const forgetful: Runtime = { ...base, async proposeCard(input, ctx) {
    const proposal = await base.proposeCard!(input, ctx) as { agentMust: { text: string }[] };
    return { ...proposal, agentMust: proposal.agentMust.filter(duty => !duty.text.startsWith('не спрашивать номер')) } as never;
  } };
  const lab = new ExperimentLab(join(await folder('inject'), '.agent-lab'), forgetful);
  await lab.init();
  try {
    const started = await lab.analyze(demoAnalysisInput(), { callCeiling: 100 });
    await lab.waitForIdle();
    const analysis = await lab.getAnalysis(started.id);
    const draft = await preparedCheck(lab, analysis, { ...link, analysisId: analysis.id }, link.dialogueIds);
    const library = draft.librarySnapshot?.formatVersion === 2 ? draft.librarySnapshot : undefined;
    const card = library?.cards.find(item => item.origin.kind === 'dialogue' && item.origin.dialogueId === 'known');
    const carried = card?.agentMust.find(duty => !duty.appliesWhen && expectationCriterionHash(duty, library!.requirements) === hash);
    claim('A', !!carried && card!.agentMust.length === 2, `a builder that leaves X out: the harness puts it into card №${card?.number} as ${carried?.id} (duties: ${card?.agentMust.map(duty => duty.id).join(', ')})`);
  } finally { await lab.close(); }
}

// ─── C: a tool criterion on logs with and without the tool's record ───────────────────────────────────────────────
const REFUND_RULE = 'Возврат оплаты агент оформляет только инструментом create_refund.';
async function proofC(): Promise<void> {
  const ask = 'Верните деньги за заказ 42, пожалуйста.';
  const said = 'Готово, возврат оформлен.';
  const rows = [
    { id: 'words', observation: 'complete', events: [{ type: 'message', role: 'user', content: ask }, { type: 'tool', tool: 'find_order', content: 'order 42: paid 1500' },
      { type: 'message', role: 'assistant', content: said }] },
    { id: 'bare', observation: 'complete', events: [{ type: 'message', role: 'user', content: `${ask} Срочно.` }, { type: 'message', role: 'assistant', content: said }] },
    { id: 'partial', observation: 'partial', events: [{ type: 'message', role: 'user', content: `${ask} Это снова я.` }, { type: 'message', role: 'assistant', content: said }] },
    { id: 'tool', observation: 'complete', events: [{ type: 'message', role: 'user', content: `${ask} Заказ оплачен картой.` }, { type: 'tool', tool: 'create_refund', content: 'refund 42 created: 1500' },
      { type: 'message', role: 'assistant', content: said }] },
  ];
  let offered: unknown;
  const judged: string[] = [];
  const stub: Runtime = {
    async proposeScenario(input) {
      offered = input.call.channels;
      return { question: 'Клиент просит вернуть оплату', variations: [{ title: 'Клиент просит вернуть оплату за заказ', examples: input.call.examples.map(example => example.dialogueId) }],
        expectations: [{ text: 'оформить возврат инструментом create_refund', strength: 'must', acceptable: null, violation: 'агент говорит, что возврат оформлен, а create_refund не вызван',
          basis: [{ sourceId: 'source-1', quote: REFUND_RULE, kind: 'behavior' }], variations: null, observation: 'tool', tool: 'create_refund' }] } as never;
    },
    // A credulous judge in the judge's own format: it passes the refund on the words, citing any tool it sees beside them.
    logJudge: { provider: 'stub', model: 'scripted-judge', protocolHash: logProtocolHash(), assess: (request, ctx) => judgeLogged(request, { provider: 'stub', id: 'scripted-judge' }, ctx,
      async (_prompt, input) => {
        const data = JSON.parse(input) as { scenario: { metrics: { id: string }[] }; dialogue: { events: { seq: number; type: string; content: string; tool?: string }[] } };
        const events = data.dialogue.events;
        judged.push(events.find(event => event.type === 'user')!.content);
        const refund = events.find(event => event.type === 'tool_result' && event.tool === 'create_refund');
        const cited = refund ? [refund] : events.filter(event => event.type === 'assistant' || event.type === 'tool_result');
        return JSON.stringify({ assessments: [{ metricId: data.scenario.metrics[0]!.id, rationale: refund ? 'Инструмент create_refund вернул результат.' : 'Агент сказал, что возврат оформлен.',
          evidence: cited.map(event => event.seq), citations: cited.map(event => ({ seq: event.seq, quote: event.content })), passCondition: 'met', failCondition: 'not_met' }] });
      }) },
  };
  const lab = new ExperimentLab(join(await folder('c'), '.agent-lab'), stub);
  await lab.init();
  try {
    const started = await lab.analyze({ task: 'Бот оформляет возвраты', mode: 'live', file: 'журнал возвратов', materials: [{ name: 'Правило возвратов', content: REFUND_RULE }],
      logs: importBatch(rows), settings: settingsSchema.parse({ timeoutMs: 60000 }) }, { callCeiling: 100 });
    await lab.waitForIdle();
    const analysis = await lab.getAnalysis(started.id);
    const expectation = analysis.scenarios[0]?.expectations[0];
    claim('C', JSON.stringify(offered) === JSON.stringify({ tools: ['create_refund', 'find_order'], toolEvents: true, state: false }) && expectation?.observation === 'tool' && expectation.tool === 'create_refund',
      `the plan was offered the tools the logs recorded ${JSON.stringify(offered)}; the criterion is seen on tool ${expectation?.tool}`);
    const finding = (id: string) => analysis.findings.find(item => item.dialogueId === id);
    const words = finding('words');
    claim('C', !!words && words.result !== 'pass' && words.complete && words.votes.length === 2,
      `(i) complete log, the agent says «${said}», only find_order recorded: judge voted pass on the words → finding ${words?.result} (channel rule)`);
    const bare = finding('bare');
    claim('C', bare?.result === 'unknown' && bare.skipped === 'channel_unobserved' && !judged.some(text => text.includes('Срочно')),
      `(i) complete log with no tool event at all: ${bare?.skipped} → ${bare?.result}, judge not asked`);
    const partial = finding('partial');
    claim('C', partial?.result === 'unknown' && partial.skipped === 'channel_unobserved' && !judged.some(text => text.includes('снова я')),
      `(ii) partially observed log: ${partial?.skipped} → ${partial?.result}, judge not asked (judge calls: ${judged.length})`);
    const tool = finding('tool');
    const toolEvent = rows[3]!.events.findIndex(event => event.type === 'tool');
    claim('C', tool?.result === 'pass' && tool.evidence.some(item => item.seq === toolEvent && item.quote.includes('refund')),
      `(iii) complete log with the create_refund result: ${tool?.result} on evidence ${JSON.stringify(tool?.evidence)}`);
    // What the judge was actually sent for (i): the audit the analysis kept beside the finding.
    const audit = words && await lab.store.readAnalysisAudit(analysis.id, words.key);
    const sent = audit ? JSON.parse(audit.input) as ReturnType<typeof logJudgeInput> : undefined;
    claim('C', new Set(analysis.findings.map(item => item.criterionHash)).size === 1 && sent?.scenario.execution.expectations[0]?.observation === 'tool'
      && !!sent.scenario.metrics[0]?.description.includes('журналу инструментов'),
      'every finding carries one criterion hash; the judge was sent the tool expectation with the tool-log rule');
  } finally { await lab.close(); }
}

// ─── D: the isolation exam against fake HTTP agents ──────────────────────────────────────────────────────────────
type Agent = (sessionId: string, message: string) => string;
const numberIn = (text: string) => /\b\d{6}\b/.exec(text)?.[0];
const reply = (known: string | undefined, message: string): string => numberIn(message) ? 'Спасибо, записал. Чем помочь?'
  : message.toLowerCase().includes('какой у меня номер') ? known ? `Ваш номер терминала ${known}.` : 'Вы ещё не называли номер терминала.' : 'Здравствуйте! Чем могу помочь?';
const agents: Record<string, () => Agent> = {
  /** One number per conversation. */
  'per-session': () => { const state = new Map<string, string>(); return (id, message) => { const answer = reply(state.get(id), message); const told = numberIn(message); if (told) state.set(id, told); return answer; }; },
  /**
   * One memory for every conversation, emptied once it is recalled: it passes every path and every control of an exam
   * whose second path only checks «Здравствуйте» — what the earlier rule took for isolation.
   */
  'shared-once': () => { let value: string | undefined; return (_id, message) => {
    const answer = reply(value, message); if (numberIn(message)) value = numberIn(message); else if (message.toLowerCase().includes('какой у меня номер')) value = undefined; return answer; }; },
  /** One variable for every conversation, cleared when a new conversation opens. */
  'shared-session': () => { let value: string | undefined; const seen = new Set<string>(); return (id, message) => {
    if (!seen.has(id)) { seen.add(id); value = undefined; } const answer = reply(value, message); value = numberIn(message) ?? value; return answer; }; },
};
const memoryPath = (name: string, value: string) => ({ name, steps: [{ say: `Мой номер терминала ${value}`, expect: 'reply' }, { say: 'Какой у меня номер терминала?', expect: 'reply', contains: value }] });
const exams = {
  'two memory probes, interleaved': [memoryPath('Клиент А', '783194'), memoryPath('Клиент Б', '892305')],
  'second path checks «Здравствуйте»': [memoryPath('Клиент А', '783194'), { name: 'Клиент Б', steps: [{ say: 'Здравствуйте', expect: 'reply', contains: 'Здравствуйте' }] }],
  'two probes, not interleaved': [memoryPath('Клиент А', '783194'),
    { name: 'Клиент Б', steps: [{ say: 'Здравствуйте', expect: 'reply' }, { say: 'Мой номер терминала 892305', expect: 'reply' }, { say: 'Какой у меня номер терминала?', expect: 'reply', contains: '892305' }] }],
};
const body = (request: IncomingMessage) => new Promise<string>(resolve => { let data = ''; request.on('data', chunk => { data += chunk; }); request.on('end', () => resolve(data)); });
async function examOf(make: () => Agent, exam: unknown) {
  const agent = make();
  const server = createServer(async (request, response) => {
    const json = JSON.parse(await body(request)) as { sessionId: string; message: string };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ reply: agent(json.sessionId, json.message) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const target = runnableTargetSchema.parse({ kind: 'http', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, timeoutMs: 5000, exam });
    return { vouches: examCanVouch(target.exam), result: await examConnection(target, new AbortController().signal) };
  } finally { server.close(); }
}
async function proofD(): Promise<void> {
  for (const [examName, exam] of Object.entries(exams)) {
    for (const [agentName, make] of Object.entries(agents)) {
      const { vouches, result } = await examOf(make, exam);
      const shouldPass = agentName === 'per-session' && examName === 'two memory probes, interleaved';
      const clean = result.paths.every(path => path.passed) && (result.controls ?? []).every(control => control.passed);
      claim('D', (result.status === 'passed') === shouldPass && (examName === 'two memory probes, interleaved') === vouches,
        `${agentName.padEnd(14)} × ${examName.padEnd(34)} → ${result.status} · isolation ${result.properties?.isolation} · exam can vouch: ${vouches}${clean && !shouldPass ? ' · every path and control passed, still not a proof' : ''}`);
    }
  }
}

try {
  await proofsAB();
  await proofC();
  await proofD();
} finally {
  await Promise.all(folders.map(dir => rm(dir, { recursive: true, force: true })));
}
console.log(failed ? `\n${failed} claim(s) FAILED` : '\nAll claims PASS: A B C D');
process.exit(failed ? 1 : 0);
