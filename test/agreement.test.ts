import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyUsage, fingerprint, settingsSchema, type Experiment, type HumanReview, type Trial } from '../src/contracts.js';
import type { JudgeReceipt, MetricAssessment } from '../src/assessment.js';
import { agreementSample, judgeAgreement, PASS_SAMPLE } from '../src/agreement.js';
import { COUNTING_RULES } from '../src/outcomes.js';

const world = { records: {}, writableFields: [], transientFailures: 0 };
type Card = Experiment['scenarios'][number];
type Result = MetricAssessment['result'];
const goal = { id: 'goal_attainment', name: 'Цель', subject: 'agent' as const, description: 'd', passCriteria: 'p', failCriteria: 'f' };
const second = { ...goal, id: 'prompt_compliance', name: 'Правила' };
const BOTH = ['goal_attainment', 'prompt_compliance'];

function card(id: string): Card {
  return {
    id, familyId: id, title: `Ситуация ${id}`, requirementIds: [], provenance: 'production', tier: 'regression', goalObservation: 'reply',
    user: { goal: 'g', facts: 'f', behavior: 'b', opening: 'o', maxFollowUps: 3 }, initialState: world, checks: [],
    metrics: [{ ...goal }, { ...second }], split: 'dev',
  };
}
/** One attempt judged on the goal (`result`) and the prompt rules (`rules`, kept by default). */
function attempt(scenarioId: string, result: Result, overrides: Partial<Trial> = {}, rules: Result = 'pass'): Trial {
  return {
    id: `t-${scenarioId}`, revisionId: 'rev', scenarioId, familyId: scenarioId, repeat: 0, userMode: 'reactive', split: 'dev', manifestHash: 'h',
    outcome: 'ungraded', reason: 'Диалог дошёл до конца.', checks: [],
    events: [{ seq: 0, type: 'user', text: 'о' }, { seq: 1, type: 'assistant', text: 'ответ' }],
    initialState: world, finalState: world, usage: emptyUsage(), elapsedMs: 1,
    assessments: [{ metricId: 'goal_attainment', result, rationale: 'r', evidence: result === 'unknown' ? [] : [1] },
      { metricId: 'prompt_compliance', result: rules, rationale: 'r', evidence: rules === 'unknown' ? [] : [1] }],
    ...overrides,
  };
}
function run(cards: Card[], trials: Trial[], overrides: Partial<Experiment> = {}): Experiment {
  return {
    schemaVersion: '1', id: 'run-1', task: 't', mode: 'live', workflow: 'evaluate', createdAt: 'now', updatedAt: 'now', phase: 'results_review', message: '',
    sources: [], settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1 }),
    target: { kind: 'command', command: 'python3', args: ['agent.py'], timeoutMs: 60000 },
    requirements: [], questions: [], goldenCases: [], dialogues: [], profiles: [], notes: '', scenarios: cards, revisions: [], selectedRevisionId: null,
    manifestHash: 'h', reviewedAt: null, reviewMode: 'human', controlConsumedAt: null, acceptedTests: [], trials, comparisons: [], iterations: [],
    usage: emptyUsage(), error: null, limitations: [], humanReviews: [], ...overrides,
  };
}
const receipt = (protocolHash = 'protocol-10', inputHash = 'input-1'): JudgeReceipt =>
  ({ protocolHash, inputHash, provider: 'openrouter', model: 'judge', auditHash: 'a', votes: [], notApplicable: [], complete: true });

/**
 * One quick mark as the lab stores it under the current rule: `saw` is the judgment the person was
 * shown, `verdict` the answer they gave; on the goal unless `options.metricId` says otherwise. Pass
 * `countingRules: undefined` for a phase-3 mark without the stamp.
 */
