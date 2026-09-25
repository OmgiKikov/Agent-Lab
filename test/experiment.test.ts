import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ExperimentLab } from '../src/experiment.js';
import { draftHash, measurementHash, resultHash } from '../src/lab/record.js';
import { ExperimentStore } from '../src/store.js';
import { createDemoRuntime, demoInput } from '../src/demo.js';
import { SANDBOX_RETIRED, createInputSchema, experimentSchema, fingerprint, runnableTarget, validatePreparation, type Experiment, type HumanReviewInput, type Target } from '../src/contracts.js';
import { metricApplies } from '../src/assessment.js';
import type { Runtime } from '../src/runtime.js';
import { assessRepeated, hasCompleteJudgment, observableSources } from '../src/judge.js';
import { awaitingVerdict, compareRuns } from '../src/comparison.js';
import { COUNTING_RULES, simulatorUsable } from '../src/outcomes.js';
import { judgeAgreement } from '../src/agreement.js';
import { buildResultView } from '../src/result-view.js';
import { trustParts } from '../src/result-text.js';
import { CODE_ONLY_ASSESSMENT, deriveRun } from '../src/run.js';
import { acceptedDemoDraft, appointmentAgent, demoEvaluateRecord, legacyDemoRuntime, legacyDraft } from './helpers/demo-record.js';

async function setup(t: TestContext, runtime?: Runtime) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-experiment-'));
  const lab = new ExperimentLab(directory, runtime);
  t.after(async () => { try { await lab.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  await lab.init();
  return { lab, directory };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
/**
 * An old-format draft (cards without an `execution` block, run by the free user simulator) against the
 * external appointment agent. Real records of external agents carry each card's evidence channel.
 */
async function externalDraft(lab: ExperimentLab, options: Parameters<typeof legacyDraft>[1] = {}, adjust?: (draft: Experiment) => void): Promise<Experiment> {
  const draft = await legacyDraft(lab, options);
  draft.scenarios = draft.scenarios.map(scenario => ({ ...scenario, goalObservation: scenario.goalObservation ?? 'reply' }));
  adjust?.(draft);
  await lab.store.save(draft);
  return lab.get(draft.id);
}
async function runDraft(lab: ExperimentLab, draft: Experiment, reviewer: 'human' | 'expectations' | 'automated' = 'automated', parallel?: number): Promise<Experiment> {
  await lab.start(draft.id, { approved: true, reviewer, expectedHash: draftHash(draft), ...(parallel ? { parallel } : {}) });
  await lab.waitForIdle();
  return lab.get(draft.id);
}
/** The headline of a run as every surface reads it: counted situations handled of those decided, and what is left undecided. */
function headlineOf(record: Experiment) {
  const view = buildResultView(record);
  return { passed: view.headline.passed, decided: view.headline.decided, accuracy: view.headline.accuracy,
    notMeasured: view.notMeasured.total, pending: view.pending, situations: view.cards.length };
}

test('a completed evaluation freezes the measurement, persists the observed evidence and never starts again', async t => {
  const { lab } = await setup(t, legacyDemoRuntime());
  const ready = await externalDraft(lab);
  assert.equal(ready.phase, 'review');
  await assert.rejects(lab.start(ready.id, { approved: false, expectedHash: draftHash(ready) }), /после вашего подтверждения/);
  const result = await runDraft(lab, ready);
  assert.equal(result.phase, 'results_review', result.error ?? '');
  assert.equal(result.manifestHash, measurementHash(result));
  assert.equal(result.sources[0]!.hash, fingerprint(result.sources[0]!.content));
  assert.deepEqual(result.scenarios, ready.scenarios);
  assert.ok(result.reviewedAt);
  assert.deepEqual(result.comparisons, []);
  const journal = (await lab.store.traceJournal(result.id)).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(journal.length, result.trials.reduce((sum, trial) => sum + trial.events.length, 0));
  assert.ok(journal.some(row => row.event.type === 'tool_result' && row.event.tool === 'lookup_record'), 'tool events reported by the agent are evidence');
  assert.deepEqual(await lab.store.get(result.id), result);
  assert.notEqual(measurementHash({ ...result, task: 'different task' }), result.manifestHash);
  const changed = structuredClone(result);
  changed.revisions[0]!.spec.instructions += ' changed';
  assert.notEqual(measurementHash(changed), result.manifestHash);
  await assert.rejects(lab.start(result.id, { approved: true, expectedHash: draftHash(result) }), /только эксперимент, ожидающий проверки/);
});

test('call budget stops the run, preserving partial trials without a final success claim', async t => {
  const { lab } = await setup(t, legacyDemoRuntime());
  // The external agent spends no model calls of the lab: the budget goes to the simulated user and the judge.
  const result = await runDraft(lab, await externalDraft(lab, { count: 10, settings: { maxCalls: 5 } }));
  assert.equal(result.phase, 'error');
  assert.match(result.error!, /call budget/);
  assert.equal(result.usage.calls, 5);
  assert.ok(result.trials.length > 0 && result.trials.length < 10, `${result.trials.length} trials`);
  assert.equal(result.resultsReviewedAt, undefined);
});

test('task-only execution records automated review and labels expectations provisional', async t => {
  const { lab } = await setup(t, legacyDemoRuntime());
  const result = await runDraft(lab, await externalDraft(lab), 'automated');
  assert.equal(result.phase, 'results_review', result.error ?? '');
  assert.equal(result.reviewMode, 'automated');
  assert.match(result.limitations.join(' '), /проверены автоматически, без человека/);
});

test('shutdown during the initial checkpoint waits, keeps the lock, and never starts model work', async t => {
  const runtime = createDemoRuntime(); let calls = 0;
  const propose = runtime.proposeCard!;
  runtime.proposeCard = async (...args) => { calls++; return propose(...args); };
  const { lab, directory } = await setup(t, runtime);
  const entered = deferred(); const release = deferred();
  const save = lab.store.save.bind(lab.store); let first = true;
  lab.store.save = async record => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    await save(record);
  };
  const creating = lab.create(demoInput());
  await entered.promise;
  await assert.rejects(lab.create(demoInput()), /другая операция/);
  let closed = false;
  const closing = lab.close().then(() => { closed = true; });
  try {
    await assert.rejects(new ExperimentStore(directory).init(), /already open/);
    assert.equal(closed, false);
  } finally { release.resolve(); }
  const record = await creating;
  await closing;
  assert.equal(calls, 0);
  assert.equal((await lab.store.get(record.id)).phase, 'cancelled');
  await assert.rejects(lab.create(demoInput()), /не открыта/);
  const next = new ExperimentStore(directory); await next.init(); await next.close();
});

test('one writer, validated atomic saves, stale recovery, and isolated corrupt records on restart', async t => {
  const { lab, directory } = await setup(t);
  const record = await lab.create(demoInput()); await lab.waitForIdle();
  const ready = await lab.get(record.id);
  await assert.rejects(new ExperimentStore(directory).init(), /already open/);
  await assert.rejects(lab.store.get('../outside'), /Invalid experiment ID/);
  await assert.rejects(lab.store.save({ ...ready, phase: 'fabricated' } as never));
  assert.equal((await lab.store.get(record.id)).phase, 'review');
  await lab.store.save({ ...ready, phase: 'baseline' });
  await writeFile(join(directory, `${record.id}.agent.json`), JSON.stringify(ready.revisions[0]!.spec));
  await lab.close();
  const restarted = new ExperimentLab(directory);
  await restarted.init();
  assert.equal((await restarted.get(record.id)).phase, 'interrupted');
  assert.equal((await restarted.get(record.id)).usage.costUsd, null);
  await restarted.close();
  await writeFile(join(directory, '.lock'), JSON.stringify({ pid: 2147483647, token: 'stale' }));
  const recovered = new ExperimentStore(directory);
  await recovered.init();
  assert.equal(JSON.parse(await readFile(join(directory, '.lock'), 'utf8')).pid, process.pid);
  await recovered.close();
  await writeFile(join(directory, `${record.id}.json`), '{"broken":true}');
  const corrupt = new ExperimentLab(directory);
  await corrupt.init();
  assert.deepEqual(await corrupt.list(), []);
  assert.equal(corrupt.store.diagnostics[0]?.id, record.id);
  assert.equal(await readFile(join(directory, `${record.id}.json`), 'utf8'), '{"broken":true}');
  await corrupt.close();
  await assert.rejects(readFile(join(directory, '.lock')), { code: 'ENOENT' });
});

test('shutdown waits for in-flight initialization and cannot reopen a closed lab or leak its lock', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-init-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lab = new ExperimentLab(directory);
  const entered = deferred(); const release = deferred();
  const init = lab.store.init.bind(lab.store);
  lab.store.init = async () => { entered.resolve(); await release.promise; await init(); };
  const opening = lab.init();
  await entered.promise;
  let closed = false;
  const closing = lab.close().then(() => { closed = true; });
  assert.equal(closed, false);
  release.resolve();
  await opening; await closing;
  await assert.rejects(lab.create(demoInput()), /не открыта/);
  await assert.rejects(lab.init(), /closing/);
  await assert.rejects(readFile(join(directory, '.lock')), { code: 'ENOENT' });
});

test('preparation rejects invented sources, cards without an expectation, and contradictory or unreachable checks', async () => {
  const recorded = experimentSchema.parse(JSON.parse(await readFile(new URL('./fixtures/legacy-demo-draft.json', import.meta.url), 'utf8')));
  const sources = recorded.sources;
  const raw = { requirements: recorded.requirements, questions: [] as string[], scenarios: recorded.scenarios.map(({ split: _split, ...scenario }) => scenario) };
  assert.deepEqual(validatePreparation(raw, sources).scenarios.map(s => s.split), raw.scenarios.map(() => 'dev'), 'recorded cards stay valid and all run');
  const check = (mutate: (p: typeof raw) => void, message: RegExp) => {
    const p = structuredClone(raw); mutate(p); assert.throws(() => validatePreparation(p, sources), message);
  };
  check(p => { p.scenarios = []; }, /No cards to run/);
  check(p => { p.requirements[0]!.quote = 'Fabricated source fact'; }, /ungrounded/);
  check(p => { delete p.scenarios[0]!.successCriteria; }, /success criteria and an explicit follow-up limit/);
  check(p => { p.scenarios[0]!.checks.push({ id: 'opposite', kind: 'state_equals', description: 'conflict', recordId: 'A101', field: 'time', value: '20:00' }); }, /Contradictory state/);
  check(p => { p.scenarios[0]!.checks.push({ id: 'no_lookup', kind: 'tool_not_called', description: 'conflict', tool: 'lookup_record' }); }, /Contradictory tool/);
  check(p => { p.scenarios[0]!.checks.push({ id: 'no_update', kind: 'tool_not_called', description: 'conflict', tool: 'update_record' }); }, /Contradictory update/);
  check(p => { p.scenarios[0]!.checks.push({ id: 'bad_count', kind: 'tool_count', description: 'conflict', tool: 'lookup_record', min: 3, max: 2 }); }, /Contradictory tool/);
  check(p => { p.scenarios[0]!.checks.push({ id: 'zero_lookups', kind: 'tool_count', description: 'conflict', tool: 'lookup_record', min: 0, max: 0 }); }, /Contradictory tool/);
  check(p => {
    p.scenarios[0]!.checks.push({ id: 'wants_time', kind: 'answer_contains', description: 'conflict', value: '14:00' });
    p.scenarios[0]!.checks.push({ id: 'forbids_time', kind: 'answer_omits', description: 'conflict', value: '14:00' });
  }, /Contradictory answer/);
  check(p => { p.scenarios[0]!.checks.push({ id: 'forbidden', kind: 'state_equals', description: 'unreachable', recordId: 'A101', field: 'owner', value: 'Other' }); p.scenarios[0]!.checks = p.scenarios[0]!.checks.filter(c => c.id !== 'owner'); }, /Unreachable/);
});

test('провалы прогона получают имена, а сорванная кластеризация не теряет прогон', async t => {
  // Агент без инструмента изменения: запись не меняется, значит проверки падают и есть что кластеризовать.
  const seen: unknown[] = [];
  const named: Runtime = {
    ...legacyDemoRuntime(),
    async failureModes(input) {
      seen.push(input);
      return [{ id: 'no_action', name: 'Пообещал перенос и не сделал его', description: 'Ответ утверждает изменение, которого нет в состоянии.', stage: 'действие', trialIds: input.failures.map(f => f.trialId) }];
    },
  };
  const { lab } = await setup(t, named);
  const done = await runDraft(lab, await externalDraft(lab), 'human');
  // Кластеризатору дают ровно те провалы, которые считает главное число: провалившиеся попытки засчитанных ситуаций, с их трассами.
  const failed = deriveRun(done).failedAttempts.map(t => t.id);
  assert.ok(failed.length >= 2, 'в демо-прогоне есть что кластеризовать');
  assert.deepEqual((seen[0] as { failures: { trialId: string }[] }).failures.map(f => f.trialId), failed);
  assert.deepEqual(failed, done.trials.filter(t => t.outcome === 'fail').map(t => t.id), 'в этом прогоне провал числа — это провал точных проверок');
  assert.equal(done.failureModes?.length, 1);
  assert.match(done.failureModes![0]!.name, /Пообещал/);
  assert.deepEqual(done.failureModes![0]!.trialIds.sort(), [...failed].sort());
  const passed = new Set(done.trials.filter(t => t.outcome !== 'fail').map(t => t.id));
  assert.ok(passed.size > 0, 'прочитанная без изменения запись проходит');
  assert.equal(failed.some(id => passed.has(id)), false);

  // Сорванный разбор — это оговорка в записи, а не потерянный прогон.
  const { lab: broken } = await setup(t, { ...legacyDemoRuntime(), async failureModes() { throw new Error('судья недоступен'); } });
  const survived = await runDraft(broken, await externalDraft(broken), 'human');
  assert.equal(survived.phase, 'results_review');
  assert.equal(survived.failureModes, undefined);
  assert.ok(survived.limitations.some(l => /Не удалось назвать типы провалов.*судья недоступен/.test(l)));
});

test('unresolved business questions block a first-format draft until new materials produce a new experiment', async t => {
  // A first-format draft's rules were read once for the whole set, so an open question leaves every card unsettled.
  // Card sets are reviewed card by card instead (card-prepare.test.ts: open grounding questions do not block them).
  const { lab } = await setup(t, legacyDemoRuntime());
  const draft = { ...await legacyDraft(lab, { count: 1 }), questions: ['Which timezone applies?'] };
  await lab.store.save(draft);
  await assert.rejects(lab.start(draft.id, { approved: true, expectedHash: draftHash(draft) }), /ответьте на бизнес-вопросы/);
  assert.equal((await lab.get(draft.id)).phase, 'review');
});

test('goal observation is part of the existing full draft hash while legacy drafts stay stable', async t => {
  const { lab } = await setup(t, legacyDemoRuntime());
  const legacy = await legacyDraft(lab, { count: 1 });
  assert.equal(legacy.scenarios[0]!.goalObservation, undefined, 'a card written before the field existed');
  const legacyHash = draftHash(legacy);
  assert.equal(draftHash(structuredClone(legacy)), legacyHash);
  const reply = structuredClone(legacy);
  reply.scenarios[0]!.goalObservation = 'reply';
  assert.notEqual(draftHash(reply), legacyHash);
  const tool = structuredClone(reply);
  tool.scenarios[0]!.goalObservation = 'tool';
  assert.notEqual(draftHash(tool), draftHash(reply));
});

test('confirming the expectations is recorded as exactly that, never as a human check of the cards or verdicts', async t => {
  const { lab } = await setup(t, legacyDemoRuntime());
  const result = await runDraft(lab, await externalDraft(lab), 'expectations');
  assert.equal(result.phase, 'results_review', result.error ?? '');
  assert.equal(result.reviewMode, 'expectations');
  // The run dialog confirms expectations; the verdicts do not exist yet, so nothing here says a
  // person checked them. The limitation must say so instead of disappearing.
  assert.match(result.limitations.join(' '), /Владелец подтвердил ожидания ситуаций перед запуском\. Определения карточек и оценки судьи человеком не проверялись\./);
  assert.doesNotMatch(result.limitations.join(' '), /проверены автоматически, без человека/);
  // An old record parses and keeps the two modes it could already hold.
  assert.equal(experimentSchema.parse({ ...result, reviewMode: 'human' }).reviewMode, 'human');
  assert.equal(experimentSchema.parse({ ...result, reviewMode: 'automated' }).reviewMode, 'automated');
});

test('the manifest covers the control set but not the owner-expectation label, and old records keep their hash', async t => {
  const { lab } = await setup(t, legacyDemoRuntime());
  const record = await externalDraft(lab, { count: 2 });
  const base = measurementHash(record);
  const [first, second] = record.scenarios.map(scenario => scenario.id) as [string, string];

  // A control card leaves the headline denominator, so two runs marking different controls did not
  // measure the same thing even when every scenario is byte-identical.
  assert.notEqual(measurementHash({ ...record, positiveControlScenarioIds: [first] }), base);
  assert.notEqual(measurementHash({ ...record, positiveControlScenarioIds: [first] }),
    measurementHash({ ...record, positiveControlScenarioIds: [second] }));
  // The owner-expectation marker is only a label: the edit that sets it already rewrote the card.
  assert.equal(measurementHash({ ...record, ownerExpectationScenarioIds: [first] }), base);

  // A record written before either field existed hashes exactly as it did then.
  const legacy = structuredClone(record);
  delete (legacy as Partial<Experiment>).positiveControlScenarioIds;
  delete (legacy as Partial<Experiment>).ownerExpectationScenarioIds;
  assert.equal(measurementHash(legacy), base);
});

test('accepting a draft records exact review metadata without granting execution authority', async t => {
  const base = legacyDemoRuntime();
  let runtimeCalls = 0;
  const runtime: Runtime = { ...base,
    async assess(...args) { runtimeCalls++; return base.assess!(...args); },
    async userTurn(...args) { runtimeCalls++; return base.userTurn!(...args); } };
  const { lab } = await setup(t, runtime);
  const draft = await externalDraft(lab, { count: 1 });
  const currentHash = draftHash(draft);

  await assert.rejects(lab.acceptDraft(draft.id, '0'.repeat(64)), /изменился/i);
  assert.deepEqual(await lab.get(draft.id), draft);
  await assert.rejects(lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: currentHash, requireAccepted: true }), /Сначала подтвердите ожидания ситуаций/);
  const accepted = await lab.acceptDraft(draft.id, currentHash);
  assert.equal(accepted.acceptedDraftHash, currentHash);
  assert.equal(accepted.acceptedTests?.length, 1);
  assert.deepEqual({ scenarioId: accepted.acceptedTests![0]!.scenarioId, definitionHash: accepted.acceptedTests![0]!.definitionHash },
    { scenarioId: accepted.scenarios[0]!.id, definitionHash: fingerprint(accepted.scenarios[0]!) });
  assert.equal(draftHash(accepted), currentHash);
  assert.equal(accepted.reviewedAt, draft.reviewedAt);
  assert.equal(accepted.reviewMode, draft.reviewMode);
  assert.equal(runtimeCalls, 0);
  assert.deepEqual(await lab.acceptDraft(draft.id, currentHash), accepted, 'accepting the current hash twice is idempotent');

  // A new run setting is a new draft version: the confirmation is withdrawn, the unchanged situation keeps its entry.
  const edited = await lab.updateDraft(draft.id, currentHash, { settings: { maxTurns: 5 } });
  assert.equal(edited.acceptedDraftHash, undefined);
  assert.deepEqual(edited.acceptedTests, accepted.acceptedTests);
  assert.notEqual(draftHash(edited), currentHash);
  await assert.rejects(lab.start(edited.id, { approved: true, reviewer: 'human', expectedHash: draftHash(edited), requireAccepted: true }), /Сначала подтвердите ожидания ситуаций/);
  const reconfirmed = await lab.acceptDraft(edited.id, draftHash(edited));
  assert.deepEqual(reconfirmed.acceptedTests, accepted.acceptedTests, 'an unchanged situation keeps its identity and date');

  await lab.start(reconfirmed.id, { approved: true, reviewer: 'human', expectedHash: draftHash(reconfirmed), requireAccepted: true });
  await lab.waitForIdle();
  const result = await lab.get(reconfirmed.id);
  assert.equal(result.phase, 'results_review', result.error ?? '');
  assert.equal(result.acceptedDraftHash, draftHash(reconfirmed), 'running does not rewrite or clear acceptance metadata');
  assert.deepEqual(result.acceptedTests, accepted.acceptedTests);
  const repeated = await lab.repeat(result.id);
  assert.equal(repeated.acceptedDraftHash, undefined, 'a fresh draft starts without review metadata');
  assert.deepEqual(repeated.acceptedTests, accepted.acceptedTests, 'an unchanged situation stays accepted in the repeat');
});

