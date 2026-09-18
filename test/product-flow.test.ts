import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { ExperimentLab, draftHash, resultHash } from '../src/experiment.js';
import { createDemoRuntime, demoEvaluationInput } from '../src/demo.js';
import { draftPatchSchema, fingerprint, goalAttainment, scriptIssue, type Runtime } from '../src/contracts.js';
import { listSuites } from '../src/connection.js';
import { awaitingVerdict, compareRuns, verdictSummary } from '../src/comparison.js';
import { evaluateTrial } from '../src/evaluation.js';
import { htmlReport } from '../src/report.js';
import { trialProofLines } from '../src/quality.js';

test('a failed case becomes a reusable regression test without changing provenance or inventing review', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-product-'));
  const lab = new ExperimentLab(join(directory, 'runs'), createDemoRuntime());
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  await lab.init();
  let draft = await lab.create(demoEvaluationInput()); await lab.waitForIdle(); draft = await lab.get(draft.id);
  const originalSettings = { ...draft.settings, provider: 'fixture', model: 'fixture', maxCalls: 20, maxDurationMs: 180000 };
  draft = await lab.updateDraft(draft.id, draftHash(draft), { settings: originalSettings });
  const patch = draftPatchSchema.parse({ settings: { userModes: ['reactive'] } });
  assert.deepEqual(patch.settings, { userModes: ['reactive'] });
  draft = await lab.updateDraft(draft.id, draftHash(draft), patch);
  assert.deepEqual(draft.settings, originalSettings);
  const scenario = draft.scenarios[0]!;
  await assert.rejects(lab.updateDraft(draft.id, draftHash(draft), { scenarios: [{ ...scenario, successCriteria: 'Now require 18:00' }] }), /исполняемые проверки остались прежними/);
  const malformed = { ...scenario, user: { ...scenario.user, maxFollowUps: 1, script: [scenario.user.opening, 'Now 18:00'] } };
  assert.match(scriptIssue(malformed.user, 4)!, /только реплики после opening/);
  let calls = 0;
  const invalid = await evaluateTrial({ requirements: [], runtime: createDemoRuntime(), revision: draft.revisions[0]!, scenario: malformed, repeat: 0, userMode: 'scripted',
    manifestHash: 'test', sources: draft.sources, settings: draft.settings, target: draft.target,
    ctx: { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() { calls++; }, addUsage() {} } });
  assert.equal(invalid.outcome, 'invalid'); assert.equal(calls, 0);
  assert.deepEqual(invalid.events.filter(e => e.type === 'user'), []);
  await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const before = await lab.get(draft.id);
  assert.equal(before.trials.length, 3);
  assert.equal(before.trials.filter(t => t.outcome === 'pass').length, 1, 'demo includes a passing read-only regression guard');
  assert.equal(before.reviewMode, 'automated'); assert.deepEqual(before.humanReviews, []);
  const failure = before.trials.find(t => t.outcome === 'fail')!;
  let reviewed = await lab.addHumanReview(before.id, { trialId: failure.id, verdict: 'invalid', note: 'Synthetic test of invalid classification; not owner review.' });
  assert.equal(awaitingVerdict(reviewed).has(failure.id), false);
  assert.equal(verdictSummary(reviewed).review.invalid, 1);
  assert.equal(verdictSummary(reviewed).review.reviewed, 1);
  assert.match(verdictSummary(reviewed).headline, /Качество агента по ним не установлено/);
  for (const id of awaitingVerdict(reviewed)) reviewed = await lab.addHumanReview(before.id, { trialId: id, verdict: 'fail', note: 'Synthetic fixture: missing update tool.' });
  reviewed = await lab.reviewResults(before.id, resultHash(reviewed));
  assert.deepEqual(reviewed.trials, before.trials, 'classification never rewrites original evidence');

  const file = await lab.saveSuite(before.id, join(directory, '.evals', 'regression.json'));
  await assert.rejects(lab.saveSuite(before.id, file), /EEXIST/);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(stored.definition.trials, []); assert.equal(stored.definition.reviewMode, null);
  let loaded = await lab.loadSuite(file, [scenario.id]);
  assert.equal(loaded.scenarios.length, 1); assert.equal(loaded.scenarios[0]!.provenance, scenario.provenance);
  assert.equal(loaded.usage.calls, 0, 'loading a test does not call a model');
  loaded = await lab.updateDraft(loaded.id, draftHash(loaded), { agent: { ...loaded.revisions[0]!.spec, tools: ['search_materials', 'lookup_record', 'update_record'] } });
  await lab.start(loaded.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(loaded) }); await lab.waitForIdle();
  const after = await lab.get(loaded.id);
  const comparison = compareRuns(before, after);
  assert.equal(comparison.comparable, true); assert.equal(comparison.fixed.length, 1);
  assert.match(comparison.headline, /Выбранные тесты \(1\/3\)/);
  assert.ok(comparison.notes.some(note => /Остальной.*не проверен/.test(note)));
  const rejectedTest = compareRuns(reviewed, after);
  assert.equal(rejectedTest.comparable, false, 'a human-invalidated test cannot establish an agent fix');
  assert.equal(rejectedTest.coverage.invalidBefore, 1); assert.deepEqual(rejectedTest.fixed, []);
  const invalidAfter = await lab.addHumanReview(after.id, { trialId: after.trials[0]!.id, verdict: 'invalid', note: 'Synthetic fixture: invalid measurement after the change.' });
  assert.equal(compareRuns(before, invalidAfter).coverage.invalidAfter, 1);
  assert.deepEqual(compareRuns(before, invalidAfter).fixed, []);
  assert.equal(verdictSummary({ ...reviewed, trials: reviewed.trials.filter(t => t.id !== failure.id) }).review.invalid, 0, 'a selected subset ignores reviews of other attempts');
  const missingBaseline = { ...after, settings: { ...after.settings, userModes: ['static', 'reactive'] as const as ['static', 'reactive'] }, trials: [{ ...failure, userMode: 'reactive' as const }] };

  const failedCLI = spawnSync(process.execPath, [resolve('dist/cli.js'), 'evaluate', '--input', file, '--yes', '--case', scenario.id, '--data-dir', join(directory, 'ci-fail')], { encoding: 'utf8' });
  assert.equal(failedCLI.status, 1, failedCLI.stderr);
  const fixedFile = await lab.saveSuite(after.id, join(directory, '.evals', 'fixed.json'));
  const passedCLI = spawnSync(process.execPath, [resolve('dist/cli.js'), 'evaluate', '--input', fixedFile, '--yes', '--data-dir', join(directory, 'ci-pass')], { encoding: 'utf8' });
  assert.equal(passedCLI.status, 0, passedCLI.stderr);
  assert.equal(JSON.parse(passedCLI.stdout).verdict.execution.completed, 1);
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

