import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sourceIdentity } from '../src/normalize.js';
import { awaitingVerdict, compareRuns, humanFindings, judgeModel, stabilityAfterReassess, stabilityBetweenRuns } from '../src/comparison.js';
import { cardOutcome, cardVerdict, goalCardOutcome, headlineCardOutcome, plannedTrials } from '../src/run.js';
import { buildResultView, exitCodeOf } from '../src/result-view.js';
import { embeddedBefore } from '../src/artifacts.js';
import { suiteEvidence } from '../src/connection.js';
import { automaticTrialResult, COUNTING_RULES, isAgentFailure } from '../src/outcomes.js';
import { assessRepeated, hasCompleteJudgment, judgeInput, JUDGE_PROMPT, JUDGE_PROTOCOL, observableSources, sealJudgeReceipt, SPLIT_RATIONALE_PREFIX } from '../src/judge.js';
import { emptyUsage, fingerprint, settingsSchema, type Experiment, type HumanReview, type Outcome, type Scenario, type Source, type Target, type TraceEvent, type Trial, type UserMode } from '../src/contracts.js';
import { goalAttainment, promptCompliance, replyQuality, simulatorFidelity, type JudgeAudit, type MetricAssessment } from '../src/assessment.js';

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
  assert.match(diff.headline, /Общих оценённых ситуаций нет/);
  assert.match(diff.headline, /разными оценками: 1\./);
  assert.doesNotMatch(diff.headline, /Исправлено/);
  assert.deepEqual([before, after], original);
  after.trials[0]!.events[1]!.text = 'A changed answer';
  assert.equal(compareRuns(before, after).pairs[0]?.reviewNote, undefined);
  after.trials[0]!.events = [];
  before.trials[0]!.events = [];
  assert.equal(compareRuns(before, after).pairs[0]?.reviewNote, undefined, 'missing replies are not identical evidence');
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
  const duplicated = compareRuns(before, { ...after, trials: [...after.trials, after.trials[0]!] });
  assert.equal(duplicated.comparable, false); assert.equal(duplicated.fixed.length, 0);
  assert.deepEqual(duplicated.pairs, []);
  assert.deepEqual(result.pairs, [
    { scenarioId: 'broken', userMode: 'reactive', repeat: 0, beforeTrialId: 'broken_0', afterTrialId: 'broken_0', change: 'regressed' },
    { scenarioId: 'fixed', userMode: 'reactive', repeat: 0, beforeTrialId: 'fixed_0', afterTrialId: 'fixed_0', change: 'fixed' },
  ]);
});

test('the result view keeps the run lifecycle apart: a draft, a running run, a failed connection, a failure and a rubric-only situation', () => {
  const settings = settingsSchema.parse({ repeats: 1, userModes: ['reactive'] });
  const scenarios = [{ ...scenario('s1'), metrics: [] }];
  const base = record({ mode: 'live', scenarios, settings });
  const draft = buildResultView({ ...base, phase: 'review' });
  assert.deepEqual([draft.pending, draft.notMeasured.total, draft.next], [0, 0, []], 'a draft that never ran is neither pending nor unmeasured and offers no step');
  const active = buildResultView({ ...base, phase: 'evaluating' });
  assert.deepEqual([active.pending, active.notMeasured.total], [1, 0], 'a situation of a running run is still being checked, not unmeasured');
  assert.deepEqual(active.next, [{ kind: 'wait' }]);
  assert.equal(exitCodeOf(active), 2);
  const unavailable = buildResultView({ ...base, trials: [{ ...trial('t', 's1', 'reactive', 'invalid'), reason: 'Cannot start fixture executable', checks: [] }] });
  assert.deepEqual(unavailable.notMeasured.reasons.map(reason => [reason.code, reason.scenarioIds]), [['agent_error', ['s1']]]);
  assert.equal(unavailable.headline.decided, 0);
  assert.deepEqual(unavailable.next, [{ kind: 'why_unmeasured', count: 1 }]);
  assert.equal(exitCodeOf(unavailable), 2);
  const failed = { ...base, phase: 'complete' as const, resultsReviewedAt: 'old', trials: [trial('t', 's1', 'reactive', 'fail', { failed: ['time'] })] };
  const failedView = buildResultView(failed);
  assert.deepEqual([failedView.headline.passed, failedView.headline.decided], [0, 1]);
  assert.equal(exitCodeOf(failedView), 1);
  assert.equal(awaitingVerdict(failed).size, 1, 'the failure waits for a verdict');
  const reviewed = { ...failed, humanReviews: [review('h', 't', 'fail')] };
  assert.equal(awaitingVerdict(reviewed).size, 0);
  assert.equal(awaitingVerdict({ ...reviewed, humanReviews: [review('h', 't', 'unknown')] }).size, 1, '«не могу сказать» is not a verdict');
  const rubricOnly = buildResultView({ ...base, scenarios: [{ ...scenario('s1'), checks: [] }],
    trials: [{ ...trial('t', 's1', 'reactive', 'ungraded', { assessments: [{ metricId: 'goal', result: 'pass', rationale: 'r', evidence: [1] },
      { metricId: 'fidelity', result: 'pass', rationale: 'r', evidence: [0] }] }), checks: [] }] });
  assert.deepEqual([rubricOnly.headline.passed, rubricOnly.headline.decided], [1, 1], 'a situation judged only by the rubric is counted');
  assert.equal(exitCodeOf(rubricOnly), 0);
});

test('a legacy comparison run shows the selected version on its control split, never an average of versions or an active control', () => {
  const dev = { ...scenario('dev'), metrics: [] };
  const control = { ...scenario('control'), split: 'control' as const, metrics: [] };
  const recordWithVersions = record({ workflow: 'compare', phase: 'complete', controlConsumedAt: 'now', selectedRevisionId: 'candidate',
    scenarios: [dev, control], settings: settingsSchema.parse({ repeats: 1, userModes: ['reactive'] }), trials: [
      { ...trial('base_dev', dev.id, 'reactive', 'fail', { failed: ['time'] }), revisionId: 'baseline' },
      { ...trial('candidate_dev', dev.id, 'reactive', 'pass'), revisionId: 'candidate' },
      { ...trial('base_control', control.id, 'reactive', 'fail', { failed: ['time'] }), revisionId: 'baseline', split: 'control' },
      { ...trial('candidate_control', control.id, 'reactive', 'pass'), revisionId: 'candidate', split: 'control' },
    ] });
  const view = buildResultView(recordWithVersions);
  assert.deepEqual([view.headline.passed, view.headline.decided], [1, 1]);
  assert.deepEqual(view.cards.map(card => [card.scenarioId, card.outcome]), [['control', 'pass']], 'the baseline failure never averages into the selected version');
  assert.equal(view.scope.dialogues, 1);
  const active = buildResultView({ ...recordWithVersions, phase: 'control',
    trials: recordWithVersions.trials.map(t => t.split === 'control' ? { ...t, outcome: 'fail', checks: t.checks.map(c => ({ ...c, passed: false })) } : t) });
  assert.deepEqual(active.cards.map(card => card.scenarioId), ['dev'], 'an active control split is not shown');
  assert.deepEqual(active.failures, []);
});