test('accepting rejects an empty draft, a compare record and a started run without mutation', async t => {
  const { lab } = await setup(t, legacyDemoRuntime());
  const emptyRecord = await externalDraft(lab, { count: 1 }, draft => { draft.scenarios = []; });
  await assert.rejects(lab.acceptDraft(emptyRecord.id, draftHash(emptyRecord)), /нечего/i);
  assert.deepEqual(await lab.get(emptyRecord.id), emptyRecord);

  const compareRecord = await externalDraft(lab, { count: 1 }, draft => { draft.workflow = 'compare'; });
  await assert.rejects(lab.acceptDraft(compareRecord.id, draftHash(compareRecord)), /evaluate/i);
  assert.deepEqual(await lab.get(compareRecord.id), compareRecord);

  const completed = await runDraft(lab, await externalDraft(lab, { count: 2 }), 'human');
  await assert.rejects(lab.acceptDraft(completed.id, draftHash(completed)), /черновик/i);
  assert.deepEqual(await lab.get(completed.id), completed);
});

test('one confirmation covers every situation of the draft and keeps unchanged entries', async t => {
  const { lab } = await setup(t, legacyDemoRuntime());
  const draft = await externalDraft(lab, { count: 2 });
  assert.equal(draft.scenarios.length, 2, draft.error ?? '');
  const hash = draftHash(draft);

  await assert.rejects(lab.acceptDraft(draft.id, '0'.repeat(64)), /Черновик изменился, пока вы смотрели/);
  assert.deepEqual(await lab.get(draft.id), draft, 'a stale confirmation writes nothing');

  const accepted = await lab.acceptDraft(draft.id, hash);
  assert.equal(accepted.acceptedDraftHash, hash);
  assert.deepEqual(accepted.acceptedTests!.map(test => test.scenarioId), accepted.scenarios.map(scenario => scenario.id));
  assert.deepEqual(accepted.acceptedTests!.map(test => test.definitionHash), accepted.scenarios.map(scenario => fingerprint(scenario)));
  assert.deepEqual(await lab.acceptDraft(draft.id, hash), accepted, 'confirming the same draft twice writes nothing');
  assert.equal((await lab.get(draft.id)).updatedAt, accepted.updatedAt);

  // A new agent version needs a fresh confirmation; the situations themselves did not change, so they keep their entries.
  const edited = await lab.updateDraft(draft.id, hash, { targetVersion: 'v2' });
  assert.equal(edited.acceptedDraftHash, undefined);
  assert.deepEqual(edited.acceptedTests, accepted.acceptedTests);
  const again = await lab.acceptDraft(edited.id, draftHash(edited));
  assert.equal(again.acceptedDraftHash, draftHash(edited));
  assert.deepEqual(again.acceptedTests, accepted.acceptedTests, 'an unchanged situation keeps its entry');
});

