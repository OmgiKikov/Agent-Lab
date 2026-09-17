import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { ExperimentLab, draftHash, measurementHash, planDiscovery, resultHash } from '../src/experiment.js';
import { ExperimentStore } from '../src/store.js';
import { createDemoRuntime, demoEvaluationInput, demoInput } from '../src/demo.js';
import { createInputSchema, emptyUsage, experimentSchema, fingerprint, goalAttainment, metricApplies, validatePreparation, type Experiment, type Runtime, type Trial } from '../src/contracts.js';
import { assessRepeated, hasCompleteJudgment, judgeInput, observableSources } from '../src/judge.js';
import { awaitingVerdict, compareRuns } from '../src/comparison.js';
import { simulatorUsable } from '../src/outcomes.js';
import { qualityLines, qualitySummary } from '../src/quality.js';

test('staged discovery batches whole logs, selects one grounded focus, and persists one exact handoff', async t => {
  const quote = 'Answer support questions only from the approved policy.';
  const candidateIds = new Set(['log_0', 'log_1', 'log_25']);
  const dialogues = Array.from({ length: 26 }, (_, index) => ({ id: `log_${index}`, outcome: index ? 'success' as const : 'failure' as const,
    messages: [{ role: 'user' as const, content: `Question ${index}` }, { role: 'assistant' as const, content: candidateIds.has(`log_${index}`) ? 'Invented answer' : 'Approved answer' }] }));
  const seen: unknown[] = [];
  let delayCoarse = false;
  const runtime: Runtime = {
    async discover(input) {
      seen.push(structuredClone(input));
      if (input.kind === 'requirements') return { kind: 'requirements', requirements: [{ id: 'owner_rule', text: quote, sourceId: 'source-1', quote, critical: true }], questions: [] };
      if (input.kind === 'coarse') {
        if (delayCoarse) await new Promise(resolve => setTimeout(resolve, 60));
        return { kind: 'coarse', observations: input.dialogues.map(dialogue => ({
        dialogueId: dialogue.id, classification: candidateIds.has(dialogue.id) ? 'candidate' as const : 'clean' as const,
        ...(candidateIds.has(dialogue.id) ? { requirementId: 'owner_rule' } : {}),
        summary: 'Observed reply', citations: [{ seq: 1, quote: dialogue.messages[1]!.content }],
        })) };
      }
      if (input.kind === 'group') return { kind: 'group', groups: [
        { requirementId: 'foreign_rule', dialogueIds: ['log_0', 'log_25'], summary: 'Invalid advisory group' },
        { requirementId: 'owner_rule', dialogueIds: [...candidateIds], summary: 'The reply gives an unapproved answer.' },
      ] };
      return { kind: 'hypothesis', hypothesis: 'The agent may answer outside the approved support policy.' };
    },
    async goals({ dialogues }) {
      const dialogue = dialogues[0]!;
      return [{ id: `goal_${dialogue.id}`, goal: 'Get an approved support answer', opening: dialogue.messages[0]!.content,
        requirementIds: ['owner_rule'], evidenceDialogueIds: [dialogue.id], successCriteria: quote, facts: 'Only the recorded user request.', outcome: 'unknown' }];
    },
    async assess({ scenario, trial }) {
      return scenario.metrics!.map(metric => ({ metricId: metric.id, result: scenario.id === 'log_1' ? 'pass' as const : 'fail' as const,
        rationale: 'The recorded reply is evidence.', evidence: [1], citations: [{ seq: 1, quote: trial.events[1]!.text! }] }));
    },
    async prepare(input) {
      if (!input.confirmedHypothesis) throw new Error('discovery must not prepare cards');
      return { requirements: [{ id: 'owner_rule', text: quote, sourceId: 'source-1', quote, critical: true }], questions: [],
        agent: { name: 'Recorded agent', instructions: quote, tools: [] }, scenarios: [{
          id: 'accepted_test', familyId: 'accepted_test', title: 'Approved support answer', requirementIds: ['owner_rule'], provenance: 'synthetic', tier: 'regression',
          user: { goal: 'Get an approved support answer', facts: 'No additional facts.', behavior: 'Ask once.', opening: 'How can I get support?', maxFollowUps: 0 },
          initialState: { records: {}, writableFields: [], transientFailures: 0 }, checks: [], successCriteria: quote, assumptions: ['Built from confirmed discovery evidence.'],
          metrics: [{ ...goalAttainment, passCriteria: quote }],
        }] };
    }, async improve() { throw new Error('discovery must not improve'); },
    async openTarget() { throw new Error('discovery must not open target'); }, async userTurn() { throw new Error('discovery must not simulate users'); },
  };
  const { lab } = await setup(t, runtime);
  const input = { task: 'Find a useful support test', mode: 'live' as const, materials: [{ name: 'policy', content: quote }], dialogues,
    settings: { maxCalls: 20, maxDurationMs: 180_000 } };
  const plan = planDiscovery(input);
  assert.equal(plan.batchCount, 2); assert.ok(plan.batches.every(batch => batch.length <= 25 && JSON.stringify({ dialogues: batch }).length <= 60_000));
  assert.equal(plan.nominalCalls, plan.batchCount + (2 * plan.metrics + 1) * plan.selectedCap + 3,
    'requirements, grouping and hypothesis are three distinct fixed calls');
  assert.deepEqual([plan.baseMaxCalls, plan.baseMaxDurationMs], [20, 180_000]);
  assert.equal(plan.maxDurationMs, Math.ceil(180_000 * plan.maxCalls / 20));
  const started = await lab.discover(input); await lab.waitForIdle();
  const result = await lab.get(started.id);
  assert.equal(result.discovery?.callPlan.nominalCalls, plan.nominalCalls); assert.equal(result.settings.maxCalls, plan.maxCalls); assert.ok(result.settings.maxCalls > 20);
  assert.ok(result.discovery!.elapsedMs! > 0, 'discovery checkpoints persist elapsed wall time');
  assert.equal(result.discovery?.phase, 'ready', result.discovery?.error ?? result.error ?? '');
  assert.equal(result.discovery?.observations.length, dialogues.length);
  assert.equal(result.discovery?.focusRequirementId, 'owner_rule');
  assert.deepEqual(result.discovery?.groups, [{ requirementId: 'owner_rule', dialogueIds: [...candidateIds].sort(), summary: 'The reply gives an unapproved answer.' }]);
  assert.deepEqual(new Set(result.discovery?.representativeIds), candidateIds);
  assert.equal(result.discovery?.selectedIds.length, result.discovery!.representativeIds.length + result.discovery!.controlIds.length);
  assert.ok(result.discovery?.controlIds.every(id => !result.discovery!.representativeIds.includes(id)));
  assert.equal(result.discovery?.deep.filter(item => item.role === 'control').length, result.discovery?.controlIds.length);
  assert.match(result.discovery!.hypothesis!.text, /НАБЛЮДЕНИЕ: ответ агента \(reply\)$/);
  assert.equal(result.discovery?.hypothesis?.requirementId, 'owner_rule');
  assert.deepEqual(new Set(result.discovery?.hypothesis?.eventIds.map(event => event.dialogueId)), new Set(['log_0', 'log_25']),
    'a representative that passed deep goal attainment is not hypothesis evidence');
  const hypothesisInput = (seen.find(item => !!item && typeof item === 'object' && 'kind' in item && item.kind === 'hypothesis') as
    Extract<Parameters<NonNullable<Runtime['discover']>>[0], { kind: 'hypothesis' }> | undefined);
  assert.deepEqual(new Set(hypothesisInput?.observations.map(item => item.dialogueId)), new Set(['log_0', 'log_25']));
  assert.deepEqual(new Set(hypothesisInput?.deep.map(item => item.dialogueId)), new Set(['log_0', 'log_25']));
  assert.equal(JSON.stringify(seen).includes('"outcome"'), false, 'stored outcome must never enter discovery Runtime payloads');
  const built = await lab.buildFromDiscovery(result.id, result.discovery!.hypothesis!.text); await lab.waitForIdle();
  const draft = await lab.get(built.id);
  assert.equal(draft.phase, 'review', draft.error ?? ''); assert.equal(draft.scenarios.length, 1); assert.equal(draft.scenarios[0]!.goalObservation, 'reply');
  assert.deepEqual([draft.settings.maxCalls, draft.settings.maxDurationMs], [20, 180_000], 'discovery budget must not leak into the accepted test');

  const bypass = structuredClone(result); bypass.id = `${result.id}_bypass`;
  const bypassAssessment = bypass.discovery!.deep.find(item => item.dialogueId === 'log_0')!.assessments!
    .find(item => item.metricId === 'goal_attainment')!;
  bypassAssessment.result = 'pass';
  await lab.store.save(bypass);
  await assert.rejects(lab.buildFromDiscovery(bypass.id, bypass.discovery!.hypothesis!.text), /минимум в двух representative-диалогах/);

  const legacy = structuredClone(result); legacy.id = `${result.id}_legacy`;
  const legacyPlan = legacy.discovery!.callPlan as unknown as Record<string, unknown>;
  delete legacyPlan.baseMaxCalls; delete legacyPlan.baseMaxDurationMs; delete legacyPlan.maxDurationMs;
  await lab.store.save(legacy);
  const reloadedLegacy = await lab.store.get(legacy.id);
  assert.deepEqual([reloadedLegacy.discovery!.callPlan.baseMaxCalls, reloadedLegacy.discovery!.callPlan.baseMaxDurationMs], [5, 5000]);
  assert.equal(reloadedLegacy.discovery!.callPlan.legacyBudgetMissing, true);
  await assert.rejects(lab.buildFromDiscovery(legacy.id, legacy.discovery!.hypothesis!.text), /не содержит исходный бюджет/);

  const tampered = await lab.store.get(result.id);
  tampered.discovery!.hypothesis!.eventIds[0]!.seq = 0;
  await lab.store.save(tampered);
  await assert.rejects(lab.buildFromDiscovery(result.id, tampered.discovery!.hypothesis!.text), /candidate-наблюдения/);
  tampered.discovery!.phase = 'partial'; tampered.discovery!.activeCall = 'deep log_0';
  await lab.store.save(tampered);
  await assert.rejects(lab.resumeDiscovery(result.id), /стоимость неизвестна/);

  delete tampered.discovery!.activeCall;
  tampered.phase = 'interrupted'; tampered.discovery!.phase = 'partial'; tampered.discovery!.error = null;
  tampered.discovery!.completedBatchCount = 0; tampered.discovery!.observations = []; tampered.discovery!.groupingComplete = false;
  tampered.discovery!.groups = []; tampered.discovery!.elapsedMs = tampered.discovery!.callPlan.maxDurationMs - 20;
  delayCoarse = true;
  await lab.store.save(tampered);
  await lab.resumeDiscovery(result.id); await lab.waitForIdle();
  const timedOut = await lab.get(result.id);
  assert.equal(timedOut.discovery!.elapsedMs, timedOut.discovery!.callPlan.maxDurationMs);
  assert.match(timedOut.error!, /time limit/i, 'resume receives only the unspent discovery time budget');
  timedOut.discovery!.phase = 'partial';
  await lab.store.save(timedOut);
  await assert.rejects(lab.resumeDiscovery(result.id), /Лимит времени discovery исчерпан/);
});

test('discovery requires assistant evidence and two repeated deep goal failures before proposing a test', async t => {
  const quote = 'Use only the approved answer.';
  const dialogues = ['a', 'b'].map(id => ({ id, messages: [
    { role: 'user' as const, content: `Question ${id}` }, { role: 'assistant' as const, content: `Unsupported ${id}` },
  ] }));
  let citationSeq = 0;
  let judgment: 'pass' | 'fail' = 'fail';
  let hypothesisCalls = 0;
  const runtime: Runtime = {
    async discover(input) {
      if (input.kind === 'requirements') return { kind: 'requirements', requirements: [{ id: 'rule', text: quote, sourceId: 'source-1', quote, critical: true }], questions: [] };
      if (input.kind === 'coarse') return { kind: 'coarse', observations: input.dialogues.map(dialogue => ({ dialogueId: dialogue.id,
        classification: 'candidate' as const, requirementId: 'rule', summary: 'Possible failure',
        citations: [{ seq: citationSeq, quote: dialogue.messages[citationSeq]!.content }] })) };
      if (input.kind === 'group') return { kind: 'group', groups: [{ requirementId: 'rule', dialogueIds: ['a', 'b'], summary: 'Same unsupported answer.' }] };
      hypothesisCalls++; return { kind: 'hypothesis', hypothesis: 'Repeated unsupported answer.' };
    },
    async goals({ dialogues: [dialogue] }) { return [{ id: `goal_${dialogue!.id}`, goal: 'Get an approved answer', opening: dialogue!.messages[0]!.content,
      requirementIds: ['rule'], evidenceDialogueIds: [dialogue!.id], successCriteria: quote }]; },
    async assess({ scenario, trial }) { return scenario.metrics!.map(metric => ({ metricId: metric.id, result: judgment,
      rationale: 'Deep check result.', evidence: [1], citations: [{ seq: 1, quote: trial.events[1]!.text! }] })); },
    async prepare() { throw new Error('unused'); }, async improve() { throw new Error('unused'); },
    async openTarget() { throw new Error('unused'); }, async userTurn() { throw new Error('unused'); },
  };
  const { lab } = await setup(t, runtime);
  const input = { task: 'Find a test', mode: 'live' as const, materials: [{ name: 'policy', content: quote }], dialogues };

  const userOnly = await lab.discover(input); await lab.waitForIdle();
  const rejectedEvidence = await lab.get(userOnly.id);
  assert.equal(rejectedEvidence.discovery?.phase, 'insufficient');
  assert.ok(rejectedEvidence.discovery?.observations.every(observation => observation.classification === 'unknown'));
  assert.equal(hypothesisCalls, 0);

  citationSeq = 1; judgment = 'pass';
  const passing = await lab.discover(input); await lab.waitForIdle();
  const rejectedJudge = await lab.get(passing.id);
  assert.equal(rejectedJudge.discovery?.phase, 'insufficient');
  assert.equal(rejectedJudge.discovery?.deep.length, 2);
  assert.equal(rejectedJudge.discovery?.hypothesis, undefined);
  assert.equal(hypothesisCalls, 0);
});

