import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { ExperimentLab } from '../src/experiment.js';
import { draftHash, resultHash } from '../src/lab/record.js';
import { createDemoRuntime, demoInput, demoTarget } from '../src/demo.js';
import { createInputSchema, draftPatchSchema, scriptIssue, type Experiment } from '../src/contracts.js';
import { awaitingVerdict } from '../src/agreement.js';
import { compareRuns } from '../src/comparison.js';
import { automaticTrialResult } from '../src/outcomes.js';
import { buildResultView, exitCodeOf } from '../src/result-view.js';
import { acceptedDemoDraft, demoCard } from './helpers/demo-record.js';
import { evaluateTrial } from '../src/evaluation.js';
import { htmlReport } from '../src/report.js';

test('a failed case becomes a reusable regression test without changing provenance or inventing review', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-product-'));
  const lab = new ExperimentLab(join(directory, 'runs'), createDemoRuntime());
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  await lab.init();
  const base = demoInput();
  let draft = await acceptedDemoDraft(lab, createInputSchema.parse({ ...base, settings: { ...base.settings, repeats: 1 } }));
  const originalSettings = { ...draft.settings, provider: 'fixture', model: 'fixture', maxCalls: 20, maxDurationMs: 180000 };
  draft = await lab.updateDraft(draft.id, draftHash(draft), { settings: originalSettings });
  const patch = draftPatchSchema.parse({ settings: { userModes: ['reactive'] } });
  assert.deepEqual(patch.settings, { userModes: ['reactive'] });
  draft = await lab.updateDraft(draft.id, draftHash(draft), patch);
  assert.deepEqual(draft.settings, originalSettings);
  // The teaching agent asks again for a number it was already given: this situation is the failed case.
  const scenario = draft.scenarios.find(item => item.id === demoCard(draft, 'known'))!;
  // A situation changes only in the library; a draft edit cannot carry cards.
  await assert.rejects(lab.updateDraft(draft.id, draftHash(draft), { scenarios: [{ ...scenario, successCriteria: 'Now require 18:00' }] } as never), /scenarios/);
  // A script is checked before any call, whatever the card: an old-format card with the opening repeated in its script.
  const { execution: _execution, ...oldFormat } = scenario;
  const malformed = { ...oldFormat, user: { ...oldFormat.user, maxFollowUps: 1, script: [oldFormat.user.opening, 'Now 18:00'] } };
  assert.match(scriptIssue(malformed.user, 4)!, /только реплики после opening/);
  let calls = 0;
  const invalid = await evaluateTrial({ requirements: [], runtime: createDemoRuntime(), revision: draft.revisions[0]!, scenario: malformed, repeat: 0, userMode: 'scripted',
    manifestHash: 'test', sources: draft.sources, settings: draft.settings, target: draft.target,
    ctx: { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() { calls++; }, addUsage() {} } });
  assert.equal(invalid.outcome, 'invalid'); assert.equal(calls, 0);
  assert.deepEqual(invalid.events.filter(e => e.type === 'user'), []);
  await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const before = await lab.get(draft.id);
  const verdict = (record: Experiment, trial: Experiment['trials'][number]) => automaticTrialResult(record.scenarios.find(s => s.id === trial.scenarioId), trial, record.humanReviews);
  assert.equal(before.trials.length, 2);
  assert.equal(before.trials.filter(t => verdict(before, t) === 'pass').length, 1, 'the number disclosed on request is handled');
  assert.equal(before.reviewMode, 'automated'); assert.deepEqual(before.humanReviews, []);
  const failure = before.trials.find(t => verdict(before, t) === 'fail')!;
  assert.equal(failure.scenarioId, scenario.id);
  let reviewed = await lab.addHumanReview(before.id, { trialId: failure.id, verdict: 'invalid', note: 'Synthetic test of invalid classification; not owner review.' });
  assert.equal(awaitingVerdict(reviewed).has(failure.id), false);
  // An invalidated test says nothing about the agent: its situation leaves the number and is named as unmeasured.
  const invalidated = buildResultView(reviewed);
  assert.deepEqual(invalidated.notMeasured.reasons.map(reason => [reason.code, reason.scenarioIds]), [['human_invalid', [scenario.id]]]);
  assert.deepEqual([invalidated.headline.passed, invalidated.headline.decided], [1, 1]);
  assert.equal(exitCodeOf(invalidated), 2);
  for (const id of awaitingVerdict(reviewed)) reviewed = await lab.addHumanReview(before.id, { trialId: id, verdict: 'fail', note: 'Synthetic fixture: the number is asked again.' });
  reviewed = await lab.reviewResults(before.id, resultHash(reviewed));
  assert.deepEqual(reviewed.trials, before.trials, 'classification never rewrites original evidence');

  const file = await lab.saveSuite(before.id, join(directory, '.evals', 'regression.json'));
  await assert.rejects(lab.saveSuite(before.id, file), /EEXIST/);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(stored.definition.trials, []); assert.equal(stored.definition.reviewMode, null);
  let loaded = await lab.loadSuite(file, [scenario.id]);
  assert.equal(loaded.scenarios.length, 1); assert.equal(loaded.scenarios[0]!.provenance, scenario.provenance);
  assert.equal(loaded.usage.calls, 0, 'loading a test does not call a model');
  // The fix is a new version of the agent: the same accepted situation runs against the corrected module.
  loaded = await lab.updateDraft(loaded.id, draftHash(loaded), { target: demoTarget(true), targetVersion: 'demo-fixed-v1' });
  await lab.start(loaded.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(loaded) }); await lab.waitForIdle();
  const after = await lab.get(loaded.id);
  const comparison = compareRuns(before, after);
  assert.equal(comparison.comparable, true); assert.equal(comparison.fixed.length, 1);
  assert.equal(comparison.headline, 'Только выбранные ситуации: 1 из 2. Исправлено 1, сломалось 0, без изменений 0 из 1 ситуации.');
  assert.ok(comparison.notes.includes('Сравнение относится только к выбранным ситуациям: остальные в этот раз не проверялись.'), comparison.notes.join('\n'));
  const rejectedTest = compareRuns(reviewed, after);
  assert.equal(rejectedTest.comparable, false, 'a human-invalidated test cannot establish an agent fix');
  assert.equal(rejectedTest.coverage.invalidBefore, 1); assert.deepEqual(rejectedTest.fixed, []);
  const invalidAfter = await lab.addHumanReview(after.id, { trialId: after.trials[0]!.id, verdict: 'invalid', note: 'Synthetic fixture: invalid measurement after the change.' });
  assert.equal(compareRuns(before, invalidAfter).coverage.invalidAfter, 1);
  assert.deepEqual(compareRuns(before, invalidAfter).fixed, []);
  assert.equal(buildResultView({ ...reviewed, trials: reviewed.trials.filter(t => t.id !== failure.id) }).notMeasured.reasons.some(reason => reason.code === 'human_invalid'), false,
    'a selected subset ignores reviews of other attempts');

  const failedCLI = spawnSync(process.execPath, [resolve('dist/cli.js'), 'evaluate', '--input', file, '--yes', '--case', scenario.id, '--data-dir', join(directory, 'ci-fail')], { encoding: 'utf8' });
  assert.equal(failedCLI.status, 1, failedCLI.stderr);
  const fixedFile = await lab.saveSuite(after.id, join(directory, '.evals', 'fixed.json'));
  const passedCLI = spawnSync(process.execPath, [resolve('dist/cli.js'), 'evaluate', '--input', fixedFile, '--yes', '--data-dir', join(directory, 'ci-pass')], { encoding: 'utf8' });
  assert.equal(passedCLI.status, 0, passedCLI.stderr);
  const printed = JSON.parse(passedCLI.stdout);
  assert.equal(printed.exitCode, 0, 'the printed exit code is the one the process returns');
  assert.deepEqual([printed.view.headline.passed, printed.view.headline.decided, printed.view.scope.dialogues], [1, 1, 1]);
});