test("an old record's owner-expectation marker survives hashes, schema, repeat and case selection", async t => {
  // Owner-written expectations are no longer edited in a draft, but records that carry the marker keep it.
  const { lab } = await setup(t, legacyDemoRuntime());
  const marked = await externalDraft(lab, { count: 2 }, draft => { draft.ownerExpectationScenarioIds = [draft.scenarios[0]!.id]; });
  const card = marked.scenarios[0]!;
  assert.deepEqual(marked.ownerExpectationScenarioIds, [card.id]);

  // Old records keep their exact hash and the field never enters the measurement hash.
  const legacy = structuredClone(marked); delete legacy.ownerExpectationScenarioIds;
  assert.equal(draftHash(legacy), draftHash({ ...legacy, ownerExpectationScenarioIds: undefined }));
  assert.notEqual(draftHash(marked), draftHash(legacy), 'the marker is part of the draft version');
  assert.equal(measurementHash(marked), measurementHash(legacy), 'the marker never changes what is measured');

  experimentSchema.parse(legacy);
  assert.throws(() => experimentSchema.parse({ ...marked, ownerExpectationScenarioIds: ['not_a_card'] }), /ситуации этого набора/);
  assert.throws(() => experimentSchema.parse({ ...marked, ownerExpectationScenarioIds: [card.id, card.id] }), /Duplicate owner expectation IDs/);

  const done = await runDraft(lab, marked, 'human');
  assert.equal(done.phase, 'results_review', done.error ?? '');
  const repeated = await lab.repeat(done.id);
  assert.deepEqual(repeated.ownerExpectationScenarioIds, [card.id], 'a repeat keeps the marker');
  const narrowed = await lab.repeat(done.id, [done.scenarios[1]!.id]);
  assert.equal(narrowed.ownerExpectationScenarioIds, undefined, 'a --case selection drops markers of situations left out');
});

/** A validation build whose model goal ids are chosen by `goalId`; `null` means the model found no goal. */
test('fifteen unaccepted cards still run, report accuracy, save, load and rerun intact', async t => {
  const { lab, directory } = await setup(t, legacyDemoRuntime());
  const batch = await externalDraft(lab, { count: 10 }, draft => {
    draft.scenarios.push(...Array.from({ length: 5 }, (_, index) => ({
      ...structuredClone(draft.scenarios[0]!), id: `batch_extra_${index + 1}`, title: `Batch sentinel ${index + 1}`,
    })));
  });
  assert.equal(batch.scenarios.length, 15);
  assert.equal(batch.acceptedDraftHash, undefined);
  assert.deepEqual(batch.acceptedTests, []);

  const first = await runDraft(lab, batch, 'automated');
  assert.equal(first.phase, 'results_review', first.error ?? '');
  assert.equal(first.trials.length, 15);
  // Only the two read-only questions pass: the agent cannot move an appointment.
  assert.deepEqual(headlineOf(first), { passed: 2, decided: 15, accuracy: 2 / 15, notMeasured: 0, pending: 0, situations: 15 });
  assert.equal(first.acceptedDraftHash, undefined);

  const suitePath = await lab.saveSuite(first.id, join(directory, 'fifteen-card-suite.json'));
  const loaded = await lab.loadSuite(suitePath);
  assert.equal(loaded.scenarios.length, 15);
  assert.equal(loaded.acceptedDraftHash, undefined);
  assert.deepEqual(loaded.acceptedTests, []);
  const rerun = await runDraft(lab, loaded, 'automated');
  assert.equal(rerun.trials.length, 15);
  assert.deepEqual(rerun.scenarios.map(scenario => scenario.id), first.scenarios.map(scenario => scenario.id));
  assert.deepEqual(headlineOf(rerun), headlineOf(first));
  assert.equal(rerun.acceptedDraftHash, undefined);
});

test('one user card requires exact human approval, runs the agent once, then preserves separate human result review', async t => {
  const { lab } = await setup(t, legacyDemoRuntime());
  const draft = await externalDraft(lab, { count: 1, settings: { repeats: 1 }, target: appointmentAgent('createRepairedSession') });
  assert.equal(draft.phase, 'review'); assert.equal(draft.scenarios.length, 1);
  assert.ok(draft.scenarios[0]!.user.persona); assert.ok(draft.scenarios[0]!.metrics?.length);
  const originalHash = draftHash(draft);
  await assert.rejects(lab.start(draft.id, { approved: false, reviewer: 'automated', expectedHash: originalHash }), /подтверждения/);
  await assert.rejects(lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: 'stale' }), /подтверждение.*версии/);
  const edited = await lab.updateDraft(draft.id, originalHash, { settings: { maxTurns: 5 } });
  assert.notEqual(draftHash(edited), originalHash); assert.equal(edited.reviewedAt, null);
  await assert.rejects(lab.updateDraft(draft.id, originalHash, { settings: { maxTurns: 4 } }), /Черновик изменился/);
  await assert.rejects(lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: originalHash }), /подтверждение.*версии/);
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(edited) }); await lab.waitForIdle();
  const result = await lab.get(draft.id);
  assert.equal(result.phase, 'results_review', result.error ?? ''); assert.equal(result.reviewMode, 'human');
  assert.equal(result.revisions.length, 1); assert.equal(result.comparisons.length, 0);
  assert.equal(result.trials.length, 1); assert.ok(result.trials[0]!.assessments?.length);
  assert.equal(result.manifestHash, measurementHash(result));
  await assert.rejects(lab.updateDraft(draft.id, draftHash(result), { settings: { maxTurns: 4 } }), /незапущенный черновик/);
  const originalTrial = structuredClone(result.trials[0]!);
  const priorResultHash = resultHash(result);
  await assert.rejects(lab.addHumanReview(result.id, { trialId: 'missing', verdict: 'invalid', note: 'Wrong user.' }), /Такого диалога/);
  await assert.rejects(lab.addHumanReview(result.id, { trialId: originalTrial.id, metricId: 'missing', verdict: 'fail', note: 'Wrong metric.' }), /Такой рубрики/);
  // A whole-dialogue mark is not taken any more: nothing reads it, and a note is never parsed for event numbers.
  const marked = { trialId: originalTrial.id, verdict: 'fail', note: 'Reviewed #1.', reviewedDialogue: true } as unknown as HumanReviewInput;
  await assert.rejects(lab.addHumanReview(result.id, marked), /reviewedDialogue/);
  const annotated = await lab.addHumanReview(result.id, {
    trialId: originalTrial.id, metricId: result.scenarios[0]!.metrics![0]!.id, verdict: 'unknown', note: 'Need the real pilot before accepting this estimate.',
  });
  assert.deepEqual(annotated.trials[0], originalTrial); assert.equal(annotated.humanReviews!.length, 1);
  await assert.rejects(lab.reviewResults(result.id, priorResultHash), /Результаты изменились/);
  const reviewed = await lab.reviewResults(result.id, resultHash(annotated));
  assert.equal(reviewed.phase, 'complete'); assert.ok(reviewed.resultsReviewedAt); assert.equal(reviewed.resultsReviewHash, resultHash(annotated));
  const reopened = await lab.addHumanReview(result.id, { trialId: originalTrial.id, verdict: 'pass', note: 'Checked the stored action and transcript.' });
  assert.equal(reopened.phase, 'results_review'); assert.equal(reopened.resultsReviewedAt, undefined);
  assert.equal(reopened.humanReviews!.length, 2); assert.deepEqual(reopened.trials[0], originalTrial);
});

test('closing during a draft edit keeps the writer lock until the edit checkpoint finishes', async t => {
  const { lab, directory } = await setup(t);
  const input = demoInput(); input.workflow = 'evaluate'; input.scenarioCount = 1;
  const created = await lab.create(input); await lab.waitForIdle(); const draft = await lab.get(created.id);
  const entered = deferred(); const release = deferred(); const save = lab.store.save.bind(lab.store);
  lab.store.save = async record => { entered.resolve(); await release.promise; await save(record); };
  const editing = lab.updateDraft(draft.id, draftHash(draft), { settings: { repeats: 1 } });
  await entered.promise;
  await assert.rejects(lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }), /другая операция/);
  let closed = false; const closing = lab.close().then(() => { closed = true; });
  await assert.rejects(new ExperimentStore(directory).init(), /already open/); assert.equal(closed, false);
  release.resolve(); await editing; await closing;
  assert.equal((await lab.store.get(draft.id)).settings.repeats, 1);
  const next = new ExperimentStore(directory); await next.init(); await next.close();
});

test('approval reserves its draft while reading so a concurrent edit cannot be overwritten by a stale start snapshot', async t => {
  const { lab } = await setup(t, legacyDemoRuntime());
  const draft = await externalDraft(lab, { count: 1, settings: { repeats: 1 } });
  const entered = deferred(); const release = deferred();
  const get = lab.store.get.bind(lab.store); let first = true;
  lab.store.get = async id => {
    const snapshot = await get(id);
    if (first) { first = false; entered.resolve(); await release.promise; }
    return snapshot;
  };
  const starting = lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) });
  await entered.promise;
  try {
    await assert.rejects(lab.updateDraft(draft.id, draftHash(draft), { settings: { maxTurns: 5 } }), /другая операция/);
  } finally { release.resolve(); }
  await starting; await lab.waitForIdle();
  const result = await lab.get(draft.id);
  assert.equal(result.phase, 'results_review', result.error ?? '');
  assert.deepEqual(result.scenarios, draft.scenarios);
  assert.deepEqual(result.settings, draft.settings);
  assert.equal(result.trials.length, 1);
});

test('a large malformed assessor response preserves the completed trial with a persistable assessment error', async t => {
  const runtime: Runtime = { ...legacyDemoRuntime(), assess: async () => Array.from({ length: 8 }, () => ({})) as never };
  const { lab } = await setup(t, runtime);
  const draft = await externalDraft(lab, { count: 1, settings: { repeats: 1 }, target: appointmentAgent('createRepairedSession') });
  await runDraft(lab, draft, 'human');
  const saved = await lab.store.get(draft.id);
  assert.equal(saved.phase, 'results_review', saved.error ?? '');
  assert.equal(saved.trials.length, 1);
  assert.equal(saved.trials[0]!.outcome, 'pass');
  assert.equal(saved.trials[0]!.finalState.records.A101!.time, '14:00');
  assert.equal(saved.trials[0]!.assessments, undefined);
  assert.match(saved.trials[0]!.assessmentError!, /invalid_type/);
  assert.ok(saved.trials[0]!.assessmentError!.length <= 4000);
});

test('evaluation runs every user mode and skips scripted cards without a script', async t => {
  const { lab } = await setup(t, legacyDemoRuntime());
  const draft = await externalDraft(lab, { count: 3, settings: { repeats: 1, userModes: ['static', 'scripted', 'reactive'] } });
  const withScript = draft.scenarios.filter(s => s.user.script?.length).length;
  assert.ok(withScript >= 1 && withScript < draft.scenarios.length, `scripted cards: ${withScript}`);
  const result = await runDraft(lab, draft, 'human');
  assert.equal(result.phase, 'results_review', result.error ?? '');
  const byMode = (mode: string) => result.trials.filter(tr => tr.userMode === mode).length;
  assert.deepEqual([byMode('static'), byMode('scripted'), byMode('reactive')], [3, withScript, 3]);
  assert.ok(result.limitations.some(l => /Scripted mode skipped/.test(l)));
  assert.ok(result.trials.filter(tr => tr.userMode === 'static').every(tr => tr.events.filter(e => e.type === 'user').length === 1));
});

