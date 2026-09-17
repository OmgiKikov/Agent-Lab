import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceIdentity } from '../src/normalize.js';
import { awaitingVerdict, compareRuns, evidenceSummary, humanFindings, isAgentFailure, judgeModel, repeatResults, stabilityAfterReassess, verdictSummary } from '../src/comparison.js';
import { embeddedBefore } from '../src/artifacts.js';
import { suiteEvidence } from '../src/connection.js';
import { assessRepeated, hasCompleteJudgment, judgeInput, JUDGE_PROMPT, JUDGE_PROTOCOL, observableSources, sealJudgeReceipt } from '../src/judge.js';
import { emptyUsage, fingerprint, goalAttainment, settingsSchema, type Experiment, type HumanReview, type JudgeAudit, type MetricAssessment, type Outcome, type Scenario, type Source, type Target, type TraceEvent, type Trial, type UserMode } from '../src/contracts.js';

const TRUSTED = 30;
const world = { records: { r: { t: '0' } }, writableFields: ['t'], transientFailures: 0 };
const metrics = [
  { id: 'goal', name: 'Goal', subject: 'agent' as const, description: 'd', passCriteria: 'p', failCriteria: 'f' },
  { id: 'fidelity', name: 'Fidelity', subject: 'simulator' as const, description: 'd', passCriteria: 'p', failCriteria: 'f' },
];
function scenario(id: string): Scenario {
  return { id, familyId: id, title: id, requirementIds: [], provenance: 'curated', user: { goal: 'g', facts: 'f', behavior: 'b', opening: 'o', maxFollowUps: 1 },
    initialState: world, checks: [{ id: 'time', kind: 'state_equals', description: 'time', recordId: 'r', field: 't', value: '1' }, { id: 'extra', kind: 'tool_called', description: 'x', tool: 'lookup_record' }], metrics, split: 'dev' };
}
function record(overrides: Partial<Experiment> = {}): Experiment {
  return {
    schemaVersion: '1', id: 'exp', task: 't', mode: 'demo', workflow: 'evaluate', createdAt: 'now', updatedAt: 'now', phase: 'results_review', message: '',
    sources: [], settings: settingsSchema.parse({ userModes: ['static', 'scripted', 'reactive'] }), target: { kind: 'sandbox' }, requirements: [], questions: [],
    goldenCases: [], dialogues: [], profiles: [], scenarios: [scenario('s1'), scenario('s2')], revisions: [], selectedRevisionId: null, manifestHash: 'h',
    reviewedAt: null, reviewMode: 'human', controlConsumedAt: null, trials: [], comparisons: [], iterations: [], usage: emptyUsage(), error: null, limitations: [], humanReviews: [],
    ...overrides,
  };
}
/** user messages alternate with assistant replies; `ended` adds a terminal simulator decision after the last exchange. */
function dialogue(userMessages: string[], ended?: 'done' | 'continue'): TraceEvent[] {
  const events: TraceEvent[] = [];
  userMessages.forEach((text, i) => {
    if (i > 0) events.push({ seq: events.length, type: 'simulator', result: { message: text, done: false } });
    events.push({ seq: events.length, type: 'user', text });
    events.push({ seq: events.length, type: 'assistant', text: 'ok' });
  });
  if (ended) events.push({ seq: events.length, type: 'simulator', result: { message: '', done: ended === 'done' } });
  return events;
}
function trial(id: string, scenarioId: string, userMode: UserMode, outcome: Outcome, options: { failed?: string[]; events?: TraceEvent[]; assessments?: MetricAssessment[]; calls?: number; costUsd?: number | null } = {}): Trial {
  const failed = new Set(options.failed ?? []);
  return {
    id, revisionId: 'rev', scenarioId, familyId: scenarioId, repeat: 0, userMode, split: 'dev', manifestHash: 'h', outcome, reason: '',
    checks: ['time', 'extra'].map(check => ({ id: check, description: check, passed: !failed.has(check), evidence: '' })),
    events: options.events ?? dialogue(['hello']), initialState: world, finalState: world,
    usage: { ...emptyUsage(), calls: options.calls ?? 1, costUsd: options.costUsd === undefined ? 0.01 : options.costUsd }, elapsedMs: 1, assessments: options.assessments === undefined ? [{ metricId: 'fidelity', result: 'pass', rationale: 'Fixture simulator follows its card.', evidence: [0] }] : options.assessments,
  };
}
const review = (id: string, trialId: string, verdict: HumanReview['verdict'], target: { metricId?: string; checkId?: string } = {}, createdAt = '2026-09-08T00:00:00Z'): HumanReview => ({ id, trialId, verdict, note: 'n', createdAt, ...target });

test('identical replies with flipped rubric scores require review without rewriting evidence', () => {
  const card = { ...scenario('s1'), checks: [] };
  const a = { ...trial('a', 's1', 'reactive', 'ungraded', {
    assessments: [{ metricId: 'goal', result: 'fail', rationale: 'later refusal', evidence: [1] }],
  }), checks: [] };
  const before = record({ id: 'before', scenarios: [card], trials: [a],
    settings: settingsSchema.parse({ repeats: 1, userModes: ['reactive'] }) });
  const after = structuredClone(before); after.id = 'after';
  after.trials[0]!.id = 'b';
  after.trials[0]!.assessments![0]!.result = 'pass';
  after.trials[0]!.events[0]!.text = 'A differently worded question';
  const original = structuredClone([before, after]);
  const diff = compareRuns(before, after);
  assert.equal(diff.comparable, true);
  assert.equal(diff.pairs[0]?.change, 'unknown', 'a score flip on coincident replies is not an agent fix');
  assert.match(diff.pairs[0]?.reviewNote ?? '', /Ответы агента совпали/);
  assert.match(diff.headline, /Общих оценённых карточек нет/);
  assert.match(diff.headline, /разными оценками: 1\./);
  assert.doesNotMatch(diff.headline, /Исправлено/);
  assert.deepEqual([before, after], original);
  after.trials[0]!.events[1]!.text = 'A changed answer';
  assert.equal(compareRuns(before, after).pairs[0]?.reviewNote, undefined);
  after.trials[0]!.events = [];
  before.trials[0]!.events = [];
  assert.equal(compareRuns(before, after).pairs[0]?.reviewNote, undefined, 'missing replies are not identical evidence');
});

test('evidence summary states observed comparison results plainly and lists what the evidence cannot yet support', () => {
  const evaluate = evidenceSummary(record({ trials: [trial('a', 's1', 'reactive', 'fail', { assessments: [{ metricId: 'goal', result: 'fail', rationale: 'r', evidence: [1] }] })], humanReviews: [review('h', 'a', 'fail', { metricId: 'goal' })] }));
  assert.equal(evaluate.comparison, null);
  assert.deepEqual(evaluate.notes, []);
  const compare = evidenceSummary(record({ workflow: 'compare', comparisons: [{
    baselineId: 'b', candidateId: 'c', manifestHash: 'h', split: 'control', plannedPairs: 4, validPairs: 4, invalidPairs: 0, families: 2,
    baselinePasses: 1, candidatePasses: 4, fixed: 3, regressed: 0, tied: 1, delta: 0.75, interval: [0.5, 1], verdict: 'insufficient', reasons: ['Only two families.'], cases: [],
  }] }));
  assert.match(compare.comparison!.observed, /3 of 4/);
  assert.match(compare.comparison!.observed, /0 regress/);
  assert.match(compare.comparison!.observed, /0\.75/);
  assert.match(compare.comparison!.status, /insufficient/);
  assert.match(compare.comparison!.status, /Only two families/);
});