test('human findings surface missed failures and false alarms without rewriting automatic evidence', () => {
  const r = record({ scenarios: [{ ...scenario('s1'), metrics: [] }], trials: [trial('t1', 's1', 'static', 'pass')], settings: settingsSchema.parse({ repeats: 1, userModes: ['static'] }) });
  const measured = JSON.stringify(r.trials);
  r.humanReviews.push(review('negative', 't1', 'fail'));
  assert.deepEqual(humanFindings(r).map(f => [f.trialId, f.subject, f.verdict, f.automatic, f.disagreement]), [['t1', 'agent', 'fail', 'pass', true]]);
  const view = buildResultView(r);
  assert.deepEqual([view.headline.passed, view.headline.decided], [1, 1], 'a whole-dialogue remark is a finding; it does not rewrite the automatic result');
  assert.equal(JSON.stringify(r.trials), measured);
  assert.equal(isAgentFailure(r, r.trials[0]!), false);
  r.humanReviews.push(review('revised', 't1', 'pass', {}, '2026-09-09T00:00:00Z'));
  assert.deepEqual(humanFindings(r), []);
  r.humanReviews.push(review('specific', 't1', 'fail', { checkId: 'time' }));
  assert.equal(humanFindings(r)[0]?.target, 'time', 'a whole-dialogue pass must not erase a separate criterion finding');
  r.humanReviews.push(review('unsure', 't1', 'unknown', { checkId: 'time' }, '2026-09-10T00:00:00Z'));
  assert.deepEqual(humanFindings(r), []);
  r.trials[0]!.outcome = 'fail'; r.trials[0]!.checks[0]!.passed = false;
  assert.deepEqual(humanFindings(r).map(f => [f.verdict, f.automatic, f.disagreement]), [['pass', 'fail', true]], 'a pass against an automatic failure is a disagreement, not a flagged problem');
});

test('simulator labels and unmeasured attempts never become automatic agent failures or calibrated disagreements', () => {
  const r = record({ trials: [trial('t1', 's1', 'reactive', 'pass', { assessments: [
    { metricId: 'goal', result: 'pass', rationale: 'r', evidence: [1] },
    { metricId: 'fidelity', result: 'pass', rationale: 'r', evidence: [1] },
  ] })], humanReviews: [review('h1', 't1', 'fail', { metricId: 'fidelity' })] });
  assert.equal(humanFindings(r)[0]?.subject, 'simulator');
  assert.equal(isAgentFailure(r, r.trials[0]!), false);
  assert.deepEqual(buildResultView(r).failures, [], 'a simulator label never becomes a counted agent failure');
  r.trials[0]!.outcome = 'cancelled';
  assert.equal(humanFindings(r)[0]?.automatic, 'unknown');
  assert.equal(humanFindings(r)[0]?.disagreement, false);
});

test('repeats that disagree fail the situation and name it flaky; missing, unknown and duplicate attempts leave it unmeasured', () => {
  const scenarios = ['s1', 's2'].map(id => ({ ...scenario(id), metrics: [] }));
  const trials = scenarios.flatMap(s => Array.from({ length: 3 }, (_, repeat) => ({
    ...trial(`${s.id}-${repeat}`, s.id, 'static', s.id === 's2' && repeat === 2 ? 'fail' : 'pass', { failed: s.id === 's2' && repeat === 2 ? ['time'] : [] }), repeat,
  })));
  const r = record({ scenarios, trials, settings: settingsSchema.parse({ repeats: 3, userModes: ['static', 'scripted'] }) });
  assert.equal(plannedTrials(r), 6, 'scripted mode without a script has no planned attempts');
  // Each call reads a fresh record: a derivation is remembered per record snapshot.
  const cards = (run: Experiment) => buildResultView(run).cards.map(card => [card.scenarioId, card.outcome, card.flaky, card.reason ?? null]);
  assert.deepEqual(cards(r), [['s1', 'pass', false, null], ['s2', 'fail', true, null]], 'one failed repeat of three fails the situation, and the disagreement is named');
  assert.deepEqual(cards({ ...r, humanReviews: [review('override', 's2-2', 'pass')] }), cards(r), 'a whole-dialogue verdict never rewrites a repeated automatic result');
  assert.deepEqual(cards({ ...r, trials: trials.slice(0, -1) })[1], ['s2', 'unknown', false, 'attempts_mismatch'], 'a missing repeat leaves the situation unmeasured');
  const duplicated = [...trials, { ...trials[0]!, id: 'duplicate' }];
  assert.deepEqual(cards({ ...r, trials: duplicated })[0], ['s1', 'unknown', false, 'attempts_mismatch'], 'a duplicate never stands in for a repeat');
  assert.deepEqual(cards({ ...r, trials: duplicated.map(t => t.id === 's1-1' ? { ...t, outcome: 'invalid' as const, checks: [] } : t) })[0], ['s1', 'unknown', false, 'agent_error']);
  assert.deepEqual(cards({ ...r, settings: settingsSchema.parse({ repeats: 1, userModes: ['static'] }), trials: [trials[0]!] }),
    [['s1', 'pass', false, null], ['s2', 'unknown', false, 'not_reached']]);
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
  assert.equal(buildResultView(after).cards[0]?.reason, 'simulator_unclear', 'a missing simulator vote leaves the situation unmeasured');
});

test('code-flagged simulator dialogues stay visible as unmeasured and never enter the number', () => {
  const flagged = { ...trial('a', 's1', 'reactive', 'pass', { events: dialogue(['hello', 'again']) }),
    simulatorChecks: [{ id: 'simulator_loop' as const, description: 'd', passed: false, evidence: 'Реплика #3 повторяет реплику #0.', seq: 3, heuristic: false }] };
  const r = record({ settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1 }), trials: [flagged] });
  const view = buildResultView(r);
  assert.deepEqual(view.notMeasured.reasons.find(reason => reason.code === 'simulator_deviated')?.scenarioIds, ['s1']);
  assert.equal(view.headline.decided, 0);
  assert.equal(exitCodeOf(view), 2);
});