test('a missing target yields a recoverable explanation and a rejected connection edit leaves the draft intact', async t => {
  const { lab, directory } = await setup(t);
  const input = createInputSchema.parse({ ...demoInput(), workflow: 'evaluate', scenarioCount: 1, target: { kind: 'module', path: join(directory, 'missing.mjs') } });
  const created = await lab.create(input); await lab.waitForIdle();
  const failed = await lab.get(created.id);
  assert.equal(failed.phase, 'error'); assert.match(failed.error!, /Не найден файл агента/); assert.doesNotMatch(failed.error!, /ENOENT|stat '/);
  assert.equal(failed.usage.calls, 0);
  const next = await lab.create(createInputSchema.parse({ ...demoInput(), workflow: 'evaluate', scenarioCount: 1 })); await lab.waitForIdle();
  const draft = await lab.get(next.id);
  await assert.rejects(lab.updateDraft(draft.id, draftHash(draft), { target: runnableTarget(input.target) }), /Не найден файл агента/);
  assert.equal(draftHash(await lab.get(draft.id)), draftHash(draft));
});

test('repeat keeps the approved suite, discards results and requires fresh approval; target drift blocks execution', async t => {
  const { lab, directory } = await setup(t, legacyDemoRuntime());
  const path = join(directory, 'target.mjs');
  await writeFile(path, 'export function createSession() { return { respond: () => "hello" }; }');
  let draft = await externalDraft(lab, { count: 1, target: { kind: 'module', path, exportName: 'createSession' }, settings: { repeats: 1, userModes: ['static'] } },
    record => { record.targetVersion = 'v1'; });
  await assert.rejects(lab.repeat(draft.id), /утверждёнными/);
  await writeFile(path, 'export function createSession() { return { respond: () => "new answer" }; }');
  await assert.rejects(lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }), /изменил/);
  draft = await lab.updateDraft(draft.id, draftHash(draft), { targetVersion: 'v2' });
  const before = await runDraft(lab, draft, 'human');
  assert.equal(before.phase, 'results_review', before.error ?? '');
  const after = await lab.repeat(before.id);
  assert.notEqual(after.id, before.id); assert.equal(after.parentRunId, before.id);
  assert.deepEqual(after.scenarios, before.scenarios); assert.deepEqual(after.settings, before.settings);
  assert.deepEqual(after.trials, []); assert.deepEqual(after.humanReviews, []); assert.equal(after.reviewedAt, null);
  assert.equal(after.targetVersion, 'v2'); assert.equal(after.phase, 'review');
  assert.deepEqual((await lab.get(before.id)).trials, before.trials);
  await assert.rejects(lab.start(after.id, { approved: false, reviewer: 'automated', expectedHash: draftHash(after) }), /подтверждения/);
});

test('rubric-only agent failures reach clustering', async t => {
  const runtime: Runtime = { ...legacyDemoRuntime(),
    async assess({ scenario }) { return scenario.metrics!.map(m => ({ metricId: m.id, result: m.subject === 'agent' ? 'fail' as const : 'pass' as const, rationale: 'evidence', evidence: [0] })); },
    async failureModes({ failures }) { return [{ id: 'goal_failed', name: 'Цель не достигнута', description: 'Рубрика зафиксировала провал цели.', trialIds: failures.map(f => f.trialId) }]; },
  };
  const { lab } = await setup(t, runtime);
  const result = await runDraft(lab, await externalDraft(lab, { count: 1 }, draft => { draft.scenarios.forEach(s => { s.checks = []; }); }), 'human');
  assert.ok(result.trials.length > 0);
  assert.ok(result.trials.every(t => t.outcome === 'ungraded'));
  // A failure decided by the rubrics alone is a headline failure, so it is clustered like any other.
  assert.deepEqual(deriveRun(result).failedAttempts.map(t => t.id), result.trials.map(t => t.id));
  assert.deepEqual(result.failureModes?.[0]?.trialIds, result.trials.map(t => t.id));
});

test('a draft edit changes only run settings, the connection, its version or the agent label; anything else saves nothing', async t => {
  const { lab } = await setup(t, legacyDemoRuntime());
  const draft = await externalDraft(lab, { count: 2 });
  const hash = draftHash(draft);
  const saved = await lab.get(draft.id);
  for (const patch of [
    { scenarios: [{ ...draft.scenarios[0]!, title: 'Другая карточка' }] }, { removeScenarioIds: [draft.scenarios[0]!.id] },
    { profileEdits: [{ id: 'owner', override: null }] }, { settings: { repeats: 0 } }, { target: { kind: 'sandbox' } }, {},
  ]) {
    await assert.rejects(lab.updateDraft(draft.id, hash, patch as never));
    assert.deepEqual(await lab.get(draft.id), saved, 'a rejected edit saves nothing');
  }
  await assert.rejects(lab.updateDraft(draft.id, hash, { target: { kind: 'sandbox' } } as never), /Встроенная учебная песочница больше не запускается/);
  const agent = { name: 'Appointment assistant v2', instructions: 'Updated instructions.', tools: [] };
  const edited = await lab.updateDraft(draft.id, hash, { settings: { repeats: 2 }, targetVersion: 'v2', agent });
  assert.deepEqual(edited.scenarios, draft.scenarios, 'the situations are untouched');
  assert.equal(edited.settings.repeats, 2); assert.equal(edited.targetVersion, 'v2');
  assert.deepEqual(edited.revisions.map(revision => revision.spec), [agent]); assert.equal(edited.selectedRevisionId, edited.revisions[0]!.id);
  assert.equal(edited.reviewedAt, null); assert.equal(edited.manifestHash, null);
  await assert.rejects(lab.updateDraft(draft.id, hash, { settings: { repeats: 1 } }), /Черновик изменился/);
  assert.deepEqual(await lab.get(draft.id), edited);
});

test('finalizing requires decisive failure review and preserves original evidence', async t => {
  const { lab } = await setup(t, legacyDemoRuntime());
  let draft = await externalDraft(lab, { count: 2, settings: { repeats: 1 } });
  draft = await lab.updateDraft(draft.id, draftHash(draft), { agent: { ...draft.revisions[0]!.spec, tools: ['search_materials', 'lookup_record'] } });
  assert.deepEqual(draft.revisions[0]!.spec.tools, ['search_materials', 'lookup_record']);
  let result = await runDraft(lab, draft, 'human');
  const original = structuredClone(result.trials);
  assert.equal(awaitingVerdict(result).size, 2);
  await assert.rejects(lab.reviewResults(result.id, resultHash(result)), /2.*без решения/);
  result = await lab.addHumanReview(result.id, { trialId: result.trials[0]!.id, verdict: 'unknown', note: 'Нужен разбор.' });
  await assert.rejects(lab.reviewResults(result.id, resultHash(result)), /без решения/);
  for (const trial of result.trials) {
    for (const check of trial.checks.filter(c => !c.passed)) result = await lab.addHumanReview(result.id, { trialId: trial.id, checkId: check.id, verdict: 'fail', note: 'Проверено по состоянию.' });
    for (const assessment of trial.assessments?.filter(a => a.result === 'fail') ?? []) result = await lab.addHumanReview(result.id, { trialId: trial.id, metricId: assessment.metricId, verdict: 'fail', note: 'Проверено по трассе.' });
  }
  assert.equal(awaitingVerdict(result).size, 0);
  const completed = await lab.reviewResults(result.id, resultHash(result));
  assert.equal(completed.phase, 'complete');
  assert.deepEqual(completed.trials, original);
  const reopened = await lab.addHumanReview(result.id, { trialId: result.trials[0]!.id, checkId: result.trials[0]!.checks.find(c => !c.passed)!.id, verdict: 'unknown', note: 'Предыдущее решение пересмотрено.' });
  assert.equal(reopened.phase, 'results_review');
  await assert.rejects(lab.reviewResults(result.id, resultHash(reopened)), /без решения/);
});

test('invalid excludes partial simulator criteria and allows finalizing the audit', async t => {
  const { lab } = await setup(t, legacyDemoRuntime());
  const record = await runDraft(lab, await externalDraft(lab, { count: 1, settings: { userModes: ['reactive'], repeats: 1 } }));
  const trial = record.trials[0]!;
  const scenario = record.scenarios.find(candidate => candidate.id === trial.scenarioId)!;
  record.scenarios = [scenario]; record.trials = [trial]; record.humanReviews = [];
  scenario.metrics = [{ id: 'simulator_metric', name: 'Simulator metric', subject: 'simulator', description: 'd', passCriteria: 'p', failCriteria: 'f' }];
  trial.userMode = 'reactive'; trial.outcome = 'ungraded'; trial.checks = [];
  if (!trial.events.some(event => event.type === 'simulator')) trial.events.push({ seq: Math.max(...trial.events.map(event => event.seq)) + 1, type: 'simulator', text: 'reply' });
  trial.simulatorChecks = [{ id: 'simulator_loop', description: 'loop', passed: false, evidence: 'e', heuristic: false }];
  trial.assessments = [{ metricId: 'simulator_metric', result: 'fail', rationale: 'r', evidence: [trial.events[0]!.seq] }];
  await lab.store.save(record);
  const reasonOf = (run: Experiment) => buildResultView(run).cards.find(card => card.scenarioId === scenario.id)!.reason;
  assert.equal(deriveRun(record).attempt(trial.id)!.usable, false);
  assert.equal(reasonOf(record), 'simulator_deviated', 'the failed simulator criteria leave the situation unmeasured');
  let reviewed = await lab.addHumanReview(record.id, { trialId: trial.id, checkId: 'simulator_loop', verdict: 'invalid', note: 'ошибочна проверка' });
  reviewed = await lab.addHumanReview(record.id, { trialId: trial.id, metricId: 'simulator_metric', verdict: 'invalid', note: 'ошибочна рубрика' });
  assert.equal(simulatorUsable(scenario, trial, reviewed.humanReviews), true);
  assert.equal(awaitingVerdict(reviewed).size, 0);
  // No simulator flag is left: the attempt is a usable measurement again and no longer unmeasured for the simulator.
  assert.equal(deriveRun(reviewed).attempt(trial.id)!.usable, true);
  assert.ok(!['simulator_deviated', 'simulator_unclear'].includes(reasonOf(reviewed) ?? ''), reasonOf(reviewed));
  assert.equal((await lab.reviewResults(record.id, resultHash(reviewed))).phase, 'complete');
});

test('the active snapshot names the current card and target wait before a trial finishes', async t => {
  const entered = deferred(); const release = deferred();
  const grading = deferred(); const releaseGrading = deferred();
  const base = legacyDemoRuntime();
  const runtime: Runtime = { ...base, async assess(...args) { grading.resolve(); await releaseGrading.promise; return base.assess!(...args); } };
  const { lab } = await setup(t, runtime);
  // An HTTP agent that answers only when the test lets it: the run is caught while it waits for the reply.
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', async () => {
      const { initialState } = JSON.parse(body) as { initialState: { records: unknown } };
      entered.resolve(); await release.promise;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ reply: 'Ответ', records: initialState.records, resetConfirmed: true, eventsComplete: true }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); }));
  const { port } = server.address() as AddressInfo;
  const draft = await externalDraft(lab, { count: 1, settings: { repeats: 1 }, target: { kind: 'http', url: `http://127.0.0.1:${port}/agent`, headersEnv: {}, timeoutMs: 60000 } });
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) });
  await entered.promise;
  try {
    const active = await lab.get(draft.id);
    assert.equal(active.trials.length, 0);
    assert.ok(active.message.includes(draft.scenarios[0]!.title));
    assert.match(active.message, /диалог 1\/1.*ответ агента/);
    const journal = await lab.store.traceJournal(draft.id);
    assert.match(journal, /"type":"user"/);
    release.resolve(); await grading.promise;
    assert.match((await lab.get(draft.id)).message, /диалог 1\/1.*оценка критериев/);
  } finally { release.resolve(); releaseGrading.resolve(); await lab.waitForIdle(); }
});

