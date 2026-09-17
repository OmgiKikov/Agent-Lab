import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyUsage, simulatorFidelity, type HumanReview, type JudgeReceipt, type Scenario, type SimulatorCheck, type Trial } from '../src/contracts.js';
import { agentRubricResult, automaticTrialResult, judgedCut, latestHumanReviews, simulatorUsable, trialAssessmentComplete } from '../src/outcomes.js';

const rubric = (id: string) => ({
  id, name: id, subject: 'agent' as const, description: 'd', passCriteria: 'p', failCriteria: 'f',
});
const scenario: Scenario = {
  id: 'card', familyId: 'card', title: 'Card', split: 'dev', provenance: 'synthetic', requirementIds: [],
  user: { goal: 'g', facts: 'f', behavior: 'b', opening: 'o', maxFollowUps: 0 }, checks: [],
  initialState: { records: {}, writableFields: [], transientFailures: 0 },
  metrics: [rubric('goal_attainment'), rubric('prompt_compliance')],
};
const trial: Trial = {
  id: 't1', revisionId: 'r', scenarioId: 'card', familyId: 'card', repeat: 0, split: 'dev', userMode: 'static', manifestHash: 'm',
  outcome: 'ungraded', reason: '', checks: [], events: [{ seq: 0, type: 'user', text: 'o' }, { seq: 1, type: 'assistant', text: 'a' }],
  initialState: scenario.initialState, finalState: scenario.initialState, usage: emptyUsage(), elapsedMs: 1,
  assessments: [
    { metricId: 'goal_attainment', result: 'pass', rationale: 'ok', evidence: [1] },
    { metricId: 'prompt_compliance', result: 'fail', rationale: 'rule', evidence: [1] },
  ],
};
const review = (verdict: HumanReview['verdict'], metricId: string, at = '2026-09-15T10:00:00Z', trialId = 't1'): HumanReview => ({
  id: `h-${trialId}-${metricId}-${verdict}-${at}`, createdAt: at, trialId, metricId, verdict, note: 'n',
});

test('the latest human criterion verdict is authoritative without rewriting automatic evidence', () => {
  const evidence = JSON.stringify(trial);

  assert.equal(automaticTrialResult(scenario, trial), 'fail');
  assert.equal(automaticTrialResult(scenario, trial, [review('invalid', 'prompt_compliance')]), 'pass');
  assert.equal(automaticTrialResult(scenario, trial, [review('pass', 'prompt_compliance')]), 'pass');
  assert.equal(automaticTrialResult(scenario, trial, [review('unknown', 'prompt_compliance')]), 'unknown');
  assert.equal(automaticTrialResult(scenario, trial, [review('fail', 'goal_attainment'), review('pass', 'prompt_compliance')]), 'fail');
  assert.equal(automaticTrialResult(scenario, trial, [
    review('pass', 'prompt_compliance'),
    review('fail', 'prompt_compliance', '2026-09-15T11:00:00Z'),
  ]), 'fail', 'the latest verdict wins');
  assert.equal(agentRubricResult(scenario, trial, [
    review('invalid', 'goal_attainment'), review('invalid', 'prompt_compliance'),
  ]), undefined, 'nothing remains to judge');
  assert.equal(automaticTrialResult(scenario, trial, [
    review('pass', 'prompt_compliance', undefined, 'another-trial'),
    review('pass', 'another-metric'),
  ]), 'fail', 'reviews for another trial or metric do not apply');
  assert.equal(JSON.stringify(trial), evidence, 'human reviews never mutate saved automatic evidence');
});

test('human criterion verdicts determine whether rubric assessment is complete', () => {
  const incomplete = { ...trial, assessments: trial.assessments!.map(assessment => assessment.metricId === 'prompt_compliance' ? { ...assessment, result: 'unknown' as const } : assessment) };
  assert.equal(trialAssessmentComplete(scenario, incomplete), false);
  for (const verdict of ['pass', 'fail', 'invalid'] as const) assert.equal(trialAssessmentComplete(scenario, incomplete, [review(verdict, 'prompt_compliance')]), true);
  assert.equal(trialAssessmentComplete(scenario, incomplete, [review('unknown', 'prompt_compliance')]), false);
  assert.equal(trialAssessmentComplete(scenario, incomplete, [review('unknown', 'prompt_compliance'), review('pass', 'prompt_compliance', '2026-09-15T11:00:00Z')]), true);
  assert.equal(trialAssessmentComplete(scenario, incomplete, [review('pass', 'prompt_compliance'), review('unknown', 'prompt_compliance', '2026-09-15T11:00:00Z')]), false);
});

