import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { experimentSchema, settingsSchema, emptyUsage, type Experiment } from '../src/contracts.js';
import { syncIssues } from '../src/issues.js';
import { ExperimentStore } from '../src/store.js';
import { observedRecord } from '../src/outcomes.js';
import { qualitySummary } from '../src/quality.js';

import { issueRecord } from './helpers/issues.js';

test('same execution is idempotent; reassessment freezes new assessment but never adds occurrence; criterion drift stays separate', () => {
  const record = issueRecord();
  const first = syncIssues(record, []);
  const second = syncIssues(record, first.issues);
  assert.equal(second.issues.length, 1); assert.equal(second.issues[0]!.evidence.length, 1);
  const again = structuredClone(record); again.id = 'run_b'; again.trials[0]!.id = 'trial_b'; again.failureModes![0]!.trialIds = ['trial_b']; again.failureModes![0]!.name = 'Новое название';
  const repeated = syncIssues(again, second.issues).issues[0]!;
  assert.equal(repeated.occurrences.length, 2); assert.equal(repeated.status, 'reproduced');
  const reassess = structuredClone(record); reassess.id = 'assessment_b'; reassess.assessmentOf = record.id; reassess.trials[0]!.reason = 'Новая точная оценка';
  const judged = syncIssues(reassess, first.issues).issues[0]!;
  assert.equal(judged.occurrences.length, 1); assert.equal(judged.evidence.length, 2);
  assert.equal(judged.evidence[0]!.assessment.trial.reason, 'Статус не изменён');
  assert.notEqual(judged.evidence[0]!.assessmentId, judged.evidence[1]!.assessmentId);
  again.scenarios[0]!.checks[0] = { ...again.scenarios[0]!.checks[0]!, value: 'refunded' } as any;
  assert.equal(syncIssues(again, first.issues).issues.length, 2);
  again.scenarios = record.scenarios; again.failureModes![0]!.description = 'Другая причина';
  const ambiguous = syncIssues(again, first.issues);
  assert.equal(ambiguous.issues.length, 2); assert.equal(ambiguous.suggestions.length, 1);
});

test('diagnostic and generator records retain raw traces but cannot enter issues or headline counting', () => {
  for (const runKind of ['diagnostic', 'generator'] as const) {
    const record = { ...issueRecord(), runKind };
    assert.equal(syncIssues(record, []).issues.length, 0);
    assert.equal(observedRecord(record).trials.length, 0);
    assert.equal(record.trials.length, 1);
    assert.equal(qualitySummary(record).cards.accuracy, null);
  }
});

test('writer journal recovers corrupt index; lock-free readers see atomic snapshots and immutable evidence', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'issues-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExperimentStore(dir); await store.init(); t.after(() => store.close());
  const record = issueRecord(); await store.save(record); await store.syncIssues(record);
  const reader = new ExperimentStore(dir);
  await Promise.all([store.syncIssues(record), reader.readIssues().then(issues => assert.equal(issues.length, 1))]);
  await writeFile(join(dir, 'issues/index.json'), 'broken');
  assert.equal((await reader.readIssues()).length, 1);
  await store.rebuildIssues();
  assert.equal((await store.readIssues())[0]!.evidence.length, 1);
  assert.equal((await stat(join(dir, 'issues'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, 'issues/index.json'))).mode & 0o777, 0o600);
  assert.match(await readFile(join(dir, 'issues/index.json'), 'utf8'), /assessmentId/);
  await assert.rejects(reader.syncIssues(record), /писатель/);
});

test('ordinary version comparison rejects diagnostic records even with matching single-arm traces', async () => {
  const { compareRuns } = await import('../src/comparison.js');
  const before = issueRecord(), after = structuredClone(before); after.id = 'after'; after.parentRunId = before.id; after.runKind = 'diagnostic'; after.trials[0]!.id = 'new_trial';
  assert.equal(compareRuns(before, after).comparable, false);
  assert.match(compareRuns(before, after).notes.join(' '), /диагност|служебн/i);
  assert.match(qualitySummary(after).headline, /исключён|не входит/i);
});