test('static connection failures precede model work and a vanished target cannot receive approval', async t => {
  const { lab, directory } = await setup(t, createDemoRuntime());
  const entry = join(directory, 'agent.mjs'); await writeFile(entry, '// local target fixture');
  const input = createInputSchema.parse({ ...demoInput(), target: { kind: 'command', command: 'agent-lab-no-such-executable-fixture', args: [entry] } });
  const created = await lab.create(input); await lab.waitForIdle();
  const failed = await lab.get(created.id);
  assert.equal(failed.phase, 'error'); assert.equal(failed.usage.calls, 0); assert.equal(failed.trials.length, 0);
  const accepted = await acceptedDemoDraft(lab, createInputSchema.parse({ ...input, target: { kind: 'command', command: process.execPath, args: [entry], timeoutMs: 1000 } }));
  const draft = await lab.get(accepted.id); assert.equal(draft.phase, 'review');
  await rm(entry);
  await assert.rejects(lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }), /Не найден файл агента/);
  assert.deepEqual(await lab.get(draft.id), draft);
});

const stdioFixture = fileURLToPath(new URL('./fixtures/stdio-agent.mjs', import.meta.url));
function stdioTarget(release?: { command: string; args: string[] }, mode: 'ok' | 'external' = 'ok'): Target {
  return { kind: 'command', command: process.execPath, args: [stdioFixture, mode], timeoutMs: 5000, ...(release ? { release: { ...release, timeoutMs: 120000 } } : {}) };
}
const oneStaticCard = { count: 1, settings: { userModes: ['static' as const], repeats: 1 } };