test('simulator review controls eligibility without rewriting evidence or becoming an agent finding', () => {
  const card = { ...scenario('s1'), metrics: [] };
  const t = trial('a', 's1', 'reactive', 'pass', { events: dialogue(['hello', '1234']) });
  t.simulatorChecks = [{ id: 'simulator_leak', description: 'suspicion', evidence: '1234', passed: false, heuristic: true }];
  const r = record({ scenarios: [card], trials: [t], settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1 }) });
  assert.equal(automaticTrialResult(card, t), 'unknown');
  assert.equal(exitCodeOf(buildResultView(r)), 2);
  r.humanReviews = [review('sim-fail', t.id, 'fail', { checkId: 'simulator_leak' })];
  assert.equal(humanFindings(r)[0]!.subject, 'simulator');
  assert.equal(isAgentFailure(r, t), false);
  r.humanReviews.push(review('sim-pass', t.id, 'pass', { checkId: 'simulator_leak' }, '2026-09-09T00:00:00Z'));
  assert.equal(automaticTrialResult(card, t, r.humanReviews), 'pass');
  const cleared = buildResultView(r);
  assert.equal(cleared.notMeasured.total, 0);
  assert.equal(exitCodeOf(cleared), 0);
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
  for (const t of before.trials) {
    const card = before.scenarios.find(s => s.id === t.scenarioId)!;
    assert.equal(hasCompleteJudgment({ scenario: card, sources: observableSources(before.sources, before.requirements), trial: t }), true, 'every judgment carries its complete audit');
  }
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

test('a control in either run is left out of the diff: union, added control, selected tests and the same run', () => {
  const SOURCE = 'c0ffee00-0000-4000-8000-000000000010', REPEAT = 'c0ffee00-0000-4000-8000-000000000011';
  const assertComparable = (diff: ReturnType<typeof compareRuns>) => {
    assert.equal(diff.comparable, true, diff.notes.join(' '));
    assert.ok(diff.notes.includes(CONTROL_NOTE));
    assert.ok(diff.notes.every(note => !note.startsWith('Набор карточек изменился') && !note.startsWith('Содержимое карточек изменилось')), diff.notes.join(' '));
    assert.ok([...diff.pairs, ...diff.incomparable].every(row => row.scenarioId !== 'ctl'));
  };

  // Union: the control is marked only in the source run, and its card differs in the repeat.
  const marked = goalRun(SOURCE, { s1: 'pass', ctl: 'pass' }, 'h', { positiveControlScenarioIds: ['ctl'] });
  const unmarked = goalRun(REPEAT, { s1: 'pass', ctl: 'fail' }, 'h', { parentRunId: SOURCE });
  unmarked.scenarios.find(s => s.id === 'ctl')!.user.maxFollowUps = 0;
  const union = compareRuns(marked, unmarked);
  assertComparable(union);
  assert.equal(union.cards.shared, 1);

  // Added: the repeat has a control card the source never had.
  const plain = goalRun(SOURCE, { s1: 'pass', s2: 'fail' }, 'h');
  const added = goalRun(REPEAT, { s1: 'pass', s2: 'fail', ctl: 'pass' }, 'h', { parentRunId: SOURCE, positiveControlScenarioIds: ['ctl'] });
  const addedDiff = compareRuns(plain, added);
  assertComparable(addedDiff);
  assert.deepEqual(addedDiff.cards.onlyAfter, []);

  // Selected tests: the subset names the control and one counted card.
  const full = goalRun(SOURCE, { s1: 'pass', s2: 'fail', s3: 'pass', ctl: 'pass' }, 'h');
  const subset = goalRun(REPEAT, { ctl: 'pass', s1: 'pass' }, 'h', { parentRunId: SOURCE, selectedScenarioIds: ['ctl', 's1'], positiveControlScenarioIds: ['ctl'] });
  const selected = compareRuns(full, subset);
  assertComparable(selected);
  assert.ok(selected.headline.startsWith('Выбранные тесты (1/'), selected.headline);
  assert.ok(selected.notes.includes('Сравнение относится только к явно выбранным тестам. Остальной регрессионный набор не проверен.'));

  // The same run: only the same-run note decides, the control note follows it.
  const self = goalRun(SOURCE, { s1: 'pass', ctl: 'pass' }, 'h', { positiveControlScenarioIds: ['ctl'] });
  assert.deepEqual(compareRuns(self, self).notes, ['Выбран один и тот же прогон.', 'Контрольные ситуации не сравниваются: они не входят в главное число.']);
});

// ---- Quick agreement marks: a situation closes when every metric that decided it is answered (CR-02). ----
const agentRubric = (id: string, name: string) =>
  ({ id, name, subject: 'agent' as const, description: 'd', passCriteria: 'p', failCriteria: 'f' });
/** A one-key mark as the lab stores it: the judgment it answers and the counting rule are stamped on the review; `unstamped` is a phase-3 mark. */
const quick = (id: string, trialId: string, verdict: HumanReview['verdict'], metricId: string,
  judgeVerdict: 'pass' | 'fail', options: { note?: string; createdAt?: string; unstamped?: true } = {}): HumanReview =>
  ({ ...review(id, trialId, verdict, { metricId }, options.createdAt), source: 'quick', judgeVerdict, ...(options.unstamped ? {} : { countingRules: COUNTING_RULES }), ...(options.note ? { note: options.note } : {}) });

/** One failed legacy situation: the goal failed, a second agent criterion failed and an exact check failed too. */
function quickFixture() {
  const card = { ...scenario('s1'), metrics: [agentRubric('goal', 'Goal'), agentRubric('quality', 'Quality'), metrics[1]!] };
  const failing = trial('t', 's1', 'reactive', 'fail', { failed: ['time'], assessments: [
    { metricId: 'goal', result: 'fail', rationale: 'клиент остался без ответа', evidence: [1] },
    { metricId: 'quality', result: 'fail', rationale: 'формулировка', evidence: [1] },
    { metricId: 'fidelity', result: 'pass', rationale: 'симулятор держался карточки', evidence: [0] },
  ] });
  return record({ scenarios: [card], trials: [failing] });
}

