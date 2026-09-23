// Regression checks for the review findings; controlled fixtures never call a provider.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { access, mkdtemp, rm, readFile, readdir, writeFile, mkdir, cp } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ExperimentLab, draftHash } from '../src/experiment.js';
import { evaluateTrial } from '../src/evaluation.js';
import { evidenceBundle } from '../src/artifacts.js';
import { createInputSchema, DEFAULT_JUDGE, fingerprint, settingsSchema } from '../src/contracts.js';
import { buildResultView } from '../src/result-view.js';
import { demoInput } from '../src/demo.js';
import { libraryHash } from '../src/scenario-library.js';
import { legacyDraft } from './helpers/demo-record.js';

const spec = { name: 'Review fixture', instructions: 'Answer correctly without revealing internal_key.', tools: [] };
const material = { name: 'policy', content: 'Answer the question correctly. Never reveal internal_key.' };
const world = { records: {}, writableFields: [], transientFailures: 0 };
const card = (index = 0) => ({
  id: `card_${index}`, familyId: `family_${index}`, title: `Question ${index}`,
  requirementIds: ['answer'], provenance: 'synthetic', tier: 'regression',
  user: { goal: 'Get the correct answer', facts: 'No additional facts', behavior: 'Ask once', opening: 'What is the answer?', maxFollowUps: 0 },
  initialState: structuredClone(world),
  checks: [{ id: 'no_secret', kind: 'answer_omits', value: 'internal_key', description: 'Do not reveal the internal key' }],
  metrics: [{ id: 'correctness', name: 'Correct answer', subject: 'agent', description: 'Answer is correct', passCriteria: 'Correct answer', failCriteria: 'Wrong answer' }],
  successCriteria: 'Correct answer without secret disclosure',
});
/** The judge of this file fails every rubric; one-reply probes need no user simulator. */
const runtime = () => ({
  async assess({ scenario }) { return scenario.metrics.map(metric => ({ metricId: metric.id, result: 'fail', rationale: 'Fixture: this answer is wrong', evidence: [1] })); },
  async userTurn() { throw new Error('Static probes do not need a simulator'); },
});
async function labFixture(t, adapter) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-workflow-'));
  const lab = new ExperimentLab(directory, adapter);
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  await lab.init();
  return lab;
}
/** An external agent that always answers wrong. It runs in its own process, so every session it opens is appended to a file next to it. */
async function wrongAgent(directory) {
  const path = join(directory, 'wrong-agent.mjs');
  await writeFile(path, `import { appendFileSync } from 'node:fs';\nexport function createSession() { appendFileSync(${JSON.stringify(join(directory, 'wrong-agent.opens'))}, 'open\\n'); return { async respond() { return 'An incorrect answer'; } }; }\n`);
  return { kind: 'module', path, exportName: 'createSession' };
}
const agentOpens = async lab => (await readFile(join(lab.store.directory, 'wrong-agent.opens'), 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
/** A draft of this file's own old-format cards (no execution block) against the wrong agent, as the retired card generator used to leave them. */
async function draftFixture(lab, cards) {
  const draft = await legacyDraft(lab, { count: 1, target: await wrongAgent(lab.store.directory), settings: { repeats: 1, maxIterations: 1, userModes: ['static'] } });
  const revision = { id: fingerprint(spec), parentId: null, spec, hypothesis: 'Agent configuration selected for dialogue evaluation.', createdAt: draft.createdAt };
  await lab.store.save({ ...draft, task: 'Review fixture', questions: [],
    sources: [{ id: 'source-1', name: material.name, content: material.content, hash: fingerprint(material.content) }],
    requirements: [{ id: 'answer', text: material.content, sourceId: 'source-1', quote: material.content, critical: false }],
    scenarios: cards.map(card => ({ ...card, split: 'dev' })), revisions: [revision], selectedRevisionId: revision.id });
  return lab.get(draft.id);
}

test('CLI accept prints the complete current test before recording its exact hash', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-cli-accept-'));
  const data = join(directory, 'data');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lab = new ExperimentLab(data, runtime());
  await lab.init();
  const opening = `Что делать?\n${'полный вход '.repeat(180)}`;
  const prepared = await draftFixture(lab, [{ ...card(), goalObservation: 'reply', user: { ...card().user, opening } }]);
  const successCriteria = prepared.scenarios[0]!.successCriteria!;
  await lab.close();

  const preview = spawnSync(process.execPath, [resolve('dist/cli.js'), 'accept', '--id', prepared.id, '--data-dir', data], { encoding: 'utf8' });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /^ТЕСТ\nСИТУАЦИЯ/m);
  assert.ok(preview.stdout.includes(opening.trimEnd().replace('\n', '\n  ')));
  assert.ok(preview.stdout.includes(successCriteria));
  assert.match(preview.stdout, /НАБЛЮДЕНИЕ\n  ответ агента \(reply\)/);
  assert.match(preview.stdout, new RegExp(`Версия: ${draftHash(prepared).slice(0, 12)}`));
  assert.match(preview.stdout, /Этот тест действительно проверяет нужное поведение\?/);
  assert.equal(JSON.parse(await readFile(join(data, `${prepared.id}.json`), 'utf8')).acceptedDraftHash, undefined);

  const accepted = spawnSync(process.execPath, [resolve('dist/cli.js'), 'accept', '--id', prepared.id, '--yes', '--json', '--data-dir', data], { encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  const events = accepted.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].type, 'test_proposal');
  assert.equal(events[0].draftHash, draftHash(prepared));
  assert.match(events[0].text, /Этот тест действительно проверяет нужное поведение\?$/);
  assert.deepEqual(events[1], { type: 'accepted', id: prepared.id, acceptedDraftHash: events[0].draftHash, agentRun: false });
  const stored = JSON.parse(await readFile(join(data, `${prepared.id}.json`), 'utf8'));
  assert.equal(stored.acceptedDraftHash, events[0].draftHash);
  assert.deepEqual(stored.trials, []); assert.equal(stored.reviewedAt, null); assert.equal(stored.reviewMode, null);
});