test('the release hook runs once before the first dialogue with the run identity, and a failing hook stops the run', async t => {
  const { lab, directory } = await setup(t, legacyDemoRuntime());
  const marker = join(directory, 'deployed.txt');
  process.env.AGENT_LAB_MARKER = marker;
  t.after(() => { delete process.env.AGENT_LAB_MARKER; });
  const draft = await externalDraft(lab, { ...oneStaticCard, target: stdioTarget({ command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.env.AGENT_LAB_MARKER, process.env.AGENT_LAB_RUN_ID)'] }) });
  assert.equal(existsSync(marker), false, 'a draft and its preflight never run the hook');
  const record = await runDraft(lab, draft);
  assert.equal(record.phase, 'results_review', record.error ?? '');
  assert.equal(readFileSync(marker, 'utf8'), record.id);
  assert.equal(record.releaseLog?.exitCode, 0);
  const failed = await runDraft(lab, await externalDraft(lab, { ...oneStaticCard, target: stdioTarget({ command: process.execPath, args: ['-e', 'console.error("deploy failed"); process.exit(2)'] }) }));
  assert.equal(failed.phase, 'error');
  assert.match(failed.error ?? '', /Хук выпуска завершился с кодом 2/); assert.match(failed.error ?? '', /deploy failed/);
  assert.equal(failed.trials.length, 0, 'no dialogue runs against an undeployed version');
  assert.equal(failed.releaseLog?.exitCode, 2);
});

test('a single failed dialogue is clustered, and a cluster may quote only the agent prompt it was given', async t => {
  const prompts: (string | undefined)[] = [];
  let quotes = ['Read the appointment before changing it.'];
  const runtime: Runtime = { ...legacyDemoRuntime(), async failureModes(input) {
    prompts.push(input.prompt);
    return [{ id: 'no_update', name: 'Прочитал запись, но не изменил её', description: 'd', trialIds: [input.failures[0]!.trialId], promptQuotes: quotes }];
  } };
  const { lab } = await setup(t, runtime);
  // The agent's own prompt arrives as a material marked «промпт агента».
  const prompt = 'Consult appointment policy. Read the appointment before changing it. Update only the time field.';
  const run = async () => runDraft(lab, await externalDraft(lab, oneStaticCard, draft => {
    draft.sources.push({ id: 'source-2', name: 'Промпт агента', content: prompt, hash: fingerprint(prompt), kind: 'prompt' });
  }));
  const named = await run();
  assert.equal(named.trials.length, 1); assert.equal(named.trials[0]!.outcome, 'fail', named.trials[0]!.reason);
  assert.deepEqual(named.failureModes?.map(m => [m.name, m.promptQuotes]), [['Прочитал запись, но не изменил её', ['Read the appointment before changing it.']]]);
  assert.equal(prompts[0], prompt, 'an external agent is clustered against its own prompt');
  quotes = ['this sentence is not in the prompt'];
  const rejected = await run();
  assert.equal(rejected.phase, 'results_review');
  assert.equal(rejected.failureModes, undefined);
  assert.ok(rejected.limitations.some(l => /Не удалось назвать типы провалов/.test(l) && /дословно/.test(l)));
});

test('human verdicts may target simulator checks, reassessment recomputes them, and an unconfirmed external world is a run limitation', async t => {
  const { lab } = await setup(t, legacyDemoRuntime());
  const record = await runDraft(lab, await externalDraft(lab, { count: 3, settings: { userModes: ['reactive'], repeats: 1 } }));
  const clarified = record.trials.find(t => t.events.filter(e => e.type === 'user').length > 1)!;
  assert.ok(clarified.simulatorChecks!.length >= 2);
  await lab.addHumanReview(record.id, { trialId: clarified.id, checkId: 'simulator_loop', verdict: 'fail', note: 'looked like a loop to me' });
  await assert.rejects(lab.addHumanReview(record.id, { trialId: clarified.id, checkId: 'simulator_missing', verdict: 'fail', note: 'x' }), /проверки симулятора/);
  const get = lab.store.get.bind(lab.store);
  lab.store.get = async id => {
    const loaded = await get(id);
    if (id === record.id) loaded.trials.find(t => t.id === clarified.id)!.checks.push({ id: 'simulator_loop', description: 'legacy collision', passed: false, evidence: '' });
    return loaded;
  };
  await assert.rejects(lab.addHumanReview(record.id, { trialId: clarified.id, checkId: 'simulator_loop', verdict: 'pass', note: 'ambiguous legacy target' }), /неоднозначен/);
  lab.store.get = get;
  const reassessed = await lab.reassess(record.id, { codeOnly: true }); await lab.waitForIdle();
  const again = (await lab.get(reassessed.id)).trials.find(t => t.id === clarified.id)!;
  assert.deepEqual(again.simulatorChecks, clarified.simulatorChecks);
  // A code-only reassessment says so in a typed field next to its fixed sentence: the situation is «судья не оценивал».
  assert.deepEqual([again.assessmentFailure, again.assessmentError], ['code_only', CODE_ONLY_ASSESSMENT]);
  // A card that seeds the agent's own test environment: an adapter that does not confirm the reset leaves it unmeasured.
  const unconfirmed = await runDraft(lab, await externalDraft(lab, { ...oneStaticCard, target: stdioTarget(undefined, 'ok') }, draft => {
    draft.scenarios = [{ ...draft.scenarios[0]!, id: 'gold_cards', familyId: 'gold_cards', title: 'List my cards', requirementIds: [], provenance: 'curated',
      user: { goal: 'List my cards', facts: 'No additional facts beyond the opening request.', behavior: 'Ask once; finish when the request is answered.', opening: 'Which cards do I have?', maxFollowUps: 0 },
      initialState: { records: {}, writableFields: [], transientFailures: 0, external: { cards: [{ id: 'c1' }, { id: 'c2' }] } },
      checks: [], successCriteria: 'Two cards are listed', assumptions: [], metrics: [{ id: 'goal', name: 'Goal', subject: 'agent', description: 'd', passCriteria: 'p', failCriteria: 'f' }] }];
  }));
  assert.ok(unconfirmed.limitations.includes('Внешнее состояние карточек не подтверждено адаптером (resetConfirmed): проверки состояния не измерены.'), unconfirmed.limitations.join('\n'));
  assert.match(unconfirmed.trials.find(t => t.scenarioId === 'gold_cards')!.reason, /не подтверждено адаптером/);
  const repeated = await lab.repeat(unconfirmed.id);
  assert.ok(!repeated.limitations.some(l => l.startsWith('Внешнее состояние карточек')));
});

function agreeingJudgeRuntime(): Runtime {
  return {
    async assess(input, ctx) {
      return assessRepeated(input, { provider: 'offline', id: 'judge' }, ctx, async (_prompt, data) => {
        ctx.beforeCall();
        const parsed = JSON.parse(data) as { scenario: { metrics: { id: string }[] }; trial: { events: { seq: number; content: string }[] } };
        const quote = parsed.trial.events.find(event => event.seq === 1)!.content;
        return JSON.stringify({ assessments: parsed.scenario.metrics.map(metric => ({ metricId: metric.id, passCondition: 'met', failCondition: 'not_met',
          rationale: 'The reply is present in the trace.', evidence: [1], citations: [{ seq: 1, quote }] })) });
      });
    },
    async userTurn() { throw new Error('reassessment must not run the simulator'); },
  };
}

/** A recorded-dialogue run in the stored format of earlier releases, reassessed by the current judge: no migration step. */
async function scoredAndReassessed(lab: ExperimentLab) {
  const recorded = experimentSchema.parse(JSON.parse(await readFile(new URL('./fixtures/recorded-run.json', import.meta.url), 'utf8')));
  await lab.store.save(recorded);
  const pending = await lab.reassess(recorded.id); await lab.waitForIdle();
  const record = await lab.get(pending.id);
  assert.equal(record.phase, 'results_review', record.error ?? '');
  return record;
}

async function assertReceiptOnly(lab: ExperimentLab, directory: string, record: Experiment) {
  assert.equal(record.trials.length, 2);
  assert.ok(!JSON.stringify(record.trials).includes('judgeAudit'), 'a new record never carries the full judge audit');
  const journal = (await lab.store.traceJournal(record.id)).split('\n').filter(Boolean).map(line => JSON.parse(line) as { trialId: string; judgeAudit?: unknown });
  for (const trial of record.trials) {
    const scenario = record.scenarios.find(s => s.id === trial.scenarioId)!;
    assert.ok(trial.judgeReceipt, `${trial.id} carries a receipt`);
    assert.equal(trial.judgeAudit, undefined);
    assert.ok(trial.assessments?.length);
    assert.equal(trial.assessmentFailure, undefined, 'a judged trial carries no judgment failure');
    assert.equal(hasCompleteJudgment({ scenario, sources: observableSources(record.sources, record.requirements), trial }), true);
    assert.ok(existsSync(join(directory, `${record.id}.judge`, `${trial.id}.json`)));
    assert.equal(fingerprint(await lab.store.readJudgeAudit(record.id, trial.id)), trial.judgeReceipt.auditHash);
    assert.equal(journal.filter(line => line.trialId === trial.id && 'judgeAudit' in line).length, 1, 'one journal copy per finished judgment');
  }
}


test('reassessing a scored record writes sidecar audits, receipt-only trials and one journal line per judgment', async t => {
  const { lab, directory } = await setup(t, agreeingJudgeRuntime());
  const record = await scoredAndReassessed(lab);
  await assertReceiptOnly(lab, directory, record);
});

test('a record whose trials carry the legacy full audit reassesses without migration into receipt-only trials', async t => {
  const { lab, directory } = await setup(t, agreeingJudgeRuntime());
  const current = await scoredAndReassessed(lab);
  const legacy = structuredClone(current);
  legacy.id = randomUUID();
  for (const trial of legacy.trials) {
    const audit = await lab.store.readJudgeAudit(current.id, trial.id);
    assert.ok(audit);
    trial.judgeAudit = audit;
    delete trial.judgeReceipt;
  }
  await lab.store.save(legacy);
  const saved = await lab.get(legacy.id);
  assert.ok(saved.trials.every(trial => trial.judgeAudit && !trial.judgeReceipt));
  const scenario = (id: string) => saved.scenarios.find(s => s.id === id)!;
  assert.ok(saved.trials.every(trial => hasCompleteJudgment({ scenario: scenario(trial.scenarioId), sources: observableSources(saved.sources, saved.requirements), trial })),
    'the legacy full audit is still judged complete');

  const pending = await lab.reassess(legacy.id); await lab.waitForIdle();
  const reassessed = await lab.get(pending.id);
  assert.equal(reassessed.phase, 'results_review', reassessed.error ?? '');
  await assertReceiptOnly(lab, directory, reassessed);
  assert.deepEqual(await lab.get(legacy.id), saved, 'the legacy source record stays unchanged on disk');
});

test('a positive control rides on the record: hashes and card identity unchanged, inherited, and bad ids rejected before saving', async t => {
  const { lab, directory } = await setup(t, legacyDemoRuntime());
  const source = await runDraft(lab, await externalDraft(lab, { count: 2 }));
  assert.equal(source.phase, 'results_review', source.error ?? '');
  const [a, b] = source.scenarios.map(scenario => scenario.id) as [string, string];

  // A record without the field keeps the exact hash it had before the field existed.
  assert.equal(source.positiveControlScenarioIds, undefined);
  assert.equal(draftHash(source), draftHash({ ...source, positiveControlScenarioIds: undefined }));
  const stored = JSON.parse(await readFile(join(directory, `${source.id}.json`), 'utf8'));
  assert.equal('positiveControlScenarioIds' in stored, false);
  const legacy = experimentSchema.parse(stored);
  assert.equal(draftHash(legacy), draftHash(source), 'an old record without the field parses and keeps its hash');
  const unknownControl = experimentSchema.safeParse({ ...stored, positiveControlScenarioIds: ['missing'] });
  assert.equal(unknownControl.success, false);
  assert.ok(unknownControl.error?.issues.some(issue => issue.message === 'Контрольная ситуация должна быть из этого набора.'));
  assert.equal(experimentSchema.safeParse({ ...stored, positiveControlScenarioIds: [a, a] }).success, false);

  const saved = (await lab.store.list()).length;
  await assert.rejects(lab.repeat(source.id, undefined, ['missing']), /Контрольная ситуация должна быть из этого набора: missing\./);
  await assert.rejects(lab.repeat(source.id, undefined, [a, a]), /Контрольных ситуаций может быть от 1 до 5, без повторов\./);
  await assert.rejects(lab.repeat(source.id, undefined, []), /от 1 до 5/);
  await assert.rejects(lab.repeat(source.id, [a], [b]), /из этого набора: /, 'a control that the case filter drops is not silently lost');
  assert.equal((await lab.store.list()).length, saved, 'nothing is saved on a rejected control');

  const sourceHash = draftHash(await lab.get(source.id));
  const controlled = await lab.repeat(source.id, undefined, [a]);
  assert.deepEqual(controlled.positiveControlScenarioIds, [a]);
  // The marker rides on the record only: every card, the control's included, stays the accepted one;
  // the one-turn rule applies when the control runs.
  assert.deepEqual(controlled.scenarios, (await lab.repeat(source.id)).scenarios, 'no card changes, the control included');
  assert.equal(draftHash(await lab.get(source.id)), sourceHash, 'the stored source keeps its draft hash');
  // A control leaves the headline denominator, so two runs with different control sets did not
  // measure the same thing; the manifest hash is the record's own claim that they did.
  assert.notEqual(measurementHash(controlled), measurementHash({ ...controlled, positiveControlScenarioIds: undefined }),
    'the manifest sees the control set');
  assert.equal(measurementHash(source), measurementHash({ ...source, positiveControlScenarioIds: undefined }),
    'an old record without the field keeps the manifest hash it had before the field existed');
  assert.notEqual(draftHash(controlled), draftHash({ ...controlled, positiveControlScenarioIds: undefined }), 'the draft hash sees the marker');

  await lab.start(controlled.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(controlled) }); await lab.waitForIdle();
  const ran = await lab.get(controlled.id);
  assert.equal(ran.phase, 'results_review', ran.error ?? '');
  assert.deepEqual(ran.positiveControlScenarioIds, [a]);
  const controlCard = ran.scenarios.find(s => s.id === a)!;
  const controlTrials = ran.trials.filter(trial => trial.scenarioId === a);
  assert.ok(controlTrials.length);
  for (const trial of controlTrials) {
    assert.equal(trial.events.filter(event => event.type === 'simulator').length, 0, 'the control never reaches the simulator');
    assert.equal(trial.events.filter(event => event.type === 'assistant').length, 1, 'the control is the opening and one reply');
    const fidelity = controlCard.metrics?.find(metric => metric.id === 'user_fidelity');
    if (fidelity) assert.equal(metricApplies(fidelity, trial), false);
  }
  const diff = compareRuns(source, ran);
  assert.equal(diff.comparable, true, diff.notes.join(' '));
  assert.ok(diff.notes.every(note => !note.startsWith('Содержимое карточек изменилось') && !note.startsWith('Набор карточек изменился')), diff.notes.join(' '));
  assert.ok(diff.notes.includes('Контрольные ситуации не сравниваются: они не входят в главное число.'));
  assert.equal(diff.cards.shared, source.scenarios.length - 1);
  assert.ok([...diff.pairs, ...diff.incomparable].every(row => row.scenarioId !== a), 'the control is not a pair of the diff');

  // Inheritance: repeat, reassess, save and load keep the marker; a case filter that drops it removes the field.
  assert.deepEqual((await lab.repeat(ran.id)).positiveControlScenarioIds, [a]);
  const reassessed = await lab.reassess(ran.id, { codeOnly: true }); await lab.waitForIdle();
  assert.deepEqual((await lab.get(reassessed.id)).positiveControlScenarioIds, [a]);
  assert.deepEqual((await lab.get(reassessed.id)).scenarios, ran.scenarios, 'reassessment never transforms the cards again');
  const suite = await lab.saveSuite(reassessed.id, join(directory, 'control-suite.json'));
  const loaded = await lab.loadSuite(suite);
  assert.deepEqual(loaded.positiveControlScenarioIds, [a]);
  // A suite whose control card allows follow-ups loads unchanged: the control still runs as one turn.
  const plainSuite = JSON.parse(await readFile(await lab.saveSuite(source.id, join(directory, 'plain-suite.json')), 'utf8'));
  plainSuite.definition.positiveControlScenarioIds = [a];
  plainSuite.definition.scenarios.find((s: { id: string }) => s.id === a).user.maxFollowUps = 5;
  const multiTurn = join(directory, 'multi-turn-control-suite.json');
  await writeFile(multiTurn, JSON.stringify(plainSuite), { mode: 0o600 });
  const oneTurn = await lab.loadSuite(multiTurn);
  assert.deepEqual(oneTurn.positiveControlScenarioIds, [a]);
  assert.equal(oneTurn.scenarios.find(s => s.id === a)!.user.maxFollowUps, 5);
  const oneTurnRun = await runDraft(lab, oneTurn);
  assert.equal(oneTurnRun.phase, 'results_review', oneTurnRun.error ?? '');
  for (const trial of oneTurnRun.trials.filter(item => item.scenarioId === a)) {
    assert.equal(trial.events.filter(event => event.type === 'assistant').length, 1, 'a control is the opening and one reply whatever its card allows');
  }
  const narrowed = await lab.repeat(ran.id, [b]);
  assert.equal('positiveControlScenarioIds' in narrowed, false);
  assert.deepEqual((await lab.repeat(ran.id, [a])).positiveControlScenarioIds, [a]);
});


test('a library run repeats with a positive control: the accepted cards stay as accepted and the control is the opening and one reply', async t => {
  const { lab } = await setup(t, createDemoRuntime());
  const accepted = await acceptedDemoDraft(lab);
  await lab.start(accepted.id, { approved: true, expectedHash: draftHash(accepted) }); await lab.waitForIdle();
  const source = await lab.get(accepted.id);
  assert.equal(source.phase, 'results_review', source.error ?? '');
  const userTurns = (trial: Experiment['trials'][number]) => trial.events.filter(event => event.type === 'user').map(event => event.text);
  const control = source.scenarios.find(card => source.trials.some(trial => trial.scenarioId === card.id && userTurns(trial).length > 1))!;
  assert.ok(control, 'the demo has a card whose dialogue goes past its opening');
  // Before the fix the control card was rewritten to one turn and the draft no longer matched the accepted library.
  const repeated = await lab.repeat(source.id, undefined, [control.id]);
  assert.deepEqual(repeated.positiveControlScenarioIds, [control.id]);
  assert.deepEqual(repeated.scenarios, source.scenarios, 'no card is rewritten for a control');
  await lab.start(repeated.id, { approved: true, expectedHash: draftHash(repeated) }); await lab.waitForIdle();
  const ran = await lab.get(repeated.id);
  assert.equal(ran.phase, 'results_review', ran.error ?? '');
  const controlTrials = ran.trials.filter(trial => trial.scenarioId === control.id);
  assert.ok(controlTrials.length);
  for (const trial of controlTrials) {
    assert.deepEqual(userTurns(trial), [control.user.opening]);
    assert.equal(trial.events.filter(event => event.type === 'assistant').length, 1);
    assert.equal(trial.events.filter(event => event.type === 'simulator').length, 0, 'the controller is never asked');
  }
  for (const trial of ran.trials.filter(item => item.scenarioId !== control.id)) {
    const before = source.trials.find(item => item.scenarioId === trial.scenarioId && item.repeat === trial.repeat)!;
    assert.deepEqual(userTurns(trial), userTurns(before), 'a counted card runs its path as before');
  }
});

/**
 * A finished one-card run whose goal rubric the judge decided, with a sealed receipt on the trial.
 * `judge: 'audit'` keeps the legacy full audit instead; `judge: 'none'` leaves the trial unjudged
 * (the demo path), so the lab has no version to record. `rules` is the recorded prompt_compliance
 * result: with `goal` it decides which metrics a quick mark may land on (03.1 markTargets).
 */
async function agreementRecord(lab: ExperimentLab, goal: 'pass' | 'fail' | 'unknown' = 'fail', judge: 'receipt' | 'audit' | 'none' = 'receipt', rules: 'pass' | 'fail' | 'unknown' = 'pass') {
  const record = await runDraft(lab, await externalDraft(lab, { count: 1, settings: { userModes: ['reactive'], repeats: 1 } }));
  const trial = record.trials[0]!;
  const scenario = record.scenarios.find(candidate => candidate.id === trial.scenarioId)!;
  record.scenarios = [scenario]; record.trials = [trial]; record.humanReviews = [];
  const criterion = (id: string) => ({ id, name: id, subject: 'agent' as const, description: 'd', passCriteria: 'p', failCriteria: 'f' });
  scenario.metrics = [criterion('goal_attainment'), criterion('prompt_compliance')];
  trial.checks = [];
  const seq = trial.events[0]!.seq;
  trial.assessments = [
    { metricId: 'goal_attainment', result: goal, rationale: 'r', evidence: goal === 'unknown' ? [] : [seq] },
    { metricId: 'prompt_compliance', result: rules, rationale: 'r', evidence: rules === 'unknown' ? [] : [seq] },
  ];
  delete trial.judgeReceipt; delete trial.judgeAudit;
  if (judge === 'receipt') {
    trial.judgeReceipt = { protocolHash: 'protocol-10', inputHash: 'input-1', provider: 'openrouter', model: 'judge',
      auditHash: 'audit-1', votes: [{ metricId: 'goal_attainment', result: goal }, { metricId: 'prompt_compliance', result: rules }], notApplicable: [], complete: true };
  }
  if (judge === 'audit') {
    trial.judgeAudit = { protocolHash: 'protocol-10', inputHash: 'input-1', provider: 'openrouter', model: 'judge',
      prompt: 'p', input: 'i', attempts: [{ startedAt: 'now', assessments: trial.assessments }], notApplicable: [] };
  }
  await lab.store.save(record);
  return { record, trial, scenario };
}

test('the lab, not the caller, records which judgment a quick mark refers to', async t => {
  const { lab } = await setup(t, legacyDemoRuntime());
  const { record, trial } = await agreementRecord(lab, 'fail');
  const before = await lab.get(record.id);
  const measured = measurementHash(before);
  const results = resultHash(before);

  await assert.rejects(lab.addHumanReview(record.id, { trialId: trial.id, metricId: 'prompt_compliance', source: 'quick', verdict: 'fail', note: 'не та оценка' }),
    /^Error: Отметку согласия можно поставить только на оценку, из-за которой ситуация решена\.$/);
  await assert.rejects(lab.addHumanReview(record.id, { trialId: trial.id, metricId: 'goal_attainment', source: 'quick', verdict: 'pass', judgeVerdict: 'pass', note: 'судья менялся' }),
    /^Error: Оценка судьи изменилась, пока вы смотрели\. Проверьте ситуацию ещё раз\.$/);

  const saved = await lab.addHumanReview(record.id, { trialId: trial.id, metricId: 'goal_attainment', source: 'quick', verdict: 'fail',
    judge: { protocolHash: 'подделка', inputHash: 'подделка' }, note: 'Согласен с судьёй.', durationMs: 1200 });
  const mark = saved.humanReviews.at(-1)!;
  assert.equal(mark.source, 'quick');
  assert.equal(mark.judgeVerdict, 'fail', 'the recorded judge result, not the caller value');
  assert.deepEqual(mark.judge, { protocolHash: 'protocol-10', inputHash: 'input-1' }, 'a forged judge version is replaced by the trial receipt');
  assert.equal(mark.durationMs, 1200);
  assert.equal(saved.phase, 'results_review');
  assert.equal(measurementHash(saved), measured, 'a mark never changes what was measured');
  assert.notEqual(resultHash(saved), results, 'a mark does change the result');

  const plain = await lab.addHumanReview(record.id, { trialId: trial.id, metricId: 'prompt_compliance', verdict: 'fail', note: 'обычный разбор' });
  const second = plain.humanReviews.at(-1)!;
  assert.equal(second.source, undefined, 'a full review is not an agreement mark');
  assert.equal(second.judgeVerdict, 'pass', 'every metric review keeps the judgment it argues with');
  assert.deepEqual(second.judge, { protocolHash: 'protocol-10', inputHash: 'input-1' });
});

test('a mark takes its judge version from the legacy audit, and none when the trial was never judged', async t => {
  const { lab } = await setup(t, legacyDemoRuntime());
  const audited = await agreementRecord(lab, 'fail', 'audit');
  const withAudit = await lab.addHumanReview(audited.record.id, { trialId: audited.trial.id, metricId: 'goal_attainment', source: 'quick', verdict: 'pass', note: 'Не согласен.' });
  assert.deepEqual(withAudit.humanReviews.at(-1)!.judge, { protocolHash: 'protocol-10', inputHash: 'input-1' });

  const bare = await agreementRecord(lab, 'fail', 'none');
  const withoutJudge = await lab.addHumanReview(bare.record.id, { trialId: bare.trial.id, metricId: 'goal_attainment', source: 'quick', verdict: 'fail',
    judge: { protocolHash: 'выдумка', inputHash: 'выдумка' }, note: 'Согласен.' });
  const mark = withoutJudge.humanReviews.at(-1)!;
  assert.equal('judge' in mark, false, 'no receipt and no audit means no judge version to store');
  assert.equal(mark.judgeVerdict, 'fail');
});

test('a quick mark on a judgment the judge never made is refused', async t => {
  const { lab } = await setup(t, legacyDemoRuntime());
  const { record, trial } = await agreementRecord(lab, 'unknown');
  await assert.rejects(lab.addHumanReview(record.id, { trialId: trial.id, metricId: 'goal_attainment', source: 'quick', verdict: 'fail', note: 'соглашаться не с чем' }),
    /^Error: Судья не вынес решения по этой ситуации — соглашаться не с чем\.$/);
  // The same undecided rubric still takes a full human verdict: only the one-key answer needs a judgment.
  const reviewed = await lab.addHumanReview(record.id, { trialId: trial.id, metricId: 'goal_attainment', verdict: 'fail', note: 'разобрал сам' });
  assert.equal(reviewed.humanReviews.at(-1)!.judgeVerdict, 'unknown');
});

test('a double failure needs a stamped mark on both metrics before it counts once in «Согласие с судьёй»', async t => {
  const { lab, directory } = await setup(t, legacyDemoRuntime());
  const { record, trial } = await agreementRecord(lab, 'fail', 'receipt', 'fail');

  // The lab stamps the counting rule; a caller value is overwritten, never trusted (CTX-20, CTX-23).
  const first = await lab.addHumanReview(record.id, { trialId: trial.id, metricId: 'goal_attainment', source: 'quick', verdict: 'fail', judgeVerdict: 'fail',
    countingRules: 'goal-v1', note: 'Быстрая отметка: согласен с судьёй.' });
  assert.equal(first.humanReviews.at(-1)!.countingRules, COUNTING_RULES, 'the lab fills the counting rule and overwrites the caller value');
  const half = judgeAgreement(first);
  assert.equal(half.checked, 0, 'one mark on a double failure is not a checked situation (CR-02)');
  assert.deepEqual(half.unmarked, [trial.id], 'the situation stays in the queue until its second metric is answered');
  assert.deepEqual(half.marks, [], 'a half-answered situation has no mark to show');
  assert.ok(trustParts(buildResultView(first)).includes('судью ещё не проверяли'), trustParts(buildResultView(first)).join(' · '));

  const second = await lab.addHumanReview(record.id, { trialId: trial.id, metricId: 'prompt_compliance', source: 'quick', verdict: 'fail', judgeVerdict: 'fail', note: 'Быстрая отметка: согласен с судьёй.' });
  assert.equal(second.humanReviews.at(-1)!.countingRules, COUNTING_RULES);
  const whole = judgeAgreement(second);
  assert.deepEqual([whole.checked, whole.agreed, whole.unsure, whole.stale, whole.staleRule], [1, 1, 0, 0, 0]);
  assert.deepEqual(whole.failures, { agreed: 1, checked: 1 });
  assert.deepEqual(whole.unmarked, []);
  assert.deepEqual(whole.marks.map(item => [item.trialId, item.answer, item.judge, item.targets]), [[trial.id, 'agree', 'fail',
    [{ metricId: 'goal_attainment', answer: 'agree' }, { metricId: 'prompt_compliance', answer: 'agree' }]]]);
  assert.ok(trustParts(buildResultView(second)).includes('с судьёй согласны 1 из 1'), trustParts(buildResultView(second)).join(' · '));

  // The stamps survive a reload through the strict schema in a fresh lab on the same directory.
  await lab.close();
  const reopened = new ExperimentLab(directory, legacyDemoRuntime());
  await reopened.init();
  try {
    const loaded = await reopened.get(record.id);
    assert.deepEqual(loaded.humanReviews.map(item => [item.metricId, item.countingRules]), [['goal_attainment', COUNTING_RULES], ['prompt_compliance', COUNTING_RULES]]);
    assert.equal(judgeAgreement(loaded).checked, 1);
  } finally { await reopened.close(); }
});

test('a quick mark lands only on a metric that decided the situation: one failed metric is one target, a pass has two', async t => {
  const { lab } = await setup(t, legacyDemoRuntime());
  // Goal fail + rules pass: the rules did not fail the situation, so they take no mark; the goal does.
  const goalOnly = await agreementRecord(lab, 'fail', 'receipt', 'pass');
  await assert.rejects(lab.addHumanReview(goalOnly.record.id, { trialId: goalOnly.trial.id, metricId: 'prompt_compliance', source: 'quick', verdict: 'pass', note: 'не та оценка' }),
    /^Error: Отметку согласия можно поставить только на оценку, из-за которой ситуация решена\.$/);
  const marked = await lab.addHumanReview(goalOnly.record.id, { trialId: goalOnly.trial.id, metricId: 'goal_attainment', source: 'quick', verdict: 'fail', note: 'согласен' });
  assert.equal(marked.humanReviews.at(-1)!.countingRules, COUNTING_RULES);
  assert.equal(judgeAgreement(marked).checked, 1, 'a goal-only failure is checked by its one mark');

  // Goal pass + rules pass: a two-metric pass has two targets (CTX-25).
  const passed = await agreementRecord(lab, 'pass', 'receipt', 'pass');
  const onGoal = await lab.addHumanReview(passed.record.id, { trialId: passed.trial.id, metricId: 'goal_attainment', source: 'quick', verdict: 'pass', note: 'согласен' });
  assert.equal(judgeAgreement(onGoal).checked, 0, 'a pass with two targets is not checked by one mark');
  const onBoth = await lab.addHumanReview(passed.record.id, { trialId: passed.trial.id, metricId: 'prompt_compliance', source: 'quick', verdict: 'pass', note: 'согласен' });
  assert.deepEqual([judgeAgreement(onBoth).checked, judgeAgreement(onBoth).passes], [1, { agreed: 1, checked: 1 }]);

  // Goal unknown + rules unknown: nothing was decided, so there is nothing to agree with.
  const undecided = await agreementRecord(lab, 'unknown', 'receipt', 'unknown');
  await assert.rejects(lab.addHumanReview(undecided.record.id, { trialId: undecided.trial.id, metricId: 'prompt_compliance', source: 'quick', verdict: 'fail', note: 'нечего' }),
    /^Error: Судья не вынес решения по этой ситуации — соглашаться не с чем\.$/);
});

test('the lab refuses a quick mark where the number cannot move: an unmeasured situation or a control', async t => {
  const { lab } = await setup(t, legacyDemoRuntime());
  const unmeasured = /^Error: Эта ситуация не измерена — отметка согласия не нужна\.$/;
  // A judge error leaves the situation «не измерено» whatever the recorded rubric says (CR-01).
  const errored = await agreementRecord(lab, 'fail', 'receipt', 'fail');
  const withError = await lab.get(errored.record.id);
  withError.trials[0]!.assessmentError = 'судья не ответил';
  await lab.store.save(withError);
  await assert.rejects(lab.addHumanReview(errored.record.id, { trialId: errored.trial.id, metricId: 'goal_attainment', source: 'quick', verdict: 'fail', note: 'согласен' }), unmeasured);
  assert.deepEqual(judgeAgreement(await lab.get(errored.record.id)).queueFailures, [], 'an unmeasured failure is not queued either');

  // A dialogue the owner marked invalid is out of the measurement, so a quick mark on it is refused.
  const invalid = await agreementRecord(lab, 'fail', 'receipt', 'fail');
  await lab.addHumanReview(invalid.record.id, { trialId: invalid.trial.id, verdict: 'invalid', note: 'невалидный тест' });
  await assert.rejects(lab.addHumanReview(invalid.record.id, { trialId: invalid.trial.id, metricId: 'goal_attainment', source: 'quick', verdict: 'fail', note: 'согласен' }), unmeasured);

  // A positive control never enters the agreement, so the lab refuses the mark instead of storing an invisible one (WR-03).
  const control = await agreementRecord(lab, 'fail', 'receipt', 'fail');
  const withControl = await lab.get(control.record.id);
  withControl.positiveControlScenarioIds = [control.scenario.id];
  await lab.store.save(withControl);
  await assert.rejects(lab.addHumanReview(control.record.id, { trialId: control.trial.id, metricId: 'goal_attainment', source: 'quick', verdict: 'fail', note: 'согласен' }),
    /^Error: Контрольная ситуация — в согласие с судьёй не входит\.$/);
});

test('a changed judge verdict is still refused, and a full review never keeps a caller counting rule', async t => {
  const { lab } = await setup(t, legacyDemoRuntime());
  const { record, trial } = await agreementRecord(lab, 'fail', 'receipt', 'fail');
  await assert.rejects(lab.addHumanReview(record.id, { trialId: trial.id, metricId: 'prompt_compliance', source: 'quick', verdict: 'pass', judgeVerdict: 'pass', note: 'судья менялся' }),
    /^Error: Оценка судьи изменилась, пока вы смотрели\. Проверьте ситуацию ещё раз\.$/);
  const full = await lab.addHumanReview(record.id, { trialId: trial.id, metricId: 'prompt_compliance', verdict: 'pass', countingRules: COUNTING_RULES, note: 'разобрал сам' });
  const review = full.humanReviews.at(-1)!;
  assert.equal(review.source, undefined);
  assert.equal('countingRules' in review, false, 'the counting rule is a property of quick marks only');
  const dialogue = await lab.addHumanReview(record.id, { trialId: trial.id, verdict: 'pass', countingRules: 'goal-v1', note: 'весь диалог' });
  assert.equal('countingRules' in dialogue.humanReviews.at(-1)!, false);
});
test('a run may drive several dialogues at once: their trace events interleave, while the default keeps them one after another', async t => {
  // In the parallel run each dialogue's first simulator call waits until all three dialogues have reached it; once
  // the gate opens, the three resume together and their trace events interleave for certain instead of by timing.
  // Every card allows one follow-up, so every dialogue asks the simulator once (the demo's own cards end two of them
  // after the first reply). If the run stopped honouring `parallel`, the waiting dialogue would go on alone after
  // the safety timeout and the assertion below would fail instead of hanging.
  let gate: { arrived: Set<string>; open: () => void; opened: Promise<void> } | undefined;
  const base = legacyDemoRuntime();
  const runtime: Runtime = { ...base, async userTurn(input, ctx) {
    if (gate && input.turn === 0) {
      gate.arrived.add(input.user.goal);
      if (gate.arrived.size === 3) gate.open();
      // An unreferenced timer: once the gate opens, it keeps nothing alive.
      await Promise.race([gate.opened, delay(5000, undefined, { ref: false })]);
    }
    return base.userTurn!(input, ctx);
  } };
  const { lab } = await setup(t, runtime);
  const oneFollowUp = (draft: Experiment) => {
    draft.scenarios = draft.scenarios.map(scenario => ({ ...scenario, user: { ...scenario.user, maxFollowUps: Math.max(1, scenario.user.maxFollowUps ?? 0) } }));
  };
  const order = async (parallel: number | undefined) => {
    const result = await runDraft(lab, await externalDraft(lab, {}, oneFollowUp), 'automated', parallel);
    assert.equal(result.phase, 'results_review', result.error ?? result.message); assert.equal(result.trials.length, 3);
    const journal = (await lab.store.traceJournal(result.id)).trim().split('\n').map(line => JSON.parse(line).trialId as string);
    // How many times the journal switches from one dialogue to another: 2 when dialogues run one after another, more when they overlap.
    return journal.filter((id, i) => i > 0 && journal[i - 1] !== id).length;
  };
  assert.equal(await order(undefined), 2);
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  gate = { arrived: new Set(), open, opened };
  assert.ok(await order(3) > 2, 'three parallel dialogues must interleave their traces');
});

test('a stored run of old-format cards repeats on a new agent version through the free user simulator', async t => {
  const users: string[] = [];
  const base = legacyDemoRuntime();
  const runtime: Runtime = { ...base, async userTurn(input, ctx) { users.push(input.user.goal); return base.userTurn!(input, ctx); } };
  const { lab } = await setup(t, runtime);
  // A finished run recorded before the scenario library, stored like the owner's real runs: cards without an
  // `execution` block, the free LLM user, an external agent.
  const stored = experimentSchema.parse({ ...JSON.parse(await readFile(new URL('./fixtures/legacy-demo-run.json', import.meta.url), 'utf8')), target: appointmentAgent() });
  assert.equal(stored.phase, 'results_review');
  assert.ok(stored.scenarios.length >= 2 && stored.scenarios.every(scenario => !scenario.execution));
  await lab.store.save(stored);
  const storedBytes = JSON.stringify(await lab.get(stored.id));

  const draft = await lab.repeat(stored.id);
  assert.equal(draft.parentRunId, stored.id); assert.equal(draft.phase, 'review');
  assert.deepEqual(draft.scenarios.map(scenario => scenario.id), stored.scenarios.map(scenario => scenario.id));
  assert.ok(draft.scenarios.every(scenario => !scenario.execution && scenario.goalObservation === 'reply'), 'an external agent is judged on its replies by default');
  const baseline = await runDraft(lab, draft, 'human');
  assert.equal(baseline.phase, 'results_review', baseline.error ?? '');
  assert.equal(baseline.trials.length, stored.trials.length);
  assert.deepEqual(baseline.trials.map(trial => trial.outcome), ['fail', 'fail'], 'the recorded agent still cannot move an appointment');
  assert.ok(baseline.trials.every(trial => trial.assessments?.length && !trial.assessmentError), 'every dialogue is judged');
  const followUp = baseline.trials.find(trial => trial.events.some(event => event.type === 'simulator'));
  assert.ok(followUp, 'the free user simulator answered the agent');
  assert.ok(users.length > 0);
  assert.ok(followUp.events.filter(event => event.type === 'user').length > 1);
  assert.equal(JSON.stringify(await lab.get(stored.id)), storedBytes, 'the stored run stays as it was');

  // The same cards against the repaired version of the agent.
  const next = await lab.repeat(baseline.id);
  const repaired = await lab.updateDraft(next.id, draftHash(next), { target: runnableTarget(appointmentAgent('createRepairedSession')), targetVersion: 'repaired-v2' });
  const fixed = await runDraft(lab, repaired, 'human');
  assert.equal(fixed.phase, 'results_review', fixed.error ?? '');
  assert.equal(fixed.targetVersion, 'repaired-v2');
  assert.deepEqual(fixed.trials.map(trial => trial.outcome), ['pass', 'pass']);
  assert.ok(fixed.trials.every(trial => trial.checks.every(check => check.passed)));
  assert.deepEqual([headlineOf(fixed).passed, headlineOf(fixed).decided], [2, 2]);
});

test('HN-4: a reassessment that cannot grade the saved facts names the measurement; a judge failure after grading names the judge', async t => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/legacy-demo-run.json', import.meta.url), 'utf8')) as Experiment;
  // An external agent's attempts stored without an observation block: reassessment reads them as state missing, tools partial.
  const ungradable = experimentSchema.parse({ ...fixture, id: randomUUID(), target: appointmentAgent(),
    trials: fixture.trials.map(({ observation: _observation, ...trial }) => trial) });
  const { lab } = await setup(t);
  await lab.store.save(ungradable);
  const pending = await lab.reassess(ungradable.id, { codeOnly: true }); await lab.waitForIdle();
  const refused = await lab.get(pending.id);
  assert.equal(refused.phase, 'results_review', refused.error ?? '');
  assert.deepEqual(refused.trials.map(trial => [trial.outcome, trial.invalidCause]), [['invalid', 'measurement'], ['invalid', 'measurement']]);
  assert.deepEqual(deriveRun(refused).situations.map(item => [item.outcome, item.reason]), [['unknown', 'measurement_error'], ['unknown', 'measurement_error']],
    'the agent was not even called: never «агент не ответил»');

  // Cards without exact checks, judged again by a judge that does not answer: the graded outcome stays, the judge is named.
  const judgeless: Runtime = { async assess() { throw new Error('Pi provider response incomplete: rate limit'); } };
  const { lab: judged } = await setup(t, judgeless);
  const unchecked = experimentSchema.parse({ ...fixture, id: randomUUID(), scenarios: fixture.scenarios.map(scenario => ({ ...scenario, checks: [] })),
    trials: fixture.trials.map(trial => ({ ...trial, checks: [] })) });
  await judged.store.save(unchecked);
  const again = await judged.reassess(unchecked.id); await judged.waitForIdle();
  const result = await judged.get(again.id);
  assert.equal(result.phase, 'results_review', result.error ?? '');
  // The recorded dialogues failed in execution (the preserved outcome); the judge failure never turns them into «не ответил».
  assert.deepEqual(result.trials.map(trial => [trial.outcome, trial.invalidCause, trial.assessmentFailure]), [['fail', undefined, 'unavailable'], ['fail', undefined, 'unavailable']]);
  assert.deepEqual(deriveRun(result).situations.map(item => item.reason), ['judge_unavailable', 'judge_unavailable']);
});

test('a retired sandbox or compare record opens and reassesses but never runs again, and a new draft cannot name the sandbox', async t => {
  const parsed = createInputSchema.safeParse({ ...demoInput(), target: { kind: 'sandbox' } });
  assert.equal(parsed.success, false);
  assert.ok(parsed.error?.issues.some(issue => issue.message === SANDBOX_RETIRED), JSON.stringify(parsed.error?.issues));
  const { lab, directory, record } = await demoEvaluateRecord('agent-lab-retired-');
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(record.target.kind, 'sandbox'); assert.equal(record.phase, 'results_review');
  await assert.rejects(lab.repeat(record.id), { message: SANDBOX_RETIRED });
  // A sandbox draft saved before the retirement stays readable; starting it explains why it cannot run.
  const sandboxDraft = await externalDraft(lab, { count: 1 }, draft => { draft.target = { kind: 'sandbox' }; delete draft.targetFingerprint; });
  await assert.rejects(lab.start(sandboxDraft.id, { approved: true, expectedHash: draftHash(sandboxDraft) }), { message: SANDBOX_RETIRED });
  assert.deepEqual(await lab.get(sandboxDraft.id), sandboxDraft);
  const compareDraft = await externalDraft(lab, { count: 1 }, draft => { draft.workflow = 'compare'; });
  await assert.rejects(lab.start(compareDraft.id, { approved: true, expectedHash: draftHash(compareDraft) }), /Сравнение с автоматическим улучшением агента больше не запускается/);
  assert.deepEqual(await lab.get(compareDraft.id), compareDraft);
  // The recorded sandbox evidence is still judged again: nothing runs, the judge reads the stored dialogues.
  const reassessed = await lab.reassess(record.id); await lab.waitForIdle();
  const result = await lab.get(reassessed.id);
  assert.equal(result.phase, 'results_review', result.error ?? '');
  assert.deepEqual(result.trials.map(trial => trial.events), record.trials.map(trial => trial.events));
});

test('references can be added to a recorded run without running the agent again', async t => {
  const { lab } = await setup(t, legacyDemoRuntime());
  const record = await runDraft(lab, await externalDraft(lab, { count: 1, settings: { repeats: 1 } }));
  const measured = record.trials.find(trial => !['invalid', 'cancelled'].includes(trial.outcome))!;
  const reference = { id: 'r1', origin: 'owner' as const, confirmed: true, text: 'Код услуги 999-777' };
  const copy = await lab.reassess(record.id, { codeOnly: true, criteria: [{ scenarioId: measured.scenarioId, references: [reference] }] });
  await lab.waitForIdle();
  const reassessed = (await lab.get(copy.id)).trials.find(trial => trial.id === measured.id)!;
  assert.equal(reassessed.checks.find(check => check.id === 'ref_r1_tokens')?.passed, false, 'a value the agent never said fails the reference');
  assert.deepEqual(reassessed.events, measured.events, 'reassessment reads the recorded dialogue, it does not run the agent');
});
