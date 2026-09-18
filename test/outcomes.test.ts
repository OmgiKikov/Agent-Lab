import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyUsage, type HumanReview, type Scenario, type Trial } from '../src/contracts.js';
import { agentRubricResult, automaticTrialResult, latestHumanReviews, trialAssessmentComplete } from '../src/outcomes.js';

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