test('discovery keeps going when one deep judge response is rejected', async t => {
  const quote = 'Use only the approved answer.';
  const candidateIds = new Set(['bad_a', 'bad_b', 'bad_c']);
  const dialogues = [...candidateIds, 'clean'].map(id => ({ id, messages: [
    { role: 'user' as const, content: `Question ${id}` }, { role: 'assistant' as const, content: candidateIds.has(id) ? `Unsupported ${id}` : 'Approved answer' },
  ] }));
  const runtime: Runtime = {
    async discover(input) {
      if (input.kind === 'requirements') return { kind: 'requirements', requirements: [{ id: 'rule', text: quote, sourceId: 'source-1', quote, critical: true }], questions: [] };
      if (input.kind === 'coarse') return { kind: 'coarse', observations: input.dialogues.map(dialogue => ({ dialogueId: dialogue.id,
        classification: candidateIds.has(dialogue.id) ? 'candidate' as const : 'clean' as const,
        ...(candidateIds.has(dialogue.id) ? { requirementId: 'rule' } : {}), summary: 'Observed reply',
        citations: [{ seq: 1, quote: dialogue.messages[1]!.content }] })) };
      if (input.kind === 'group') return { kind: 'group', groups: [{ requirementId: 'rule', dialogueIds: [...candidateIds], summary: 'Same unsupported answer.' }] };
      return { kind: 'hypothesis', hypothesis: 'The agent may return an unsupported answer.' };
    },
    async goals({ dialogues: [dialogue] }) { return [{ id: `goal_${dialogue!.id}`, goal: 'Get an approved answer', opening: dialogue!.messages[0]!.content,
      requirementIds: ['rule'], evidenceDialogueIds: [dialogue!.id], successCriteria: quote }]; },
    async assess({ scenario, trial }, ctx) {
      // 'clean' fails before any judgment is reported, so no sidecar exists for it.
      if (scenario.id === 'clean') throw new Error('Judge response rejected; original responses and errors are preserved in judgeAudit');
      ctx.onJudgment?.(trial.id, { protocolHash: 'p', inputHash: 'i', provider: 'offline', model: 'judge', prompt: 'p', input: '{}', attempts: [], notApplicable: [] }, true);
      return scenario.metrics!.map(metric => ({ metricId: metric.id, result: 'fail' as const, rationale: 'Deep check result.', evidence: [1],
        citations: [{ seq: 1, quote: trial.events[1]!.text! }] }));
    },
    async prepare() { throw new Error('unused'); }, async improve() { throw new Error('unused'); },
    async openTarget() { throw new Error('unused'); }, async userTurn() { throw new Error('unused'); },
  };
  const { lab } = await setup(t, runtime);
  const started = await lab.discover({ task: 'Find a test', mode: 'live', materials: [{ name: 'policy', content: quote }], dialogues });
  await lab.waitForIdle();
  const result = await lab.get(started.id);
  assert.equal(result.discovery?.phase, 'ready', result.discovery?.error ?? result.error ?? '');
  assert.equal(result.discovery?.completedDeepIds.length, result.discovery?.selectedIds.length);
  assert.match(result.discovery?.deep.find(item => item.dialogueId === 'clean')?.error ?? '', /Judge response rejected/);
  assert.ok(result.discovery?.hypothesis);
  // Deep judgments are keyed per attempt and named by the record, never by the dialogue id.
  assert.equal(result.discovery!.deep.find(item => item.dialogueId === 'clean')?.judgeTrialId, undefined, 'no key for a judgment that was never written');
  const keys = result.discovery!.deep.filter(item => item.dialogueId !== 'clean').map(item => item.judgeTrialId);
  assert.ok(keys.every(key => key?.startsWith('deep-')), JSON.stringify(keys));
  assert.equal(new Set(keys).size, keys.length);
  for (const key of keys) assert.ok(await lab.store.readJudgeAudit(result.id, key!), `sidecar for ${key}`);
  for (const id of [...candidateIds, 'clean']) assert.equal(await lab.store.readJudgeAudit(result.id, id), null);
  const journalKeys = (await lab.store.traceJournal(result.id)).trim().split('\n').map(line => JSON.parse(line) as { trialId: string; judgeAudit?: unknown })
    .filter(line => line.judgeAudit).map(line => line.trialId);
  assert.deepEqual(new Set(journalKeys), new Set(keys));
});

test('discovery groups one repeated behavior before deep checks instead of merging a broad requirement', async t => {
  const quote = 'Answers must follow the approved policy.';
  const dialogues = ['invent_a', 'invent_b', 'omit_a', 'omit_b'].map(id => ({ id, messages: [
    { role: 'user' as const, content: `Question ${id}` }, { role: 'assistant' as const, content: `Reply ${id}` },
  ] }));
  let groupedInput: unknown;
  let hypothesisIds: string[] = [];
  const runtime: Runtime = {
    async discover(input) {
      if (input.kind === 'requirements') return { kind: 'requirements', requirements: [{ id: 'policy', text: quote, sourceId: 'source-1', quote, critical: true }], questions: [] };
      if (input.kind === 'coarse') return { kind: 'coarse', observations: input.dialogues.map(dialogue => ({
        dialogueId: dialogue.id, classification: 'candidate' as const, requirementId: 'policy',
        summary: dialogue.id.startsWith('invent') ? 'Invents a policy answer.' : 'Omits the required answer.',
        citations: [{ seq: 1, quote: dialogue.messages[1]!.content }],
      })) };
      if (input.kind === 'group') {
        groupedInput = structuredClone(input);
        return { kind: 'group', groups: [
          { requirementId: 'policy', dialogueIds: ['invent_a', 'invent_b'], summary: 'Invents a policy answer.' },
          { requirementId: 'policy', dialogueIds: ['omit_a', 'omit_b'], summary: 'Omits the required answer.' },
          { requirementId: 'foreign', dialogueIds: ['invent_a', 'invent_b'], summary: 'Invalid group.' },
        ] };
      }
      hypothesisIds = input.observations.map(observation => observation.dialogueId);
      return { kind: 'hypothesis', hypothesis: 'The selected behavior repeats.' };
    },
    async goals({ dialogues: [dialogue] }) { return [{ id: `goal_${dialogue!.id}`, goal: 'Get a policy answer', opening: dialogue!.messages[0]!.content,
      requirementIds: ['policy'], evidenceDialogueIds: [dialogue!.id], successCriteria: quote }]; },
    async assess({ scenario, trial }) { return scenario.metrics!.map(metric => ({ metricId: metric.id, result: 'fail' as const,
      rationale: 'The selected reply fails the policy.', evidence: [1], citations: [{ seq: 1, quote: trial.events[1]!.text! }] })); },
    async prepare() { throw new Error('unused'); }, async improve() { throw new Error('unused'); },
    async openTarget() { throw new Error('unused'); }, async userTurn() { throw new Error('unused'); },
  };
  const { lab } = await setup(t, runtime);
  const started = await lab.discover({ task: 'Find one repeated behavior', mode: 'live', materials: [{ name: 'policy', content: quote }], dialogues });
  await lab.waitForIdle();
  const result = await lab.get(started.id);
  assert.equal(result.discovery?.phase, 'ready', result.discovery?.error ?? result.error ?? '');
  assert.equal(result.discovery?.groups?.length, 2, 'foreign model groups are ignored');
  const representatives = new Set(result.discovery?.representativeIds);
  const invent = ['invent_a', 'invent_b'].every(id => representatives.has(id));
  const omit = ['omit_a', 'omit_b'].every(id => representatives.has(id));
  assert.notEqual(invent, omit, 'representatives must come from exactly one behavioral group');
  assert.deepEqual(new Set(hypothesisIds), representatives, 'only deeply confirmed representatives become hypothesis evidence');
  assert.deepEqual(Object.keys(groupedInput as object).sort(), ['kind', 'observations', 'requirements']);
  assert.equal(JSON.stringify(groupedInput).includes('Question '), false, 'grouping sees short observations, not full dialogues');
});

test('ExperimentLab rejects backend checks from a custom Runtime for confirmed reply-only RAG tests, including sandbox targets', async t => {
  const quote = 'Support is available at support@example.com.';
  let invalid = true, targetCalls = 0;
  const runtime: Runtime = {
    async prepare() {
      const successCriteria = 'The reply contains support@example.com.';
      return { requirements: [{ id: 'support_rule', text: quote, sourceId: 'source-1', quote, critical: true }], questions: [],
        agent: { name: 'External agent', instructions: quote, tools: [] }, scenarios: [{
          id: 'support_test', familyId: 'support_test', title: 'Support reply', requirementIds: ['support_rule'], provenance: 'synthetic', tier: 'regression',
          user: { goal: 'Get support', facts: 'No additional facts.', behavior: 'Ask once.', opening: 'How do I get support?', maxFollowUps: 0 },
          initialState: invalid ? { records: { account: { status: 'active' } }, writableFields: ['status'], transientFailures: 0 }
            : { records: {}, writableFields: [], transientFailures: 0 },
          checks: invalid ? [{ id: 'lookup', kind: 'tool_called' as const, description: 'Invented backend lookup.', tool: 'lookup_record' }]
            : [{ id: 'reply', kind: 'answer_contains' as const, description: 'Reply contains the approved address.', value: 'support@example.com' }],
          successCriteria, assumptions: ['Confirmed reply-only RAG hypothesis.'], metrics: [{ ...goalAttainment, passCriteria: successCriteria }],
        }] };
    },
    async improve() { throw new Error('unused'); },
    async openTarget() { targetCalls++; throw new Error('target must not open while building a draft'); },
    async userTurn() { throw new Error('unused'); },
  };
  const { lab } = await setup(t, runtime);
  const input = { task: 'Check support reply', confirmedHypothesis: 'The agent may omit the support address.', goalObservation: 'reply' as const,
    mode: 'live' as const, workflow: 'evaluate' as const, scenarioCount: 1, materials: [{ name: 'Policy', content: quote }],
    target: { kind: 'sandbox' as const } };
  const rejected = await lab.create(input); await lab.waitForIdle();
  const failed = await lab.get(rejected.id);
  assert.equal(failed.phase, 'error'); assert.match(failed.error ?? '', /reply-only RAG.*backend state.*tool\/state/); assert.equal(targetCalls, 0);
  invalid = false;
  const accepted = await lab.create(input); await lab.waitForIdle();
  const draft = await lab.get(accepted.id);
  assert.equal(draft.phase, 'review', draft.error ?? ''); assert.equal(draft.scenarios.length, 1); assert.equal(targetCalls, 0);
});

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

test('complete experiment freezes measurement, restricts builder feedback, persists actual evidence and exports the selected agent', async t => {
  const runtime = createDemoRuntime();
  const improve = runtime.improve;
  let feedbackSeen = false;
  runtime.improve = async (input, ctx) => {
    assert.ok(input.feedback.length > 0);
    assert.ok(input.feedback.every(f => f.scenario.split === 'dev' && f.trials.every(trial => trial.split === 'dev')));
    feedbackSeen = true;
    const proposal = await improve(input, ctx);
    // A proposal must never acquire a mutable reference to frozen source/check data.
    input.sources[0]!.content = 'mutated by builder';
    input.feedback[0]!.scenario.checks = [];
    return proposal;
  };
  const { lab } = await setup(t, runtime);
  const created = await lab.create(demoInput());
  await lab.waitForIdle();
  const ready = await lab.get(created.id);
  assert.equal(ready.phase, 'review');
  await assert.rejects(lab.start(ready.id, { approved: false }), /после вашего подтверждения/);
  await lab.start(ready.id, { approved: true });
  await lab.waitForIdle();
  const result = await lab.get(ready.id);
  assert.equal(result.phase, 'complete', result.error ?? '');
  assert.equal(feedbackSeen, true);
  assert.equal(result.manifestHash, measurementHash(result));
  assert.equal(result.sources[0]!.hash, fingerprint(result.sources[0]!.content));
  assert.deepEqual(result.scenarios, ready.scenarios);
  assert.ok(result.reviewedAt && result.controlConsumedAt);
  assert.ok(result.revisions.find(r => r.id === result.selectedRevisionId)!.spec.tools.includes('update_record'));
  const final = result.comparisons.at(-1)!;
  assert.equal(final.split, 'control');
  assert.deepEqual([final.baselinePasses, final.candidatePasses, final.fixed, final.regressed, final.validPairs, final.families], [4, 8, 4, 0, 8, 2]);
  assert.equal(final.verdict, 'insufficient');
  const journal = (await lab.store.traceJournal(result.id)).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(journal.length, result.trials.reduce((sum, trial) => sum + trial.events.length, 0));
  assert.ok(journal.some(row => row.event.type === 'tool_result' && row.event.tool === 'update_record'));
  assert.deepEqual(await lab.store.get(result.id), result);
  assert.notEqual(measurementHash({ ...result, task: 'different task' }), result.manifestHash);
  const changed = structuredClone(result);
  changed.revisions[0]!.spec.instructions += ' changed';
  assert.notEqual(measurementHash(changed), result.manifestHash);
  await assert.rejects(lab.start(result.id, { approved: true }), /только эксперимент, ожидающий проверки/);
});

test('compare improvement accepts a decisive human review for an unknown agent metric', async t => {
  const runtime = createDemoRuntime(); let improvements = 0;
  const improve = runtime.improve;
  runtime.improve = async (...args) => { improvements++; return improve(...args); };
  const { lab } = await setup(t, runtime);
  const created = await lab.create({ ...demoInput(), settings: { ...demoInput().settings, repeats: 1 } }); await lab.waitForIdle();
  let draft = await lab.get(created.id);
  const scenario = draft.scenarios.find(card => card.split === 'dev')!;
  draft = await lab.updateDraft(draft.id, draftHash(draft), { scenarios: [{ ...scenario, metrics: [{
    id: 'human_only', name: 'Human-only criterion', subject: 'agent', description: 'Requires human judgment.',
    passCriteria: 'A human accepts the dialogue.', failCriteria: 'A human rejects the dialogue.',
  }] }] });
  const save = lab.store.save.bind(lab.store); let reviews = 0;
  lab.store.save = async record => {
    for (const trial of record.trials) for (const assessment of trial.assessments?.filter(item => item.result === 'unknown') ?? []) {
      if (record.humanReviews.some(review => review.trialId === trial.id && review.metricId === assessment.metricId)) continue;
      record.humanReviews.push({ id: `review_${trial.id}`, trialId: trial.id, metricId: assessment.metricId,
        verdict: 'pass', note: 'Accepted from the recorded dialogue.', createdAt: record.updatedAt });
      reviews++;
    }
    await save(record);
  };
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const result = await lab.get(draft.id);
  assert.equal(result.phase, 'complete', result.error ?? '');
  assert.equal(improvements, 1); assert.ok(reviews > 0);
});