test('owner merge survives index rebuild and reassessment chains preserve one execution', async t => {
  const { ExperimentLab } = await import('../src/experiment.js');
  const { createDemoRuntime } = await import('../src/demo.js');
  const dir = await mkdtemp(join(tmpdir(), 'issue-decision-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const lab = new ExperimentLab(dir, createDemoRuntime()); await lab.init(); t.after(() => lab.close());
  const source = issueRecord(); source.scenarios[0]!.successCriteria = 'Статус изменён'; source.requirements = [{ id: 'rule', text: 'Изменить статус', sourceId: 'policy', quote: 'Изменить статус', critical: true }]; source.sources = [{ id: 'policy', name: 'Правило', content: 'Изменить статус', hash: 'policy' }]; delete source.failureModes;
  await lab.store.save(source); await lab.store.syncIssues(source);
  const reassessed = await lab.reassess(source.id, { codeOnly: true }); await lab.waitForIdle();
  const twice = await lab.reassess(reassessed.id, { codeOnly: true }); await lab.waitForIdle();
  assert.equal((await lab.get(twice.id)).executionRunId, source.id);
  const issue = (await lab.store.readIssues())[0]!;
  assert.equal(issue.occurrences.length, 1); assert.equal(issue.evidence.length, 3);
  const other = structuredClone(source); other.id = 'other'; other.trials[0]!.id = 'other_trial'; other.failureModes = [{ id: 'm', name: 'Другая формулировка', description: 'Отдельно названный механизм', trialIds: ['other_trial'] }];
  await lab.store.save(other); await lab.store.syncIssues(other);
  const candidate = (await lab.store.readIssues()).find(i => i.id !== issue.id)!;
  await lab.store.decideIssue({ id: 'owner_merge', fromIssueId: candidate.id, intoIssueId: issue.id, reason: 'Проверил обе трассы: одна причина', at: '2026-09-20' });
  await lab.store.rebuildIssues();
  const merged = (await lab.store.readIssues()).find(i => i.id === issue.id)!;
  assert.equal(merged.occurrences.length, 2); assert.equal(merged.evidence.length, 4);
  assert.equal((await lab.store.readIssueJournal()).decisions.length, 1);
  const annotated = await lab.addHumanReview(twice.id, { trialId: source.trials[0]!.id, verdict: 'fail', note: 'Проверил событие #1' });
  assert.equal(annotated.executionRunId, source.id);
});

test('failed issue index update never rolls back a completed reassessment', async t => {
  const { mkdir } = await import('node:fs/promises');
  const { ExperimentLab } = await import('../src/experiment.js');
  const { createDemoRuntime } = await import('../src/demo.js');
  const dir = await mkdtemp(join(tmpdir(), 'issue-index-failure-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const lab = new ExperimentLab(dir, createDemoRuntime()); await lab.init(); t.after(() => lab.close());
  const source = issueRecord(); source.scenarios[0]!.successCriteria = 'Статус изменён';
  source.requirements = [{ id: 'rule', text: 'Изменить статус', sourceId: 'policy', quote: 'Изменить статус', critical: true }]; source.sources = [{ id: 'policy', name: 'Правило', content: 'Изменить статус', hash: 'policy' }];
  await lab.store.save(source);
  await mkdir(join(dir, 'issues', 'index.json'), { recursive: true });
  const run = await lab.reassess(source.id, { codeOnly: true }); await lab.waitForIdle();
  const completed = await lab.store.get(run.id);
  assert.equal(completed.phase, 'results_review'); assert.equal(completed.trials.length, 1); assert.equal(completed.error, null);
  assert.match(completed.limitations.join(' '), /индекс проблем/);
  assert.deepEqual((await lab.store.get(source.id)).trials, source.trials);
  await rm(join(dir, 'issues', 'index.json'), { recursive: true });
  assert.ok((await lab.store.rebuildIssues()).length > 0);
});

test('required and diagnostic checkpoints produce different issue kinds with exact checkpoint receipt identity', async () => {
  const { libraryFixture } = await import('./helpers/scenario-library.js');
  const { acceptLibrary, compileLibrary, libraryHash } = await import('../src/scenario-library.js');
  const library = libraryFixture(), source = issueRecord();
  source.librarySnapshot = acceptLibrary(library, libraryHash(library), ['variant_1']);
  source.scenarios = compileLibrary(source.librarySnapshot);
  const scenario = source.scenarios[0]!, cp = scenario.execution!.evaluatorView.checkpoints[0]!;
  scenario.execution!.evaluatorView.checkpoints.push({ ...cp, id: 'optional', role: 'diagnostic' });
  const trial = source.trials[0]!; trial.scenarioId = scenario.id; trial.familyId = scenario.familyId;
  trial.checks = []; trial.checkpoints = [cp, { ...cp, id: 'optional', role: 'diagnostic' as const }].map(c => ({ checkpointId: c.id, requirementId: c.requirementId, role: c.role, observation: c.observation, result: 'fail', evidence: [1], rationale: 'Не уточнил номер' }));
  trial.checkpointReceipt = { protocolHash: 'protocol', inputHash: 'input', resultHash: 'result', decisionHash: 'decision', decisions: [] };
  const issues = syncIssues(source, []).issues;
  assert.deepEqual(issues.map(i => i.kind), ['defect']);
  assert.deepEqual(issues[0]!.businessScenarios, [library.variants[0]!.businessScenarioId]);
  assert.equal(issues[0]!.evidence[0]!.assessment.trial.checkpointReceipt!.decisionHash, 'decision');
  trial.checkpoints[0]!.result = 'pass'; trial.outcome = 'pass';
  trial.checkpointReceipt = (await import('../src/checkpoints.js')).checkpointReceipt(scenario, trial, trial.checkpoints, []);
  assert.deepEqual(syncIssues(source, []).issues.map(i => i.kind), ['opportunity']);
});

test('analysis budget exhaustion preserves completed target measurements and recoverable issue evidence', async t => {
  const { ExperimentLab, draftHash } = await import('../src/experiment.js'); const { createDemoRuntime } = await import('../src/demo.js');
  const dir = await mkdtemp(join(tmpdir(), 'issue-analysis-budget-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = { ...createDemoRuntime(), async openTarget(_a: any, _s: any, _tools: any, ctx: any) { return { async respond() { for (let i = 0; i < 5; i++) ctx.beforeCall(); return 'Не получилось'; }, async close() {} }; }, async failureModes(_input: any, ctx: any) { ctx.beforeCall(); return []; } };
  const lab = new ExperimentLab(dir, runtime); await lab.init(); t.after(() => lab.close());
  const source = issueRecord(); source.phase = 'review'; source.reviewedAt = null; source.trials = []; delete source.failureModes; source.settings.maxCalls = 5;
  await lab.store.save(source); const run = await lab.start(source.id, { approved: true, expectedHash: draftHash(source) }); await lab.waitForIdle();
  const result = await lab.get(run.id); assert.equal(result.phase, 'results_review'); assert.equal(result.trials.length, 1); assert.equal(result.error, null); assert.equal(result.usage.calls, 5);
  assert.match(result.limitations.join(' '), /назвать типы провалов/); assert.equal((await lab.store.readIssues()).length, 1);
});