test('the verdict says how many dialogues passed, where the agent is weak and what to do next', () => {
  const failing = (id: string, scenarioId: string, checks: string[], goal: 'pass' | 'fail') => trial(id, scenarioId, 'reactive', checks.length ? 'fail' : 'pass', { failed: checks, assessments: [{ metricId: 'goal', result: goal, rationale: 'r', evidence: [1] }] });
  const synthetic = record({
    scenarios: [scenario('s1'), scenario('s2')].map(s => ({ ...s, provenance: 'synthetic' as const })),
    trials: [failing('a', 's1', ['time'], 'fail'), failing('b', 's1', ['time', 'extra'], 'fail'), failing('c', 's2', [], 'pass'), trial('d', 's2', 'reactive', 'invalid')],
  });
  const verdict = verdictSummary(synthetic);
  assert.deepEqual([verdict.passed, verdict.graded, verdict.passRate], [1, 3, 1 / 3]);
  assert.match(verdict.headline, /1 из 3/);
  assert.deepEqual(verdict.provenance.synthetic, { cards: 2, passed: 1, graded: 3 });
  assert.deepEqual(verdict.provenance.curated, { cards: 0, passed: 0, graded: 0 });
  assert.deepEqual(verdict.weakSpots.map(w => [w.kind, w.description, w.failures]), [['check', 'time', 2], ['metric', 'Goal', 2], ['check', 'extra', 1]]);
  assert.ok(verdict.confidenceReasons.some(r => /синтетическ/.test(r.text)));
  assert.ok(verdict.confidenceReasons.some(r => /не удалось измерить/.test(r.text)));
  assert.ok(verdict.nextSteps.some(s => /golden set/.test(s.text)));
  assert.ok(verdict.nextSteps.some(s => /вердикт/.test(s.text)));
  assert.ok(verdict.nextSteps.some(s => /своего агента/.test(s.text)));
  const mixed = record({ mode: 'live',
    scenarios: [{ ...scenario('s1'), provenance: 'curated' as const }, { ...scenario('s2'), provenance: 'production' as const }],
    trials: Array.from({ length: TRUSTED }, (_, i) => failing(`t${i}`, i % 2 ? 's1' : 's2', i < 2 ? ['time'] : [], i < 2 ? 'fail' : 'pass')),
    humanReviews: [review('h1', 't0', 'fail', { metricId: 'goal' }), review('h2', 't1', 'fail')], resultsReviewedAt: '2026-09-09T00:00:00Z', target: { kind: 'module', path: '/agent.mjs', exportName: 'createSession' },
  });
  const trusted = verdictSummary(mixed);
  assert.ok(trusted.confidenceReasons.some(r => r.code === 'small_sample'));
  assert.deepEqual([trusted.passed, trusted.graded], [TRUSTED - 2, TRUSTED]);
  assert.equal(trusted.nextSteps.some(s => /своего агента/.test(s.text)), false);
  const partial = verdictSummary({ ...mixed, resultsReviewedAt: undefined, humanReviews: [] });
  assert.ok(partial.confidenceReasons.some(r => /вердикт/.test(r.text)));
  const empty = verdictSummary(record());
  assert.equal(empty.passRate, null);
  assert.match(empty.headline, /Диалогов с оценкой ещё нет/);
});

test('сравнение двух прогонов называет, что починилось и что сломалось, а не среднее', () => {
  let runId = 0;
  const card = (id: string, tier: 'smoke' | 'regression' | 'frontier'): Scenario => ({ ...scenario(id), tier, metrics: [] });
  const run = (results: Record<string, 'pass' | 'fail'>, extra: Partial<Experiment> = {}) => record({
    id: `run-${runId++}`, settings: settingsSchema.parse({ repeats: 1, userModes: ['reactive'] }),
    scenarios: Object.keys(results).map(id => card(id, id === 'basics' ? 'smoke' : 'regression')),
    trials: Object.entries(results).map(([id, outcome], i) => trial(`t${i}_${id}`, id, 'reactive', outcome, { failed: outcome === 'fail' ? ['time'] : [] })),
    ...extra,
  });
  const before = run({ basics: 'pass', tariff: 'fail', refund: 'fail' });
  const after = run({ basics: 'pass', tariff: 'pass', refund: 'fail' });
  const diff = compareRuns(before, after);
  assert.match(diff.headline, /Исправлено 1, сломалось 0/);
  assert.deepEqual(diff.fixed.map(f => f.scenarioId), ['tariff']);
  assert.deepEqual(diff.regressed, []);
  assert.deepEqual(diff.unchanged, { passing: 1, failing: 1 });
  assert.ok(diff.notes.some(n => /может быть случайной/.test(n)), 'малая выборка названа прямо');

  // Улучшение на одной карточке не должно прятать поломку базового поведения.
  const broken = compareRuns(before, run({ basics: 'fail', tariff: 'pass', refund: 'fail' }));
  assert.match(broken.headline, /Исправлено 1, сломалось 1/);
  assert.deepEqual(broken.regressed.map(r => [r.scenarioId, r.tier]), [['basics', 'smoke']]);
  assert.ok(broken.notes.some(n => /дымовых карточек/.test(n)));

  // Несравнимые прогоны признаются несравнимыми.
  const other = compareRuns(before, run({ basics: 'pass', newcard: 'pass' }, { settings: settingsSchema.parse({ repeats: 3 }) }));
  assert.ok(other.notes.some(n => /Набор карточек изменился/.test(n)));
  assert.ok(other.notes.some(n => /повторов отличаются/.test(n)));
  assert.deepEqual(other.cards.onlyBefore.sort(), ['refund', 'tariff']);
  assert.deepEqual(other.cards.onlyAfter, ['newcard']);
});

test('этапы показывают, какое звено сломалось, а провал дымовой карточки становится приоритетом', () => {
  const staged = (id: string): Scenario => ({
    ...scenario(id), tier: id === 'smoke_card' ? 'smoke' : 'frontier',
    checks: [{ id: 'time', description: 'Клиент получил ответ', kind: 'answer_contains', value: 'ответ', stage: 'сборка ответа' }],
    metrics: [
      { id: 'compose', name: 'Ответ собран по базе знаний', subject: 'agent', description: 'd', passCriteria: 'p', failCriteria: 'f', stage: 'сборка ответа' },
      { id: 'guard', name: 'Ответ дошёл до клиента', subject: 'agent', description: 'd', passCriteria: 'p', failCriteria: 'f', stage: 'валидация' },
    ],
  });
  // Агент собрал верный ответ и сам его убил валидатором: сквозной вердикт этого не различает.
  const composed = (id: string, scenarioId: string, guard: 'pass' | 'fail'): Trial => trial(id, scenarioId, 'reactive', guard === 'pass' ? 'pass' : 'fail', {
    failed: guard === 'pass' ? [] : ['time'],
    assessments: [{ metricId: 'compose', result: 'pass', rationale: 'r', evidence: [1] }, { metricId: 'guard', result: guard, rationale: 'r', evidence: [2] }],
  });
  const r = record({
    scenarios: [staged('frontier_card'), staged('smoke_card')],
    trials: [composed('t1', 'frontier_card', 'fail'), composed('t2', 'frontier_card', 'fail'), composed('t3', 'smoke_card', 'pass')],
  });
  const v = verdictSummary(r);
  assert.deepEqual(v.stages, [
    { stage: 'валидация', passed: 1, evaluated: 3 },
    { stage: 'сборка ответа', passed: 4, evaluated: 6 },
  ]);
  assert.ok(v.weakSpots.every(w => w.stage), 'каждое слабое место названо этапом');
  assert.ok(v.weakSpots.some(w => w.stage === 'валидация' && w.kind === 'metric'));
  assert.ok(v.nextSteps.some(n => n.code === 'fix_weakest' && /на этапе «/.test(n.text)));
  assert.deepEqual(v.tiers.filter(t => t.cards), [
    { tier: 'smoke', cards: 1, passed: 1, graded: 1 },
    { tier: 'frontier', cards: 1, passed: 0, graded: 2 },
  ]);

  // Дымовая карточка — приоритет исправления.
  const broken = verdictSummary({ ...r, trials: [...r.trials, composed('t4', 'smoke_card', 'fail')] });
  assert.ok(broken.nextSteps.some(n => n.code === 'smoke_failed' && n.count === 1));
  assert.equal(broken.confidenceReasons.some(n => n.code === 'smoke_failed'), false);
});