test('candidate infrastructure failures retain the baseline and remain visible rather than becoming improvement', async t => {
  const runtime = createDemoRuntime();
  const openTarget = runtime.openTarget;
  runtime.openTarget = async (agent, ...args) => {
    if (agent.tools.includes('update_record')) throw new Error('Candidate provider unavailable');
    return openTarget(agent, ...args);
  };
  const { lab } = await setup(t, runtime);
  const input = demoInput(); input.settings.repeats = 1;
  const record = await lab.create(input); await lab.waitForIdle();
  await lab.start(record.id, { approved: true }); await lab.waitForIdle();
  const result = await lab.get(record.id);
  assert.equal(result.phase, 'complete');
  assert.equal(result.selectedRevisionId, result.revisions[0]!.id);
  assert.equal(result.iterations[0]!.accepted, false);
  assert.ok(result.trials.some(trial => trial.outcome === 'invalid'));
  assert.equal(result.comparisons.at(-1)!.verdict, 'no_change');
});

test('call budget stops the run, preserving partial trials without a final success claim', async t => {
  const { lab } = await setup(t);
  const input = demoInput(); input.settings.maxCalls = 5;
  const record = await lab.create(input); await lab.waitForIdle();
  await lab.start(record.id, { approved: true }); await lab.waitForIdle();
  const result = await lab.get(record.id);
  assert.equal(result.phase, 'error');
  assert.match(result.error!, /call budget/);
  assert.equal(result.usage.calls, 5);
  assert.ok(result.trials.length > 0);
  assert.equal(result.controlConsumedAt, null);
  assert.equal(result.comparisons.length, 0);
});

test('task-only execution records automated review and labels expectations provisional', async t => {
  const { lab } = await setup(t);
  const record = await lab.create(demoInput()); await lab.waitForIdle();
  await lab.start(record.id, { approved: true, reviewer: 'automated' }); await lab.waitForIdle();
  const result = await lab.get(record.id);
  assert.equal(result.phase, 'complete');
  assert.equal(result.reviewMode, 'automated');
  assert.match(result.limitations.join(' '), /without human validation/);
  assert.match(result.comparisons.at(-1)!.reasons.join(' '), /provisional/);
  assert.notEqual(result.comparisons.at(-1)!.verdict, 'improved');
});

test('shutdown during the initial checkpoint waits, keeps the lock, and never starts model work', async t => {
  const runtime = createDemoRuntime(); let calls = 0;
  const prepare = runtime.prepare;
  runtime.prepare = async (...args) => { calls++; return prepare(...args); };
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

test('preparation rejects invented sources, uncovered critical requirements, and contradictory or unreachable checks', async () => {
  const input = demoInput();
  const sources = input.materials.map((m, i) => ({ ...m, id: `source-${i}`, hash: fingerprint(m.content) }));
  const raw = await createDemoRuntime().prepare({ task: input.task, sources }, {
    signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {},
  });
  const check = (mutate: (p: typeof raw) => void, message: RegExp) => {
    const p = structuredClone(raw); mutate(p); assert.throws(() => validatePreparation(p, sources), message);
  };
  check(p => { p.requirements[0]!.quote = 'Fabricated source fact'; }, /ungrounded/);
  check(p => { p.requirements.push({ ...p.requirements[0]!, id: 'uncovered' }); }, /no test coverage/);
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
  check(p => { p.scenarios.forEach(s => { s.familyId = 'same'; }); }, /four distinct/);
});

test('провалы прогона получают имена, а сорванная кластеризация не теряет прогон', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-modes-'));
  // Агент, который только обещает: состояние не меняется, значит проверки падают и есть что кластеризовать.
  const base = { ...createDemoRuntime(), async openTarget() { return { respond: async () => 'Готово, перенёс.', close: async () => {} }; } };
  const seen: unknown[] = [];
  const named = {
    ...base,
    async failureModes(input: { task: string; failures: { trialId: string }[] }) {
      seen.push(input);
      return [{ id: 'no_action', name: 'Пообещал перенос и не сделал его', description: 'Ответ утверждает изменение, которого нет в состоянии.', stage: 'действие', trialIds: input.failures.map(f => f.trialId) }];
    },
  };
  const lab = new ExperimentLab(directory, named as never);
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  await lab.init();
  const draft = await lab.create({ ...demoInput(), workflow: 'evaluate' as const });
  await lab.waitForIdle();
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(await lab.get(draft.id)) });
  await lab.waitForIdle();
  const done = await lab.get(draft.id);
  assert.ok(done.trials.filter(t => t.outcome === 'fail').length >= 2, 'в демо-прогоне есть что кластеризовать');
  assert.equal(done.failureModes?.length, 1);
  assert.match(done.failureModes![0]!.name, /Пообещал/);
  assert.deepEqual(done.failureModes![0]!.trialIds.sort(), done.trials.filter(t => t.outcome === 'fail').map(t => t.id).sort());
  // Кластеризатору дают только провалившиеся диалоги и их трассы.
  const passed = new Set(done.trials.filter(t => t.outcome !== 'fail').map(t => t.id));
  assert.equal((seen[0] as { failures: { trialId: string }[] }).failures.some(f => passed.has(f.trialId)), false);

  // Сорванный разбор — это оговорка в записи, а не потерянный прогон.
  const brokenDir = await mkdtemp(join(tmpdir(), 'agent-lab-modes-broken-'));
  const broken = new ExperimentLab(brokenDir, { ...base, async failureModes() { throw new Error('судья недоступен'); } } as never);
  t.after(async () => { await broken.close(); await rm(brokenDir, { recursive: true, force: true }); });
  await broken.init();
  const second = await broken.create({ ...demoInput(), workflow: 'evaluate' as const });
  await broken.waitForIdle();
  await broken.start(second.id, { approved: true, reviewer: 'human', expectedHash: draftHash(await broken.get(second.id)) });
  await broken.waitForIdle();
  const survived = await broken.get(second.id);
  assert.equal(survived.phase, 'results_review');
  assert.equal(survived.failureModes, undefined);
  assert.ok(survived.limitations.some(l => /Не удалось назвать типы провалов.*судья недоступен/.test(l)));
});

test('unresolved business questions block approval until new materials produce a new experiment', async t => {
  const runtime = createDemoRuntime(); const prepare = runtime.prepare;
  runtime.prepare = async (...args) => ({ ...await prepare(...args), questions: ['Which timezone applies?'] });
  const { lab } = await setup(t, runtime);
  const record = await lab.create(demoInput()); await lab.waitForIdle();
  await assert.rejects(lab.start(record.id, { approved: true }), /ответьте на бизнес-вопросы/);
  assert.equal((await lab.get(record.id)).phase, 'review');
});

test('goal observation is part of the existing full draft hash while legacy drafts stay stable', async t => {
  const { lab } = await setup(t, createDemoRuntime());
  const input = demoInput(); input.workflow = 'evaluate'; input.scenarioCount = 1;
  const created = await lab.create(input); await lab.waitForIdle();
  const legacy = await lab.get(created.id);
  const legacyHash = draftHash(legacy);
  assert.equal(draftHash(structuredClone(legacy)), legacyHash);

  const card = { ...legacy.scenarios[0]!, goalObservation: 'reply' as const };
  const edited = await lab.updateDraft(legacy.id, legacyHash, { scenarios: [card] });
  assert.notEqual(draftHash(edited), legacyHash);
  const toolDraft = structuredClone(edited);
  toolDraft.scenarios[0]!.goalObservation = 'tool';
  assert.notEqual(draftHash(toolDraft), draftHash(edited));
});

test('confirming the expectations is recorded as exactly that, and never upgrades a comparison', async t => {
  const { lab } = await setup(t, createDemoRuntime());
  const created = await lab.create(demoInput()); await lab.waitForIdle();
  const ready = await lab.get(created.id);
  await lab.start(ready.id, { approved: true, reviewer: 'expectations' });
  await lab.waitForIdle();
  const result = await lab.get(ready.id);
  assert.equal(result.phase, 'complete', result.error ?? '');
  assert.equal(result.reviewMode, 'expectations');
  // The run dialog confirms expectations; the verdicts do not exist yet, so nothing here says a
  // person checked them. The limitation must say so instead of disappearing.
  assert.match(result.limitations.join(' '), /Владелец подтвердил ожидания ситуаций перед запуском\. Определения карточек и оценки судьи человеком не проверялись\./);
  assert.doesNotMatch(result.limitations.join(' '), /without human validation/);
  const final = result.comparisons.at(-1)!;
  assert.equal(final.split, 'control');
  assert.notEqual(final.verdict, 'improved', 'a confirmed draft does not lift a provisional comparison');
  assert.ok(final.reasons.includes('Scenario expectations have not been validated by a human; this comparison is provisional.'));
  // An old record parses and keeps the two modes it could already hold.
  assert.equal(experimentSchema.parse({ ...result, reviewMode: 'human' }).reviewMode, 'human');
  assert.equal(experimentSchema.parse({ ...result, reviewMode: 'automated' }).reviewMode, 'automated');
});

test('the manifest covers the control set but not the owner-expectation label, and old records keep their hash', async t => {
  const { lab } = await setup(t, createDemoRuntime());
  const input = demoInput(); input.workflow = 'evaluate'; input.scenarioCount = 2;
  const created = await lab.create(input); await lab.waitForIdle();
  const record = await lab.get(created.id);
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

test('accepting a draft records exact one-test review metadata without granting execution authority', async t => {
  const runtime = createDemoRuntime();
  let runtimeCalls = 0;
  const prepare = runtime.prepare;
  runtime.prepare = async (...args) => { runtimeCalls++; return prepare(...args); };
  const { lab } = await setup(t, runtime);
  const created = await lab.create({ ...demoInput(), workflow: 'evaluate', scenarioCount: 1 });
  await lab.waitForIdle();
  const draft = await lab.get(created.id);
  const currentHash = draftHash(draft);
  runtimeCalls = 0;

  await assert.rejects(lab.acceptDraft(draft.id, '0'.repeat(64)), /изменился/i);
  assert.deepEqual(await lab.get(draft.id), draft);
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

  const changedCard = { ...accepted.scenarios[0]!, title: 'Уточнённый тест' };
  const edited = await lab.updateDraft(draft.id, currentHash, { scenarios: [changedCard] });
  assert.equal(edited.acceptedDraftHash, currentHash);
  assert.deepEqual(edited.acceptedTests, [], 'an edited definition is not presented as the accepted test');
  assert.notEqual(draftHash(edited), edited.acceptedDraftHash, 'a semantic edit exposes stale acceptance');

  await lab.start(edited.id, { approved: true, reviewer: 'human', expectedHash: draftHash(edited) });
  await lab.waitForIdle();
  const result = await lab.get(edited.id);
  assert.equal(result.acceptedDraftHash, currentHash, 'running does not rewrite or clear acceptance metadata');
  assert.deepEqual(result.acceptedTests, []);
  const repeated = await lab.repeat(result.id);
  assert.equal(repeated.acceptedDraftHash, undefined, 'a fresh draft starts without review metadata');
  assert.deepEqual(repeated.acceptedTests, []);
});

test('accepting rejects an empty draft, a compare record and a started run without mutation', async t => {
  const { lab } = await setup(t, createDemoRuntime());
  const one = await lab.create({ ...demoInput(), workflow: 'evaluate', scenarioCount: 1 }); await lab.waitForIdle();
  const emptyRecord = await lab.get(one.id); emptyRecord.scenarios = []; await lab.store.save(emptyRecord);
  await assert.rejects(lab.acceptDraft(emptyRecord.id, draftHash(emptyRecord)), /нечего/i);
  assert.deepEqual(await lab.get(emptyRecord.id), emptyRecord);

  const many = await lab.create({ ...demoInput(), workflow: 'evaluate', scenarioCount: 2 }); await lab.waitForIdle();
  const manyRecord = await lab.get(many.id);

  const compare = await lab.create(demoInput()); await lab.waitForIdle();
  const compareRecord = await lab.get(compare.id);
  await assert.rejects(lab.acceptDraft(compareRecord.id, draftHash(compareRecord)), /evaluate/i);
  assert.deepEqual(await lab.get(compareRecord.id), compareRecord);

  await lab.start(manyRecord.id, { approved: true, reviewer: 'human', expectedHash: draftHash(manyRecord) }); await lab.waitForIdle();
  const completed = await lab.get(manyRecord.id);
  await assert.rejects(lab.acceptDraft(completed.id, draftHash(completed)), /черновик/i);
  assert.deepEqual(await lab.get(completed.id), completed);
});

test('one confirmation covers every situation of the draft and keeps unchanged entries', async t => {
  const { lab } = await setup(t, createDemoRuntime());
  const created = await lab.create({ ...demoInput(), workflow: 'evaluate', scenarioCount: 2 }); await lab.waitForIdle();
  const draft = await lab.get(created.id);
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

  const kept = accepted.scenarios[1]!.id;
  const keptEntry = accepted.acceptedTests!.find(test => test.scenarioId === kept)!;
  const edited = await lab.updateDraft(draft.id, hash, { scenarios: [{ ...accepted.scenarios[0]!, title: 'Другая ситуация' }] });
  assert.deepEqual(edited.acceptedTests!.map(test => test.scenarioId), [kept], 'only the untouched situation stays confirmed');
  const again = await lab.acceptDraft(edited.id, draftHash(edited));
  assert.equal(again.acceptedTests!.length, 2);
  assert.deepEqual(again.acceptedTests!.find(test => test.scenarioId === kept), keptEntry, 'an unchanged situation keeps its entry');
});

const REFUND_RULE = 'Верните деньги через терминал в течение трёх дней.';
/** Two judge-evaluated situations: their goal is scored by the `goal_attainment` rubric, not by exact checks. */
function judgeGoalRuntime(): Runtime {
  const situation = (index: number) => ({
    id: `case_${index}`, familyId: `case_${index}`, title: `Ситуация ${index}`, requirementIds: ['refund_rule'],
    provenance: 'synthetic' as const, tier: 'regression' as const,
    user: { goal: `Вернуть деньги по операции ${index}`, facts: 'Оплата картой.', behavior: 'Спрашивает один раз.',
      opening: 'Как вернуть деньги?', maxFollowUps: 0 },
    initialState: { records: {}, writableFields: [], transientFailures: 0 },
    checks: [{ id: 'mentions_terminal', kind: 'answer_contains' as const, description: 'Ответ называет терминал.', value: 'терминал' }],
    metrics: [{ ...goalAttainment, passCriteria: `Ожидание ${index}` }],
    successCriteria: `Ожидание ${index}`, goalObservation: 'reply' as const,
  });
  return {
    async prepare({ sources }) {
      return { requirements: [{ id: 'refund_rule', text: REFUND_RULE, sourceId: sources[0]!.id, quote: REFUND_RULE, critical: true }],
        questions: [], agent: { name: 'Агент эквайринга', instructions: REFUND_RULE, tools: [] }, scenarios: [situation(1), situation(2)] };
    },
    async assess({ scenario }) { return (scenario.metrics ?? []).map(metric => ({ metricId: metric.id, result: 'pass' as const, rationale: 'Фикстура.', evidence: [1] })); },
    async improve() { throw new Error('unused'); },
    async openTarget() { return { async respond() { return 'Верните через терминал.'; }, async close() {} }; },
    async userTurn() { throw new Error('unused'); },
  };
}
const judgeGoalInput = () => ({ task: 'Проверить возвраты', goalObservation: 'reply' as const,
  mode: 'live' as const, workflow: 'evaluate' as const, scenarioCount: 2, materials: [{ name: 'Правила возврата', content: REFUND_RULE }],
  target: { kind: 'sandbox' as const }, settings: { repeats: 1, maxIterations: 1, userModes: ['static' as const] } });

test('the owner rewrites one expectation in their own words; it becomes the criterion and the old confirmation goes stale', async t => {
  const { lab } = await setup(t, judgeGoalRuntime());
  const created = await lab.create(judgeGoalInput()); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  assert.equal(draft.phase, 'review', draft.error ?? '');
  assert.equal(draft.scenarios.length, 2);
  const hash = draftHash(draft);
  const accepted = await lab.acceptDraft(draft.id, hash);
  const card = accepted.scenarios[0]!;
  const other = accepted.scenarios[1]!;

  const before = await lab.get(draft.id);
  await assert.rejects(lab.setExpectation(draft.id, '0'.repeat(64), card.id, 'Текст'), /Черновик изменился, пока вы смотрели/);
  await assert.rejects(lab.setExpectation(draft.id, hash, card.id, '   \n  '), /Ожидание пустое/);
  await assert.rejects(lab.setExpectation(draft.id, hash, card.id, 'я'.repeat(3001)), /Ожидание длиннее 3000 знаков/);
  await assert.rejects(lab.setExpectation(draft.id, hash, 'no_such_card', 'Текст'), /Нет такой ситуации в черновике: no_such_card\./);
  assert.deepEqual(await lab.get(draft.id), before, 'a rejected expectation writes nothing');

  const text = 'Объяснить порядок возврата через терминал.';
  const edited = await lab.setExpectation(draft.id, hash, card.id, `  ${text}  `);
  const changed = edited.scenarios.find(item => item.id === card.id)!;
  assert.equal(changed.successCriteria, text, 'the owner text is stored verbatim');
  const goal = changed.metrics!.find(metric => metric.id === 'goal_attainment')!;
  assert.equal(goal.passCriteria, text);
  assert.equal(goal.failCriteria, goalAttainment.failCriteria);
  assert.equal(goal.description, goalAttainment.description);
  assert.deepEqual(changed.checks, card.checks);
  assert.deepEqual(edited.scenarios.find(item => item.id === other.id), other, 'the other situation is untouched');
  assert.deepEqual(edited.ownerExpectationScenarioIds, [card.id]);
  assert.notEqual(draftHash(edited), hash);
  assert.equal(edited.acceptedDraftHash, hash, 'the earlier confirmation stays visibly stale');
  assert.deepEqual(edited.acceptedTests!.map(entry => entry.scenarioId), [other.id]);
  assert.equal(edited.reviewedAt, null); assert.equal(edited.reviewMode, null); assert.equal(edited.manifestHash, null);

  const again = await lab.setExpectation(draft.id, draftHash(edited), card.id, text);
  assert.equal(again.updatedAt, edited.updatedAt, 'the same text writes nothing');

  const stub: Trial = { id: 'trial', revisionId: 'rev', scenarioId: changed.id, familyId: changed.familyId, repeat: 0, userMode: 'static',
    split: 'dev', manifestHash: 'h', outcome: 'fail', reason: 'r', checks: [],
    events: [{ seq: 0, type: 'user', text: 'Как вернуть деньги?' }, { seq: 1, type: 'assistant', text: 'Не знаю.' }],
    initialState: changed.initialState, finalState: changed.initialState, usage: emptyUsage(), elapsedMs: 1 };
  const judged = judgeInput({ scenario: changed, sources: edited.sources, trial: stub });
  assert.equal(judged.scenario.successCriteria, text);
  assert.equal(judged.scenario.metrics!.find(metric => metric.id === 'goal_attainment')!.passCriteria, text);

  const notes = compareRuns({ ...accepted, id: 'before-run', phase: 'results_review' },
    { ...edited, id: 'after-run', phase: 'results_review' }).notes;
  assert.ok(notes.some(note => note.startsWith('Содержимое карточек изменилось')), notes.join(' | '));

  await assert.rejects(lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(edited), requireAccepted: true }),
    /Сначала подтвердите ожидания ситуаций/);
  assert.equal((await lab.get(draft.id)).phase, 'review', 'a refused start writes nothing');
  const reconfirmed = await lab.acceptDraft(draft.id, draftHash(edited));
  await lab.start(reconfirmed.id, { approved: true, reviewer: 'human', expectedHash: draftHash(reconfirmed), requireAccepted: true });
  await lab.waitForIdle();
  assert.notEqual((await lab.get(draft.id)).phase, 'review', 'a confirmed draft starts');
});

