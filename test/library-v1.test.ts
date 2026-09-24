import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { experimentSchema, fingerprint, type Experiment, type VariantExecution } from '../src/contracts.js';
import { judgeAuditSchema, type JudgeAudit } from '../src/assessment.js';
import type { Runtime } from '../src/runtime.js';
import { libraryV1Of, projectedExpectations } from '../src/card/legacy-v1.js';
import { compareRuns } from '../src/comparison.js';
import { scenarioLibrarySchema } from '../src/card/schema.js';
import { demoTarget } from '../src/demo.js';
import { ExperimentLab } from '../src/experiment.js';
import { draftHash } from '../src/lab/record.js';
import { hasCompleteJudgment, observableSources, scenarioSources } from '../src/judge.js';
import { automaticTrialResult } from '../src/outcomes.js';
import { buildResultView } from '../src/result-view.js';
import { libraryHash, verifyAcceptedRun } from '../src/scenario-library.js';
import { libraryV1File, libraryV1Run, libraryV1Runtime } from './helpers/library-v1.js';

/*
 * Goldens of a stored first-format library run (test/helpers/library-v1.ts). They must hold after every
 * later change of the card format, its compiler, the judge and the result model: an owner's old run opens,
 * reads, re-assesses and repeats exactly as it was accepted.
 */

const complete = (record: Experiment, trial: Experiment['trials'][number], judgeAudit?: JudgeAudit) => {
  const scenario = record.scenarios.find(item => item.id === trial.scenarioId)!;
  return hasCompleteJudgment({ scenario, sources: observableSources(scenarioSources(record, scenario), record.requirements), trial: judgeAudit ? { ...trial, judgeAudit } : trial });
};
const verdicts = (record: Experiment) => record.trials.map(trial => `${trial.scenarioId}:${automaticTrialResult(record.scenarios.find(item => item.id === trial.scenarioId), trial, record.humanReviews)}`).sort();

test('a stored first-format library run parses to itself: record, library file and judge audits', async () => {
  const raw = await libraryV1File('run.json') as Experiment;
  assert.equal(fingerprint(experimentSchema.parse(raw)), fingerprint(raw));
  const library = await libraryV1File('library.json');
  assert.equal(fingerprint(scenarioLibrarySchema.parse(library)), fingerprint(library));
  assert.equal(fingerprint(library), fingerprint(raw.librarySnapshot), 'the library file is the snapshot the run carries');
  assert.equal(raw.librarySnapshot?.formatVersion, 1);
  assert.equal(libraryHash(raw.librarySnapshot!), raw.librarySnapshot!.acceptance!.libraryHash);
  for (const trial of raw.trials) {
    const audit = await libraryV1File(`run.judge/${trial.id}.json`);
    assert.equal(fingerprint(judgeAuditSchema.parse(audit)), fingerprint(audit));
    assert.equal(trial.judgeReceipt?.auditHash, fingerprint(audit), 'the receipt seals exactly the stored audit');
  }
});

test('the result of a stored first-format run stays as it was: headline, situations and reasons', async () => {
  const record = experimentSchema.parse(await libraryV1File('run.json'));
  assert.deepEqual(verdicts(record), ['known_number:fail', 'known_number:fail', 'late_number:pass', 'late_number:unknown']);
  const view = buildResultView(record);
  assert.deepEqual({ passed: view.headline.passed, decided: view.headline.decided, accuracy: view.headline.accuracy }, { passed: 0, decided: 1, accuracy: 0 });
  assert.deepEqual(view.cards.map(card => ({ id: card.scenarioId, outcome: card.outcome, reason: card.reason })),
    [{ id: 'known_number', outcome: 'fail', reason: undefined }, { id: 'late_number', outcome: 'unknown', reason: 'judge_unclear' }]);
  assert.deepEqual(view.notMeasured.reasons.map(reason => ({ code: reason.code, count: reason.count, scenarioIds: reason.scenarioIds })),
    [{ code: 'judge_unclear', count: 1, scenarioIds: ['late_number'] }]);
  assert.deepEqual(view.failures.map(failure => failure.scenarioId), ['known_number']);
  assert.equal(view.failures[0]!.said?.quote, 'Уточните номер терминала.');
});