test('rubric failures in dialogues without objective checks still count as weak spots', () => {
  const rubricOnly = (id: string, goal: 'pass' | 'fail', fidelity: 'pass' | 'fail' = 'pass'): Trial => ({
    ...trial(id, 's1', 'reactive', 'ungraded', { assessments: [{ metricId: 'goal', result: goal, rationale: 'r', evidence: [1] }, { metricId: 'fidelity', result: fidelity, rationale: 'r', evidence: [1] }] }), checks: [],
  });
  const r = record({
    scenarios: [{ ...scenario('s1'), checks: [], provenance: 'curated' }],
    trials: [rubricOnly('a', 'fail'), rubricOnly('b', 'fail', 'fail'), rubricOnly('c', 'pass')],
    humanReviews: [review('h', 'a', 'fail', { metricId: 'goal' })], resultsReviewedAt: '2026-09-09T00:00:00Z',
  });
  const v = verdictSummary(r);
  assert.deepEqual([v.passed, v.graded], [0, 0]);
  assert.deepEqual(v.rubric, { assessed: 3, passed: 1, failed: 2, unknown: 0 });
  assert.deepEqual(v.weakSpots, [{ kind: 'metric', description: 'Goal', failures: 2 }]);
  assert.match(v.headline, /Объективных проверок нет/);
  assert.match(v.headline, /1 из 3/);
  assert.match(v.headline, /не проверена/);
  assert.ok(v.confidenceReasons.some(n => n.code === 'rubric_only'));
  assert.ok(v.confidenceReasons.some(n => n.code === 'simulator_flagged' && n.count === 1));
  assert.equal(v.simulatorFlagged, 1);
  // The dialogue flagged by the fidelity rubric is not yet a usable agent measurement: the first step is a verdict on the simulator, not on the agent.
  assert.equal(v.review.pending, 1);
  assert.ok(v.nextSteps.some(n => n.code === 'inspect_simulator' && n.count === 1));
  assert.equal(v.nextSteps.some(n => n.code === 'record_verdicts'), false);
  const simulatorCleared = verdictSummary({ ...r, humanReviews: [...r.humanReviews, review('h2', 'b', 'pass', { metricId: 'fidelity' })] });
  assert.equal(simulatorCleared.simulatorFlagged, 0);
  assert.equal(simulatorCleared.nextSteps.some(n => n.code === 'record_verdicts'), false, 'a decisive automatic failure needs no mandatory human verdict');
});

test('run differences reject changed cards, missing or duplicate attempts and invalid evidence; rubric-only failures participate', () => {
  const s = { ...scenario('s1'), checks: [], metrics: metrics.filter(m => m.subject === 'agent') };
  const make = (id: string, result: 'pass' | 'fail' | 'unknown') => record({ id, scenarios: [s], settings: settingsSchema.parse({ repeats: 1, userModes: ['reactive'] }),
    trials: [{ ...trial('t', 's1', 'reactive', 'ungraded', { assessments: [{ metricId: 'goal', result, rationale: 'r', evidence: [1] }] }), checks: [] }] });
  const before = make('before', 'fail'); const after = make('after', 'pass'); after.trials[0]!.events[1]!.text = 'The actual improved answer';
  assert.equal(compareRuns(before, after).fixed.length, 1);
  assert.equal(compareRuns(before, after).includesRubrics, true);
  const unknown = compareRuns(before, make('unknown', 'unknown'));
  assert.equal(unknown.ungraded, 1);
  assert.match(unknown.incomparable[0]?.reason ?? '', /решающей.*оценки/);
  for (const changed of [
    { ...after, scenarios: [{ ...s, user: { ...s.user, opening: 'easier task' } }] },
    { ...after, trials: [] },
    { ...after, trials: [after.trials[0]!, after.trials[0]!] },
    { ...after, trials: [{ ...after.trials[0]!, outcome: 'invalid' as const }] },
    { ...after, trials: [{ ...after.trials[0]!, manifestHash: 'stale' }] },
    { ...after, phase: 'cancelled' as const },
  ]) {
    const diff = compareRuns(before, changed);
    assert.equal(diff.comparable, false); assert.equal(diff.fixed.length, 0);
    assert.ok(diff.incomparable.length > 0); assert.ok(diff.incomparable.every(pair => pair.reason.length > 0));
  }
  const failed = { ...before, humanReviews: [review('h', 't', 'pass', { metricId: 'fidelity' })] };
  assert.equal(awaitingVerdict(failed).size, 1);
  failed.humanReviews.push(review('h2', 't', 'fail', { metricId: 'goal' }));
  assert.equal(awaitingVerdict(failed).size, 0);
});

test('partial run comparisons pair the same valid attempts and disclose missing evidence without hiding regressions', () => {
  const cards = ['fixed', 'broken', 'unpaired'].map(id => ({ ...scenario(id), metrics: [] }));
  const settings = settingsSchema.parse({ repeats: 2, userModes: ['reactive'] });
  const attempt = (id: string, repeat: number, outcome: Outcome) => ({ ...trial(`${id}_${repeat}`, id, 'reactive', outcome, { failed: outcome === 'fail' ? ['time'] : [] }), repeat,
    ...(outcome === 'invalid' ? { checks: [] } : {}) });
  const before = record({ id: 'before', scenarios: cards, settings, trials: [attempt('fixed', 0, 'fail'), attempt('fixed', 1, 'invalid'), attempt('broken', 0, 'pass'), attempt('broken', 1, 'pass'), attempt('unpaired', 0, 'fail')] });
  const after = record({ id: 'after', scenarios: cards, settings, trials: [attempt('fixed', 0, 'pass'), attempt('fixed', 1, 'fail'), attempt('broken', 0, 'fail'), attempt('broken', 1, 'invalid'), attempt('unpaired', 1, 'pass')] });
  const result = compareRuns(before, after);
  assert.equal(result.comparable, true); assert.match(result.headline, /Частичное сравнение \(2\/6 пар\)/);
  assert.deepEqual(result.fixed.map(c => c.scenarioId), ['fixed']); assert.deepEqual(result.regressed.map(c => c.scenarioId), ['broken']);
  assert.equal(result.ungraded, 1, 'different repeat numbers must never be paired');
  assert.equal(result.incomparable.length, 4);
  assert.deepEqual(result.incomparable.map(pair => pair.reason).sort(), [
    'Нет попытки «до».', 'Нет попытки «после».', 'Попытка «до» невалидна или не измерена.', 'Попытка «после» невалидна или не измерена.',
  ]);
  assert.deepEqual(result.coverage, { plannedPairs: 6, validPairs: 2, excludedPairs: 4, invalidBefore: 1, invalidAfter: 1, missingBefore: 1, missingAfter: 1,
    excludedBy: { invalidBefore: 1, invalidAfter: 1, missingBefore: 1, missingAfter: 1, judgeIncomplete: 0, other: 0 } });
  assert.ok(result.notes.some(n => /Сбои могут скрывать регрессии/.test(n)));
  const tier = result.tiers.find(t => t.tier === 'regression')!;
  assert.equal(tier.before.graded, 2); assert.equal(tier.after.graded, 2, 'stage/tier rates must use the paired sample too');
  const duplicated = compareRuns(before, { ...after, trials: [...after.trials, after.trials[0]!] });
  assert.equal(duplicated.comparable, false); assert.equal(duplicated.fixed.length, 0);
  assert.deepEqual(duplicated.pairs, []);
  assert.deepEqual(result.pairs, [
    { scenarioId: 'broken', userMode: 'reactive', repeat: 0, beforeTrialId: 'broken_0', afterTrialId: 'broken_0', change: 'regressed' },
    { scenarioId: 'fixed', userMode: 'reactive', repeat: 0, beforeTrialId: 'fixed_0', afterTrialId: 'fixed_0', change: 'fixed' },
  ]);
});