test('on a legacy card a quick mark answers its metric alone: the other failed rubric keeps the situation waiting until it is reviewed (CR-02)', () => {
  const base = quickFixture();
  const pending = (...reviews: HumanReview[]) => awaitingVerdict({ ...base, humanReviews: reviews }).size;

  assert.equal(pending(), 1, 'a failure nobody marked waits for a verdict');
  assert.equal(pending(quick('agree', 't', 'fail', 'goal', 'fail')), 1,
    'agreeing on the main verdict does not close it while another agent criterion the judge failed has no decision');
  assert.equal(pending(quick('disagree', 't', 'pass', 'goal', 'fail')), 1, 'disagreeing does not close it either');
  assert.equal(pending(quick('agree', 't', 'fail', 'goal', 'fail'), review('quality', 't', 'fail', { metricId: 'quality' })), 0,
    'a full review on the other failed rubric closes it; the failed exact check is not part of the headline');
  assert.equal(pending(quick('agree', 't', 'fail', 'goal', 'fail'), review('quality', 't', 'unknown', { metricId: 'quality' })), 1,
    'a full review that cannot decide the other rubric leaves it waiting');
  assert.equal(pending(quick('unsure', 't', 'unknown', 'goal', 'fail'), review('quality', 't', 'fail', { metricId: 'quality' })), 1, 'doubt is not a decision: the situation stays open');
  assert.equal(pending(quick('agree', 't', 'fail', 'goal', 'fail'), review('quality', 't', 'fail', { metricId: 'quality' }),
    review('full', 't', 'unknown', { metricId: 'goal' }, '2026-09-09T00:00:00Z')), 1,
    'a later full review that cannot decide supersedes the quick mark');
  assert.equal(pending(quick('agree', 't', 'fail', 'goal', 'fail', { unstamped: true }), review('quality', 't', 'fail', { metricId: 'quality' })), 0,
    'a legacy card asks the same question under both rules, so a phase-3 mark still closes it');

  // A card without a goal rubric: the main verdict is the first agent criterion the judge failed.
  const noGoal = { ...base, scenarios: [{ ...base.scenarios[0]!, metrics: [agentRubric('style', 'Style'), agentRubric('answer', 'Answer'), metrics[1]!] }],
    trials: [{ ...base.trials[0]!, assessments: [
      { metricId: 'style', result: 'pass' as const, rationale: 'r', evidence: [1] },
      { metricId: 'answer', result: 'fail' as const, rationale: 'r', evidence: [1] },
      { metricId: 'fidelity', result: 'pass' as const, rationale: 'r', evidence: [0] },
    ] }] };
  assert.equal(awaitingVerdict(noGoal).size, 1);
  assert.equal(awaitingVerdict({ ...noGoal, humanReviews: [quick('agree', 't', 'fail', 'answer', 'fail')] }).size, 0, 'the only failed rubric answered closes it');

  // The simulator is judged separately: a mark on the agent's verdict does not answer for it.
  // `simulatorWasUsed` needs a reactive dialogue with a simulator turn, so the events carry one.
  const deviated = { ...base, trials: [{ ...base.trials[0]!, events: dialogue(['hello'], 'continue'),
    simulatorChecks: [{ id: 'simulator_leak' as const, description: 'утечка', passed: false, evidence: '#1', heuristic: true }] }] };
  assert.equal(awaitingVerdict({ ...deviated, humanReviews: [quick('agree', 't', 'fail', 'goal', 'fail'), review('quality', 't', 'fail', { metricId: 'quality' })] }).size, 1,
    'an undecided simulator check keeps the dialogue in the queue');
});

test('on a goal card quick marks close a situation only when every metric that decided it is answered under the current rule (CR-02, CTX-18)', () => {
  const card = { ...ruledCard('c', [{ ...goalAttainment }, { ...promptCompliance }, { ...replyQuality }, { ...simulatorFidelity }]), checks: scenario('c').checks };
  const votesOf = (goal: Vote, rules: Vote): MetricAssessment[] => [judged('goal_attainment', goal), judged('prompt_compliance', rules), judged('reply_quality', 'fail'), judged('user_fidelity', 'pass')];
  // Reply quality fails and an exact check fails on every attempt here: neither is part of the headline.
  const failedCheck = { checks: [{ id: 'time', description: 'time', passed: false, evidence: '' }, { id: 'extra', description: 'extra', passed: true, evidence: '' }], outcome: 'fail' as const };
  const runOf = (goal: Vote, rules: Vote, ...reviews: HumanReview[]) => ruledRun([card], [ruledAttempt('t', 'c', votesOf(goal, rules), failedCheck)], { humanReviews: reviews });
  const pending = (goal: Vote, rules: Vote, ...reviews: HumanReview[]) => awaitingVerdict(runOf(goal, rules, ...reviews)).size;

  assert.equal(pending('fail', 'fail'), 1);
  assert.equal(pending('fail', 'fail', quick('g', 't', 'fail', 'goal_attainment', 'fail')), 1, 'one mark on a double failure leaves it waiting');
  assert.equal(pending('fail', 'fail', quick('r', 't', 'fail', 'prompt_compliance', 'fail')), 1);
  assert.equal(pending('fail', 'fail', quick('g', 't', 'fail', 'goal_attainment', 'fail'), quick('r', 't', 'fail', 'prompt_compliance', 'fail')), 0,
    'both marked closes it even though reply quality failed and an exact check failed');
  assert.equal(pending('fail', 'fail', quick('g', 't', 'pass', 'goal_attainment', 'fail'), quick('r', 't', 'fail', 'prompt_compliance', 'fail')), 0, 'a partial overturn is an answer on both');
  assert.equal(pending('fail', 'fail', quick('g', 't', 'fail', 'goal_attainment', 'fail'), quick('r', 't', 'unknown', 'prompt_compliance', 'fail')), 1, 'doubt on one target keeps it waiting');
  assert.equal(pending('fail', 'fail', quick('g', 't', 'fail', 'goal_attainment', 'fail', { unstamped: true }), quick('r', 't', 'fail', 'prompt_compliance', 'fail')), 1,
    'a phase-3 mark on a double failure answers the previous rule, not this one');
  assert.equal(pending('fail', 'pass', quick('g', 't', 'fail', 'goal_attainment', 'fail', { unstamped: true })), 0, 'on a goal-only failure the phase-3 mark still closes it');
  assert.equal(pending('pass', 'fail', quick('r', 't', 'fail', 'prompt_compliance', 'fail')), 0, 'a rules-only failure has one target');
  assert.equal(pending('pass', 'fail', quick('g', 't', 'pass', 'goal_attainment', 'pass')), 1, 'a mark on the goal does not answer a rules-only failure');
  // A two-metric pass: without quick marks the failed reply quality and check still go through the full review path, as before.
  assert.equal(pending('pass', 'pass'), 1);
  assert.equal(pending('pass', 'pass', quick('g', 't', 'pass', 'goal_attainment', 'pass')), 1, 'one mark on a two-target pass is not an answer');
  assert.equal(pending('pass', 'pass', quick('g', 't', 'pass', 'goal_attainment', 'pass'), quick('r', 't', 'pass', 'prompt_compliance', 'pass')), 0, 'both targets answered closes it');
});