test('every stored judgment of the first-format run stays complete, from its receipt and from its audit', async t => {
  const { lab, directory, record } = await libraryV1Run();
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(record.trials.length, 4);
  for (const trial of record.trials) {
    assert.ok(trial.checkpoints?.length && trial.checkpointReceipt, 'the run was judged by checkpoints');
    assert.deepEqual(trial.assessments?.map(assessment => assessment.metricId), ['library_required']);
    assert.equal(trial.judgeAudit, undefined, 'the record keeps receipts only');
    assert.equal(complete(record, trial), true, `receipt of ${trial.id}`);
    const audit = await lab.store.readJudgeAudit(record.id, trial.id);
    assert.ok(audit);
    assert.equal(complete(record, trial, audit), true, `audit of ${trial.id}`);
  }
});

test('an accepted first-format run is verified by its stored hashes: the receipt, the materials and every card', async () => {
  const record = experimentSchema.parse(await libraryV1File('run.json'));
  verifyAcceptedRun(record);
  const renamed = structuredClone(record);
  libraryV1Of(renamed)!.variants[0]!.title = 'Другое название';
  assert.throws(() => verifyAcceptedRun(renamed), /изменены после утверждения/, 'a changed variant breaks the library receipt');
  const card = structuredClone(record);
  card.scenarios[0]!.title = 'Другое название';
  assert.throws(() => verifyAcceptedRun(card), /отличается от утверждённой/, 'a changed card breaks its definition hash');
  const rules = structuredClone(record);
  rules.requirements[0]!.text = 'Другое правило';
  assert.throws(() => verifyAcceptedRun(rules), /Правила изменились/);
  // Accepted under an older controller prompt: the stored card and its receipt agree. No compiler of this format is left
  // to write the card again — the stored hashes are the whole proof.
  const older = structuredClone(record);
  const accepted = older.scenarios[0]!;
  accepted.execution!.controllerHash = 'a'.repeat(64);
  older.acceptedTests = older.acceptedTests!.map(entry => entry.scenarioId === accepted.id ? { ...entry, definitionHash: fingerprint(accepted) } : entry);
  verifyAcceptedRun(older);
  const foreign = structuredClone(record);
  foreign.acceptedTests = foreign.acceptedTests!.map(entry => ({ ...entry, definitionHash: fingerprint(foreign.scenarios[0]) }));
  assert.throws(() => verifyAcceptedRun(foreign), /отличается от утверждённой/, 'an acceptance entry of another card proves nothing');
});

test('the first-format run is re-assessed from its recorded evidence with its accepted cards', async t => {
  const { lab, directory, record } = await libraryV1Run();
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  const reassessed = await lab.reassess(record.id); await lab.waitForIdle();
  const result = await lab.get(reassessed.id);
  assert.equal(result.assessmentOf, record.id);
  assert.equal(fingerprint(result.scenarios), fingerprint(record.scenarios), 'the accepted cards are judged as they are');
  assert.deepEqual(result.trials.map(trial => trial.events), record.trials.map(trial => trial.events), 'no agent or simulator ran');
  assert.deepEqual(verdicts(result), ['known_number:fail', 'known_number:fail', 'late_number:pass', 'late_number:pass']);
  for (const trial of result.trials) {
    assert.equal(complete(result, trial), true);
    // Judged through the projection: no checkpoint verdict, one expectation per required checkpoint, two votes each.
    const required = projectedExpectations(result.scenarios.find(item => item.id === trial.scenarioId)!.execution as VariantExecution).map(expectation => expectation.id);
    assert.deepEqual(required, ['ask_once', 'refund_explanation']);
    assert.equal(trial.checkpoints, undefined); assert.equal(trial.checkpointReceipt, undefined);
    assert.deepEqual(trial.assessments?.map(assessment => assessment.metricId), required, 'the one `library_required` rubric is gone');
    assert.deepEqual(trial.judgeReceipt?.votes.map(vote => vote.metricId), required.flatMap(id => [id, id]));
  }
});