function mark(trialId: string, verdict: HumanReview['verdict'], saw: 'pass' | 'fail', options: Partial<HumanReview> = {}): HumanReview {
  const review: HumanReview = { id: `m-${trialId}`, createdAt: '2026-09-17T00:00:00Z', trialId, metricId: 'goal_attainment', verdict,
    note: 'отметка', source: 'quick', judgeVerdict: saw, countingRules: COUNTING_RULES, ...options };
  if (review.countingRules === undefined) delete review.countingRules;
  return review;
}
/** One mark per metric that decided the situation, with unique ids — how the board answers a two-target situation. */
function marks(trialId: string, verdict: HumanReview['verdict'], saw: 'pass' | 'fail', ids: string[], options: Partial<HumanReview> = {}): HumanReview[] {
  return ids.map(metricId => mark(trialId, verdict, saw, { ...options, id: `m-${trialId}-${metricId}`, metricId }));
}
/** A run of failed and passed situations, in that order; every failure fails the goal alone, every pass passes both metrics. */
function shaped(failed: number, passed: number, overrides: Partial<Experiment> = {}): Experiment {
  const cards: Card[] = []; const trials: Trial[] = [];
  const add = (id: string, result: Result) => { cards.push(card(id)); trials.push(attempt(id, result)); };
  for (let i = 0; i < failed; i++) add(`f${i}`, 'fail');
  for (let i = 0; i < passed; i++) add(`p${i}`, 'pass');
  return run(cards, trials, overrides);
}
/** One situation the judge failed on both the goal and the prompt rules. */
function doubleFailure(overrides: Partial<Experiment> = {}): Experiment {
  return run([card('d0')], [attempt('d0', 'fail', {}, 'fail')], overrides);
}

test('a disagreement counts as checked but not agreed, and names the situation', () => {
  const record = shaped(1, 0, { humanReviews: [mark('t-f0', 'pass', 'fail')] });
  const found = judgeAgreement(record);
  assert.equal(found.agreed, 0);
  assert.equal(found.checked, 1);
  assert.deepEqual(found.failures, { agreed: 0, checked: 1 });
  assert.deepEqual(found.passes, { agreed: 0, checked: 0 });
  assert.deepEqual(found.disagreements, [{ trialId: 't-f0', scenarioId: 'f0', title: 'Ситуация f0', judge: 'fail', human: 'pass', note: 'отметка' }]);
  assert.deepEqual(found.marks, [{ trialId: 't-f0', scenarioId: 'f0', title: 'Ситуация f0', answer: 'disagree', judge: 'fail', note: 'отметка', stale: false,
    targets: [{ metricId: 'goal_attainment', answer: 'disagree' }] }]);
  assert.deepEqual(found.unmarked, [], 'a marked failure leaves the queue');
  assert.equal(found.staleRule, 0);
});

test('agreement is counted on the recorded judgment, never on the human-overridden result', () => {
  const record = shaped(1, 0, { humanReviews: [mark('t-f0', 'pass', 'fail')] });
  assert.equal(record.trials[0]!.assessments![0]!.result, 'fail');
  const found = judgeAgreement(record);
  assert.equal(`${found.agreed} из ${found.checked}`, '0 из 1', 'a flipped verdict must not agree with itself');
});

test('an agreed pass, an unsure failure and their tallies stay apart', () => {
  const record = shaped(1, 1, { humanReviews: [mark('t-f0', 'unknown', 'fail'), ...marks('t-p0', 'pass', 'pass', BOTH)] });
  const found = judgeAgreement(record);
  assert.deepEqual(found.passes, { agreed: 1, checked: 1 });
  assert.deepEqual(found.failures, { agreed: 0, checked: 0 });
  assert.equal(found.checked, 1);
  assert.equal(found.unsure, 1);
  assert.equal(found.sampleChecked, 1, 'the checked pass was the sampled one');
  assert.deepEqual(found.unmarked, [], '«не могу сказать» is still an answer, so the situation leaves the queue');
});