test('Python reference adapter retains state within a dialogue and resets in a new process', () => {
  const initialState = { records: { A101: { time: '09:00' } } };
  const requests = ['Move A101 to 14:00', 'Thank you.'].map(message => JSON.stringify({ type: 'respond', message, initialState })).join('\n') + '\n';
  for (let i = 0; i < 2; i++) {
    const run = spawnSync('python3', ['examples/echo-agent.py'], { input: requests, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const replies = run.stdout.trim().split('\n').map(s => JSON.parse(s));
    assert.deepEqual(replies.map(r => r.records.A101.time), ['14:00', '14:00']);
    assert.equal(replies[0].events[0].result.record.time, '09:00');
  }
});

test('the report runs only its fixed CSP-authorized script and escapes recorded text', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-navigation-'));
  const lab = new ExperimentLab(directory, createDemoRuntime());
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  await lab.init();
  const record = await acceptedDemoDraft(lab);
  // A situation is named in the report by its card, as it was accepted.
  const library = record.librarySnapshot;
  assert.equal(library?.formatVersion, 2);
  if (library?.formatVersion === 2) library.cards[0]!.title = '<script>evil()</script>';
  const html = htmlReport(record);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const code = scripts[0]![1]!;
  assert.ok(html.includes(`script-src 'sha256-${createHash('sha256').update(code).digest('base64')}'`));
  assert.ok(html.includes('&lt;script&gt;evil()&lt;/script&gt;'));
  // The one script unfolds every section for printing.
  const handlers: Record<string, () => void> = {};
  const sections = [{ open: false }, { open: false }];
  runInNewContext(code, { document: { querySelectorAll: () => sections }, addEventListener: (name: string, handler: () => void) => { handlers[name] = handler; } });
  handlers.beforeprint!();
  assert.deepEqual(sections.map(section => section.open), [true, true]);
});