test('an exact-check situation keeps the old refusal; the owner marker survives hashes, schema, repeat and case selection', async t => {
  const { lab } = await setup(t, judgeGoalRuntime());
  const created = await lab.create(judgeGoalInput()); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  const hash = draftHash(draft);
  const card = draft.scenarios[0]!;

  // A situation the judge does not score keeps today's refusal, in setExpectation and in updateDraft.
  const { lab: demoLab } = await setup(t, createDemoRuntime());
  const demo = await demoLab.create({ ...demoInput(), workflow: 'evaluate', scenarioCount: 1 }); await demoLab.waitForIdle();
  const demoDraft = await demoLab.get(demo.id);
  const demoCard = demoDraft.scenarios[0]!;
  assert.equal((demoCard.metrics ?? []).some(metric => metric.id === 'goal_attainment'), false);
  await assert.rejects(demoLab.setExpectation(demoDraft.id, draftHash(demoDraft), demoCard.id, 'Своими словами.'),
    /Эту ситуацию проверяют точные проверки, а не судья\. Поправьте её словами: a\./);
  assert.deepEqual(await demoLab.get(demoDraft.id), demoDraft);
  await assert.rejects(demoLab.updateDraft(demoDraft.id, draftHash(demoDraft), { scenarios: [{ ...demoCard, successCriteria: 'Другое ожидание' }] }),
    /изменилось, а исполняемые проверки остались прежними/);
  // The same edit of a judge-evaluated situation now goes through.
  const relaxed = await lab.updateDraft(draft.id, hash, { scenarios: [{ ...card, successCriteria: 'Другое ожидание' }] });
  assert.equal(relaxed.scenarios.find(item => item.id === card.id)!.successCriteria, 'Другое ожидание');

  const edited = await lab.setExpectation(draft.id, draftHash(relaxed), card.id, 'Ожидание владельца.');
  assert.deepEqual(edited.ownerExpectationScenarioIds, [card.id]);

  // Old records keep their exact hash and the field never enters the measurement hash.
  const legacy = structuredClone(edited); delete legacy.ownerExpectationScenarioIds;
  assert.equal(draftHash(legacy), draftHash({ ...legacy, ownerExpectationScenarioIds: undefined }));
  assert.notEqual(draftHash(edited), draftHash(legacy), 'the marker is part of the draft version');
  // The edit itself already moved the measurement: it rewrote successCriteria and the goal rubric,
  // so the card fingerprint changed. The marker is only a label on that change.
  assert.equal(measurementHash(edited), measurementHash(legacy), 'the marker never changes what is measured');

  experimentSchema.parse(legacy);
  assert.throws(() => experimentSchema.parse({ ...edited, ownerExpectationScenarioIds: ['not_a_card'] }), /ситуации этого набора/);
  assert.throws(() => experimentSchema.parse({ ...edited, ownerExpectationScenarioIds: [card.id, card.id] }), /Duplicate owner expectation IDs/);

  await lab.acceptDraft(edited.id, draftHash(edited));
  const confirmed = await lab.get(edited.id);
  await lab.start(confirmed.id, { approved: true, reviewer: 'human', expectedHash: draftHash(confirmed) });
  await lab.waitForIdle();
  const done = await lab.get(edited.id);
  const repeated = await lab.repeat(done.id);
  assert.deepEqual(repeated.ownerExpectationScenarioIds, [card.id], 'a repeat keeps the marker');
  const narrowed = await lab.repeat(done.id, [done.scenarios[1]!.id]);
  assert.equal(narrowed.ownerExpectationScenarioIds, undefined, 'a --case selection drops markers of situations left out');
});

test('validation grounds expectations and user facts, uses reactive turns, excludes missing customer data and masked dialogues', async t => {
  const policy = 'Отвечайте по базе знаний и не отправляйте клиента в поддержку.';
  const dialogues = Array.from({ length: 3 }, (_, index) => ({ id: `real_${index}`, outcome: index === 0 ? 'failure' as const : 'success' as const,
    messages: [
      { role: 'user' as const, content: `Вопрос ${index}` }, { role: 'assistant' as const, content: 'Уточните деталь.' },
      { role: 'user' as const, content: `Деталь ${index}` }, { role: 'assistant' as const, content: 'Ответ из базы.' },
    ] }));
  let grounded = false;
  let prepareCalls = 0, activeGoals = 0, maxActiveGoals = 0;
  const attempts = new Map<string, number>();
  const runtime: Runtime = {
    async prepare(input) {
      assert.equal(input.scenarioCount, 0);
      grounded = true; prepareCalls++;
      return { requirements: [{ id: 'reply_rule', text: policy, sourceId: 'source-1', quote: policy, critical: true }], questions: [],
        agent: { name: 'Real agent', instructions: policy, tools: [] }, scenarios: [] };
    },
    async goals(input) {
      assert.equal(grounded, true);
      assert.equal(input.requireApplicable, true);
      assert.deepEqual(input.requirements?.map(requirement => requirement.id), ['reply_rule']);
      assert.equal(input.dialogues.length, 1);
      const dialogue = input.dialogues[0]!;
      attempts.set(dialogue.id, (attempts.get(dialogue.id) ?? 0) + 1);
      activeGoals++; maxActiveGoals = Math.max(maxActiveGoals, activeGoals);
      await new Promise(resolve => setTimeout(resolve, 5)); activeGoals--;
      if (dialogue.id === 'real_1' && attempts.get(dialogue.id) === 1) throw new Error('Pi provider response incomplete: connection failure');
      return [{ id: `goal_${dialogue.id}`, goal: `Ответить на ${dialogue.id}`, opening: dialogue.messages[0]!.content,
        facts: `Пользователь сообщил: ${dialogue.messages.filter(m => m.role === 'user').map(m => m.content).join('; ')}`,
        testability: dialogue.id === 'customer' ? 'customer_data' : 'knowledge', testabilityReason: dialogue.id === 'customer' ? 'Нужна персональная ставка клиента.' : 'Достаточно базы знаний.',
        requirementIds: ['reply_rule'], evidenceDialogueIds: [dialogue.id], successCriteria: policy }];
    },
    async improve() { throw new Error('unused'); }, async openTarget() { throw new Error('unused'); }, async userTurn() { throw new Error('unused'); },
  };
  const { lab } = await setup(t, runtime);
  const created = await lab.create(createInputSchema.parse({ task: 'Проверить ответы', mode: 'live', scenarioCount: 0, validationCount: 4, dialogues: [...dialogues,
    { id: 'customer', messages: [{ role: 'user', content: 'Какая у меня ставка?' }] },
    { id: 'masked', messages: [{ role: 'user', content: '*** ###' }] }],
    materials: [{ name: 'prompt', kind: 'prompt', content: policy }], settings: { userModes: ['scripted'], maxTurns: 16 } }));
  await lab.waitForIdle();
  const draft = await lab.get(created.id);
  assert.equal(draft.phase, 'review', draft.error ?? '');
  assert.deepEqual(draft.scenarios.map(card => card.id), dialogues.map(dialogue => dialogue.id));
  assert.ok(draft.scenarios.every(card => card.goalObservation === 'reply'));
  assert.deepEqual(draft.settings.userModes, ['reactive']);
  assert.ok(draft.scenarios.every(card => card.user.script === undefined && card.user.facts.includes('Деталь')));
  assert.ok(draft.scenarios.every(card => /передал вопрос оператору/.test(card.user.behavior) && /Каждый раз, когда агент называет другую организацию/.test(card.user.behavior)), 'the simulator stops after a handoff and corrects every wrong object');
  assert.ok(draft.scenarios.every(card => card.metrics?.map(metric => metric.id).join(',') === 'prompt_compliance,goal_attainment,reply_quality,user_fidelity'));
  assert.match(draft.limitations.join('\n'), /Исключён customer: Нужна персональная ставка/);
  assert.match(draft.limitations.join('\n'), /Исключён masked:/);
  assert.match(draft.limitations.join('\n'), /Измеримы 3 из запрошенных 4/);
  assert.deepEqual(draft.validationExclusions, [
    { dialogueId: 'masked', kind: 'masked', reason: 'реплика клиента целиком скрыта обезличиванием' },
    { dialogueId: 'customer', kind: 'customer_data', reason: 'Нужна персональная ставка клиента.' },
  ]);
  assert.equal(qualityLines(qualitySummary(draft)).coverage, 'Не вошли в набор 2 диалога: нужны данные клиента — 1, реплика клиента скрыта — 1. В accuracy они не считаются.');
  assert.equal(attempts.has('masked'), false, 'masked-only turns never reach the model');
  assert.equal(attempts.get('real_1'), 2, 'one transient transport failure is retried once');
  assert.ok(maxActiveGoals >= 4, `recorded dialogues are read in wide parallel batches, saw ${maxActiveGoals}`);
  const again = await lab.create(createInputSchema.parse({ task: 'Проверить ответы', mode: 'live', scenarioCount: 0, validationCount: 4, dialogues,
    materials: [{ name: 'prompt', kind: 'prompt', content: policy }], settings: { userModes: ['scripted'], maxTurns: 16 } }));
  await lab.waitForIdle();
  const repeated = await lab.get(again.id);
  assert.equal(repeated.phase, 'review', repeated.error ?? '');
  assert.equal(prepareCalls, 1, 'identical materials, task and model reuse the grounded requirements');
  assert.deepEqual(repeated.requirements, draft.requirements);
  assert.match(repeated.limitations.join('\n'), /Требования взяты из кэша подготовки/);
});