test('a mark made under another judge version is stale, and a demo mark with no version is current', () => {
  const judged = shaped(1, 0);
  judged.trials[0]!.judgeReceipt = receipt();
  const version = { protocolHash: 'protocol-10', inputHash: 'input-1' };
  const cases: [string, Partial<HumanReview>, boolean][] = [
    ['the same version', { judge: version }, false],
    ['another protocol', { judge: { ...version, protocolHash: 'protocol-11' } }, true],
    ['another input', { judge: { ...version, inputHash: 'input-2' } }, true],
    ['no version at all', {}, true],
    ['another recorded verdict', { judge: version, judgeVerdict: 'pass' }, true],
  ];
  for (const [name, options, stale] of cases) {
    const found = judgeAgreement({ ...judged, humanReviews: [mark('t-f0', 'fail', 'fail', options)] });
    assert.equal(found.stale, stale ? 1 : 0, name);
    assert.equal(found.checked, stale ? 0 : 1, name);
    assert.equal(found.marks[0]?.stale, stale, name);
  }
  // A trial the judge never signed (the demo path) accepts a mark without a version and refuses an invented one.
  const bare = shaped(1, 0);
  assert.equal(judgeAgreement({ ...bare, humanReviews: [mark('t-f0', 'fail', 'fail')] }).checked, 1);
  assert.equal(judgeAgreement({ ...bare, humanReviews: [mark('t-f0', 'fail', 'fail', { judge: version })] }).stale, 1);
});

test('a quick mark carried in sourceEvidence is stale: a reassessment is a new judgment', () => {
  const base = shaped(1, 0);
  const carried = mark('t-f0', 'fail', 'fail');
  const record = { ...base, sourceEvidence: { runId: 'run-0', trials: base.trials, humanReviews: [carried] } };
  const found = judgeAgreement(record);
  assert.equal(found.stale, 1);
  assert.equal(found.checked, 0);
  assert.deepEqual(found.marks.map(item => [item.trialId, item.stale]), [['t-f0', true]]);
  assert.deepEqual(found.unmarked, ['t-f0'], 'a stale mark leaves the situation in the queue');

  const own = judgeAgreement({ ...record, humanReviews: [mark('t-f0', 'pass', 'fail')] });
  assert.equal(own.stale, 0, 'an own mark on the same key wins over the carried one');
  assert.equal(own.checked, 1);
  assert.equal(own.marks.length, 1);
});

test('stale marks with nothing checked still report themselves; a mark on a situation the judge no longer decides does not', () => {
  // A carried mark on a decided failure is stale and shows as such even though nothing was checked yet.
  const failed = shaped(1, 0);
  const staleOnly = { ...failed, sourceEvidence: { runId: 'run-0', trials: failed.trials, humanReviews: [mark('t-f0', 'fail', 'fail')] } };
  const found = judgeAgreement(staleOnly);
  assert.deepEqual([found.stale, found.checked, found.unmarked], [1, 0, ['t-f0']]);
  // An undecided situation is not in the agreement at all (CR-01: the queue counts what the headline counts), so its old mark has nothing to be stale against.
  const undecided = shaped(0, 0);
  undecided.scenarios = [card('u0')];
  undecided.trials = [attempt('u0', 'unknown')];
  const record = { ...undecided, sourceEvidence: { runId: 'run-0', trials: undecided.trials, humanReviews: [mark('t-u0', 'fail', 'fail')] } };
  const none = judgeAgreement(record);
  assert.deepEqual([none.queueFailures, none.sampledPasses], [[], []]);
  assert.deepEqual([none.stale, none.staleRule, none.checked, none.marks.length], [0, 0, 0, 0]);
});

test('a later full review on the same rubric removes the quick pair from the count', () => {
  const full: HumanReview = { id: 'h1', createdAt: '2026-09-17T01:00:00Z', trialId: 't-f0', metricId: 'goal_attainment', verdict: 'pass', note: 'разобрал' };
  const found = judgeAgreement(shaped(1, 0, { humanReviews: [mark('t-f0', 'fail', 'fail'), full] }));
  assert.deepEqual([found.checked, found.stale, found.unsure, found.marks.length], [0, 0, 0, 0]);
  assert.deepEqual(found.unmarked, ['t-f0']);
});