test('compareRuns names a run that holds marks under the previous counting rule, once, and stays comparable', () => {
  const before = ruledRecord(RULED_SOURCE, { A: { goal: 'fail', rules: 'fail' }, B: { goal: 'pass', rules: 'pass' } });
  const after = ruledRecord(RULED_REPEAT, { A: { goal: 'fail', rules: 'fail' }, B: { goal: 'pass', rules: 'pass' } }, { parentRunId: RULED_SOURCE }, { reply: 'another reply' });
  after.humanReviews = [quick('old', 't-A-0', 'fail', 'goal_attainment', 'fail', { unstamped: true })];
  const diff = compareRuns(before, after);
  assert.equal(diff.comparable, true, diff.notes.join(' '));
  assert.equal(diff.notes.filter(note => note === 'В прогоне d0d0d0d0 есть отметки по прежнему правилу подсчёта: 1.').length, 1);
  assert.deepEqual(diff.unchanged, { passing: 1, failing: 1 }, 'the note is informational: the comparison itself is untouched');
  // Current-rule marks and a run without marks add nothing.
  after.humanReviews = [quick('g', 't-A-0', 'fail', 'goal_attainment', 'fail'), quick('r', 't-A-0', 'fail', 'prompt_compliance', 'fail')];
  assert.ok(!compareRuns(before, after).notes.some(note => note.includes('по прежнему правилу подсчёта')));
  // Both sides are named separately.
  before.humanReviews = [quick('old', 't-A-0', 'fail', 'goal_attainment', 'fail', { unstamped: true })];
  after.humanReviews = [quick('old', 't-A-0', 'fail', 'goal_attainment', 'fail', { unstamped: true })];
  assert.equal(compareRuns(before, after).notes.filter(note => note.includes('по прежнему правилу подсчёта')).length, 2);
});

test('a quick agreement is not a human remark, a quick disagreement still is', () => {
  const base = quickFixture();
  const passing = { ...trial('t2', 's2', 'reactive', 'pass', { assessments: [
    { metricId: 'goal', result: 'pass', rationale: 'ответ дан', evidence: [1] },
    { metricId: 'fidelity', result: 'pass', rationale: 'r', evidence: [0] },
  ] }) };
  const both = { ...base, scenarios: [base.scenarios[0]!, { ...scenario('s2'), metrics: [agentRubric('goal', 'Goal'), metrics[1]!] }],
    trials: [base.trials[0]!, passing] };

  const agreed = { ...both, humanReviews: [quick('agree', 't', 'fail', 'goal', 'fail')] };
  assert.deepEqual(humanFindings(agreed), [], 'agreeing with the judge is not a remark of the owner');
  assert.deepEqual(buildResultView(agreed).agreement.disagreements, []);

  const objected = quick('objection', 't2', 'fail', 'goal', 'pass', { note: 'Судья не заметил, что реквизиты не те.' });
  const mixed = { ...both, humanReviews: [quick('agree', 't', 'fail', 'goal', 'fail'), objected] };
  const findings = humanFindings(mixed);
  assert.equal(findings.length, 1, 'only the disagreement is reported');
  assert.equal(findings[0]?.trialId, 't2');
  assert.equal(findings[0]?.disagreement, true);
  assert.equal(findings[0]?.note, 'Судья не заметил, что реквизиты не те.');
  assert.deepEqual(buildResultView(mixed).agreement.disagreements.map(item => item.trialId), ['t2'], 'the agreement counts the objection alone');

  const full = { ...both, humanReviews: [review('full', 't', 'fail', { metricId: 'goal' })] };
  assert.equal(humanFindings(full).length, 1, 'a full review on the same rubric is reported as before');
});

// ---- The headline rule (03.1): the goal and, when the card has it, the prompt rules; one gate for both. ----
type Vote = 'pass' | 'fail' | 'unknown';
const SPLIT = `${SPLIT_RATIONALE_PREFIX} pass / fail. Основания каждой оценки сохранены в judgeAudit.`;
const RULED = [{ ...goalAttainment }, { ...promptCompliance }, { ...simulatorFidelity }];
/** A card with the acquiring rubrics (goal, prompt rules, simulator fidelity) and no exact checks. */
function ruledCard(id: string, metrics = RULED): Scenario { return { ...scenario(id), checks: [], metrics }; }
const judged = (metricId: string, result: Vote, rationale = 'r'): MetricAssessment => ({ metricId, result, rationale, evidence: result === 'unknown' ? [] : [1] });
/** One reactive attempt: opening, reply, and the simulator closing the dialogue, so fidelity applies. */
function ruledAttempt(id: string, scenarioId: string, votes: MetricAssessment[], extra: Partial<Trial> = {}): Trial {
  return { ...trial(id, scenarioId, 'reactive', 'ungraded', { assessments: votes, events: dialogue(['hello'], 'done') }), checks: [], ...extra };
}
const votes = (goal: Vote, rules: Vote, fidelity: Vote = 'pass', extra: MetricAssessment[] = []): MetricAssessment[] =>
  [judged('goal_attainment', goal, goal === 'unknown' ? SPLIT : 'r'), judged('prompt_compliance', rules, rules === 'unknown' ? SPLIT : 'r'), judged('user_fidelity', fidelity), ...extra];
function ruledRun(cards: Scenario[], trials: Trial[], overrides: Partial<Experiment> = {}): Experiment {
  return record({ id: 'ruled', settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1 }), scenarios: cards, trials, ...overrides });
}
/** The headline verdict and its two halves, without the owner-facing parts (asserted on their own). */
const halves = ({ outcome, goal, rules }: ReturnType<typeof headlineCardOutcome>) => ({ outcome, goal, rules });
/** One card `c` with one attempt; returns the headline outcome, its parts, the verdict with its reason and the goal-only outcome. */
function one(assessments: MetricAssessment[], extra: Partial<Trial> = {}, overrides: Partial<Experiment> = {}, card = ruledCard('c')) {
  const run = ruledRun([card], [ruledAttempt('t', 'c', assessments, extra)], overrides);
  const headline = headlineCardOutcome(run, card);
  return { headline: halves(headline), parts: headline.parts, verdict: cardVerdict(run, card), goal: goalCardOutcome(run, card), run, card };
}