test('execution, judgement source and human review describe distinct facts across the run lifecycle', () => {
  const settings = settingsSchema.parse({ repeats: 1, userModes: ['reactive'] });
  const scenarios = [{ ...scenario('s1'), metrics: [] }];
  const base = record({ mode: 'live', scenarios, settings });
  const draft = verdictSummary({ ...base, phase: 'review' });
  assert.equal(draft.nextSteps[0]!.code, 'approve_and_run');
  assert.deepEqual(draft.execution, { planned: 1, completed: 0, invalid: 0, cancelled: 0, missing: 1, running: false });
  assert.equal(draft.review.status, 'not_started');
  const active = verdictSummary({ ...base, phase: 'evaluating' });
  assert.match(active.headline, /Идёт прогон/); assert.equal(active.execution.running, true);
  assert.equal(active.nextSteps[0]!.code, 'wait_for_run');
  const unavailable = verdictSummary({ ...base, trials: [{ ...trial('t', 's1', 'reactive', 'invalid'), reason: 'Cannot start fixture executable', checks: [] }] });
  assert.match(unavailable.headline, /Не удалось измерить.*Cannot start fixture executable/);
  assert.equal(unavailable.nextSteps[0]!.code, 'repair_execution');
  assert.equal(unavailable.nextSteps.some(step => step.code === 'approve_and_run'), false);
  assert.deepEqual(unavailable.execution, { planned: 1, completed: 0, invalid: 1, cancelled: 0, missing: 0, running: false });
  const failed = { ...base, phase: 'complete' as const, resultsReviewedAt: 'old', trials: [trial('t', 's1', 'reactive', 'fail', { failed: ['time'] })] };
  const reviewState = (record: Experiment) => {
    const { status, pending, reviewed, total } = verdictSummary(record).review;
    return { status, pending, reviewed, total };
  };
  assert.deepEqual(reviewState(failed), { status: 'pending', pending: 1, reviewed: 0, total: 1 });
  const reviewed = { ...failed, humanReviews: [review('h', 't', 'fail')] };
  assert.deepEqual(reviewState(reviewed), { status: 'complete', pending: 0, reviewed: 1, total: 1 });
  assert.deepEqual(reviewState({ ...reviewed, humanReviews: [review('h', 't', 'unknown')] }), { status: 'pending', pending: 1, reviewed: 0, total: 1 });
  const rubricOnly = verdictSummary({ ...base, scenarios: [{ ...scenario('s1'), checks: [] }],
    trials: [{ ...trial('t', 's1', 'reactive', 'ungraded', { assessments: [{ metricId: 'goal', result: 'pass', rationale: 'r', evidence: [1] }] }), checks: [] }] });
  assert.deepEqual([rubricOnly.execution.completed, rubricOnly.graded, rubricOnly.rubric.assessed], [1, 0, 1]);
  assert.match(rubricOnly.headline, /Оценка модели.*1 из 1/);
  assert.doesNotMatch(rubricOnly.headline, /Доверие/);
});

test('legacy comparison summaries describe selected control evidence without averaging versions or exposing active control', () => {
  const dev = { ...scenario('dev'), metrics: [] };
  const control = { ...scenario('control'), split: 'control' as const, metrics: [] };
  const recordWithVersions = record({ workflow: 'compare', phase: 'complete', controlConsumedAt: 'now', selectedRevisionId: 'candidate',
    scenarios: [dev, control], settings: settingsSchema.parse({ repeats: 1, userModes: ['reactive'] }), trials: [
      { ...trial('base_dev', dev.id, 'reactive', 'fail', { failed: ['time'] }), revisionId: 'baseline' },
      { ...trial('candidate_dev', dev.id, 'reactive', 'pass'), revisionId: 'candidate' },
      { ...trial('base_control', control.id, 'reactive', 'fail', { failed: ['time'] }), revisionId: 'baseline', split: 'control' },
      { ...trial('candidate_control', control.id, 'reactive', 'pass'), revisionId: 'candidate', split: 'control' },
    ] });
  const summary = evidenceSummary(recordWithVersions);
  assert.deepEqual([summary.verdict.passed, summary.verdict.graded], [1, 1]);
  assert.deepEqual(summary.verdict.execution, { planned: 1, completed: 1, invalid: 0, cancelled: 0, missing: 0, running: false });
  const active = evidenceSummary({ ...recordWithVersions, phase: 'control',
    trials: recordWithVersions.trials.map(t => t.split === 'control' ? { ...t, outcome: 'fail', checks: t.checks.map(c => ({ ...c, passed: false })) } : t) });
  assert.deepEqual([active.verdict.passed, active.verdict.graded], [1, 1]);
  assert.deepEqual(active.verdict.weakSpots, []);
});

test('human findings surface missed failures and false alarms without rewriting automatic evidence', () => {
  const r = record({ scenarios: [{ ...scenario('s1'), metrics: [] }], trials: [trial('t1', 's1', 'static', 'pass')] });
  const measured = JSON.stringify(r.trials);
  r.humanReviews.push(review('negative', 't1', 'fail'));
  const v = verdictSummary(r);
  assert.match(v.headline, /^Человек отметил проблемы: 1/);
  assert.equal(v.passed, 1);
  assert.equal(v.review.flagged, 1);
  assert.equal(v.review.failed, 1);
  assert.equal(v.review.disagreements, 1);
  assert.equal(v.nextSteps[0]?.code, 'inspect_human_findings');
  assert.equal(JSON.stringify(r.trials), measured);
  assert.equal(isAgentFailure(r, r.trials[0]!), false);
  r.humanReviews.push(review('revised', 't1', 'pass', {}, '2026-09-09T00:00:00Z'));
  assert.deepEqual(humanFindings(r), []);
  r.humanReviews.push(review('specific', 't1', 'fail', { checkId: 'time' }));
  assert.equal(humanFindings(r)[0]?.target, 'time', 'a whole-dialogue pass must not erase a separate criterion finding');
  assert.equal(verdictSummary(r).review.passed, 1);
  r.humanReviews.push(review('unsure', 't1', 'unknown', { checkId: 'time' }, '2026-09-10T00:00:00Z'));
  assert.deepEqual(humanFindings(r), []);
  r.trials[0]!.outcome = 'fail'; r.trials[0]!.checks[0]!.passed = false;
  const falseAlarm = verdictSummary(r);
  assert.equal(falseAlarm.review.flagged, 0);
  assert.equal(falseAlarm.review.disagreements, 1);
  assert.match(falseAlarm.headline, /^Есть расхождения/);
});