test('the first-format run repeats on a new agent version with its accepted cards, never recompiled', async t => {
  // The controller of the repeat is given each card's stored customer view, exactly as it was accepted.
  const seen: unknown[] = [];
  const runtime: Runtime = libraryV1Runtime();
  const choose = runtime.selectUserAction!;
  runtime.selectUserAction = (input, ctx) => { seen.push(input.user); return choose(input, ctx); };
  const { lab, directory, record } = await libraryV1Run(runtime);
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  const repeated = await lab.repeat(record.id);
  assert.equal(fingerprint(repeated.scenarios), fingerprint(record.scenarios));
  const draft = await lab.updateDraft(repeated.id, draftHash(repeated), { target: demoTarget(true) });
  await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const run = await lab.get(draft.id);
  assert.equal(run.phase, 'results_review');
  assert.equal(fingerprint(run.scenarios), fingerprint(record.scenarios));
  assert.deepEqual(verdicts(run), ['known_number:pass', 'known_number:pass', 'late_number:pass', 'late_number:pass'], 'the fixed agent no longer asks twice');
  const views = new Set(record.scenarios.map(scenario => fingerprint(scenario.execution!.userView)));
  assert.ok(seen.length > 0 && seen.every(view => views.has(fingerprint(view))), 'the stored userView drives the controller');
});

test('a repeat compares with the old run re-judged by today\'s judge, never with the checkpoint verdicts of the raw run', async t => {
  const { lab, directory, record } = await libraryV1Run();
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  const reassessed = await lab.reassess(record.id); await lab.waitForIdle();
  const repeated = await lab.repeat(record.id);
  const draft = await lab.updateDraft(repeated.id, draftHash(repeated), { target: demoTarget(true) });
  await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const run = await lab.get(draft.id);
  const raw = compareRuns(record, run);
  assert.equal(raw.comparable, false);
  assert.ok(raw.notes.some(note => note.startsWith('Протокол судьи отличается')), raw.notes.join(' | '));
  const rejudged = compareRuns(await lab.get(reassessed.id), run);
  assert.equal(rejudged.comparable, true, rejudged.notes.join(' | '));
  assert.deepEqual(rejudged.fixed.map(row => row.scenarioId), ['known_number'], 'the fixed agent no longer asks twice');
});

test('criteria of a re-assessment cannot change an accepted first-format card', async t => {
  const { lab, directory, record } = await libraryV1Run();
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(() => lab.reassess(record.id, { criteria: [{ scenarioId: 'known_number', successCriteria: 'Другое ожидание' }], codeOnly: true }), /отличается от утверждённой/);
  assert.deepEqual(await lab.get(record.id), record, 'the stored run is untouched');
});

test('a first-format run saved as a suite loads in another store with its library and import, and runs as accepted', async t => {
  const { lab, directory, record } = await libraryV1Run();
  const other = new ExperimentLab(join(directory, 'other'), libraryV1Runtime());
  t.after(async () => { await lab.close(); await other.close(); await rm(directory, { recursive: true, force: true }); });
  await other.init();
  const file = await lab.saveSuite(record.id, join(directory, 'suite.json'), ['late_number']);
  const loaded = await other.loadSuite(file, undefined, { format: 'agent-lab-connection-1', target: demoTarget(true) });
  assert.equal(fingerprint(loaded.librarySnapshot), fingerprint(record.librarySnapshot));
  assert.deepEqual(loaded.scenarios.map(scenario => scenario.id), ['late_number']);
  assert.deepEqual(loaded.selectedScenarioIds, ['late_number']);
  const library = libraryV1Of(loaded)!;
  assert.equal(fingerprint(await other.store.readLibrary(library.id, libraryHash(library))), fingerprint(library), 'the library is kept in the new store');
  assert.equal((await other.store.readImport(loaded.originalImport!.id)).dialogues.length, 2, 'so is its import');
  await other.start(loaded.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(loaded) }); await other.waitForIdle();
  assert.deepEqual(verdicts(await other.get(loaded.id)), ['late_number:pass', 'late_number:pass']);
});