test('CLI accept shows what the agent must do in every situation and confirms them all at once', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-cli-sheet-'));
  const data = join(directory, 'data');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lab = new ExperimentLab(data, runtime());
  await lab.init();
  const draft = await draftFixture(lab, [card(0), card(1)]);
  assert.equal(draft.scenarios.length, 2, draft.error ?? '');
  await lab.close();
  const hash = draftHash(draft);

  const preview = spawnSync(process.execPath, [resolve('dist/cli.js'), 'accept', '--id', draft.id, '--data-dir', data], { encoding: 'utf8' });
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /^Что агент должен сделать: 2 ситуации\. Номер правила — порядок в ваших материалах\.$/m);
  assert.equal(preview.stdout.match(/Ситуация: Get the correct answer/g)?.length, 2);
  assert.equal(preview.stdout.match(/^ {3}Должен: Correct answer without secret disclosure$/gm)?.length, 2);
  assert.match(preview.stdout, /^ {3}Правило 1 · policy: «Answer the question correctly\. Never reveal internal_key\.»$/m);
  assert.match(preview.stdout, new RegExp(`^Версия ожиданий: ${hash.slice(0, 12)}$`, 'm'));
  assert.match(preview.stdout, new RegExp(`^Подтвердить все ожидания: agent-lab accept --id ${draft.id} --yes$`, 'm'));
  assert.equal(JSON.parse(await readFile(join(data, `${draft.id}.json`), 'utf8')).acceptedDraftHash, undefined);

  const accepted = spawnSync(process.execPath, [resolve('dist/cli.js'), 'accept', '--id', draft.id, '--yes', '--json', '--data-dir', data], { encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  const events = accepted.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].type, 'test_proposal');
  assert.equal(events[0].draftHash, hash);
  assert.deepEqual(events[1], { type: 'accepted', id: draft.id, acceptedDraftHash: hash, agentRun: false });
  const stored = JSON.parse(await readFile(join(data, `${draft.id}.json`), 'utf8'));
  assert.equal(stored.acceptedTests.length, 2);
  assert.equal(stored.acceptedDraftHash, hash);
  assert.deepEqual(stored.trials, []); assert.equal(stored.reviewedAt, null);
});