test('simulator labels and unmeasured attempts never become automatic agent failures or calibrated disagreements', () => {
  const r = record({ trials: [trial('t1', 's1', 'reactive', 'pass', { assessments: [
    { metricId: 'goal', result: 'pass', rationale: 'r', evidence: [1] },
    { metricId: 'fidelity', result: 'pass', rationale: 'r', evidence: [1] },
  ] })], humanReviews: [review('h1', 't1', 'fail', { metricId: 'fidelity' })] });
  assert.equal(humanFindings(r)[0]?.subject, 'simulator');
  assert.equal(isAgentFailure(r, r.trials[0]!), false);
  assert.equal(verdictSummary(r).review.failed, 0, 'criterion review is not a whole-dialogue verdict');
  r.trials[0]!.outcome = 'cancelled';
  assert.equal(humanFindings(r)[0]?.automatic, 'unknown');
  assert.equal(humanFindings(r)[0]?.disagreement, false);
});

test('repeats reveal mixed cases behind 5/6 and retain missing, unknown and duplicate attempts', () => {
  const scenarios = ['s1', 's2'].map(id => ({ ...scenario(id), metrics: [] }));
  const trials = scenarios.flatMap(s => Array.from({ length: 3 }, (_, repeat) => ({
    ...trial(`${s.id}-${repeat}`, s.id, 'static', s.id === 's2' && repeat === 2 ? 'fail' : 'pass', { failed: s.id === 's2' && repeat === 2 ? ['time'] : [] }), repeat,
  })));
  const r = record({ scenarios, trials, settings: settingsSchema.parse({ repeats: 3, userModes: ['static', 'scripted'] }) });
  const v = verdictSummary(r);
  assert.equal(v.passed, 5); assert.equal(v.graded, 6);
  assert.deepEqual(v.repeats.map(row => [row.status, row.passed, row.failed, row.unknown]), [['all_pass', 3, 0, 0], ['mixed', 2, 1, 0]]);
  assert.equal(v.nextSteps.some(n => n.code === 'inspect_repeats'), true);
  assert.equal(v.repeats.length, 2, 'scripted mode without a script has no planned attempts');
  r.humanReviews = [review('override', 's2-2', 'pass')];
  assert.equal(repeatResults(r)[1]?.status, 'mixed', 'manual verdicts never rewrite repeated automatic results');
  r.trials.pop();
  assert.deepEqual(repeatResults(r)[1]?.unknown, 1);
  assert.equal(repeatResults(r)[1]?.status, 'incomplete');
  r.trials.push({ ...trials[0]!, id: 'duplicate' });
  assert.equal(repeatResults(r)[0]?.status, 'incomplete');
  assert.equal(repeatResults(r)[0]?.unknown, 1);
  r.trials[1]!.outcome = 'invalid';
  assert.equal(repeatResults(r)[0]?.unknown, 2);
  r.settings.repeats = 1; r.settings.userModes = ['static']; r.trials = [trials[0]!];
  assert.equal(repeatResults(r)[0]?.status, 'single');
});

test('comparison opens the repaired repeat before unchanged attempts of the same card', () => {
  const scenarios = [{ ...scenario('s1'), metrics: [] }];
  const settings = settingsSchema.parse({ repeats: 3, userModes: ['static'] });
  const attempts = Array.from({ length: 3 }, (_, repeat) => ({ ...trial(`t${repeat}`, 's1', 'static', repeat === 2 ? 'fail' : 'pass', { failed: repeat === 2 ? ['time'] : [] }), repeat }));
  const before = record({ id: 'before', scenarios, settings, trials: attempts });
  const after = record({ id: 'after', scenarios, settings, trials: attempts.map(t => ({ ...t, id: `new-${t.id}`, outcome: 'pass', checks: t.checks.map(c => ({ ...c, passed: true })) })) });
  const diff = compareRuns(before, after);
  assert.equal(diff.fixed.length, 1);
  assert.deepEqual(diff.pairs.map(p => p.repeat), [2, 0, 1]);
  assert.deepEqual(diff.pairs.map(p => p.change), ['fixed', 'unchanged', 'unchanged']);
});

test('live rubric comparisons require recorded compatible judge protocols and a measured simulator', () => {
  const card = { ...scenario('s1'), checks: [] };
  const before = record({ id: 'before', mode: 'live', scenarios: [card], settings: settingsSchema.parse({ repeats: 1, userModes: ['reactive'] }),
    trials: [{ ...trial('a', 's1', 'reactive', 'ungraded', { assessments: [
      { metricId: 'goal', result: 'fail', rationale: 'Evidence', evidence: [1] },
      { metricId: 'fidelity', result: 'pass', rationale: 'Evidence', evidence: [0] },
    ] }), checks: [] }] });
  const after = structuredClone(before); after.id = 'after'; after.trials[0]!.id = 'b'; after.trials[0]!.events[1]!.text = 'Better answer'; after.trials[0]!.assessments![0]!.result = 'pass';
  assert.equal(compareRuns(before, after).comparable, false, 'legacy single votes cannot establish improvement');
  for (const run of [before, after]) {
    for (const a of run.trials[0]!.assessments!) a.citations = a.evidence.map(seq => ({ seq, quote: run.trials[0]!.events.find(e => e.seq === seq)!.text! }));
    const data = judgeInput({ scenario: card, sources: run.sources, trial: run.trials[0]! });
    run.trials[0]!.judgeAudit = { protocolHash: JUDGE_PROTOCOL, inputHash: fingerprint(data), provider: 'offline', model: 'judge', prompt: JUDGE_PROMPT, input: JSON.stringify(data),
      attempts: [0, 1].map(() => ({ startedAt: 'now', raw: JSON.stringify({ assessments: run.trials[0]!.assessments!.map(({ result, ...v }) => ({ ...v, passCondition: result === 'pass' ? 'met' : 'not_met', failCondition: result === 'fail' ? 'met' : 'not_met' })) }), assessments: structuredClone(run.trials[0]!.assessments!) })), notApplicable: [] };
  }
  assert.equal(compareRuns(before, after).fixed.length, 1);
  after.trials[0]!.judgeAudit!.protocolHash = 'protocol-v2';
  assert.equal(compareRuns(before, after).comparable, false);
  after.trials[0]!.judgeAudit!.protocolHash = JUDGE_PROTOCOL;
  after.trials[0]!.assessments = after.trials[0]!.assessments!.filter(a => a.metricId !== 'fidelity');
  const unknown = compareRuns(before, after);
  assert.equal(unknown.fixed.length, 0); assert.equal(unknown.comparable, false);
  assert.equal(verdictSummary(after).simulatorFlagged, 1);
});

test('code-flagged simulator dialogues remain visible in the verdict', () => {
  const flagged = { ...trial('a', 's1', 'reactive', 'pass', { events: dialogue(['hello', 'again']) }),
    simulatorChecks: [{ id: 'simulator_loop' as const, description: 'd', passed: false, evidence: 'Реплика #3 повторяет реплику #0.', seq: 3, heuristic: false }] };
  const r = record({ settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1 }), trials: [flagged] });
  const v = verdictSummary(r);
  assert.equal(v.simulatorFlagged, 1);
  assert.ok(v.confidenceReasons.some(n => n.code === 'simulator_flagged' && /кодовым проверкам/.test(n.text)));
  assert.ok(v.nextSteps.some(n => n.code === 'inspect_simulator'));
});