/** A validation build whose model goal ids are chosen by `goalId`; `null` means the model found no goal. */
async function validationBuild(t: TestContext, goalId: (dialogueId: string) => string | null) {
  const policy = 'Отвечайте по базе знаний.';
  const dialogues = ['real_a', 'real_b', 'real_c'].map(id => ({ id, messages: [
    { role: 'user' as const, content: `Вопрос ${id}` }, { role: 'assistant' as const, content: 'Ответ из базы.' },
  ] }));
  const runtime: Runtime = {
    async prepare() {
      return { requirements: [{ id: 'reply_rule', text: policy, sourceId: 'source-1', quote: policy, critical: true }], questions: [],
        agent: { name: 'Real agent', instructions: policy, tools: [] }, scenarios: [] };
    },
    async goals(input) {
      const dialogue = input.dialogues[0]!;
      const id = goalId(dialogue.id);
      if (id === null) return [];
      return [{ id, goal: `Ответить на ${dialogue.id}`, opening: dialogue.messages[0]!.content, facts: 'Только вопрос.',
        testability: 'knowledge', testabilityReason: 'Достаточно базы знаний.', requirementIds: ['reply_rule'],
        evidenceDialogueIds: [dialogue.id], successCriteria: policy }];
    },
    async improve() { throw new Error('unused'); }, async openTarget() { throw new Error('unused'); }, async userTurn() { throw new Error('unused'); },
  };
  const { lab } = await setup(t, runtime);
  const created = await lab.create(createInputSchema.parse({ task: 'Проверить ответы', mode: 'live', scenarioCount: 0, validationCount: 3, dialogues,
    materials: [{ name: 'prompt', kind: 'prompt', content: policy }], settings: { userModes: ['scripted'], maxTurns: 16 } }));
  await lab.waitForIdle();
  return { draft: await lab.get(created.id), dialogues };
}
const GOAL_ID_COLLISION = 'Модель выдала совпадающие id целей; каждой цели присвоен id её диалога.';

test('a validation build with colliding model goal ids keeps one card per dialogue and names the collision', async t => {
  const { draft, dialogues } = await validationBuild(t, () => 'same');
  assert.equal(draft.phase, 'review', draft.error ?? '');
  assert.deepEqual(draft.scenarios.map(card => card.id), dialogues.map(dialogue => dialogue.id));
  assert.ok(draft.limitations.includes(GOAL_ID_COLLISION));
});

test('distinct model goal ids leave no collision note and cards still carry dialogue ids', async t => {
  const { draft, dialogues } = await validationBuild(t, id => `goal_${id}`);
  assert.equal(draft.phase, 'review', draft.error ?? '');
  assert.deepEqual(draft.scenarios.map(card => card.id), dialogues.map(dialogue => dialogue.id));
  assert.equal(draft.limitations.includes(GOAL_ID_COLLISION), false);
});

test('a dialogue without a model goal is an unconfirmed exclusion, not a duplicate-id failure', async t => {
  const { draft } = await validationBuild(t, id => id === 'real_b' ? null : 'same');
  assert.equal(draft.phase, 'review', draft.error ?? '');
  assert.deepEqual(draft.scenarios.map(card => card.id), ['real_a', 'real_c']);
  assert.deepEqual(draft.validationExclusions?.map(item => [item.dialogueId, item.kind]), [['real_b', 'unconfirmed']]);
});

test('fifteen unaccepted cards still run, report accuracy, save, load and rerun intact', async t => {
  const { lab, directory } = await setup(t, createDemoRuntime());
  const input = demoEvaluationInput(); input.scenarioCount = 10;
  const created = await lab.create(input); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  const additions = Array.from({ length: 5 }, (_, index) => ({
    ...structuredClone(draft.scenarios[0]!), id: `batch_extra_${index + 1}`, title: `Batch sentinel ${index + 1}`,
  }));
  const batch = await lab.updateDraft(draft.id, draftHash(draft), { scenarios: additions });
  assert.equal(batch.scenarios.length, 15);
  assert.equal(batch.acceptedDraftHash, undefined);
  assert.deepEqual(batch.acceptedTests, []);

  await lab.start(batch.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(batch) }); await lab.waitForIdle();
  const first = await lab.get(batch.id);
  assert.equal(first.phase, 'results_review', first.error ?? '');
  assert.equal(first.trials.length, 15);
  assert.deepEqual(qualitySummary(first).cards, { passed: 2, failed: 13, unknown: 0, invalid: 0, notReached: 0, total: 15, accuracy: 2 / 15 });
  assert.equal(first.acceptedDraftHash, undefined);

  const suitePath = await lab.saveSuite(first.id, join(directory, 'fifteen-card-suite.json'));
  const loaded = await lab.loadSuite(suitePath);
  assert.equal(loaded.scenarios.length, 15);
  assert.equal(loaded.acceptedDraftHash, undefined);
  assert.deepEqual(loaded.acceptedTests, []);
  await lab.start(loaded.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(loaded) }); await lab.waitForIdle();
  const rerun = await lab.get(loaded.id);
  assert.equal(rerun.trials.length, 15);
  assert.deepEqual(rerun.scenarios.map(scenario => scenario.id), first.scenarios.map(scenario => scenario.id));
  assert.deepEqual(qualitySummary(rerun).cards, qualitySummary(first).cards);
  assert.equal(rerun.acceptedDraftHash, undefined);
});

test('one user card requires exact human approval, runs one unchanged agent, then preserves separate human result review', async t => {
  const runtime = createDemoRuntime();
  let targets = 0; let improvements = 0;
  const openTarget = runtime.openTarget;
  runtime.openTarget = async (...args) => { targets++; return openTarget(...args); };
  runtime.improve = async () => { improvements++; throw new Error('Evaluation must not optimize'); };
  const { lab } = await setup(t, runtime);
  const input = demoInput(); input.workflow = 'evaluate'; input.scenarioCount = 1; input.settings.repeats = 1;
  const created = await lab.create(input); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  assert.equal(draft.phase, 'review'); assert.equal(draft.scenarios.length, 1); assert.equal(targets, 0);
  assert.ok(draft.scenarios[0]!.user.persona); assert.ok(draft.scenarios[0]!.metrics?.length);
  const originalHash = draftHash(draft);
  await assert.rejects(lab.start(draft.id, { approved: false, reviewer: 'automated', expectedHash: originalHash }), /подтверждения/);
  await assert.rejects(lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: 'stale' }), /подтверждение.*версии/);
  const cards = structuredClone(draft.scenarios);
  cards[0]!.user.persona = 'A busy customer with one appointment';
  const edited = await lab.updateDraft(draft.id, originalHash, { scenarios: cards });
  assert.notEqual(draftHash(edited), originalHash); assert.equal(edited.reviewedAt, null);
  await assert.rejects(lab.updateDraft(draft.id, originalHash, { scenarios: cards }), /Черновик изменился/);
  await assert.rejects(lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: originalHash }), /подтверждение.*версии/);
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(edited) }); await lab.waitForIdle();
  const result = await lab.get(draft.id);
  assert.equal(result.phase, 'results_review', result.error ?? ''); assert.equal(result.reviewMode, 'human');
  assert.equal(result.revisions.length, 1); assert.equal(result.comparisons.length, 0); assert.equal(improvements, 0);
  assert.equal(targets, 1); assert.equal(result.trials.length, 1); assert.ok(result.trials[0]!.assessments?.length);
  assert.equal(result.manifestHash, measurementHash(result));
  await assert.rejects(lab.updateDraft(draft.id, draftHash(result), { scenarios: cards }), /незапущенный черновик/);
  const originalTrial = structuredClone(result.trials[0]!);
  const priorResultHash = resultHash(result);
  await assert.rejects(lab.addHumanReview(result.id, { trialId: 'missing', verdict: 'invalid', note: 'Wrong user.' }), /Такого диалога/);
  await assert.rejects(lab.addHumanReview(result.id, { trialId: originalTrial.id, metricId: 'missing', verdict: 'fail', note: 'Wrong metric.' }), /Такой рубрики/);
  await assert.rejects(lab.addHumanReview(result.id, { trialId: originalTrial.id, verdict: 'fail', note: 'No event reference.', reviewedDialogue: true }), /ссылаться на событие/);
  const foreignSeq = Math.max(...originalTrial.events.map(event => event.seq)) + 1;
  await assert.rejects(lab.addHumanReview(result.id, { trialId: originalTrial.id, verdict: 'fail', note: `Reviewed #${foreignSeq}.`, reviewedDialogue: true }), /ссылаться на событие/);
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
  const { lab } = await setup(t);
  const input = demoInput(); input.workflow = 'evaluate'; input.scenarioCount = 1; input.settings.repeats = 1;
  const created = await lab.create(input); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  const entered = deferred(); const release = deferred();
  const get = lab.store.get.bind(lab.store); let first = true;
  lab.store.get = async id => {
    const snapshot = await get(id);
    if (first) { first = false; entered.resolve(); await release.promise; }
    return snapshot;
  };
  const starting = lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) });
  await entered.promise;
  const scenarios = structuredClone(draft.scenarios);
  scenarios[0]!.user.persona = 'A newer draft that has not been approved';
  try {
    await assert.rejects(lab.updateDraft(draft.id, draftHash(draft), { scenarios }), /другая операция/);
  } finally { release.resolve(); }
  await starting; await lab.waitForIdle();
  const result = await lab.get(draft.id);
  assert.equal(result.phase, 'results_review', result.error ?? '');
  assert.deepEqual(result.scenarios, draft.scenarios);
  assert.equal(result.trials.length, 1);
});

test('a large malformed assessor response preserves the completed trial with a persistable assessment error', async t => {
  const runtime = createDemoRuntime();
  runtime.assess = async () => Array.from({ length: 8 }, () => ({})) as never;
  const { lab } = await setup(t, runtime);
  const input = demoInput(); input.workflow = 'evaluate'; input.scenarioCount = 1; input.settings.repeats = 1;
  const created = await lab.create(input); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) });
  await lab.waitForIdle();
  const saved = await lab.store.get(draft.id);
  assert.equal(saved.phase, 'results_review', saved.error ?? '');
  assert.equal(saved.trials.length, 1);
  assert.equal(saved.trials[0]!.outcome, 'pass');
  assert.equal(saved.trials[0]!.finalState.records.A101!.time, '14:00');
  assert.equal(saved.trials[0]!.assessments, undefined);
  assert.match(saved.trials[0]!.assessmentError!, /invalid_type/);
  assert.ok(saved.trials[0]!.assessmentError!.length <= 4000);
});

test('evaluation runs every user mode, skips scripted cards without a script, and rejects multi-mode comparison', async t => {
  const { lab } = await setup(t);
  const input = demoInput(); input.workflow = 'evaluate'; input.scenarioCount = 3; input.settings.repeats = 1; input.settings.userModes = ['static', 'scripted', 'reactive'];
  const created = await lab.create(input); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  const withScript = draft.scenarios.filter(s => s.user.script?.length).length;
  assert.ok(withScript >= 1 && withScript < draft.scenarios.length, `scripted cards: ${withScript}`);
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const result = await lab.get(draft.id);
  assert.equal(result.phase, 'results_review', result.error ?? '');
  const byMode = (mode: string) => result.trials.filter(tr => tr.userMode === mode).length;
  assert.deepEqual([byMode('static'), byMode('scripted'), byMode('reactive')], [3, withScript, 3]);
  assert.ok(result.limitations.some(l => /Scripted mode skipped/.test(l)));
  assert.ok(result.trials.filter(tr => tr.userMode === 'static').every(tr => tr.events.filter(e => e.type === 'user').length === 1));
  const compare = demoInput(); compare.settings.userModes = ['static', 'reactive'];
  await assert.rejects(lab.create(compare), /в одном режиме пользователя/);
  await assert.rejects(lab.create(createInputSchema.parse({ ...demoInput(), target: { kind: 'http', url: 'http://localhost:1' } })), /внешнего агента/);
});

test('golden cases and real dialogues enter the draft without inventing user profiles', async t => {
  const { lab } = await setup(t);
  const input = createInputSchema.parse({
    ...demoInput(), workflow: 'evaluate', scenarioCount: 2, settings: { ...demoInput().settings, repeats: 1 },
    goldenCases: [{ id: 'gold_move', goal: 'Move appointment A101 to 14:00', opening: 'Please move appointment A101 to 14:00.', successCriteria: 'A101 is at 14:00',
      initialState: { records: { A101: { time: '09:00', owner: 'Sample customer', status: 'booked' } }, writableFields: ['time'], transientFailures: 0 },
      checks: [{ id: 'time', kind: 'state_equals', description: 'moved', recordId: 'A101', field: 'time', value: '14:00' }] }],
    dialogues: [
      { id: 'd1', messages: [{ role: 'user', content: 'move A101 to 14:00 pls' }, { role: 'assistant', content: 'Done.' }], outcome: 'success' },
      { id: 'd2', messages: [{ role: 'user', content: 'can you move my appt? not sure of the id' }, { role: 'assistant', content: 'Which appointment?' }], outcome: 'abandoned' },
    ],
  });
  const created = await lab.create(input); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  assert.equal(draft.phase, 'review', draft.error ?? '');
  assert.deepEqual(draft.profiles, []);
  const golden = draft.scenarios.find(s => s.id === 'gold_move')!;
  assert.equal(golden.provenance, 'curated'); assert.equal(golden.checks.length, 1); assert.deepEqual(golden.requirementIds, []);
  const synthetic = draft.scenarios.filter(s => s.provenance === 'synthetic');
  assert.equal(synthetic.length, 2);
  assert.ok(synthetic.every(s => !s.profileId));
  assert.notEqual(measurementHash(draft), measurementHash({ ...draft, dialogues: [] }));
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const result = await lab.get(draft.id);
  assert.equal(result.phase, 'results_review', result.error ?? '');
  const goldenTrial = result.trials.find(tr => tr.scenarioId === 'gold_move')!;
  assert.equal(goldenTrial.outcome, 'pass', goldenTrial.reason);
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
  await assert.rejects(lab.updateDraft(draft.id, draftHash(draft), { target: input.target }), /Не найден файл агента/);
  assert.equal(draftHash(await lab.get(draft.id)), draftHash(draft));
});

