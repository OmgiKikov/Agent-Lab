import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyUsage, type HumanReview, type Scenario, type Trial } from '../src/contracts.js';
import { RAG_METRIC_IDS } from '../src/assessment.js';
import { agentMetricResult, agentRubricResult, automaticTrialResult, COUNTING_RULES, headlineMetricIds, headlineTrialResult, latestHumanReviews, markTargets, markUnderCurrentRule, primaryMetricId, recordedResult, trialAssessmentComplete } from '../src/outcomes.js';

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

const card = (ids: string[]): Scenario => ({ ...scenario, metrics: ids.map(rubric) });
const judged = (...rows: [string, 'pass' | 'fail' | 'unknown'][]): Trial =>
  ({ ...trial, assessments: rows.map(([metricId, result]) => ({ metricId, result, rationale: 'r', evidence: [] })) });

test('the primary metric is the goal, else the first failed agent rubric, else the first passed one', () => {
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

// ---- 03.1: the headline metrics, the recorded verdict and the metrics a one-key mark answers. ----
const GOAL = 'goal_attainment', RULES = 'prompt_compliance';

test('headlineMetricIds names the goal and, when the card has it, the prompt rules — never reply quality, RAG or the simulator', () => {
  assert.deepEqual(headlineMetricIds(scenario), [GOAL, RULES]);
  assert.deepEqual(headlineMetricIds(card([GOAL])), [GOAL]);
  assert.deepEqual(headlineMetricIds(card([GOAL, 'reply_quality', RULES])), [GOAL, RULES], 'goal first, rules second, whatever the card order');
  assert.deepEqual(headlineMetricIds(card(['a', 'b'])), [], 'a legacy card has no headline metrics: the strict outcome decides it');
  assert.deepEqual(headlineMetricIds(undefined), []);
});

test('recordedResult reads the judge alone: a human verdict never moves what a mark is measured against', () => {
  assert.equal(recordedResult(trial, GOAL), 'pass');
  assert.equal(recordedResult(trial, RULES), 'fail');
  assert.equal(recordedResult(trial, undefined), undefined);
  assert.equal(recordedResult(trial, 'reply_quality'), undefined, 'a metric the judge never assessed has no recorded result');
  assert.equal(recordedResult({ ...trial, assessments: undefined }, GOAL), undefined);
  assert.equal(agentMetricResult(trial, RULES, [review('pass', RULES)]), 'pass', 'the overridden result differs …');
  assert.equal(recordedResult(trial, RULES), 'fail', '… and the recorded one does not follow it');
});

test('markTargets is the recorded verdict by the headline rule plus the metrics whose result equals it', () => {
  assert.deepEqual(markTargets(scenario, judged([GOAL, 'fail'], [RULES, 'fail'])), { verdict: 'fail', metricIds: [GOAL, RULES] }, 'a double failure has two targets');
  assert.deepEqual(markTargets(scenario, judged([GOAL, 'pass'], [RULES, 'fail'])), { verdict: 'fail', metricIds: [RULES] }, 'a met request that broke a rule is answered on the rules alone');
  assert.deepEqual(markTargets(scenario, judged([GOAL, 'unknown'], [RULES, 'fail'])), { verdict: 'fail', metricIds: [RULES] }, 'an undecided goal next to broken rules is still a failure on the rules');
  assert.deepEqual(markTargets(scenario, judged([GOAL, 'fail'], [RULES, 'pass'])), { verdict: 'fail', metricIds: [GOAL] });
  assert.deepEqual(markTargets(scenario, judged([GOAL, 'pass'], [RULES, 'pass'])), { verdict: 'pass', metricIds: [GOAL, RULES] }, 'a two-metric pass has two targets (CTX-25)');
  assert.equal(markTargets(scenario, judged([GOAL, 'pass'], [RULES, 'unknown'])), undefined, 'a pass needs every headline metric decided');
  assert.equal(markTargets(scenario, judged([GOAL, 'unknown'], [RULES, 'unknown'])), undefined);
  assert.equal(markTargets(scenario, { ...trial, assessments: undefined }), undefined);
  assert.deepEqual(markTargets(card([GOAL]), judged([GOAL, 'fail'])), { verdict: 'fail', metricIds: [GOAL] }, 'a goal-only card has one target');
  assert.deepEqual(markTargets(card([GOAL, 'reply_quality']), judged([GOAL, 'pass'], ['reply_quality', 'fail'])), { verdict: 'pass', metricIds: [GOAL] }, 'reply quality never decides or takes a mark');
  // A legacy card keeps today's single primary metric.
  assert.deepEqual(markTargets(card(['a', 'b']), judged(['a', 'pass'], ['b', 'fail'])), { verdict: 'fail', metricIds: ['b'] });
  assert.deepEqual(markTargets(card(['a', 'b']), judged(['a', 'pass'], ['b', 'pass'])), { verdict: 'pass', metricIds: ['a'] });
  assert.equal(markTargets(card(['a', 'b']), judged(['a', 'unknown'], ['b', 'unknown'])), undefined);
  assert.equal(markTargets(undefined, trial), undefined);
});

test('markUnderCurrentRule: a stamped mark answers the current rule; an unstamped one only where the old rule asked the same question', () => {
  const stamped = (countingRules?: string): HumanReview => ({ ...review('fail', GOAL), source: 'quick', judgeVerdict: 'fail', ...(countingRules === undefined ? {} : { countingRules }) });
  assert.equal(markUnderCurrentRule(scenario, trial, stamped(COUNTING_RULES), [GOAL, RULES]), true);
  assert.equal(markUnderCurrentRule(scenario, trial, stamped(COUNTING_RULES), [RULES]), true);
  assert.equal(markUnderCurrentRule(scenario, trial, stamped('goal-v1'), [GOAL]), false, 'a stamp that names another rule is never current');
  assert.equal(markUnderCurrentRule(scenario, trial, stamped(), [GOAL]), true, 'a goal-only failure asked the same question under the previous rule');
  assert.equal(markUnderCurrentRule(scenario, trial, stamped(), [GOAL, RULES]), false, 'a double failure did not exist under the previous rule');
  assert.equal(markUnderCurrentRule(scenario, trial, stamped(), [RULES]), false);
  assert.equal(markUnderCurrentRule(card(['a', 'b']), trial, stamped(), ['b']), true, 'a legacy card counts the same way under both rules');
});

test('headlineTrialResult combines the headline metrics fail-first with the human verdicts applied', () => {
  assert.equal(headlineTrialResult(scenario, trial), 'fail', 'goal pass, rules fail');
  assert.equal(headlineTrialResult(scenario, trial, [review('pass', RULES)]), 'pass', 'a full human pass on the rules lifts the situation');
  assert.equal(headlineTrialResult(scenario, trial, [{ ...review('unknown', RULES), source: 'quick', judgeVerdict: 'fail' }]), 'fail', 'a quick «не могу сказать» leaves the judge in place');
  assert.equal(headlineTrialResult(scenario, judged([GOAL, 'pass'], [RULES, 'pass'])), 'pass');
  assert.equal(headlineTrialResult(scenario, judged([GOAL, 'pass'], [RULES, 'unknown'])), 'unknown');
  assert.equal(headlineTrialResult(scenario, { ...trial, assessmentError: 'судья не ответил' }), 'unknown', 'an unusable measurement is unknown whatever the rules say');
  assert.equal(headlineTrialResult(card(['a', 'b']), judged(['a', 'pass'], ['b', 'fail'])), 'fail', 'a legacy card takes the strict automatic result');
  assert.equal(headlineTrialResult(undefined, trial), 'unknown');
});

test('a quick «не могу сказать» leaves the judge result in place, a full one still overrides it', () => {
  const failedGoal: Trial = { ...trial, assessments: [
    { metricId: 'goal_attainment', result: 'fail', rationale: 'клиент остался без ответа', evidence: [1] },
    { metricId: 'prompt_compliance', result: 'pass', rationale: 'правила соблюдены', evidence: [1] },
  ] };
  const quick = (verdict: HumanReview['verdict'], at = '2026-09-15T10:00:00Z'): HumanReview =>
    ({ ...review(verdict, 'goal_attainment', at), source: 'quick', judgeVerdict: 'fail' });

  // A one-key «не могу сказать» is doubt, not a verdict: the judge's failure stays in the number.
  assert.equal(agentMetricResult(failedGoal, 'goal_attainment', [quick('unknown')]), 'fail');
  assert.equal(agentRubricResult(scenario, failedGoal, [quick('unknown')]), 'fail');
  assert.equal(automaticTrialResult(scenario, failedGoal, [quick('unknown')]), 'fail');
  assert.equal(trialAssessmentComplete(scenario, failedGoal, [quick('unknown')]), true);

  // A full review that says «не могу сказать» works exactly as before: the card loses its verdict.
  const full = review('unknown', 'goal_attainment');
  assert.equal(agentMetricResult(failedGoal, 'goal_attainment', [full]), 'unknown');
  assert.equal(agentRubricResult(scenario, failedGoal, [full]), 'unknown');
  assert.equal(trialAssessmentComplete(scenario, failedGoal, [full]), false);

  // A decided quick mark still overrides the judge in both directions.
  assert.equal(agentMetricResult(failedGoal, 'goal_attainment', [quick('pass')]), 'pass');
  assert.equal(agentRubricResult(scenario, failedGoal, [quick('pass')]), 'pass');
  assert.equal(agentMetricResult(trial, 'goal_attainment', [{ ...quick('fail'), judgeVerdict: 'pass' }]), 'fail');

  // The latest review wins, and a quick unsure falls back to the judge, not to the earlier human verdict.
  assert.equal(agentMetricResult(failedGoal, 'goal_attainment', [
    review('pass', 'goal_attainment'), quick('unknown', '2026-09-15T11:00:00Z'),
  ]), 'fail');
});

test('a quick mark supersedes and is superseded on its own key like any other review', () => {
  const quick = (verdict: HumanReview['verdict'], at: string): HumanReview =>
    ({ ...review(verdict, 'goal_attainment', at), source: 'quick', judgeVerdict: 'pass' });
  const latest = latestHumanReviews({ trials: [trial], humanReviews: [quick('pass', '2026-09-15T10:00:00Z'), review('fail', 'goal_attainment', '2026-09-15T11:00:00Z')] });
  assert.equal(latest.get('t1|metric:goal_attainment')?.source, undefined, 'a later full review replaces the quick mark');
});