test('simulator review controls eligibility without rewriting evidence or becoming an agent finding', async () => {
  const { automaticTrialResult, evaluationExitCode } = await import('../src/comparison.js');
  const card = { ...scenario('s1'), metrics: [] };
  const t = trial('a', 's1', 'reactive', 'pass', { events: dialogue(['hello', '1234']) });
  t.simulatorChecks = [{ id: 'simulator_leak', description: 'suspicion', evidence: '1234', passed: false, heuristic: true }];
  const r = record({ scenarios: [card], trials: [t], settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1 }) });
  assert.equal(automaticTrialResult(card, t), 'unknown');
  assert.equal(evaluationExitCode(r), 2);
  r.humanReviews = [review('sim-fail', t.id, 'fail', { checkId: 'simulator_leak' })];
  assert.equal(humanFindings(r)[0]!.subject, 'simulator');
  assert.equal(isAgentFailure(r, t), false);
  r.humanReviews.push(review('sim-pass', t.id, 'pass', { checkId: 'simulator_leak' }, '2026-09-09T00:00:00Z'));
  assert.equal(automaticTrialResult(card, t, r.humanReviews), 'pass');
  assert.equal(verdictSummary(r).simulatorFlagged, 0);
  assert.equal(evaluationExitCode(r), 0);
  assert.equal(t.simulatorChecks[0]!.passed, false, 'raw evidence stays immutable');
});

const commandTarget: Target = { kind: 'command', command: 'python3', args: ['agent.py'], timeoutMs: 60000 };
const cardChanged = (notes: string[]) => notes.some(n => n.startsWith('Содержимое карточек изменилось'));

test('an external legacy card without an evidence channel equals the same card judged on the reply', () => {
  const legacy = { ...scenario('s1'), metrics: [] };
  const current = { ...legacy, goalObservation: 'reply' as const };
  const settings = settingsSchema.parse({ repeats: 1, userModes: ['static'] });
  const trials = [trial('t1', 's1', 'static', 'pass')];
  const pair = (target: Target, before: Scenario, after: Scenario) => compareRuns(
    record({ id: 'before', target, settings, scenarios: [before], trials }),
    record({ id: 'after', target, settings, scenarios: [after], trials: trials.map(t => ({ ...t, id: `new-${t.id}` })), parentRunId: 'before' }));
  const external = pair(commandTarget, legacy, current);
  assert.equal(cardChanged(external.notes), false);
  assert.equal(external.comparable, true);
  assert.equal(legacy.goalObservation, undefined, 'the stored card is not rewritten');
  assert.equal(cardChanged(pair({ kind: 'sandbox' }, legacy, current).notes), true, 'a sandbox card has no default channel');
  assert.equal(cardChanged(pair(commandTarget, legacy, { ...current, title: 'Другая цель' }).notes), true, 'a real change stays visible');
});

async function judgedRun(id: string, sources: Source[], requirements: Experiment['requirements'], verdicts: Record<string, 'pass' | 'fail'>, reply = 'ok'): Promise<Experiment> {
  const cards = ['s1', 's2'].map(cardId => ({ ...scenario(cardId), checks: [], metrics: [metrics[0]!] }));
  const trials: Trial[] = [];
  for (const card of cards) {
    const events: TraceEvent[] = [{ seq: 0, type: 'user', text: 'hello' }, { seq: 1, type: 'assistant', text: reply }];
    const attempt: Trial = { ...trial(`${id}-${card.id}`, card.id, 'static', 'ungraded', { assessments: [], events }), checks: [] };
    delete attempt.assessments;
    let audit: JudgeAudit | undefined;
    const pass = verdicts[card.id] === 'pass';
    const assessments = await assessRepeated({ scenario: card, sources: observableSources(sources, requirements), trial: attempt }, { provider: 'offline', id: 'judge' },
      { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, onJudgment(_id, value) { audit = value; } },
      async () => JSON.stringify({ assessments: [{ metricId: 'goal', passCondition: pass ? 'met' : 'not_met', failCondition: pass ? 'not_met' : 'met',
        rationale: 'Fixture evidence.', evidence: [1], citations: [{ seq: 1, quote: reply }] }] }));
    trials.push({ ...attempt, assessments, judgeAudit: audit });
  }
  return record({ id, mode: 'live', target: commandTarget, sources, requirements, scenarios: cards, trials,
    settings: settingsSchema.parse({ repeats: 1, userModes: ['static'] }) });
}

test('live comparison checks judge receipts against the sources the judge saw, one pair at a time', async () => {
  const sources: Source[] = [{ id: 'p', name: 'Prompt', content: 'Always cite the tariff page.', hash: 'h', kind: 'prompt' }];
  const requirements = [{ id: 'cite', text: 'Cite the tariff page', sourceId: 'p', quote: 'Always cite the tariff page.', critical: false }];
  const before = await judgedRun('before', sources, requirements, { s1: 'fail', s2: 'fail' });
  const after = { ...await judgedRun('after', sources, requirements, { s1: 'pass', s2: 'fail' }, 'better'), parentRunId: 'before' };
  assert.equal(verdictSummary(before).confidenceReasons.some(r => r.code === 'judge_unaudited'), false);
  const diff = compareRuns(before, after);
  assert.equal(diff.notes.some(n => /судь|Судь/.test(n)), false, JSON.stringify(diff.notes));
  assert.equal(diff.comparable, true);
  assert.equal(diff.fixed.length, 1);

  const rejected = structuredClone(after);
  rejected.trials[1]!.assessmentError = 'Judge response rejected';
  const partial = compareRuns(before, rejected);
  assert.equal(partial.comparable, true, 'one rejected judgment does not hide the rest of the diff');
  assert.deepEqual(partial.incomparable.map(i => [i.scenarioId, i.reason]), [['s2', 'Судья не завершил оценку этой попытки.']]);
  assert.equal(partial.fixed.length, 1);
  assert.equal(partial.coverage.validPairs, 1);
  assert.deepEqual(partial.coverage.excludedBy, { invalidBefore: 0, invalidAfter: 0, missingBefore: 0, missingAfter: 0, judgeIncomplete: 1, other: 0 });
  assert.ok(partial.notes.includes('Сопоставлено 1 из 2 пар попыток. Исключено 1: до — 0 невалидных и 0 пропущенных; после — 0 невалидных и 0 пропущенных; без завершённой оценки судьи — 1. Сбои могут скрывать регрессии; вывод относится только к сопоставленной части.'), JSON.stringify(partial.notes));

  const otherJudge = structuredClone(after);
  for (const t of otherJudge.trials) t.judgeAudit!.model = 'another-judge';
  assert.equal(compareRuns(before, otherJudge).comparable, false, 'a different judge model still blocks the whole diff');
});

/** The same run as a new executor would store it: a sealed receipt per trial, no full audit. */
function withReceipts(run: Experiment): Experiment {
  const copy = structuredClone(run);
  for (const t of copy.trials) {
    const scenario = copy.scenarios.find(s => s.id === t.scenarioId)!;
    const complete = hasCompleteJudgment({ scenario, sources: observableSources(copy.sources, copy.requirements), trial: t });
    t.judgeReceipt = sealJudgeReceipt(t.judgeAudit!, complete);
    delete t.judgeAudit;
  }
  return copy;
}