test('the headline card passes only when the goal and the prompt rules pass; either failing fails it', () => {
  assert.deepEqual(one(votes('pass', 'pass')).headline, { outcome: 'pass', goal: 'pass', rules: 'pass' });
  assert.deepEqual(one(votes('pass', 'fail')).headline, { outcome: 'fail', goal: 'pass', rules: 'fail' }, 'a met request that broke a prompt rule is not «справился»');
  assert.deepEqual(one(votes('fail', 'pass')).headline, { outcome: 'fail', goal: 'fail', rules: 'pass' });
  assert.deepEqual(one(votes('fail', 'fail')).headline, { outcome: 'fail', goal: 'fail', rules: 'fail' });
  assert.deepEqual(one(votes('unknown', 'fail')).headline, { outcome: 'fail', goal: 'unknown', rules: 'fail' }, 'an undecided goal next to broken rules is still a failure');
  assert.deepEqual(one(votes('pass', 'unknown')).headline, { outcome: 'unknown', goal: 'pass', rules: 'unknown' });
  assert.deepEqual(one(votes('pass', 'unknown')).verdict, { outcome: 'unknown', reason: 'judge_split' }, 'the rules vote that split names the reason');
  assert.deepEqual(one(votes('unknown', 'pass')).headline, { outcome: 'unknown', goal: 'unknown', rules: 'pass' });
  assert.deepEqual(one(votes('unknown', 'pass')).verdict, { outcome: 'unknown', reason: 'judge_split' });
  assert.deepEqual(one(votes('pass', 'pass')).verdict, { outcome: 'pass' });
  assert.deepEqual(one(votes('pass', 'fail')).verdict, { outcome: 'fail' });
  assert.deepEqual(one(votes('pass', 'fail')).parts, [{ id: 'goal_attainment', label: 'Цель', outcome: 'pass' }, { id: 'prompt_compliance', label: 'Правила промпта', outcome: 'fail' }],
    'the owner reads the two halves as the parts «Цель» and «Правила промпта»');
  // The other undecided rules reasons reuse the goal ladder.
  const unjudgedRules = one([judged('goal_attainment', 'pass'), judged('user_fidelity', 'pass')]);
  assert.deepEqual(unjudgedRules.verdict, { outcome: 'unknown', reason: 'not_judged' });
  assert.deepEqual(one(votes('pass', 'unknown').map(v => v.metricId === 'prompt_compliance' ? { ...v, rationale: 'Условие не проверялось.' } : v)).verdict,
    { outcome: 'unknown', reason: 'judge_unclear' });
  assert.deepEqual(one(votes('pass', 'fail'), {}, { humanReviews: [review('h', 't', 'unknown', { metricId: 'prompt_compliance' })] }).verdict,
    { outcome: 'unknown', reason: 'human_unknown' }, 'a full «не могу сказать» on the rules takes the card out of the number');
});

test('an unusable measurement stays unknown with its reason whatever the rules say', () => {
  const deviated = one(votes('pass', 'fail', 'fail'));
  assert.deepEqual(deviated.headline, { outcome: 'unknown', goal: 'unknown', rules: 'unknown' }, 'the gate runs before any fail is read');
  assert.deepEqual(deviated.verdict, { outcome: 'unknown', reason: 'simulator_deviated' });
  const errored = one(votes('pass', 'fail'), { assessmentError: 'Judge response rejected; original responses and errors are preserved in judgeAudit' });
  assert.deepEqual(errored.headline, { outcome: 'unknown', goal: 'unknown', rules: 'unknown' });
  assert.deepEqual(errored.verdict, { outcome: 'unknown', reason: 'judge_error' });
  // A provider failure is the judge not answering, not a malformed answer; a typed failure wins over the text of an older record.
  assert.deepEqual(one(votes('pass', 'fail'), { assessmentError: 'Pi provider response incomplete: rate limit' }).verdict, { outcome: 'unknown', reason: 'judge_unavailable' });
  assert.deepEqual(one(votes('pass', 'fail'), { assessmentError: 'Judge response rejected', assessmentFailure: 'unavailable' }).verdict, { outcome: 'unknown', reason: 'judge_unavailable' });
  const invalid = one(votes('pass', 'fail'), {}, { humanReviews: [review('h', 't', 'invalid')] });
  assert.deepEqual(invalid.headline, { outcome: 'unknown', goal: 'unknown', rules: 'unknown' });
  assert.deepEqual(invalid.verdict, { outcome: 'unknown', reason: 'human_invalid' });
  const unreset = one(votes('pass', 'fail'), {}, {}, { ...ruledCard('c'), initialState: { ...world, external: { account: 'a1' } } });
  assert.deepEqual(unreset.verdict, { outcome: 'unknown', reason: 'reset_unconfirmed' });
});

test('two attempts: a rules failure in one of them fails the card; a missing attempt leaves it unknown', () => {
  const card = ruledCard('c');
  const two = { settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 2 }) };
  const mixed = ruledRun([card], [ruledAttempt('t0', 'c', votes('pass', 'pass')), ruledAttempt('t1', 'c', votes('pass', 'fail'), { repeat: 1 })], two);
  assert.deepEqual(halves(headlineCardOutcome(mixed, card)), { outcome: 'fail', goal: 'pass', rules: 'fail' });
  const clean = ruledRun([card], [ruledAttempt('t0', 'c', votes('pass', 'pass')), ruledAttempt('t1', 'c', votes('pass', 'pass'), { repeat: 1 })], two);
  assert.deepEqual(halves(headlineCardOutcome(clean, card)), { outcome: 'pass', goal: 'pass', rules: 'pass' });
  const missing = ruledRun([card], [ruledAttempt('t0', 'c', votes('pass', 'fail'))], two);
  assert.deepEqual(halves(headlineCardOutcome(missing, card)), { outcome: 'unknown', goal: 'unknown', rules: 'unknown' });
  assert.deepEqual(cardVerdict(missing, card), { outcome: 'unknown', reason: 'attempts_mismatch' });
  assert.deepEqual(halves(headlineCardOutcome(missing, card, { partial: true })), { outcome: 'fail', goal: 'pass', rules: 'fail' }, 'the partial gate decides the matched attempts alone');
  const foreign = ruledRun([card], [ruledAttempt('t', 'c', votes('pass', 'fail'), { manifestHash: 'other' })]);
  assert.deepEqual(cardVerdict(foreign, card), { outcome: 'unknown', reason: 'attempts_mismatch' });
  assert.equal(headlineCardOutcome(foreign, card, { partial: true }).outcome, 'unknown', 'a foreign attempt is never decided, even partially');
});

test('a card without the prompt-rule check is decided by its goal; reply quality never moves the headline', () => {
  const goalOnly = ruledCard('c', [{ ...goalAttainment }, { ...replyQuality }, { ...simulatorFidelity }]);
  const passed = one([judged('goal_attainment', 'pass'), judged('reply_quality', 'fail'), judged('user_fidelity', 'pass')], {}, {}, goalOnly);
  assert.deepEqual(passed.headline, { outcome: 'pass', goal: 'pass', rules: 'none' });
  assert.deepEqual(passed.verdict, { outcome: 'pass' });
  const ruled = one(votes('pass', 'pass', 'pass', [judged('reply_quality', 'fail')]), {}, {}, ruledCard('c', [...RULED, { ...replyQuality }]));
  assert.deepEqual(ruled.headline, { outcome: 'pass', goal: 'pass', rules: 'pass' }, 'goal pass + rules pass + quality fail is «справился»');
  assert.equal(cardOutcome(ruled.run, ruled.card), 'fail', 'the strict card outcome still sees the quality failure');
});