test('owner profile edits update linked cards, invalidate approval and survive a run and repeat', async t => {
  const runtime = createDemoRuntime();
  const users: unknown[] = []; const userTurn = runtime.userTurn;
  runtime.userTurn = async (input, ctx) => { users.push(structuredClone(input.user)); return userTurn(input, ctx); };
  const { lab } = await setup(t, runtime);
  const created = await lab.create(createInputSchema.parse({ ...demoInput(), workflow: 'evaluate', scenarioCount: 2, settings: { repeats: 1 },
    profiles: [{ id: 'hurried_owner', persona: 'A customer in a hurry', characteristics: ['Terse'] }],
    dialogues: [{ id: 'd1', messages: [{ role: 'user', content: 'move A101 to 14:00 pls' }] }],
  }));
  await lab.waitForIdle();
  const draft = await lab.get(created.id); assert.equal(draft.phase, 'review', draft.error ?? '');
  const original = structuredClone(draft.profiles[0]!);
  const id = original.id;
  const edit = { id, override: { persona: null, characteristics: ['Answers only the question asked'] } };
  const edited = await lab.updateDraft(draft.id, draftHash(draft), { profileEdits: [edit] });
  assert.deepEqual(edited.profiles[0], { ...original, draftOverride: edit.override });
  assert.ok(edited.scenarios.some(s => s.provenance === 'production'));
  assert.ok(edited.scenarios.every(s => s.profileId === id && !s.user.persona));
  assert.ok(edited.scenarios.every(s => s.user.characteristics?.[0] === edit.override.characteristics[0]));
  assert.notEqual(draftHash(edited), draftHash(draft)); assert.notEqual(measurementHash(edited), measurementHash(draft));
  await assert.rejects(lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }), /подтверждение.*версии/);
  for (const profileEdits of [[{ id: 'unknown', override: null }], [edit, edit], [{ id, override: { source: 'owner' } }]]) {
    await assert.rejects(lab.updateDraft(draft.id, draftHash(edited), { profileEdits } as never));
    assert.deepEqual(await lab.get(draft.id), JSON.parse(JSON.stringify(edited)), 'a rejected edit must leave the saved draft intact');
  }
  const silentEdit = structuredClone(edited.scenarios); silentEdit[0]!.user.persona = 'Would be overwritten';
  await assert.rejects(lab.updateDraft(draft.id, draftHash(edited), { scenarios: silentEdit }), /profileEdits/);
  const restored = await lab.updateDraft(draft.id, draftHash(edited), { profileEdits: [{ id, override: null }] });
  assert.deepEqual(restored.profiles[0], original); assert.deepEqual(restored.scenarios, draft.scenarios);
  const cleared = await lab.updateDraft(draft.id, draftHash(restored), { profileEdits: [{ id, override: { persona: null, characteristics: [] } }] });
  // Scripted fixture consent: exercise the same freeze/run boundary used by the human Pi UI.
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(cleared) }); await lab.waitForIdle();
  const result = await lab.get(draft.id); assert.equal(result.phase, 'results_review', result.error ?? '');
  assert.ok(users.length); assert.ok(users.every(u => !(u as { persona?: string }).persona));
  await assert.rejects(lab.updateDraft(draft.id, draftHash(result), { profileEdits: [{ id, override: null }] }), /незапущенный черновик/);
  const repeated = await lab.repeat(result.id);
  assert.deepEqual(repeated.profiles, cleared.profiles); assert.deepEqual(repeated.scenarios, cleared.scenarios);
  assert.equal(repeated.phase, 'review'); assert.equal(repeated.reviewMode, null); assert.equal(repeated.trials.length, 0);
});

test('logs yield production goals without requiring a user profile', async t => {
  const runtime = createDemoRuntime();
  const prepare = runtime.prepare;
  runtime.prepare = async (input, ctx) => {
    const result = await prepare(input, ctx);
    for (const scenario of result.scenarios) { delete scenario.user.persona; delete scenario.user.characteristics; }
    return result;
  };
  const { lab } = await setup(t, runtime);
  const created = await lab.create(createInputSchema.parse({ ...demoInput(), workflow: 'evaluate', scenarioCount: 1,
    dialogues: [{ id: 'd1', messages: [{ role: 'user', content: 'move A101 to 14:00 pls' }] }],
  }));
  await lab.waitForIdle(); const draft = await lab.get(created.id);
  assert.equal(draft.phase, 'review', draft.error ?? ''); assert.deepEqual(draft.profiles, []);
  assert.equal(draft.scenarios.length, 2); assert.ok(draft.scenarios.every(s => !s.profileId && !s.user.persona));
  assert.equal(draft.scenarios.find(s => s.provenance === 'production')!.user.opening, 'move A101 to 14:00 pls');
});

test('owner notes and owner profiles are first-class inputs: cards may cite an owner profile and the runtime sees the notes', async t => {
  const runtime = createDemoRuntime();
  const prepare = runtime.prepare;
  let seen: { notes?: string; profiles?: { id: string; source: string }[] } = {};
  runtime.prepare = async (input, ctx) => { seen = { notes: input.notes, profiles: input.profiles?.map(p => ({ id: p.id, source: p.source })) }; return prepare(input, ctx); };
  const { lab } = await setup(t, runtime);
  const input = createInputSchema.parse({
    ...demoInput(), workflow: 'evaluate', scenarioCount: 1, notes: 'Most users are in a hurry and do not know their appointment ID.',
    profiles: [{ id: 'hurried_owner', persona: 'A customer in a hurry', characteristics: ['Terse', 'Impatient'] }],
    dialogues: [{ id: 'd1', messages: [{ role: 'user', content: 'move A101 to 14:00' }], outcome: 'success' }],
  });
  const created = await lab.create(input); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  assert.equal(draft.phase, 'review', draft.error ?? '');
  assert.equal(seen.notes, input.notes);
  assert.deepEqual(seen.profiles, [{ id: 'hurried_owner', source: 'owner' }]);
  assert.equal(draft.notes, input.notes);
  assert.deepEqual(draft.profiles.map(p => p.source), ['owner']);
  assert.equal(draft.scenarios[0]!.profileId, 'hurried_owner');
  assert.equal(draft.scenarios[0]!.user.persona, 'A customer in a hurry');
  const edited = await lab.updateDraft(draft.id, draftHash(draft), { settings: { repeats: 2 } });
  assert.equal(edited.scenarios[0]!.profileId, 'hurried_owner');
  assert.equal(edited.settings.repeats, 2);
});

test('real dialogues also yield production cards: observed goals with verbatim openings that cite supplied dialogues', async t => {
  const { lab } = await setup(t);
  const input = createInputSchema.parse({
    ...demoInput(), workflow: 'evaluate', scenarioCount: 1, settings: { ...demoInput().settings, repeats: 1 },
    dialogues: [
      { id: 'd1', messages: [{ role: 'user', content: 'move A101 to 14:00 pls' }, { role: 'assistant', content: 'Done.' }], outcome: 'success' },
      { id: 'd2', messages: [{ role: 'user', content: 'hi, what time is my appointment A102?' }, { role: 'assistant', content: '09:00.' }], outcome: 'success' },
    ],
  });
  const created = await lab.create(input); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  assert.equal(draft.phase, 'review', draft.error ?? '');
  const production = draft.scenarios.filter(s => s.provenance === 'production');
  assert.equal(production.length, 2);
  assert.deepEqual(production.map(s => s.user.opening).sort(), ['hi, what time is my appointment A102?', 'move A101 to 14:00 pls']);
  assert.ok(production.every(s => !s.profileId && !s.user.persona));
  assert.equal(draft.scenarios.filter(s => s.provenance === 'synthetic').length, 1);
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const result = await lab.get(draft.id);
  assert.equal(result.phase, 'results_review', result.error ?? '');
  assert.equal(result.trials.filter(tr => production.some(s => s.id === tr.scenarioId)).length, 2);
});

test('recorded scoring preserves 40, 41 and 200 dialogues through reassessment without truncation', async t => {
  const runtime: Runtime = {
    async prepare({ sources }) {
      return { requirements: [{ id: 'owner_rule', text: 'Answer from the owner material', sourceId: sources[0]!.id,
        quote: sources[0]!.content, critical: false }], questions: [],
        agent: { name: 'Recorded agent', instructions: 'Recorded only', tools: [] }, scenarios: [] };
    },
    async goals({ dialogues }) {
      const dialogue = dialogues[0]!;
      return [{ id: `goal_${dialogue.id}`, goal: `Answer ${dialogue.id}`, opening: dialogue.messages.find(message => message.role === 'user')!.content,
        evidenceDialogueIds: [dialogue.id], requirementIds: ['owner_rule'], successCriteria: 'Answer from the owner material', facts: 'User message only', outcome: 'unknown' }];
    },
    async improve() { throw new Error('score must not improve'); },
    async openTarget() { throw new Error('score must not open the target'); },
    async userTurn() { throw new Error('score must not run the simulator'); },
  };
  const { lab } = await setup(t, runtime);
  const makeInput = (count: number) => createInputSchema.parse({ task: 'Score recorded dialogues', mode: 'live',
    materials: [{ name: 'policy', content: 'Answer from the owner material' }], scenarioCount: 0,
    settings: { maxDurationMs: 14_400_000 },
    dialogues: Array.from({ length: count }, (_, index) => ({ id: `d${index}`, goal: `Goal ${index}`,
      messages: [{ role: 'user' as const, content: `Question ${index}` }, { role: 'assistant' as const, content: `Answer ${index}` }] })),
  });
  let largest;
  for (const count of [40, 41, 200]) {
    const seed = await lab.score(makeInput(count)); await lab.waitForIdle();
    const record = await lab.get(seed.id);
    assert.equal(record.phase, 'results_review', record.error ?? '');
    assert.equal(record.scenarios.length, count);
    assert.equal(record.trials.length, count);
    assert.deepEqual(record.scenarios.map(scenario => scenario.id), record.dialogues.map(dialogue => dialogue.id));
    assert.deepEqual(record.trials.map(trial => trial.id), record.dialogues.map(dialogue => dialogue.id));
    if (count === 200) largest = record;
  }
  assert.ok(largest);
  const reassessed = await lab.reassess(largest.id, { codeOnly: true }); await lab.waitForIdle();
  const copied = await lab.get(reassessed.id);
  assert.equal(copied.phase, 'results_review', copied.error ?? '');
  assert.equal(copied.sourceEvidence!.trials.length, 200);
  assert.deepEqual(copied.trials.map(trial => trial.events), largest.trials.map(trial => trial.events));
  assert.deepEqual(await lab.get(largest.id), largest, 'reassessment must not mutate the imported seed');
  assert.throws(() => makeInput(201));
  assert.throws(() => createInputSchema.parse({ ...makeInput(1), settings: { maxDurationMs: 14_400_001 } }));

  const repeated = await lab.score(makeInput(41)); await lab.waitForIdle();
  const again = await lab.get(repeated.id);
  assert.notEqual(again.id, largest.id);
  assert.deepEqual(again.trials.map(trial => trial.events), largest.trials.slice(0, 41).map(trial => trial.events));
});

test('model-backed recorded scoring grounds criteria, regrades copied traces and rebuilds clusters from saved sources', async t => {
  const calls = { prepare: 0, goals: 0, assess: 0, clusters: 0, target: 0, simulator: 0 };
  const prompts: (string | undefined)[] = [];
  let clusterError = false;
  const runtime: Runtime = {
    async prepare({ sources }, ctx) {
      calls.prepare++;
      ctx.beforeCall(); ctx.addUsage({ inputTokens: 1, outputTokens: 1, costUsd: null });
      return { requirements: [{ id: 'owner_rule', text: 'Do not claim completion without evidence.', sourceId: sources[0]!.id,
        quote: sources[0]!.content, critical: true }], questions: [], agent: { name: 'Recorded agent', instructions: 'Recorded only', tools: [] }, scenarios: [] };
    },
    async goals({ dialogues, requirements }, ctx) {
      calls.goals++;
      ctx.beforeCall(); ctx.addUsage({ inputTokens: 1, outputTokens: 1, costUsd: null });
      assert.deepEqual(requirements?.map(requirement => requirement.id), ['owner_rule']);
      const dialogue = dialogues[0]!;
      return [{ id: `goal_${dialogue.id}`, goal: 'Create the request', opening: dialogue.messages[0]!.content,
        evidenceDialogueIds: [dialogue.id], requirementIds: ['owner_rule'], successCriteria: 'The request exists in observable state.' }];
    },
    async assess({ scenario, trial }, ctx) {
      calls.assess++;
      ctx.beforeCall();
      ctx.addUsage({ inputTokens: 7, outputTokens: 3, costUsd: null });
      assert.deepEqual(trial.events.map(event => event.text), ['Создай заявку', 'Готово ✅, заявка создана']);
      return scenario.metrics!.map(metric => ({ metricId: metric.id, result: metric.id === 'goal_attainment' ? 'fail' as const : 'pass' as const,
        rationale: metric.id === 'goal_attainment' ? 'Нет наблюдаемого результата действия.' : 'Ответ можно оценить независимо.', evidence: [1] }));
    },
    async failureModes(input, ctx) {
      calls.clusters++; prompts.push(input.prompt);
      ctx.beforeCall(); ctx.addUsage({ inputTokens: 1, outputTokens: 1, costUsd: null });
      if (clusterError) throw new Error('cluster unavailable');
      return [{ id: `unsupported_action_${calls.clusters}`, name: `Заявил о создании без результата ${calls.clusters}`,
        description: 'Ассистент подтвердил действие, которого нет в наблюдаемом состоянии.', trialIds: input.failures.map(failure => failure.trialId), promptQuotes: [] }];
    },
    async improve() { throw new Error('score must not improve'); },
    async openTarget() { calls.target++; throw new Error('score must not open the target'); },
    async userTurn() { calls.simulator++; throw new Error('score must not run the simulator'); },
  };
  const { lab, directory } = await setup(t, runtime);
  const promptFile = join(directory, 'live-prompt.md');
  await writeFile(promptFile, 'CHANGED_LIVE_PROMPT');
  const savedPrompt = 'OWNER_SAVED_PROMPT: do not claim completion without observable evidence.';
  const input = createInputSchema.parse({ task: 'Score recorded dialogue', mode: 'live',
    materials: [{ name: 'prompt.md', content: savedPrompt, kind: 'prompt' }], scenarioCount: 0,
    target: { kind: 'command', command: 'never-run', args: [], promptFile },
    dialogues: [{ id: 'd1', messages: [{ role: 'user', content: 'Создай заявку' }, { role: 'assistant', content: 'Готово ✅, заявка создана' }] }],
    settings: { maxCalls: 5 },
  });
  const seed = await lab.score(input); await lab.waitForIdle();
  const imported = await lab.get(seed.id);
  assert.equal(imported.phase, 'results_review', imported.error ?? '');
  assert.equal(imported.usage.calls, 2);
  assert.equal(imported.trials[0]!.assessments, undefined);
  assert.equal(imported.failureModes, undefined);
  assert.equal(imported.scenarios[0]!.goalObservation, 'reply');
  assert.deepEqual(imported.scenarios[0]!.metrics!.map(metric => metric.id), ['prompt_compliance', 'goal_attainment', 'reply_quality']);
  const legacy = structuredClone(imported);
  delete legacy.scenarios[0]!.goalObservation;
  await lab.store.save(legacy);
  const repeatedLegacy = await lab.repeat(imported.id);
  assert.equal(repeatedLegacy.scenarios[0]!.goalObservation, 'reply', 'repeating an external legacy run upgrades only its fresh draft');
  assert.equal((await lab.get(imported.id)).scenarios[0]!.goalObservation, undefined, 'the legacy source remains immutable');
  await writeFile(promptFile, 'A NEWER PROMPT THAT MUST NOT BE READ');

  const first = await lab.reassess(imported.id, {}, { carryUsage: true }); await lab.waitForIdle();
  const assessed = await lab.get(first.id);
  assert.equal(assessed.phase, 'results_review', assessed.error ?? '');
  assert.equal(assessed.scenarios[0]!.goalObservation, 'reply', 'reassessment upgrades an external legacy copy');
  assert.equal((await lab.get(imported.id)).scenarios[0]!.goalObservation, undefined, 'reassessment also leaves the legacy source immutable');
  assert.deepEqual(assessed.trials[0]!.assessments!.map(item => item.metricId), ['prompt_compliance', 'goal_attainment', 'reply_quality']);
  assert.deepEqual(prompts, [savedPrompt]);
  assert.match(assessed.failureModes![0]!.id, /_1$/);
  assert.deepEqual([calls.target, calls.simulator], [0, 0]);
  assert.equal(assessed.usage.costUsd, null);
  assert.equal(assessed.usage.calls, 4, 'score and reassessment share the confirmed call ceiling');
  assert.match(qualityLines(qualitySummary(assessed)).scope, /стоимость неизвестна/);

  const second = await lab.reassess(assessed.id); await lab.waitForIdle();
  const rebuilt = await lab.get(second.id);
  assert.deepEqual(rebuilt.failureModes!.map(mode => mode.id), ['unsupported_action_2']);
  assert.deepEqual(prompts, [savedPrompt, savedPrompt]);

  clusterError = true;
  const failedCluster = await lab.reassess(imported.id); await lab.waitForIdle();
  const survived = await lab.get(failedCluster.id);
  assert.equal(survived.phase, 'results_review');
  assert.ok(survived.trials[0]!.assessments?.length);
  assert.equal(survived.failureModes, undefined);
  assert.ok(survived.limitations.some(note => /cluster unavailable/.test(note)));

  const beforeCodeOnly = { ...calls };
  const exactOnly = await lab.reassess(imported.id, { codeOnly: true }); await lab.waitForIdle();
  const codeOnly = await lab.get(exactOnly.id);
  assert.deepEqual(calls, beforeCodeOnly);
  assert.equal(codeOnly.failureModes, undefined);
  assert.ok(codeOnly.limitations.some(note => /code-only/i.test(note)));
});