test('control situations never enter the queue, the sample or the count', () => {
  const record = shaped(1, 1, { positiveControlScenarioIds: ['p0'], humanReviews: [mark('t-p0', 'pass', 'pass')] });
  const found = judgeAgreement(record);
  assert.deepEqual(found.sampledPasses, [], 'a control pass is not a situation to double-check');
  assert.deepEqual(found.queueFailures, ['t-f0']);
  assert.deepEqual([found.checked, found.stale, found.marks.length], [0, 0, 0]);
  const failedControl = shaped(1, 0, { positiveControlScenarioIds: ['f0'] });
  assert.deepEqual(judgeAgreement(failedControl).queueFailures, []);
});

test('a comparison run and a run still going report nothing at all', () => {
  const marks = [mark('t-f0', 'fail', 'fail')];
  for (const overrides of [{ workflow: 'compare' as const }, { phase: 'evaluating' as const }]) {
    const found = judgeAgreement(shaped(1, 1, { ...overrides, humanReviews: marks }));
    assert.deepEqual([found.agreed, found.checked, found.unsure, found.stale, found.sampleChecked], [0, 0, 0, 0, 0]);
    assert.deepEqual([found.queueFailures, found.sampledPasses, found.unmarked, found.marks, found.disagreements], [[], [], [], [], []]);
  }
});