test('a legacy full-audit run and a receipt run of the same judge compare as one judge', async () => {
  const sources: Source[] = [{ id: 'p', name: 'Prompt', content: 'Always cite the tariff page.', hash: 'h', kind: 'prompt' }];
  const requirements = [{ id: 'cite', text: 'Cite the tariff page', sourceId: 'p', quote: 'Always cite the tariff page.', critical: false }];
  const before = await judgedRun('before', sources, requirements, { s1: 'fail', s2: 'fail' });
  const after = withReceipts({ ...await judgedRun('after', sources, requirements, { s1: 'pass', s2: 'fail' }, 'better'), parentRunId: 'before' });
  assert.ok(after.trials.every(t => !t.judgeAudit && t.judgeReceipt?.complete));
  const diff = compareRuns(before, after);
  assert.equal(diff.notes.some(n => n.startsWith('Протокол или модель судьи отличаются')), false, JSON.stringify(diff.notes));
  assert.equal(diff.notes.some(n => n.includes('смешаны разные протоколы судьи')), false);
  assert.equal(diff.comparable, true);
  assert.equal(diff.fixed.length, 1);
  // Mixed storage inside one run is still one judge.
  const mixed = structuredClone(before);
  mixed.trials[1] = withReceipts(before).trials[1]!;
  assert.equal(compareRuns(mixed, after).comparable, true);
  // A receipt from another model is still another judge.
  const other = structuredClone(after);
  for (const t of other.trials) t.judgeReceipt!.model = 'another-judge';
  assert.equal(compareRuns(before, other).comparable, false);

  assert.equal(judgeModel(after), 'judge', 'the model is read from receipts');
  assert.equal(judgeModel(before), 'judge');
});

// ---- Stability after a reassessment of saved answers. ----
const REASSESSED_SOURCE = 'c0ffee00-0000-4000-8000-000000000001';
/** One reactive attempt per card judged on the goal rubric; the reassessment keeps the source trial ids. */
function goalRun(id: string, goals: Record<string, 'pass' | 'fail' | 'unknown'>, manifestHash: string, overrides: Partial<Experiment> = {}): Experiment {
  const cards = Object.keys(goals).map(key => ({ ...scenario(key), checks: [], metrics: [{ ...goalAttainment }] }));
  const trials = Object.entries(goals).map(([key, goal]) => ({ ...trial(`t-${key}`, key, 'reactive', 'ungraded', {
    assessments: [{ metricId: 'goal_attainment', result: goal, rationale: 'r', evidence: goal === 'unknown' ? [] : [1] }] }), checks: [], manifestHash }));
  return record({ id, settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1 }), scenarios: cards, trials, manifestHash, ...overrides });
}
function reassessed(source: Experiment, goals: Record<string, 'pass' | 'fail' | 'unknown'>, overrides: Partial<Experiment> = {}): Experiment {
  const next = goalRun('c0ffee00-0000-4000-8000-000000000002', goals, 'h-reassess', { parentRunId: source.id, assessmentOf: source.id,
    assessmentTrialIds: Object.keys(goals).map(key => `t-${key}`), evidenceHash: 'evidence',
    sourceEvidence: { runId: source.id, trials: structuredClone(source.trials), humanReviews: [] }, ...overrides });
  return next;
}

test('stabilityAfterReassess counts a goal flip on the same answers and the same criteria', () => {
  const source = goalRun(REASSESSED_SOURCE, { s1: 'pass', s2: 'fail' }, 'h');
  const next = reassessed(source, { s1: 'fail', s2: 'fail' });
  const stability = stabilityAfterReassess(next, source);
  assert.deepEqual(stability, { basis: 'reassess', comparedWith: REASSESSED_SOURCE, checked: 2, skipped: null,
    unstable: [{ scenarioId: 's1', title: 's1', before: 'pass', after: 'fail' }] });
  const rebuilt = embeddedBefore(next, REASSESSED_SOURCE);
  assert.ok(rebuilt);
  assert.deepEqual(stabilityAfterReassess(next, rebuilt), { ...stability, checked: 0, unstable: [], skipped: 'исходный прогон недоступен' },
    'a legacy embedded source has no identity to compare with');
  next.sourceEvidence!.identity = sourceIdentity(source, ['s1', 's2']);
  const labelled = { ...next, sourceEvidence: { ...next.sourceEvidence!, identity: { ...next.sourceEvidence!.identity!, manifestHash: 'h-identity' } } };
  assert.equal(embeddedBefore(labelled, REASSESSED_SOURCE)!.manifestHash, 'h-identity', 'the source manifest comes from its identity');
  assert.deepEqual(stabilityAfterReassess(next, embeddedBefore(next, REASSESSED_SOURCE)!), stability, 'the embedded identity gives the same answer as the stored one');
});

test('stabilityAfterReassess against a rebuilt source never compares the reassessment with itself', () => {
  const source = goalRun(REASSESSED_SOURCE, { s1: 'pass', s2: 'pass' }, 'h', { evaluatorVersion: 'judge-1' });
  const identity = sourceIdentity(source, ['s1', 's2']);
  // Changed criteria on s1: the rebuilt source holds the new card, the identity holds the old one.
  const criteria = reassessed(source, { s1: 'fail', s2: 'fail' }, { evaluatorVersion: 'judge-1' });
  criteria.scenarios[0]!.metrics = [{ ...goalAttainment, passCriteria: 'Другое условие.' }];
  criteria.sourceEvidence!.identity = identity;
  const stability = stabilityAfterReassess(criteria, embeddedBefore(criteria, REASSESSED_SOURCE)!);
  assert.equal(stability?.checked, 1);
  assert.deepEqual(stability?.unstable.map(row => row.scenarioId), ['s2']);
  // Another judge: the rebuilt source carries the current settings, the identity the original.
  const judge = reassessed(source, { s1: 'fail', s2: 'fail' }, { evaluatorVersion: 'judge-1',
    settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1, judge: { provider: 'openrouter', model: 'another-judge' } }) });
  judge.sourceEvidence!.identity = identity;
  assert.equal(stabilityAfterReassess(judge, embeddedBefore(judge, REASSESSED_SOURCE)!)?.skipped, 'судья или его настройки изменились');
});

test('stabilityAfterReassess skips changed criteria, partial coverage and unknown verdicts', () => {
  const source = goalRun(REASSESSED_SOURCE, { s1: 'pass', s2: 'pass', s3: 'pass' }, 'h');
  const next = reassessed(source, { s1: 'fail', s2: 'fail', s3: 'unknown' });
  next.scenarios[0]!.metrics = [{ ...goalAttainment, passCriteria: 'Другое условие.' }];
  // s2 was reassessed from an attempt the source never had.
  next.trials[1]!.id = 't-foreign';
  const stability = stabilityAfterReassess(next, source);
  assert.equal(stability?.checked, 0);
  assert.deepEqual(stability?.unstable, []);
  // A card with two source attempts, only one of them reassessed, is not counted.
  const two = goalRun(REASSESSED_SOURCE, { s1: 'pass' }, 'h');
  two.settings = settingsSchema.parse({ userModes: ['reactive'], repeats: 2 });
  two.trials.push({ ...structuredClone(two.trials[0]!), id: 't-s1-b', repeat: 1 });
  const partial = reassessed(two, { s1: 'fail' }, { settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1 }) });
  assert.deepEqual(stabilityAfterReassess(partial, two)?.unstable, []);
  assert.equal(stabilityAfterReassess(partial, two)?.checked, 0);
});