test('model-backed score rejects missing, duplicate and unknown grounded goals before publishing criteria', async t => {
  let goals: Awaited<ReturnType<NonNullable<Runtime['goals']>>> = [];
  const runtime: Runtime = {
    async prepare({ sources }) { return { requirements: [{ id: 'known', text: 'Known rule', sourceId: sources[0]!.id, quote: sources[0]!.content, critical: true }], questions: [], agent: { name: 'A', instructions: 'A', tools: [] }, scenarios: [] }; },
    async goals() { return goals; }, async improve() { throw new Error('unused'); }, async openTarget() { throw new Error('unused'); }, async userTurn() { throw new Error('unused'); },
  };
  const { lab } = await setup(t, runtime);
  const input = createInputSchema.parse({ task: 'Score', mode: 'live', materials: [{ name: 'policy', content: 'Known rule' }], scenarioCount: 0,
    dialogues: [{ id: 'd1', messages: [{ role: 'user', content: 'Question' }, { role: 'assistant', content: 'Answer' }] }] });
  const valid = { id: 'g', goal: 'Get an answer', opening: 'Question', evidenceDialogueIds: ['d1'], requirementIds: ['known'], successCriteria: 'Known rule' };
  for (const value of [[], [valid, { ...valid, id: 'g2' }], [{ ...valid, requirementIds: ['missing'] }]]) {
    goals = value;
    const pending = await lab.score(input); await lab.waitForIdle();
    const record = await lab.get(pending.id);
    assert.equal(record.phase, 'error');
    assert.match(record.error ?? '', /ровно одну цель|неизвестн/i);
    assert.equal(record.scenarios.length, 0);
    assert.equal(record.trials.length, 0);
  }
});

test('open owner questions preserve imported facts but stop goal extraction and reassessment', async t => {
  const calls = { goals: 0, assess: 0 };
  const runtime: Runtime = {
    async prepare({ sources }) { return { requirements: [{ id: 'ambiguous', text: 'Follow the applicable policy', sourceId: sources[0]!.id,
      quote: sources[0]!.content, critical: true }], questions: ['Which policy applies?'], agent: { name: 'Recorded', instructions: 'Recorded', tools: [] }, scenarios: [] }; },
    async goals() { calls.goals++; throw new Error('unresolved questions must stop goals'); },
    async assess() { calls.assess++; throw new Error('unresolved questions must stop judging'); },
    async improve() { throw new Error('unused'); }, async openTarget() { throw new Error('unused'); }, async userTurn() { throw new Error('unused'); },
  };
  const { lab } = await setup(t, runtime);
  const input = createInputSchema.parse({ task: 'Score ambiguous dialogue', mode: 'live', scenarioCount: 0,
    materials: [{ name: 'policy.md', content: 'Follow the applicable policy.' }],
    dialogues: [{ id: 'd1', messages: [{ role: 'user', content: 'Сделай по правилам' }, { role: 'assistant', content: 'Готово' }] }],
  });
  const seed = await lab.score(input); await lab.waitForIdle();
  const record = await lab.get(seed.id);
  assert.equal(record.phase, 'results_review', record.error ?? '');
  assert.deepEqual(record.questions, ['Which policy applies?']);
  assert.equal(record.trials.length, 1);
  assert.deepEqual(calls, { goals: 0, assess: 0 });
  await assert.rejects(lab.reassess(record.id), /открытые вопросы владельца/);
});

test('recorded scoring keeps the existing one-writer rejection instead of interleaving mutations', async t => {
  const entered = deferred(); const release = deferred();
  const runtime: Runtime = {
    async prepare({ sources }) {
      entered.resolve(); await release.promise;
      return { requirements: [{ id: 'owner_rule', text: 'Owner rule', sourceId: sources[0]!.id, quote: 'Owner rule', critical: false }],
        questions: [], agent: { name: 'Recorded agent', instructions: 'Recorded only', tools: [] }, scenarios: [] };
    },
    async goals({ dialogues }) { const dialogue = dialogues[0]!; return [{ id: `goal_${dialogue.id}`, goal: 'Answer', opening: dialogue.messages[0]!.content,
      evidenceDialogueIds: [dialogue.id], requirementIds: ['owner_rule'], successCriteria: 'Owner rule' }]; },
    async improve() { throw new Error('unused'); }, async openTarget() { throw new Error('unused'); }, async userTurn() { throw new Error('unused'); },
  };
  const { lab } = await setup(t, runtime);
  const input = createInputSchema.parse({ task: 'Score', mode: 'live', materials: [{ name: 'policy', content: 'Owner rule' }], scenarioCount: 0,
    dialogues: [{ id: 'd1', messages: [{ role: 'user', content: 'Question' }, { role: 'assistant', content: 'Answer' }] }] });
  const first = lab.score(input);
  await entered.promise;
  try { await assert.rejects(lab.score(input), /другая операция/); }
  finally { release.resolve(); }
  const seed = await first; await lab.waitForIdle();
  const record = await lab.get(seed.id);
  assert.equal(record.phase, 'results_review', record.error ?? '');
  assert.equal(record.trials.length, 1);
});

test('an observed goal whose opening is not a real user message fails preparation', async t => {
  const runtime = createDemoRuntime();
  runtime.goals = async () => [{ id: 'g', goal: 'x', opening: 'never said this', evidenceDialogueIds: ['d1'], successCriteria: 'y', facts: 'f', outcome: 'unknown' }];
  const { lab } = await setup(t, runtime);
  const input = createInputSchema.parse({ ...demoInput(), workflow: 'evaluate', scenarioCount: 1, dialogues: [{ id: 'd1', messages: [{ role: 'user', content: 'hello' }] }] });
  const created = await lab.create(input); await lab.waitForIdle();
  const failed = await lab.get(created.id);
  assert.equal(failed.phase, 'error');
  assert.match(failed.error ?? '', /opening/i);
});

test('repeat keeps the approved suite, discards results and requires fresh approval; target drift blocks execution', async t => {
  const { lab, directory } = await setup(t);
  const path = join(directory, 'target.mjs');
  await writeFile(path, 'export function createSession() { return { respond: () => "hello" }; }');
  const input = createInputSchema.parse({ ...demoInput(), workflow: 'evaluate', scenarioCount: 1,
    target: { kind: 'module', path }, targetVersion: 'v1', settings: { ...demoInput().settings, repeats: 1, userModes: ['static'] } });
  const created = await lab.create(input); await lab.waitForIdle();
  let draft = await lab.get(created.id);
  assert.equal(draft.scenarios[0]!.goalObservation, 'reply', 'external cards default to reply evidence');
  await assert.rejects(lab.repeat(draft.id), /утверждёнными/);
  await writeFile(path, 'export function createSession() { return { respond: () => "new answer" }; }');
  await assert.rejects(lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }), /изменил/);
  draft = await lab.updateDraft(draft.id, draftHash(draft), { targetVersion: 'v2' });
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const before = await lab.get(draft.id);
  assert.equal(before.phase, 'results_review', before.error ?? '');
  const after = await lab.repeat(before.id);
  assert.notEqual(after.id, before.id); assert.equal(after.parentRunId, before.id);
  assert.deepEqual(after.scenarios, before.scenarios); assert.deepEqual(after.settings, before.settings);
  assert.deepEqual(after.trials, []); assert.deepEqual(after.humanReviews, []); assert.equal(after.reviewedAt, null);
  assert.equal(after.targetVersion, 'v2'); assert.equal(after.phase, 'review');
  assert.deepEqual((await lab.get(before.id)).trials, before.trials);
  await assert.rejects(lab.start(after.id, { approved: false, reviewer: 'automated', expectedHash: draftHash(after) }), /подтверждения/);

  const explicit = await lab.create({ ...input, goalObservation: 'state' }); await lab.waitForIdle();
  assert.equal((await lab.get(explicit.id)).scenarios[0]!.goalObservation, 'state', 'the owner-selected channel wins over the external default');
});

test('rubric-only agent failures reach clustering', async t => {
  const runtime = createDemoRuntime();
  const prepare = runtime.prepare;
  runtime.prepare = async (...args) => { const p = await prepare(...args); p.scenarios.forEach(s => { s.checks = []; }); return p; };
  runtime.assess = async ({ scenario }) => scenario.metrics!.map(m => ({ metricId: m.id, result: m.subject === 'agent' ? 'fail' : 'pass', rationale: 'evidence', evidence: [0] }));
  runtime.failureModes = async ({ failures }) => [{ id: 'goal_failed', name: 'Цель не достигнута', description: 'Рубрика зафиксировала провал цели.', trialIds: failures.map(f => f.trialId) }];
  const { lab } = await setup(t, runtime);
  const created = await lab.create({ ...demoInput(), workflow: 'evaluate', scenarioCount: 1 }); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const result = await lab.get(draft.id);
  assert.ok(result.trials.every(t => t.outcome === 'ungraded'));
  assert.deepEqual(result.failureModes?.[0]?.trialIds, result.trials.map(t => t.id));
});

test('one-card edits preserve neighbours; only explicit removals delete and invalid changes save nothing', async t => {
  const { lab } = await setup(t);
  const created = await lab.create({ ...demoInput(), workflow: 'evaluate', scenarioCount: 5 }); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  const changed = { ...draft.scenarios[1]!, title: 'Только вторая карточка' };
  const edited = await lab.updateDraft(draft.id, draftHash(draft), { scenarios: [changed] });
  assert.equal(edited.scenarios.length, 5);
  assert.deepEqual(edited.scenarios.map(s => s.id), draft.scenarios.map(s => s.id));
  assert.deepEqual(edited.scenarios.filter(s => s.id !== changed.id), draft.scenarios.filter(s => s.id !== changed.id));
  assert.match(edited.message, /изменено 1, добавлено 0, удалено 0/);
  const extra = { ...changed, id: 'new_card', title: 'Новая карточка' };
  const updated = await lab.updateDraft(draft.id, draftHash(edited), { scenarios: [extra], removeScenarioIds: [draft.scenarios[0]!.id] });
  assert.equal(updated.scenarios.length, 5);
  assert.equal(updated.scenarios.at(-1)!.id, extra.id);
  assert.equal(updated.scenarios.some(s => s.id === draft.scenarios[0]!.id), false);
  assert.match(updated.message, /изменено 0, добавлено 1, удалено 1/);
  const hash = draftHash(updated);
  const saved = await lab.get(draft.id);
  for (const patch of [
    { removeScenarioIds: ['missing'] }, { removeScenarioIds: updated.scenarios.map(s => s.id) },
    { scenarios: [{ ...changed, user: { ...changed.user, maxFollowUps: -1 } }] },
    { scenarios: [{ ...changed, profileId: 'missing_profile' }] },
    { scenarios: [changed], settings: { repeats: 0 } },
  ]) {
    await assert.rejects(lab.updateDraft(draft.id, hash, patch));
    assert.deepEqual(await lab.get(draft.id), saved);
  }
  await assert.rejects(lab.updateDraft(draft.id, draftHash(draft), { scenarios: [changed] }), /Черновик изменился/);
  assert.deepEqual(await lab.get(draft.id), saved);
});