test('a legacy card without the goal rubric keeps the strict card outcome, with no goal and no rules part', () => {
  const legacy = ruledCard('c', [{ ...replyQuality }, { ...simulatorFidelity }]);
  const failed = one([judged('reply_quality', 'fail'), judged('user_fidelity', 'pass')], {}, {}, legacy);
  assert.deepEqual(failed.headline, { outcome: 'fail', goal: 'none', rules: 'none' });
  assert.deepEqual(failed.parts, [], 'the strict result has no parts');
  assert.equal(failed.headline.outcome, cardOutcome(failed.run, legacy));
  assert.equal(failed.goal, cardOutcome(failed.run, legacy));
  const passed = one([judged('reply_quality', 'pass'), judged('user_fidelity', 'pass')], {}, {}, legacy);
  assert.deepEqual(passed.headline, { outcome: 'pass', goal: 'none', rules: 'none' });
  assert.deepEqual(passed.verdict, { outcome: 'pass' });
});

test('a human verdict on the prompt rules applies to the headline; a quick «не могу сказать» leaves the judge in place', () => {
  const overruled = one(votes('pass', 'fail'), {}, { humanReviews: [review('h', 't', 'pass', { metricId: 'prompt_compliance' })] });
  assert.deepEqual(overruled.headline, { outcome: 'pass', goal: 'pass', rules: 'pass' });
  const doubted = one(votes('pass', 'fail'), {}, { humanReviews: [{ ...review('h', 't', 'unknown', { metricId: 'prompt_compliance' }), source: 'quick', judgeVerdict: 'fail' }] });
  assert.deepEqual(doubted.headline, { outcome: 'fail', goal: 'pass', rules: 'fail' });
  assert.deepEqual(doubted.verdict, { outcome: 'fail' });
});

test('goalCardOutcome is the goal-only result in every case, and the control verdict reads it', () => {
  const cases: [Vote, Vote, Vote][] = [['pass', 'pass', 'pass'], ['pass', 'fail', 'pass'], ['fail', 'pass', 'fail'], ['fail', 'fail', 'fail'],
    ['unknown', 'fail', 'unknown'], ['pass', 'unknown', 'pass'], ['unknown', 'pass', 'unknown']];
  for (const [goal, rules, expected] of cases) {
    const found = one(votes(goal, rules));
    assert.equal(found.goal, expected, `${goal}/${rules}`);
    assert.equal(found.headline.goal, expected, `${goal}/${rules} goal part`);
    assert.equal(cardVerdict(found.run, found.card, 'goal').outcome, expected, `${goal}/${rules} goal verdict`);
  }
  assert.equal(one(votes('pass', 'fail', 'fail')).goal, 'unknown', 'the goal-only result keeps the usability gate');
  assert.deepEqual(cardVerdict(one(votes('unknown', 'fail')).run, ruledCard('c'), 'goal'), { outcome: 'unknown', reason: 'judge_split' }, 'the goal-only reasons ignore the rules vote');
});

// ---- 03.1: repeats, reassessments and before/after comparisons count by the headline rule and say so. ----
const RULE_NOTE = 'Сравнение считает «справился» как главное число: запрос выполнен и правила промпта соблюдены.';
const RULED_SOURCE = 'd0d0d0d0-0000-4000-8000-000000000001', RULED_REPEAT = 'd0d0d0d0-0000-4000-8000-000000000002';
type Ruled = { goal: Vote; rules: Vote | 'none'; quality?: Vote };
/** opening → reply → the simulator ends the dialogue; the reply text tells two runs apart, so identical answers never trigger the review note. */
const replied = (text: string): TraceEvent[] => [{ seq: 0, type: 'user', text: 'hello' }, { seq: 1, type: 'assistant', text }, { seq: 2, type: 'simulator', result: { message: '', done: true } }];
/** One demo run: `repeats` reactive attempts per card, every card judged on the goal, the prompt rules (unless 'none') and, when asked, reply quality. */
function ruledRecord(id: string, cards: Record<string, Ruled>, overrides: Partial<Experiment> = {}, options: { repeats?: number; reply?: string } = {}): Experiment {
  const repeats = options.repeats ?? 1;
  const scenarios = Object.entries(cards).map(([key, c]) => ruledCard(key, [{ ...goalAttainment },
    ...(c.rules === 'none' ? [] : [{ ...promptCompliance }]), ...(c.quality ? [{ ...replyQuality }] : []), { ...simulatorFidelity }]));
  const trials = Object.entries(cards).flatMap(([key, c]) => Array.from({ length: repeats }, (_, repeat) => ruledAttempt(`t-${key}-${repeat}`, key, [
    judged('goal_attainment', c.goal, c.goal === 'unknown' ? SPLIT : 'r'),
    ...(c.rules === 'none' ? [] : [judged('prompt_compliance', c.rules, c.rules === 'unknown' ? SPLIT : 'r')]),
    ...(c.quality ? [judged('reply_quality', c.quality)] : []),
    judged('user_fidelity', 'pass'),
  ], { repeat, events: replied(options.reply ?? 'ok') })));
  return record({ id, mode: 'demo', targetFingerprint: 'fp-agent', settings: settingsSchema.parse({ userModes: ['reactive'], repeats }), scenarios, trials, ...overrides });
}

test('a repeat is unstable when the request holds but the prompt rules flip; a flip only in reply quality is not', () => {
  const source = ruledRecord(RULED_SOURCE, { A: { goal: 'pass', rules: 'pass', quality: 'pass' }, B: { goal: 'pass', rules: 'pass', quality: 'pass' }, C: { goal: 'fail', rules: 'pass', quality: 'pass' } });
  const repeat = ruledRecord(RULED_REPEAT, { A: { goal: 'pass', rules: 'fail', quality: 'pass' }, B: { goal: 'pass', rules: 'pass', quality: 'fail' }, C: { goal: 'fail', rules: 'fail', quality: 'pass' } },
    { parentRunId: RULED_SOURCE }, { reply: 'another reply' });
  const stability = stabilityBetweenRuns(source, repeat);
  assert.equal(stability.skipped, null);
  assert.equal(stability.checked, 3);
  assert.deepEqual(stability.unstable, [{ scenarioId: 'A', title: 'A', before: 'pass', after: 'fail' }], 'B flipped only in reply quality, C stayed «не справился»');
  // The same for a reassessment of the saved answers.
  const reassessment = ruledRecord('d0d0d0d0-0000-4000-8000-000000000003', { A: { goal: 'pass', rules: 'fail', quality: 'pass' }, B: { goal: 'pass', rules: 'pass', quality: 'fail' }, C: { goal: 'fail', rules: 'fail', quality: 'pass' } },
    { parentRunId: RULED_SOURCE, assessmentOf: RULED_SOURCE, assessmentTrialIds: ['t-A-0', 't-B-0', 't-C-0'], evidenceHash: 'evidence',
      sourceEvidence: { runId: RULED_SOURCE, trials: structuredClone(source.trials), humanReviews: [] } });
  const found = stabilityAfterReassess(reassessment, source);
  assert.equal(found?.skipped, null);
  assert.equal(found?.checked, 3);
  assert.deepEqual(found?.unstable, [{ scenarioId: 'A', title: 'A', before: 'pass', after: 'fail' }]);
});

