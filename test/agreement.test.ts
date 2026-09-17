import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyUsage, fingerprint, settingsSchema, type Experiment, type HumanReview, type JudgeReceipt, type MetricAssessment, type Trial } from '../src/contracts.js';
import { agreementSample, judgeAgreement, PASS_SAMPLE } from '../src/agreement.js';

const world = { records: {}, writableFields: [], transientFailures: 0 };
type Card = Experiment['scenarios'][number];
type Result = MetricAssessment['result'];
const goal = { id: 'goal_attainment', name: 'Цель', subject: 'agent' as const, description: 'd', passCriteria: 'p', failCriteria: 'f' };
const second = { ...goal, id: 'prompt_compliance', name: 'Правила' };

function card(id: string): Card {
  return {
    id, familyId: id, title: `Ситуация ${id}`, requirementIds: [], provenance: 'production', tier: 'regression', goalObservation: 'reply',
    user: { goal: 'g', facts: 'f', behavior: 'b', opening: 'o', maxFollowUps: 3 }, initialState: world, checks: [],
    metrics: [{ ...goal }, { ...second }], split: 'dev',
  };
}
function attempt(scenarioId: string, result: Result, overrides: Partial<Trial> = {}): Trial {
  return {
    id: `t-${scenarioId}`, revisionId: 'rev', scenarioId, familyId: scenarioId, repeat: 0, userMode: 'reactive', split: 'dev', manifestHash: 'h',
    outcome: 'ungraded', reason: 'Диалог дошёл до конца.', checks: [],
    events: [{ seq: 0, type: 'user', text: 'о' }, { seq: 1, type: 'assistant', text: 'ответ' }],
    initialState: world, finalState: world, usage: emptyUsage(), elapsedMs: 1,
    assessments: [{ metricId: 'goal_attainment', result, rationale: 'r', evidence: result === 'unknown' ? [] : [1] },
      { metricId: 'prompt_compliance', result: 'pass', rationale: 'r', evidence: [1] }],
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

/** One quick mark: `saw` is the judgment the person was shown, `verdict` is the answer they gave. */
function mark(trialId: string, verdict: HumanReview['verdict'], saw: 'pass' | 'fail', options: Partial<HumanReview> = {}): HumanReview {
  return { id: `m-${trialId}`, createdAt: '2026-09-17T00:00:00Z', trialId, metricId: 'goal_attainment', verdict,
    note: 'отметка', source: 'quick', judgeVerdict: saw, ...options };
}
/** A run of failed and passed situations, in that order. */
function shaped(failed: number, passed: number, overrides: Partial<Experiment> = {}): Experiment {
  const cards: Card[] = []; const trials: Trial[] = [];
  const add = (id: string, result: Result) => { cards.push(card(id)); trials.push(attempt(id, result)); };
  for (let i = 0; i < failed; i++) add(`f${i}`, 'fail');
  for (let i = 0; i < passed; i++) add(`p${i}`, 'pass');
  return run(cards, trials, overrides);
}

test('a disagreement counts as checked but not agreed, and names the situation', () => {
  const record = shaped(1, 0, { humanReviews: [mark('t-f0', 'pass', 'fail')] });
  const found = judgeAgreement(record);
  assert.equal(found.agreed, 0);
  assert.equal(found.checked, 1);
  assert.deepEqual(found.failures, { agreed: 0, checked: 1 });
  assert.deepEqual(found.passes, { agreed: 0, checked: 0 });
  assert.deepEqual(found.disagreements, [{ trialId: 't-f0', scenarioId: 'f0', title: 'Ситуация f0', judge: 'fail', human: 'pass', note: 'отметка' }]);
  assert.deepEqual(found.marks, [{ trialId: 't-f0', scenarioId: 'f0', title: 'Ситуация f0', answer: 'disagree', judge: 'fail', note: 'отметка', stale: false }]);
  assert.deepEqual(found.unmarked, [], 'a marked failure leaves the queue');
});

test('agreement is counted on the recorded judgment, never on the human-overridden result', () => {
  const record = shaped(1, 0, { humanReviews: [mark('t-f0', 'pass', 'fail')] });
  assert.equal(record.trials[0]!.assessments![0]!.result, 'fail');
  const found = judgeAgreement(record);
  assert.equal(`${found.agreed} из ${found.checked}`, '0 из 1', 'a flipped verdict must not agree with itself');
});

test('an agreed pass, an unsure failure and their tallies stay apart', () => {
  const record = shaped(1, 1, { humanReviews: [mark('t-f0', 'unknown', 'fail'), mark('t-p0', 'pass', 'pass')] });
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

test('only stale marks with an empty queue still report themselves', () => {
  const undecided = shaped(0, 0);
  undecided.scenarios = [card('u0')];
  undecided.trials = [attempt('u0', 'unknown')];
  const record = { ...undecided, sourceEvidence: { runId: 'run-0', trials: undecided.trials, humanReviews: [mark('t-u0', 'fail', 'fail')] } };
  const found = judgeAgreement(record);
  assert.deepEqual([found.queueFailures, found.sampledPasses], [[], []]);
  assert.equal(found.stale, 1);
  assert.equal(found.checked, 0);
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
