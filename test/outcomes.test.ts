import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyUsage, type HumanReview, type Scenario, type Trial } from '../src/contracts.js';
import { agentRubricResult, automaticTrialResult } from '../src/outcomes.js';

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