test('compareRuns counts a card by the headline rule, names the rule once, and leaves reply quality out of the card verdict', () => {
  const before = ruledRecord(RULED_SOURCE, { A: { goal: 'pass', rules: 'fail', quality: 'pass' }, B: { goal: 'pass', rules: 'pass', quality: 'pass' }, C: { goal: 'fail', rules: 'pass', quality: 'pass' } });
  const after = ruledRecord(RULED_REPEAT, { A: { goal: 'pass', rules: 'pass', quality: 'pass' }, B: { goal: 'pass', rules: 'pass', quality: 'fail' }, C: { goal: 'fail', rules: 'pass', quality: 'pass' } },
    { parentRunId: RULED_SOURCE }, { reply: 'another reply' });
  const diff = compareRuns(before, after);
  assert.equal(diff.comparable, true, diff.notes.join(' '));
  assert.deepEqual(diff.fixed.map(row => row.scenarioId), ['A'], 'the rules were kept this time, so the request-met card is now «справился»');
  assert.deepEqual(diff.regressed, []);
  assert.deepEqual(diff.unchanged, { passing: 1, failing: 1 }, 'B flipped only in reply quality and stays a pass; C stays a failure');
  assert.equal(diff.pairs.find(pair => pair.scenarioId === 'A')?.change, 'fixed');
  assert.equal(diff.pairs.find(pair => pair.scenarioId === 'B')?.change, 'unchanged');
  assert.equal(diff.pairs.find(pair => pair.scenarioId === 'C')?.change, 'unchanged');
  assert.equal(diff.notes.filter(note => note === RULE_NOTE).length, 1, 'the rule is named exactly once');
  assert.equal(diff.incomparable.length, 0, 'the note never makes a comparable pair incomparable');

  // Goal-only cards: the same rule, but without prompt rules there is nothing to name.
  const plainBefore = ruledRecord(RULED_SOURCE, { A: { goal: 'fail', rules: 'none', quality: 'pass' } });
  const plainAfter = ruledRecord(RULED_REPEAT, { A: { goal: 'pass', rules: 'none', quality: 'fail' } }, { parentRunId: RULED_SOURCE }, { reply: 'another reply' });
  const plain = compareRuns(plainBefore, plainAfter);
  assert.equal(plain.comparable, true, plain.notes.join(' '));
  assert.deepEqual(plain.fixed.map(row => row.scenarioId), ['A'], 'a reply-quality failure does not hide the fixed request');
  assert.ok(!plain.notes.includes(RULE_NOTE));

  // An incomparable pair keeps its reasons; the rule note is not added to them.
  const other = ruledRecord(RULED_REPEAT, { A: { goal: 'pass', rules: 'pass' } }, { parentRunId: RULED_SOURCE, mode: 'live' });
  const incomparable = compareRuns(before, other);
  assert.equal(incomparable.comparable, false);
  assert.ok(!incomparable.notes.includes(RULE_NOTE));
});

test('compareRuns decides a card from its matched attempts when a repeat is missing, as the strict rule did', () => {
  const before = ruledRecord(RULED_SOURCE, { A: { goal: 'pass', rules: 'fail' }, B: { goal: 'fail', rules: 'fail' } }, {}, { repeats: 2 });
  const after = ruledRecord(RULED_REPEAT, { A: { goal: 'pass', rules: 'pass' }, B: { goal: 'fail', rules: 'fail' } }, { parentRunId: RULED_SOURCE }, { repeats: 2, reply: 'another reply' });
  after.trials = after.trials.filter(trial => trial.repeat === 0);
  const diff = compareRuns(before, after);
  assert.equal(diff.comparable, true, diff.notes.join(' '));
  assert.equal(diff.coverage.validPairs, 2);
  assert.ok(diff.headline.includes('Частичное сравнение (2/4 пар)'), diff.headline);
  assert.deepEqual(diff.fixed.map(row => row.scenarioId), ['A'], 'the matched pair decides the card; the missing repeat is disclosed, not a reason to leave it ungraded');
  assert.deepEqual(diff.unchanged, { passing: 0, failing: 1 });
  assert.equal(diff.ungraded, 0);
  // The strict rule on legacy cards behaves the same way (the phase-1 partial comparison).
  const strictBefore = ruledRecord(RULED_SOURCE, { A: { goal: 'fail', rules: 'none' } }, {}, { repeats: 2 });
  for (const card of strictBefore.scenarios) card.metrics = [{ ...replyQuality }, { ...simulatorFidelity }];
  for (const t of strictBefore.trials) t.assessments = [judged('reply_quality', 'fail'), judged('user_fidelity', 'pass')];
  const strictAfter = structuredClone(strictBefore);
  strictAfter.id = RULED_REPEAT; strictAfter.parentRunId = RULED_SOURCE;
  strictAfter.trials = strictAfter.trials.filter(trial => trial.repeat === 0).map(trial => ({ ...trial, events: replied('another reply'), assessments: [judged('reply_quality', 'pass'), judged('user_fidelity', 'pass')] }));
  const strict = compareRuns(strictBefore, strictAfter);
  assert.equal(strict.comparable, true, strict.notes.join(' '));
  assert.deepEqual(strict.fixed.map(row => row.scenarioId), ['A']);
  assert.ok(!strict.notes.includes(RULE_NOTE), 'a legacy card has no headline rule to name');
});

test('the CI exit code follows the headline: a reply-quality failure alone exits 0, a counted failure 1, anything unmeasured 2', () => {
  const exit = (cards: Record<string, Ruled>, overrides: Partial<Experiment> = {}) => exitCodeOf(buildResultView(ruledRecord(RULED_SOURCE, cards, overrides)));
  assert.equal(exit({ A: { goal: 'pass', rules: 'pass', quality: 'fail' }, B: { goal: 'pass', rules: 'none', quality: 'fail' } }), 0, 'reply quality never fails the run');
  assert.equal(exit({ A: { goal: 'pass', rules: 'fail' }, B: { goal: 'pass', rules: 'pass' } }), 1, 'a broken prompt rule fails a counted situation');
  assert.equal(exit({ A: { goal: 'fail', rules: 'pass' }, B: { goal: 'pass', rules: 'unknown' } }), 2, 'an unmeasured situation outranks a failure');
  assert.equal(exit({ A: { goal: 'pass', rules: 'pass' } }, { phase: 'evaluating' }), 2, 'an unfinished run');
  assert.equal(exit({ A: { goal: 'pass', rules: 'pass' }, C: { goal: 'fail', rules: 'pass' } }, { positiveControlScenarioIds: ['C'] }), 2, 'a failed control raises the alarm');
});