test('persisted append order determines the latest review even when timestamps move backwards', () => {
  assert.equal(agentRubricResult(scenario, trial, [
    review('fail', 'prompt_compliance', '2026-09-15T12:00:00+03:00'),
    review('pass', 'prompt_compliance', '2026-09-15T10:00:00Z'),
  ]), 'pass', 'ISO offsets do not define persisted review order');
  assert.equal(agentRubricResult(scenario, trial, [
    review('fail', 'prompt_compliance', '2026-09-15T11:00:00Z'),
    review('pass', 'prompt_compliance', '2026-09-15T09:00:00Z'),
  ]), 'pass', 'a system-clock rollback does not restore an older verdict');

  const whole = latestHumanReviews({ trials: [trial], humanReviews: [
    { id: 'whole-marked', trialId: trial.id, verdict: 'unknown', note: '#1: complete', reviewedDialogue: true, createdAt: '2026-09-15T12:00:00Z' },
    { id: 'whole-newer', trialId: trial.id, verdict: 'unknown', note: '#1: revised', createdAt: '2026-09-15T09:00:00Z' },
  ] }).get(`${trial.id}|dialogue`);
  assert.equal(whole?.reviewedDialogue, undefined, 'a newer unmarked whole-dialogue review revokes the marker');
});

// ---- goal-v2: the simulator cut. ----
const receipt = (cutBefore?: number): JudgeReceipt => ({
  protocolHash: 'p', inputHash: 'i', provider: 'x', model: 'm', auditHash: 'a', votes: [], notApplicable: [], complete: true,
  ...(cutBefore === undefined ? {} : { cutBefore }),
});
const reactiveCard: Scenario = { ...scenario, metrics: [rubric('goal_attainment'), { ...simulatorFidelity }] };
const heuristic = (seq?: number): SimulatorCheck => ({ id: 'simulator_leak', description: 'd', passed: false, evidence: 'e', heuristic: true, ...(seq === undefined ? {} : { seq }) });
function reactive(fidelity: 'pass' | 'fail' | 'unknown', checks: SimulatorCheck[] = []): Trial {
  return {
    ...trial, id: 't2', userMode: 'reactive', simulatorChecks: checks,
    events: [{ seq: 0, type: 'user', text: 'o' }, { seq: 1, type: 'assistant', text: 'a' }, { seq: 2, type: 'simulator', result: { message: 'm', done: false } },
      { seq: 3, type: 'user', text: 'u' }, { seq: 4, type: 'assistant', text: 'b' }],
    assessments: [
      { metricId: 'goal_attainment', result: 'fail', rationale: 'r', evidence: [1] },
      { metricId: 'user_fidelity', result: fidelity, rationale: 'r', evidence: fidelity === 'unknown' ? [] : [3] },
    ],
  };
}

test('simulatorUsable with a cut ignores the fidelity vote and heuristic checks at or after the cut', () => {
  const cut = { beforeSeq: 3 };
  assert.equal(simulatorUsable(reactiveCard, reactive('fail'), [], cut), true, 'failed fidelity without review');
  assert.equal(simulatorUsable(reactiveCard, reactive('unknown'), [], cut), true, 'unknown fidelity without review');
  assert.equal(simulatorUsable(reactiveCard, reactive('pass', [heuristic(3)]), [], cut), true, 'check at the cut');
  assert.equal(simulatorUsable(reactiveCard, reactive('pass', [heuristic(2)]), [], cut), false, 'check before the cut');
  assert.equal(simulatorUsable(reactiveCard, reactive('pass', [heuristic()]), [], cut), false, 'check without seq');
  assert.equal(simulatorUsable(reactiveCard, reactive('pass', [{ ...heuristic(4), heuristic: false }]), [], cut), false, 'a non-heuristic check always counts');
  assert.equal(simulatorUsable(reactiveCard, reactive('pass'), [review('fail', 'user_fidelity', undefined, 't2')], cut), false, 'human fail on fidelity');
  assert.equal(simulatorUsable(reactiveCard, reactive('fail'), [review('pass', 'user_fidelity', undefined, 't2')], cut), true, 'human pass on fidelity');
});

test('simulatorUsable without options keeps the goal-v1 result', () => {
  assert.equal(simulatorUsable(reactiveCard, reactive('fail')), false);
  assert.equal(simulatorUsable(reactiveCard, reactive('unknown')), false);
  assert.equal(simulatorUsable(reactiveCard, reactive('pass', [heuristic(3)])), false);
  assert.equal(simulatorUsable(reactiveCard, reactive('pass')), true);
  const cutTrial = { ...reactive('fail'), judgedBeforeSeq: 3, judgeReceipt: receipt(3) };
  assert.equal(automaticTrialResult(reactiveCard, cutTrial), 'unknown', 'the strict outcome ignores the cut');
});

test('judgedCut needs the same cutBefore in the receipt', () => {
  assert.equal(judgedCut({ judgedBeforeSeq: 3, judgeReceipt: receipt(3) }), 3);
  assert.equal(judgedCut({ judgedBeforeSeq: 0, judgeReceipt: receipt(0) }), 0);
  assert.equal(judgedCut({ judgedBeforeSeq: 3, judgeReceipt: receipt(2) }), undefined);
  assert.equal(judgedCut({ judgedBeforeSeq: 3, judgeReceipt: receipt() }), undefined);
  assert.equal(judgedCut({ judgedBeforeSeq: 3 }), undefined);
  assert.equal(judgedCut({ judgeReceipt: receipt(3) }), undefined);
});