test('report links reveal their dialogue and event with only the fixed CSP-authorized script', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-navigation-'));
  const lab = new ExperimentLab(directory, createDemoRuntime());
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  await lab.init();
  const created = await lab.create(demoEvaluationInput()); await lab.waitForIdle();
  const record = await lab.get(created.id);
  record.task = '<script>evil()</script>';
  const html = htmlReport(record);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const code = scripts[0]![1]!;
  assert.ok(html.includes(`script-src 'sha256-${createHash('sha256').update(code).digest('base64')}'`));
  assert.ok(html.includes('&lt;script&gt;evil()&lt;/script&gt;'));
  const handlers: Record<string, () => void> = {};
  const details = { tagName: 'DETAILS', open: false, parentElement: null };
  let scrolled = false;
  const event = { tagName: 'DIV', parentElement: details, scrollIntoView() { scrolled = true; } };
  runInNewContext(code, { location: { hash: '#example' }, document: { getElementById: () => event, addEventListener() {} }, addEventListener: (name: string, handler: () => void) => { handlers[name] = handler; } });
  handlers.hashchange!();
  assert.equal(details.open, true); assert.equal(scrolled, true);
});

test('logs become one accepted, evidenced and reusable regression test against a real process', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-product-flow-'));
  const calls = { discover: 0, prepare: 0, goals: 0, assess: 0 };
  const quote = 'The reply must include support@example.com.';
  const runtime: Runtime = {
    async discover(input) {
      calls.discover++;
      if (input.kind === 'requirements') return { kind: 'requirements', requirements: [
        { id: 'support_rule', text: quote, sourceId: 'source-1', quote, critical: true },
      ], questions: [] };
      if (input.kind === 'coarse') return { kind: 'coarse', observations: input.dialogues.map(dialogue => ({
        dialogueId: dialogue.id, classification: 'candidate' as const, requirementId: 'support_rule',
        summary: 'The approved support address is missing.', citations: [{ seq: 1, quote: dialogue.messages[1]!.content }],
      })) };
      if (input.kind === 'group') return { kind: 'group', groups: [{
        requirementId: 'support_rule', dialogueIds: input.observations.map(item => item.dialogueId), summary: 'Same missing address.',
      }] };
      return { kind: 'hypothesis', hypothesis: 'The agent may omit the approved support address.' };
    },
    async goals({ dialogues }) {
      calls.goals++;
      const dialogue = dialogues[0]!;
      return [{ id: `goal_${dialogue.id}`, goal: 'Get the approved support address', opening: dialogue.messages[0]!.content,
        requirementIds: ['support_rule'], evidenceDialogueIds: [dialogue.id], successCriteria: quote,
        facts: 'Only the recorded request.', outcome: 'unknown' }];
    },
    async prepare(input) {
      calls.prepare++;
      assert.equal(input.confirmedHypothesis, 'The agent may omit the approved support address.\nНАБЛЮДЕНИЕ: ответ агента (reply)');
      assert.equal(input.goalObservation, 'reply');
      return {
        requirements: [{ id: 'support_rule', text: quote, sourceId: 'source-1', quote, critical: true }], questions: [],
        agent: { name: 'Support agent', instructions: quote, tools: [] },
        scenarios: [{
          id: 'support_reply', familyId: 'support_reply', title: 'Approved support reply', requirementIds: ['support_rule'],
          provenance: 'synthetic', tier: 'regression',
          user: { goal: 'Get the approved support address', facts: 'The request already names the expected address.',
            behavior: 'Ask once.', opening: 'Please confirm support@example.com', maxFollowUps: 0 },
          initialState: { records: {}, writableFields: [], transientFailures: 0 },
          checks: [{ id: 'approved_address', kind: 'answer_contains', description: 'Reply includes the approved address.', value: 'support@example.com' }],
          successCriteria: quote, assumptions: ['Built from the confirmed discovery evidence.'], metrics: [{ ...goalAttainment, passCriteria: quote }],
        }],
      };
    },
    async assess({ scenario, trial }) {
      calls.assess++;
      const reply = trial.events.findLast(event => event.type === 'assistant')!;
      const result = reply.text!.includes('support@example.com') ? 'pass' as const : 'fail' as const;
      return scenario.metrics!.map(metric => ({
        metricId: metric.id, result, rationale: result === 'pass'
          ? 'The persisted assistant reply contains the approved address.'
          : 'The persisted assistant reply omits the approved address.',
        evidence: [reply.seq], citations: [{ seq: reply.seq, quote: reply.text! }],
      }));
    },
    async improve() { throw new Error('evaluate flow must not improve the agent'); },
    async openTarget() { throw new Error('the command adapter, not Runtime.openTarget, must execute the target'); },
    async userTurn() { throw new Error('static tests must not simulate another user turn'); },
  };
  const lab = new ExperimentLab(directory, runtime);
  t.after(async () => { try { await lab.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  await lab.init();

  const discovered = await lab.discover({
    task: 'Find a useful support regression test', mode: 'live', materials: [{ name: 'Support policy', content: quote }],
    settings: { userModes: ['static'], repeats: 1, maxTurns: 2 },
    target: { kind: 'command', command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/stdio-agent.mjs', import.meta.url))], timeoutMs: 5000 },
    dialogues: [
      { id: 'log_one', messages: [{ role: 'user', content: 'Where is support?' }, { role: 'assistant', content: 'No address was provided.' }] },
      { id: 'log_two', messages: [{ role: 'user', content: 'Where should I write?' }, { role: 'assistant', content: 'No contact was provided.' }] },
    ],
  });
  await lab.waitForIdle();
  const discovery = await lab.get(discovered.id);
  assert.equal(discovery.discovery?.phase, 'ready', discovery.discovery?.error ?? discovery.error ?? '');
  assert.equal(discovery.discovery?.hypothesis?.requirementId, 'support_rule');
  assert.deepEqual(new Set(discovery.discovery?.hypothesis?.eventIds.map(item => `${item.dialogueId}:${item.seq}`)), new Set(['log_one:1', 'log_two:1']));
  const hypothesis = discovery.discovery!.hypothesis!.text;

  const built = await lab.buildFromDiscovery(discovery.id, hypothesis); await lab.waitForIdle();
  const draft = await lab.get(built.id);
  assert.equal(draft.phase, 'review', draft.error ?? '');
  assert.equal(draft.scenarios.length, 1);
  assert.equal(draft.scenarios[0]!.goalObservation, 'reply');
  const beforeAcceptance = { ...calls };
  const accepted = await lab.acceptDraft(draft.id, draftHash(draft));
  assert.equal(accepted.acceptedDraftHash, draftHash(accepted));
  assert.equal(accepted.acceptedTests?.length, 1);
  const acceptedTest = accepted.acceptedTests![0]!;
  assert.equal(acceptedTest.scenarioId, accepted.scenarios[0]!.id);
  assert.equal(acceptedTest.definitionHash, fingerprint(accepted.scenarios[0]!));
  assert.equal(accepted.phase, 'review'); assert.equal(accepted.reviewedAt, null); assert.equal(accepted.trials.length, 0);
  assert.deepEqual(calls, beforeAcceptance, 'acceptance records metadata without running the target or judge');

  await lab.start(accepted.id, { approved: true, reviewer: 'human', expectedHash: draftHash(accepted) }); await lab.waitForIdle();
  const result = await lab.get(accepted.id);
  assert.equal(result.phase, 'results_review', result.error ?? '');
  assert.equal(result.acceptedDraftHash, draftHash(accepted));
  assert.deepEqual(result.acceptedTests, [acceptedTest]);
  assert.equal(result.trials.length, 1);
  const trial = result.trials[0]!;
  const assistant = trial.events.find(event => event.type === 'assistant')!;
  assert.match(assistant.text!, /^You said: Please confirm support@example\.com/);
  const goal = trial.assessments?.find(item => item.metricId === 'goal_attainment');
  assert.deepEqual({ result: goal?.result, evidence: goal?.evidence }, { result: 'pass', evidence: [assistant.seq] });
  const proof = trialProofLines(result, trial.id).lines.join('\n');
  assert.match(proof, new RegExp(`#${assistant.seq} АГЕНТ: You said: Please confirm support@example\\.com`));
  assert.match(proof, new RegExp(`PASS \\[goal_attainment\\].*события: #${assistant.seq}`));

  const suite = await lab.saveSuite(result.id, join(directory, 'support-suite.json'));
  const repeated = await lab.repeat(result.id);
  assert.deepEqual(repeated.acceptedTests, [acceptedTest], 'repeat keeps the accepted identity while the scenario definition matches');
  const beforeReload = { ...calls };
  const loaded = await lab.loadSuite(suite);
  assert.equal(loaded.acceptedDraftHash, undefined, 'acceptance is metadata, not a suite execution gate');
  assert.deepEqual(loaded.acceptedTests, [acceptedTest], 'suite round-trip keeps the same accepted test identity');
  const listed = await listSuites(directory);
  const listedSuite = listed.find(item => item.file === suite)!;
  assert.equal('acceptedCount' in listedSuite ? listedSuite.acceptedCount : undefined, 1);
  assert.deepEqual('acceptedTestIds' in listedSuite ? listedSuite.acceptedTestIds : undefined, [acceptedTest.testId]);
  assert.deepEqual(loaded.scenarios.map(item => item.id), ['support_reply']);
  assert.deepEqual(loaded.scenarios[0]!.checks.map(item => item.id), ['approved_address']);
  assert.deepEqual(loaded.scenarios[0]!.metrics!.map(item => item.id), ['goal_attainment']);
  await lab.start(loaded.id, { approved: true, reviewer: 'human', expectedHash: draftHash(loaded) }); await lab.waitForIdle();
  const rerun = await lab.get(loaded.id);
  assert.equal(rerun.phase, 'results_review', rerun.error ?? '');
  assert.deepEqual(rerun.scenarios.map(item => item.id), result.scenarios.map(item => item.id));
  assert.deepEqual(rerun.scenarios[0]!.checks.map(item => item.id), result.scenarios[0]!.checks.map(item => item.id));
  assert.deepEqual(rerun.scenarios[0]!.metrics!.map(item => item.id), result.scenarios[0]!.metrics!.map(item => item.id));
  assert.equal(calls.discover, beforeReload.discover);
  assert.equal(calls.prepare, beforeReload.prepare);
  assert.equal(calls.goals, beforeReload.goals);
  assert.ok(calls.assess > beforeReload.assess, 'rerun judges the fresh real dialogue without rebuilding its test');
});