test('stabilityAfterReassess refuses another judge and records that are not a reassessment of this source', () => {
  const source = goalRun(REASSESSED_SOURCE, { s1: 'pass' }, 'h', { evaluatorVersion: 'judge-1' });
  const judge = reassessed(source, { s1: 'fail' }, { evaluatorVersion: 'judge-2',
    settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1, judge: { provider: 'openrouter', model: 'another-judge' } }) });
  assert.deepEqual(stabilityAfterReassess(judge, source), { basis: 'reassess', comparedWith: REASSESSED_SOURCE, checked: 0, unstable: [], skipped: 'судья или его настройки изменились' });
  // An Agent Lab upgrade changes evaluatorVersion but not the judge: the flip is still found.
  const upgraded = reassessed(source, { s1: 'fail' }, { evaluatorVersion: 'judge-2' });
  assert.equal(stabilityAfterReassess(upgraded, source)?.skipped, null);
  assert.equal(stabilityAfterReassess(upgraded, source)?.unstable.length, 1);
  // Another judge protocol or configuration on the recorded votes is another judge.
  const receipt = (protocolHash: string) => ({ protocolHash, inputHash: 'i', provider: 'openrouter', model: 'judge', auditHash: 'a', votes: [], notApplicable: [], complete: true });
  const oldProtocol = structuredClone(source); oldProtocol.trials[0]!.judgeReceipt = receipt('protocol-1');
  const newProtocol = reassessed(oldProtocol, { s1: 'fail' }); newProtocol.trials[0]!.judgeReceipt = receipt('protocol-2');
  assert.equal(stabilityAfterReassess(newProtocol, oldProtocol)?.skipped, 'судья или его настройки изменились');
  newProtocol.trials[0]!.judgeReceipt = receipt('protocol-1');
  assert.equal(stabilityAfterReassess(newProtocol, oldProtocol)?.skipped, null);
  const noHash = reassessed(source, { s1: 'fail' }, { evaluatorVersion: 'judge-1' });
  delete noHash.evidenceHash;
  assert.equal(stabilityAfterReassess(noHash, source), null);
  const other = reassessed(source, { s1: 'fail' }, { evaluatorVersion: 'judge-1', assessmentOf: 'c0ffee00-0000-4000-8000-00000000ffff' });
  assert.equal(stabilityAfterReassess(other, source), null);
});

// ---- Saved suites and reassessments carry receipts, not legacy audits. ----
test('suiteEvidence seals legacy audits into receipts and copies receipts unchanged', async () => {
  const sources: Source[] = [{ id: 'p', name: 'Prompt', content: 'Always cite the tariff page.', hash: 'h', kind: 'prompt' }];
  const requirements = [{ id: 'cite', text: 'Cite the tariff page', sourceId: 'p', quote: 'Always cite the tariff page.', critical: false }];
  const legacy = await judgedRun('legacy', sources, requirements, { s1: 'pass', s2: 'fail' });
  const audits = legacy.trials.map(t => structuredClone(t.judgeAudit!));
  // The second trial's audit no longer matches its input: its receipt must say so.
  legacy.trials[1]!.judgeAudit!.inputHash = 'stale';
  const staleAudit = structuredClone(legacy.trials[1]!.judgeAudit!);
  const before = JSON.stringify(legacy);
  const evidence = suiteEvidence(legacy, ['s1', 's2']);
  assert.equal(JSON.stringify(legacy), before, 'the source record is not changed');
  assert.equal(JSON.stringify(evidence).includes('"judgeAudit"'), false);
  const [first, second] = evidence.trials;
  assert.equal(first!.judgeReceipt?.complete, true);
  assert.equal(first!.judgeReceipt?.auditHash, fingerprint(audits[0]));
  assert.equal(second!.judgeReceipt?.complete, false);
  assert.equal(second!.judgeReceipt?.auditHash, fingerprint(staleAudit));

  const sealed = withReceipts(await judgedRun('sealed', sources, requirements, { s1: 'pass', s2: 'fail' }));
  const copied = suiteEvidence(sealed, ['s1', 's2']);
  assert.deepEqual(copied.trials, sealed.trials, 'a trial that already has a receipt is copied unchanged');

  // A card that is missing from the record cannot be verified.
  const orphan = structuredClone(await judgedRun('orphan', sources, requirements, { s1: 'pass', s2: 'pass' }));
  orphan.trials[0]!.scenarioId = 'gone';
  const lost = suiteEvidence(orphan, ['gone']);
  assert.equal(lost.trials[0]!.judgeReceipt?.complete, false);
  assert.equal(lost.trials[0]!.judgeAudit, undefined);
});

test('a reassessment rebuilt from receipt-carrying source evidence keeps the same stability', () => {
  const source = goalRun(REASSESSED_SOURCE, { s1: 'pass', s2: 'fail' }, 'h');
  for (const t of source.trials) {
    t.judgeAudit = { protocolHash: JUDGE_PROTOCOL, inputHash: 'legacy', provider: 'offline', model: 'judge', prompt: JUDGE_PROMPT, input: '{}',
      attempts: [0, 1].map(() => ({ startedAt: 'now', raw: 'LEGACY_RAW', assessments: structuredClone(t.assessments!) })), notApplicable: [] };
  }
  const next = reassessed(source, { s1: 'fail', s2: 'fail' }, { sourceEvidence: suiteEvidence(source, ['s1', 's2']) });
  assert.equal(JSON.stringify(next).includes('"judgeAudit"'), false);
  assert.equal(JSON.stringify(next).includes('LEGACY_RAW'), false);
  const stored = stabilityAfterReassess(next, source);
  assert.equal(stored?.checked, 2);
  const rebuilt = embeddedBefore(next, REASSESSED_SOURCE);
  assert.ok(rebuilt);
  assert.deepEqual(stabilityAfterReassess(next, rebuilt), stored);
});

// ---- Positive controls are left out of the repeat diff. ----
const CONTROL_NOTE = 'Контрольные ситуации не сравниваются: они не входят в главное число.';
/** A repeat of `source` that made `ctl` a one-turn control, carrying the source evidence and its identity. */
function controlledRepeat(source: Experiment, edit?: (run: Experiment) => void): Experiment {
  const ids = source.scenarios.map(s => s.id);
  const after = goalRun('c0ffee00-0000-4000-8000-000000000003', Object.fromEntries(ids.map(id => [id, 'pass'])), source.manifestHash!, {
    parentRunId: source.id, positiveControlScenarioIds: ['ctl'],
    sourceEvidence: { runId: source.id, trials: structuredClone(source.trials), humanReviews: [], identity: sourceIdentity(source, ids) } });
  after.scenarios.find(s => s.id === 'ctl')!.user.maxFollowUps = 0;
  edit?.(after);
  return after;
}

test('a rebuilt source keeps its card identity when control situations are left out of the diff', () => {
  const source = goalRun(REASSESSED_SOURCE, { s1: 'pass', s2: 'pass', ctl: 'pass' }, 'h');
  const same = controlledRepeat(source);
  const sameDiff = compareRuns(embeddedBefore(same, source.id)!, same);
  assert.equal(sameDiff.comparable, true, sameDiff.notes.join(' '));
  assert.ok(sameDiff.notes.includes(CONTROL_NOTE));
  assert.equal(sameDiff.cards.shared, 2);
  assert.ok([...sameDiff.pairs, ...sameDiff.incomparable].every(row => row.scenarioId !== 'ctl'));

  // The rebuilt source holds the current cards; only the identity from the original record reveals the edit.
  const edited = controlledRepeat(source, run => { run.scenarios.find(s => s.id === 's1')!.user.goal = 'another goal'; });
  const editedDiff = compareRuns(embeddedBefore(edited, source.id)!, edited);
  assert.equal(editedDiff.comparable, false);
  assert.ok(editedDiff.notes.some(note => note.startsWith('Содержимое карточек изменилось')), editedDiff.notes.join(' '));
});
