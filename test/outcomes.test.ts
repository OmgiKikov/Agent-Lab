import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyUsage, RAG_METRIC_IDS, type HumanReview, type Scenario, type Trial } from '../src/contracts.js';
import { agentRubricResult, automaticTrialResult, latestHumanReviews, primaryMetricId, trialAssessmentComplete } from '../src/outcomes.js';

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

test('the primary metric is the goal, else the first failed agent rubric, else the first passed one', () => {
  const card = (ids: string[]): Scenario => ({ ...scenario, metrics: ids.map(rubric) });
  const judged = (...rows: [string, 'pass' | 'fail' | 'unknown'][]): Trial =>
    ({ ...trial, assessments: rows.map(([metricId, result]) => ({ metricId, result, rationale: 'r', evidence: [] })) });

  assert.equal(primaryMetricId(scenario, trial), 'goal_attainment', 'the goal wins even when another rubric failed');
  assert.equal(primaryMetricId(card(['a', 'b']), judged(['a', 'pass'], ['b', 'fail'])), 'b');
  assert.equal(primaryMetricId(card(['a', 'b']), judged(['a', 'pass'], ['b', 'pass'])), 'a');
  assert.equal(primaryMetricId(card(['a', 'b']), judged(['a', 'unknown'], ['b', 'unknown'])), undefined);
  assert.equal(primaryMetricId(card(['a']), { ...trial, assessments: undefined }), undefined);
  assert.equal(primaryMetricId(undefined, trial), undefined);

  const simulatorOnly: Scenario = { ...scenario, metrics: [{ ...rubric('user_fidelity'), subject: 'simulator' }] };
  assert.equal(primaryMetricId(simulatorOnly, judged(['user_fidelity', 'fail'])), undefined, 'the simulator rubric is not the main judgment');
  const [ragId] = [...RAG_METRIC_IDS];
  assert.ok(ragId);
  assert.equal(primaryMetricId(card(['a']), judged(['a', 'pass'], [ragId, 'fail'])), 'a', 'a RAG diagnostic is never the primary metric');
});

test('a quick mark supersedes and is superseded on its own key like any other review', () => {
  const quick = (verdict: HumanReview['verdict'], at: string): HumanReview =>
    ({ ...review(verdict, 'goal_attainment', at), source: 'quick', judgeVerdict: 'pass' });
  const latest = latestHumanReviews({ trials: [trial], humanReviews: [quick('pass', '2026-09-15T10:00:00Z'), review('fail', 'goal_attainment', '2026-09-15T11:00:00Z')] });
  assert.equal(latest.get('t1|metric:goal_attainment')?.source, undefined, 'a later full review replaces the quick mark');
});