test('the pass sample holds every pass up to three and otherwise a draw fixed by the run id', () => {
  assert.equal(PASS_SAMPLE, 3);
  assert.deepEqual(agreementSample(shaped(1, 2)), ['t-p0', 't-p1'], 'at most three passes means all of them, in record order');
  assert.deepEqual(agreementSample(shaped(1, 3)).length, 3);
  assert.deepEqual(agreementSample(shaped(1, 0)), []);
  assert.deepEqual(agreementSample(shaped(0, 2, { phase: 'evaluating' })), [], 'a running run has nothing settled to sample');

  const seven = shaped(2, 7);
  const drawn = agreementSample(seven);
  assert.equal(drawn.length, 3);
  const expected = ['t-p0', 't-p1', 't-p2', 't-p3', 't-p4', 't-p5', 't-p6']
    .map(id => ({ id, key: fingerprint({ run: seven.id, trial: id }) }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).slice(0, 3).map(item => item.id);
  assert.deepEqual(drawn, expected);
  assert.deepEqual(agreementSample(structuredClone(seven)), drawn, 'reopening the run draws the same situations');
  assert.deepEqual(agreementSample({ ...seven, humanReviews: [mark(drawn[0]!, 'fail', 'pass')] }), drawn, 'a human flip never moves the sample');

  const repeated = { ...seven, id: 'run-2' };
  const other = ['t-p0', 't-p1', 't-p2', 't-p3', 't-p4', 't-p5', 't-p6']
    .map(id => ({ id, key: fingerprint({ run: 'run-2', trial: id }) }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).slice(0, 3).map(item => item.id);
  assert.deepEqual(agreementSample(repeated), other);
  assert.notDeepEqual(other, drawn, 'a new run gets a new draw');
});

test('the queue lists failed situations in record order and only the unanswered ones stay unmarked', () => {
  const record = shaped(3, 2, { humanReviews: [mark('t-f1', 'fail', 'fail')] });
  const found = judgeAgreement(record);
  assert.deepEqual(found.queueFailures, ['t-f0', 't-f1', 't-f2']);
  assert.deepEqual(found.sampledPasses, ['t-p0', 't-p1']);
  assert.deepEqual(found.unmarked, ['t-f0', 't-f2', 't-p0', 't-p1'], 'failures first, then the sampled passes');
});

// ---- 03.1: the queue holds what the headline decides; a situation counts once over every metric that decided it. ----

test('CR-01: a failure the headline cannot measure is neither queued, sampled nor counted', () => {
  const deviated = attempt('f0', 'fail', { events: [{ seq: 0, type: 'user', text: 'о' }, { seq: 1, type: 'assistant', text: 'ответ' }, { seq: 2, type: 'simulator', result: { message: '', done: true } }],
    simulatorChecks: [{ id: 'simulator_leak', description: 'утечка', passed: false, evidence: '#1', heuristic: true }] });
  const invalidPass = attempt('p0', 'pass');
  const record = run([card('f0'), card('p0'), card('f1')], [deviated, invalidPass, attempt('f1', 'fail')], {
    humanReviews: [{ id: 'v', createdAt: 'now', trialId: 't-p0', verdict: 'invalid', note: 'невалидный тест' }, mark('t-f0', 'fail', 'fail'), ...marks('t-p0', 'pass', 'pass', BOTH)] });
  const found = judgeAgreement(record);
  assert.deepEqual(found.queueFailures, ['t-f1'], 'the simulator-deviated failure is not in the queue');
  assert.deepEqual(found.sampledPasses, [], 'the dialogue marked invalid is not sampled');
  assert.deepEqual(agreementSample(record), []);
  assert.deepEqual([found.checked, found.stale, found.staleRule, found.marks.length], [0, 0, 0, 0], 'marks on unmeasured situations count nothing');
  assert.deepEqual(found.unmarked, ['t-f1']);
});

test('CR-02: a double failure counts once, and only when both metrics that failed it carry a current mark', () => {
  const half = judgeAgreement(doubleFailure({ humanReviews: [mark('t-d0', 'fail', 'fail')] }));
  assert.deepEqual([half.checked, half.agreed, half.unsure, half.stale, half.staleRule], [0, 0, 0, 0, 0], 'one mark on a double failure is not a checked situation');
  assert.deepEqual(half.unmarked, ['t-d0'], 'the situation stays in the queue');
  assert.deepEqual(half.marks, [], 'and has no mark to show yet');

  const both = judgeAgreement(doubleFailure({ humanReviews: marks('t-d0', 'fail', 'fail', BOTH) }));
  assert.deepEqual([both.checked, both.agreed], [1, 1], 'two marks, one situation');
  assert.deepEqual(both.failures, { agreed: 1, checked: 1 });
  assert.deepEqual(both.unmarked, []);
  assert.deepEqual(both.marks.map(item => [item.answer, item.judge, item.targets]), [['agree', 'fail', [{ metricId: 'goal_attainment', answer: 'agree' }, { metricId: 'prompt_compliance', answer: 'agree' }]]]);
});

test('the answers of one situation combine as disagree over unsure over agree, and a partial overturn names the metric', () => {
  const agreeGoalDisagreeRules = doubleFailure({ humanReviews: [mark('t-d0', 'fail', 'fail'), mark('t-d0', 'pass', 'fail', { id: 'm-rules', metricId: 'prompt_compliance', note: 'правило не нарушено' })] });
  const partial = judgeAgreement(agreeGoalDisagreeRules);
  assert.deepEqual([partial.checked, partial.agreed], [1, 0]);
  assert.deepEqual(partial.marks.map(item => [item.answer, item.note]), [['disagree', 'правило не нарушено']], 'the note of the disagreeing metric leads');
  assert.deepEqual(partial.disagreements, [{ trialId: 't-d0', scenarioId: 'd0', title: 'Ситуация d0', judge: 'fail', human: 'fail', note: 'правило не нарушено', overturned: ['prompt_compliance'] }],
    'the request is still unmet, so the owner’s verdict on the situation stays «не справился»; the overturned half is named');

  const goalOverturned = judgeAgreement(doubleFailure({ humanReviews: [mark('t-d0', 'pass', 'fail'), mark('t-d0', 'fail', 'fail', { id: 'm-rules', metricId: 'prompt_compliance' })] }));
  assert.deepEqual(goalOverturned.disagreements[0]?.overturned, ['goal_attainment']);
  assert.equal(goalOverturned.disagreements[0]?.human, 'fail');

  const full = judgeAgreement(doubleFailure({ humanReviews: marks('t-d0', 'pass', 'fail', BOTH) }));
  assert.deepEqual(full.disagreements, [{ trialId: 't-d0', scenarioId: 'd0', title: 'Ситуация d0', judge: 'fail', human: 'pass', note: 'отметка' }], 'a full overturn keeps the phase-3 shape: no `overturned`');

  const doubted = judgeAgreement(doubleFailure({ humanReviews: [mark('t-d0', 'fail', 'fail'), mark('t-d0', 'unknown', 'fail', { id: 'm-rules', metricId: 'prompt_compliance' })] }));
  assert.deepEqual([doubted.checked, doubted.unsure, doubted.disagreements.length], [0, 1, 0], 'agree + unsure is unsure');
  assert.deepEqual(doubted.unmarked, [], 'doubt on every target is still an answer');
});

test('an unstamped mark counts only where the previous rule asked the same question; elsewhere it is a mark under the previous rule', () => {
  const oldOnDouble = judgeAgreement(doubleFailure({ humanReviews: [mark('t-d0', 'fail', 'fail', { countingRules: undefined })] }));
  assert.deepEqual([oldOnDouble.staleRule, oldOnDouble.stale, oldOnDouble.checked, oldOnDouble.agreed], [1, 0, 0, 0], 'never in N or M');
  assert.deepEqual(oldOnDouble.unmarked, ['t-d0'], 'the situation still needs marks under the current rule');
  assert.deepEqual(oldOnDouble.marks.map(item => [item.stale, item.staleRule, item.answer]), [[true, true, 'agree']]);

  const oldOnGoalOnly = judgeAgreement(shaped(1, 0, { humanReviews: [mark('t-f0', 'fail', 'fail', { countingRules: undefined })] }));
  assert.deepEqual([oldOnGoalOnly.staleRule, oldOnGoalOnly.checked, oldOnGoalOnly.agreed], [0, 1, 1], 'a goal-only failure asked the same question before, so the phase-3 mark counts as today');

  const wrongStamp = judgeAgreement(shaped(1, 0, { humanReviews: [mark('t-f0', 'fail', 'fail', { countingRules: 'goal-v1' })] }));
  assert.deepEqual([wrongStamp.staleRule, wrongStamp.checked], [1, 0], 'a stamp naming another rule is never current');

  // One current mark and one old-rule mark: the old one decides the classification, and the situation is not counted.
  const mixed = judgeAgreement(doubleFailure({ humanReviews: [mark('t-d0', 'fail', 'fail'), mark('t-d0', 'fail', 'fail', { id: 'm-rules', metricId: 'prompt_compliance', countingRules: undefined })] }));
  assert.deepEqual([mixed.staleRule, mixed.checked], [1, 0]);
});

test('a pass with two headline metrics has two targets and needs two marks', () => {
  const one = judgeAgreement(shaped(0, 1, { humanReviews: [mark('t-p0', 'pass', 'pass')] }));
  assert.deepEqual([one.checked, one.passes.checked, one.sampleChecked], [0, 0, 0]);
  assert.deepEqual(one.unmarked, ['t-p0']);
  const two = judgeAgreement(shaped(0, 1, { humanReviews: marks('t-p0', 'pass', 'pass', BOTH) }));
  assert.deepEqual([two.checked, two.passes.agreed, two.sampleChecked], [1, 1, 1]);
  // A rules-only failure has one target: the goal takes no mark there, and one on it changes nothing.
  const rulesOnly = run([card('r0')], [attempt('r0', 'pass', {}, 'fail')], { humanReviews: [mark('t-r0', 'fail', 'fail', { metricId: 'prompt_compliance' })] });
  assert.deepEqual([judgeAgreement(rulesOnly).checked, judgeAgreement(rulesOnly).failures.agreed], [1, 1]);
  const strayGoal = run([card('r0')], [attempt('r0', 'pass', {}, 'fail')], { humanReviews: [mark('t-r0', 'pass', 'pass')] });
  assert.deepEqual([judgeAgreement(strayGoal).checked, judgeAgreement(strayGoal).marks.length], [0, 0], 'a mark on a metric that did not decide the situation is not a target and counts nothing');
});