test('CLI run returns the full persisted dialogue, automatic verdict and cited proof in JSON', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-cli-run-proof-'));
  const data = join(directory, 'data');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lab = new ExperimentLab(data);
  await lab.init();
  const base = demoInput();
  const created = await lab.create(createInputSchema.parse({ ...base, settings: { ...base.settings, repeats: 1 } }));
  await lab.waitForIdle();
  const { library } = await lab.readLibrary(created.id);
  const { experiment: accepted } = await lab.acceptLibrary(created.id, libraryHash(library), ['known_number']);
  await lab.close();

  const cli = spawnSync(process.execPath, [resolve('dist/cli.js'), 'run', '--id', accepted.id, '--yes', '--json', '--data-dir', data], { encoding: 'utf8' });
  const output = JSON.parse(cli.stdout);
  assert.equal(cli.status, output.exitCode, cli.stderr);
  assert.equal(output.proofs.length, 1);
  const proof = output.proofs[0];
  assert.match(proof.automaticVerdict, /^(?:pass|fail|unknown)$/);
  assert.match(proof.lines.join('\n'), /РЕПЛИКИ\n#0 ПОЛЬЗОВАТЕЛЬ: [^\n]+\n#\d+ АГЕНТ:/);
  assert.match(proof.lines.join('\n'), /Автоматический вердикт: (?:pass|fail|unknown)/);
  assert.match(proof.lines.join('\n'), /КОНТРОЛЬНЫЕ ТОЧКИ\n(?:ВЫПОЛНЕНО|НАРУШЕНО) \[ask_once\] · обязательная · требование refund_rule · события #\d+\n  Обоснование:/);
  assert.match(proof.lines.join('\n'), /ОЦЕНКИ\n(?:PASS|FAIL|UNKNOWN) \[[^\]]+\].*события: #\d+/);
});

test('external state must not pass when the adapter never reported it', async t => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify('No backend observation was made.'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const scenario = { ...card(), split: 'dev', metrics: [],
    initialState: { records: { A: { time: '09:00' } }, writableFields: [], transientFailures: 0 },
    checks: [{ id: 'state', kind: 'state_equals', description: 'The backend record is unchanged', recordId: 'A', field: 'time', value: '09:00' }] };
  const trial = await evaluateTrial({ requirements: [], runtime: runtime(), revision: { id: fingerprint(spec), parentId: null, spec, hypothesis: 'Fixture', createdAt: new Date().toISOString() },
    scenario, repeat: 0, manifestHash: 'review', sources: [], settings: settingsSchema.parse({}), userMode: 'static',
    target: { kind: 'http', url: `http://127.0.0.1:${server.address().port}`, headersEnv: {}, timeoutMs: 1000 },
    ctx: { signal: AbortSignal.timeout(5000), timeoutMs: 1000, beforeCall() {}, addUsage() {} } });
  t.diagnostic(JSON.stringify({ outcome: trial.outcome, reason: trial.reason, checks: trial.checks }));
  assert.notEqual(trial.outcome, 'pass', 'Absent backend evidence must not become a passing state check');
});

import { doctor, readConnection, listSuites, rememberedConnection } from '../src/connection.js';
import { compareRuns } from '../src/comparison.js';
import { readData } from '../src/imports.js';

test('reassessment never opens the target, preserves original evidence, versions criteria and validates citations', async t => {
  const adapter = runtime();
  const lab = await labFixture(t, adapter);
  const prepared = await draftFixture(lab, [card()]);
  await lab.start(prepared.id, { approved: true, expectedHash: draftHash(prepared) }); await lab.waitForIdle();
  const original = await lab.get(prepared.id);
  adapter.assess = async ({ scenario }) => scenario.metrics.map(m => ({ metricId: m.id, result: 'pass', rationale: 'Changed rubric fixture', evidence: [1] }));
  const scoring = await lab.reassess(original.id, { criteria: [{ scenarioId: 'card_0', metrics: [{ ...card().metrics[0], passCriteria: 'The answer is explicitly incorrect' }] }] });
  await lab.waitForIdle();
  const revised = await lab.get(scoring.id);
  assert.equal(revised.phase, 'results_review', revised.error);
  assert.equal(await agentOpens(lab), 1, 'Only the original run opened a target session');
  assert.deepEqual(await lab.get(original.id), original, 'No original facts or scores are overwritten');
  assert.equal(revised.assessmentOf, original.id);
  assert.deepEqual(revised.trials[0].events, original.trials[0].events);
  assert.equal(revised.trials[0].assessments[0].result, 'pass');
  assert.equal(original.trials[0].assessments[0].result, 'fail');
  assert.equal(compareRuns(original, revised).comparable, false);
  const codeOnly = await lab.reassess(original.id, { codeOnly: true }); await lab.waitForIdle();
  assert.equal((await lab.get(codeOnly.id)).usage.calls, 0);
  adapter.assess = async () => [{ metricId: 'correctness', result: 'pass', rationale: 'Bad citation', evidence: [999] }];
  const invalid = await lab.reassess(original.id); await lab.waitForIdle();
  assert.match((await lab.get(invalid.id)).trials[0].assessmentError, /nonexistent/);
  assert.equal(await agentOpens(lab), 1);
  const judge = { provider: 'openrouter', model: 'other-judge', upstream: 'openai' };
  const judged = await lab.reassess(original.id, { judge }); await lab.waitForIdle();
  const judgedResult = await lab.get(judged.id);
  assert.notEqual(judgedResult.evaluatorVersion, original.evaluatorVersion);
  assert.deepEqual(judgedResult.settings.judge, judge);
  assert.equal(judgedResult.settings.roles.judge, undefined);
});

test('rejudged version pairs remain comparable without copying original human labels', async t => {
  const adapter = runtime();
  const lab = await labFixture(t, adapter);
  const created = await draftFixture(lab, [card()]);
  await lab.start(created.id, { approved: true, expectedHash: draftHash(created) }); await lab.waitForIdle();
  let original = await lab.get(created.id);
  await lab.addHumanReview(original.id, { trialId: original.trials[0].id, metricId: 'correctness', verdict: 'pass', note: 'Explicit test fixture label, not a real human verdict.' });
  original = await lab.get(original.id);
  adapter.assess = async () => [{ metricId: 'correctness', result: 'pass', rationale: 'Changed evaluator fixture', evidence: [1] }];
  const first = await lab.reassess(original.id); await lab.waitForIdle();
  const before = await lab.get(first.id);
  assert.deepEqual(before.humanReviews, [], 'Referenced labels do not become new human approvals');
  const next = await lab.repeat(original.id);
  await lab.start(next.id, { approved: true, expectedHash: draftHash(next) }); await lab.waitForIdle();
  const second = await lab.reassess(next.id); await lab.waitForIdle();
  const after = await lab.get(second.id);
  assert.equal(after.sourceEvidence.parentRunId, original.id);
  assert.equal(compareRuns(before, after).comparable, true);
  assert.equal(compareRuns(original, after).comparable, false);
  assert.equal(compareRuns(before, { ...after, evaluatorVersion: 'other' }).comparable, false);
});

test('local JSONL imports keep the dialogue as written and name the broken line', async t => {
  const lab = await labFixture(t, runtime());
  const file = join(lab.store.directory, 'dialogues.jsonl');
  await writeFile(file, JSON.stringify({ id: 'real', messages: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi' }] }) + '\n');
  const imported = await readData(file); assert.equal(imported[0].id, 'real');
  await writeFile(file, '{bad}\n'); await assert.rejects(readData(file), /строке 1/);
});

test('draft edits cannot touch cards or launder their provenance: situations change only in the library', async t => {
  const lab = await labFixture(t, runtime());
  const original = await draftFixture(lab, [card()]);
  await assert.rejects(lab.updateDraft(original.id, draftHash(original), {
    scenarios: [{ ...original.scenarios[0], provenance: 'curated' }],
  }), /scenarios/);
  assert.deepEqual(await lab.get(original.id), original, 'a refused edit saves nothing');
});

test('partial external observations, unreported costs and out-of-scope tools cannot look like complete measurements', async t => {
  let responseFor;
  let requests = 0;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body); requests++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(responseFor(input, requests)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const scenario = { ...card(), metrics: [], split: 'dev', user: { ...card().user, opening: 'Read', script: ['Read again'], maxFollowUps: 1 },
    initialState: { records: { A: { time: '09:00' } }, writableFields: [], transientFailures: 0 },
    checks: [{ id: 'state', kind: 'state_equals', recordId: 'A', field: 'time', value: '09:00', description: 'Unchanged' }] };
  const run = (s = scenario) => evaluateTrial({ requirements: [], runtime: runtime(), revision: { id: fingerprint(spec), parentId: null, spec, hypothesis: 'fixture', createdAt: new Date().toISOString() },
    scenario: s, repeat: 0, manifestHash: 'fixture', sources: [], settings: settingsSchema.parse({}), userMode: 'scripted',
    target: { kind: 'http', url: `http://127.0.0.1:${server.address().port}`, headersEnv: {}, timeoutMs: 1000 },
    ctx: { signal: AbortSignal.timeout(5000), timeoutMs: 1000, beforeCall() {}, addUsage() {} } });
  const reply = (input, turn) => ({ reply: 'OK', records: { A: { time: '09:00' } }, eventsComplete: true, resetConfirmed: true,
    sessionId: input.sessionId, turn, version: 'v1', usage: { calls: 1, inputTokens: 10, outputTokens: 2, costUsd: 0.1 } });
  responseFor = (input, turn) => turn === 1 ? reply(input, turn) : 'No snapshot';
  let result = await run(); assert.equal(result.outcome, 'invalid'); assert.equal(result.externalUsage.costUsd, null);
  requests = 0; responseFor = (input, turn) => ({ ...reply(input, turn), records: { A: {} } });
  result = await run(); assert.equal(result.outcome, 'invalid'); assert.match(result.reason, /Не наблюдалось поле/);
  requests = 0; responseFor = (input, turn) => ({ ...reply(input, turn), eventScope: ['read_*'] });
  result = await run({ ...scenario, checks: [{ id: 'no_write', kind: 'tool_not_called', tool: 'update_record', description: 'No writes' }] });
  assert.equal(result.outcome, 'invalid'); assert.match(result.reason, /область событий/);
  requests = 0; responseFor = (input, turn) => ({ ...reply(input, turn), sessionId: 'wrong-session' });
  result = await run(); assert.equal(result.outcome, 'invalid'); assert.match(result.reason, /идентификатор/);
  requests = 0; responseFor = (input, turn) => ({ ...reply(input, turn), version: `v${turn}` });
  result = await run(); assert.equal(result.outcome, 'invalid'); assert.match(result.reason, /Версия.*изменилась/);
});