test('finalizing requires decisive failure review and preserves original evidence', async t => {
  const { lab } = await setup(t);
  const input = createInputSchema.parse({ ...demoInput(), workflow: 'evaluate', scenarioCount: 2, settings: { repeats: 1 } });
  const created = await lab.create(input); await lab.waitForIdle();
  let draft = await lab.get(created.id);
  draft = await lab.updateDraft(draft.id, draftHash(draft), { agent: { ...draft.revisions[0]!.spec, tools: ['search_materials', 'lookup_record'] } });
  assert.match(draft.message, /Агент обновлён/);
  await lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  let result = await lab.get(draft.id);
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
  const { lab } = await setup(t, createDemoRuntime());
  const base = demoEvaluationInput();
  const created = await lab.create(createInputSchema.parse({ ...base, scenarioCount: 1, settings: { ...base.settings, userModes: ['reactive'], repeats: 1 } }));
  await lab.waitForIdle();
  await lab.start(created.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(await lab.get(created.id)) }); await lab.waitForIdle();
  const record = await lab.get(created.id);
  const trial = record.trials[0]!;
  const scenario = record.scenarios.find(candidate => candidate.id === trial.scenarioId)!;
  record.scenarios = [scenario]; record.trials = [trial]; record.humanReviews = [];
  scenario.metrics = [{ id: 'simulator_metric', name: 'Simulator metric', subject: 'simulator', description: 'd', passCriteria: 'p', failCriteria: 'f' }];
  trial.userMode = 'reactive'; trial.outcome = 'ungraded'; trial.checks = [];
  if (!trial.events.some(event => event.type === 'simulator')) trial.events.push({ seq: Math.max(...trial.events.map(event => event.seq)) + 1, type: 'simulator', text: 'reply' });
  trial.simulatorChecks = [{ id: 'simulator_loop', description: 'loop', passed: false, evidence: 'e', heuristic: false }];
  trial.assessments = [{ metricId: 'simulator_metric', result: 'fail', rationale: 'r', evidence: [trial.events[0]!.seq] }];
  await lab.store.save(record);
  let reviewed = await lab.addHumanReview(record.id, { trialId: trial.id, checkId: 'simulator_loop', verdict: 'invalid', note: 'ошибочна проверка' });
  reviewed = await lab.addHumanReview(record.id, { trialId: trial.id, metricId: 'simulator_metric', verdict: 'invalid', note: 'ошибочна рубрика' });
  assert.equal(simulatorUsable(scenario, trial, reviewed.humanReviews), true);
  assert.equal(awaitingVerdict(reviewed).size, 0);
  assert.equal(qualitySummary(reviewed).humanQueue.simulatorFlags, 0);
  assert.equal((await lab.reviewResults(record.id, resultHash(reviewed))).phase, 'complete');
});

test('the active snapshot names the current card and target wait before a trial finishes', async t => {
  const runtime = createDemoRuntime();
  const entered = deferred(); const release = deferred();
  const grading = deferred(); const releaseGrading = deferred();
  const assess = runtime.assess!;
  runtime.openTarget = async () => ({ async respond() { entered.resolve(); await release.promise; return 'Ответ'; }, async close() {} });
  runtime.assess = async (...args) => { grading.resolve(); await releaseGrading.promise; return assess(...args); };
  const { lab } = await setup(t, runtime);
  const created = await lab.create(createInputSchema.parse({ ...demoInput(), workflow: 'evaluate', scenarioCount: 1, settings: { repeats: 1 } })); await lab.waitForIdle();
  const draft = await lab.get(created.id);
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
  const { lab, directory } = await setup(t);
  const entry = join(directory, 'agent.mjs'); await writeFile(entry, '// local target fixture');
  const input = createInputSchema.parse({ ...demoInput(), workflow: 'evaluate', scenarioCount: 1,
    target: { kind: 'command', command: 'agent-lab-no-such-executable-fixture', args: [entry] } });
  const created = await lab.create(input); await lab.waitForIdle();
  const failed = await lab.get(created.id);
  assert.equal(failed.phase, 'error'); assert.equal(failed.usage.calls, 0); assert.equal(failed.trials.length, 0);
  const next = await lab.create({ ...input, target: { kind: 'command', command: process.execPath, args: [entry], timeoutMs: 1000 } }); await lab.waitForIdle();
  const draft = await lab.get(next.id); assert.equal(draft.phase, 'review');
  await rm(entry);
  await assert.rejects(lab.start(draft.id, { approved: true, reviewer: 'human', expectedHash: draftHash(draft) }), /Не найден файл агента/);
  assert.deepEqual(await lab.get(draft.id), draft);
});

const stdioFixture = fileURLToPath(new URL('./fixtures/stdio-agent.mjs', import.meta.url));
function externalInput(release?: { command: string; args: string[] }, mode: 'ok' | 'external' = 'ok') {
  const base = demoEvaluationInput();
  return createInputSchema.parse({ ...base, scenarioCount: 1, settings: { ...base.settings, userModes: ['static'], repeats: 1 },
    target: { kind: 'command', command: process.execPath, args: [stdioFixture, mode], timeoutMs: 5000, ...(release ? { release } : {}) } });
}

test('the release hook runs once before the first dialogue with the run identity, and a failing hook stops the run', async t => {
  const { lab, directory } = await setup(t, createDemoRuntime());
  const marker = join(directory, 'deployed.txt');
  process.env.AGENT_LAB_MARKER = marker;
  t.after(() => { delete process.env.AGENT_LAB_MARKER; });
  const created = await lab.create(externalInput({ command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.env.AGENT_LAB_MARKER, process.env.AGENT_LAB_RUN_ID)'] }));
  await lab.waitForIdle();
  const draft = await lab.get(created.id);
  assert.equal(existsSync(marker), false, 'preparation and preflight never run the hook');
  await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const record = await lab.get(draft.id);
  assert.equal(record.phase, 'results_review', record.error ?? '');
  assert.equal(readFileSync(marker, 'utf8'), record.id);
  assert.equal(record.releaseLog?.exitCode, 0);
  const broken = await lab.create(externalInput({ command: process.execPath, args: ['-e', 'console.error("deploy failed"); process.exit(2)'] }));
  await lab.waitForIdle();
  const draft2 = await lab.get(broken.id);
  await lab.start(draft2.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft2) }); await lab.waitForIdle();
  const failed = await lab.get(draft2.id);
  assert.equal(failed.phase, 'error');
  assert.match(failed.error ?? '', /Хук выпуска завершился с кодом 2/); assert.match(failed.error ?? '', /deploy failed/);
  assert.equal(failed.trials.length, 0, 'no dialogue runs against an undeployed version');
  assert.equal(failed.releaseLog?.exitCode, 2);
});

test('a single failed dialogue is clustered, and a cluster may quote only the agent instructions it was given', async t => {
  const runtime = createDemoRuntime();
  const prompts: (string | undefined)[] = [];
  let quotes = ['Read the appointment before changing it.'];
  runtime.failureModes = async input => { prompts.push(input.prompt); return [{ id: 'no_update', name: 'Прочитал запись, но не изменил её', description: 'd', trialIds: [input.failures[0]!.trialId], promptQuotes: quotes }]; };
  const { lab } = await setup(t, runtime);
  const run = async () => {
    const base = demoEvaluationInput();
    const created = await lab.create(createInputSchema.parse({ ...base, scenarioCount: 1, settings: { ...base.settings, userModes: ['static'], repeats: 1 } }));
    await lab.waitForIdle();
    const draft = await lab.get(created.id);
    await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft) }); await lab.waitForIdle();
    return lab.get(draft.id);
  };
  const named = await run();
  assert.equal(named.trials.length, 1); assert.equal(named.trials[0]!.outcome, 'fail');
  assert.deepEqual(named.failureModes?.map(m => [m.name, m.promptQuotes]), [['Прочитал запись, но не изменил её', ['Read the appointment before changing it.']]]);
  assert.equal(prompts[0], named.revisions[0]!.spec.instructions, 'sandbox clusters see the agent instructions as the prompt');
  quotes = ['this sentence is not in the instructions'];
  const rejected = await run();
  assert.equal(rejected.phase, 'results_review');
  assert.equal(rejected.failureModes, undefined);
  assert.ok(rejected.limitations.some(l => /Не удалось назвать типы провалов/.test(l) && /дословно/.test(l)));
});

test('human verdicts may target simulator checks, reassessment recomputes them, and an unconfirmed external world is a run limitation', async t => {
  const { lab } = await setup(t, createDemoRuntime());
  const base = demoEvaluationInput();
  const created = await lab.create(createInputSchema.parse({ ...base, scenarioCount: 3, settings: { ...base.settings, userModes: ['reactive'], repeats: 1 } }));
  await lab.waitForIdle();
  const draft = await lab.get(created.id);
  await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const record = await lab.get(draft.id);
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
  // The demo runtime refuses scenarioCount 0, so one demo card rides along; the golden card is the one under test.
  const external = await lab.create(createInputSchema.parse({ ...externalInput(undefined, 'ok'), scenarioCount: 1,
    goldenCases: [{ id: 'gold_cards', goal: 'List my cards', opening: 'Which cards do I have?', successCriteria: 'Two cards are listed', maxFollowUps: 0, metrics: [{ id: 'goal', name: 'Goal', subject: 'agent', description: 'd', passCriteria: 'p', failCriteria: 'f' }],
      initialState: { records: {}, writableFields: [], transientFailures: 0, external: { cards: [{ id: 'c1' }, { id: 'c2' }] } } }] }));
  await lab.waitForIdle();
  const draft2 = await lab.get(external.id);
  await lab.start(draft2.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft2) }); await lab.waitForIdle();
  const unconfirmed = await lab.get(draft2.id);
  assert.ok(unconfirmed.limitations.includes('Внешнее состояние карточек не подтверждено адаптером (resetConfirmed): проверки состояния не измерены.'), unconfirmed.limitations.join('\n'));
  assert.match(unconfirmed.trials.find(t => t.scenarioId === 'gold_cards')!.reason, /не подтверждено адаптером/);
  const repeated = await lab.repeat(unconfirmed.id);
  assert.ok(!repeated.limitations.some(l => l.startsWith('Внешнее состояние карточек')));
});

test('a run may drive several dialogues at once: their trace events interleave, while the default keeps them one after another', async t => {
  const { lab } = await setup(t);
  const order = async (parallel: number | undefined) => {
    const record = await lab.create(demoEvaluationInput()); await lab.waitForIdle();
    await lab.start(record.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(await lab.get(record.id)), ...(parallel ? { parallel } : {}) }); await lab.waitForIdle();
    const result = await lab.get(record.id);
    assert.equal(result.phase, 'results_review', result.error ?? result.message); assert.equal(result.trials.length, 3);
    const journal = (await lab.store.traceJournal(record.id)).trim().split('\n').map(line => JSON.parse(line).trialId as string);
    // How many times the journal switches from one dialogue to another: 2 when dialogues run one after another, more when they overlap.
    return journal.filter((id, i) => i > 0 && journal[i - 1] !== id).length;
  };
  assert.equal(await order(undefined), 2);
  assert.ok(await order(3) > 2, 'three parallel dialogues must interleave their traces');
});

/** A judge that answers every requested rubric as met, citing the assistant reply (seq 1). */
function agreeingJudgeRuntime(): Runtime {
  return {
    async prepare({ sources }) {
      return { requirements: [{ id: 'owner_rule', text: 'Answer from the owner material', sourceId: sources[0]!.id,
        quote: sources[0]!.content, critical: false }], questions: [],
        agent: { name: 'Recorded agent', instructions: 'Recorded only', tools: [] }, scenarios: [] };
    },
    async goals({ dialogues }) {
      const dialogue = dialogues[0]!;
      return [{ id: `goal_${dialogue.id}`, goal: `Answer ${dialogue.id}`, opening: dialogue.messages[0]!.content,
        evidenceDialogueIds: [dialogue.id], requirementIds: ['owner_rule'], successCriteria: 'Answer from the owner material' }];
    },
    async assess(input, ctx) {
      return assessRepeated(input, { provider: 'offline', id: 'judge' }, ctx, async (_prompt, data) => {
        ctx.beforeCall();
        const parsed = JSON.parse(data) as { scenario: { metrics: { id: string }[] }; trial: { events: { seq: number; content: string }[] } };
        const quote = parsed.trial.events.find(event => event.seq === 1)!.content;
        return JSON.stringify({ assessments: parsed.scenario.metrics.map(metric => ({ metricId: metric.id, passCondition: 'met', failCondition: 'not_met',
          rationale: 'The reply is present in the trace.', evidence: [1], citations: [{ seq: 1, quote }] })) });
      });
    },
    async improve() { throw new Error('score must not improve'); },
    async openTarget() { throw new Error('score must not open the target'); },
    async userTurn() { throw new Error('score must not run the simulator'); },
  };
}

async function scoredAndReassessed(lab: ExperimentLab) {
  const input = createInputSchema.parse({ task: 'Score recorded dialogues', mode: 'live',
    materials: [{ name: 'policy', content: 'Answer from the owner material' }], scenarioCount: 0,
    dialogues: ['d0', 'd1'].map(id => ({ id, messages: [{ role: 'user' as const, content: `Question ${id}` }, { role: 'assistant' as const, content: `Answer ${id}` }] })),
  });
  const seed = await lab.score(input); await lab.waitForIdle();
  const scored = await lab.get(seed.id);
  assert.equal(scored.phase, 'results_review', scored.error ?? '');
  const pending = await lab.reassess(scored.id); await lab.waitForIdle();
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
  const { lab, directory } = await setup(t, createDemoRuntime());
  const created = await lab.create({ ...demoInput(), workflow: 'evaluate', scenarioCount: 2 }); await lab.waitForIdle();
  const draft = await lab.get(created.id);
  await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft) }); await lab.waitForIdle();
  const source = await lab.get(draft.id);
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
  // A control runs as one turn: only its own follow-up limit (and a script, when present) changes; no marker enters the cards.
  const plain = (await lab.repeat(source.id)).scenarios;
  assert.equal(controlled.scenarios.length, plain.length);
  for (const card of controlled.scenarios) {
    const reference = plain.find(item => item.id === card.id)!;
    if (card.id !== a) { assert.deepEqual(card, reference, 'a counted card is unchanged'); continue; }
    assert.equal(card.user.maxFollowUps, 0);
    if (reference.user.script === undefined) assert.equal('script' in card.user, false, 'no script appears where there was none');
    else assert.deepEqual(card.user.script, []);
    const { maxFollowUps: _m, script: _s, ...rest } = card.user;
    const { maxFollowUps: _rm, script: _rs, ...referenceRest } = reference.user;
    assert.deepEqual({ ...card, user: rest }, { ...reference, user: referenceRest });
  }
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
  // A suite whose control card still allows follow-ups loads as a one-turn control; the other card is untouched.
  const plainSuite = JSON.parse(await readFile(await lab.saveSuite(source.id, join(directory, 'plain-suite.json')), 'utf8'));
  plainSuite.definition.positiveControlScenarioIds = [a];
  plainSuite.definition.scenarios.find((s: { id: string }) => s.id === a).user.maxFollowUps = 5;
  const multiTurn = join(directory, 'multi-turn-control-suite.json');
  await writeFile(multiTurn, JSON.stringify(plainSuite), { mode: 0o600 });
  const oneTurn = await lab.loadSuite(multiTurn);
  assert.deepEqual(oneTurn.positiveControlScenarioIds, [a]);
  assert.equal(oneTurn.scenarios.find(s => s.id === a)!.user.maxFollowUps, 0);
  assert.equal(oneTurn.scenarios.find(s => s.id === b)!.user.maxFollowUps, plainSuite.definition.scenarios.find((s: { id: string }) => s.id === b).user.maxFollowUps);
  const narrowed = await lab.repeat(ran.id, [b]);
  assert.equal('positiveControlScenarioIds' in narrowed, false);
  assert.deepEqual((await lab.repeat(ran.id, [a])).positiveControlScenarioIds, [a]);
});

