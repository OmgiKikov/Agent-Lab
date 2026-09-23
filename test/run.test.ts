import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { emptyUsage, goalAttainment, promptCompliance, replyQuality, settingsSchema, simulatorFidelity, type Experiment, type HumanReview, type MetricAssessment, type Trial } from '../src/contracts.js';
import { Stopped } from '../src/errors.js';
import { AGREED_RATIONALE_PREFIX, GOAL_UNSUPPORTED_RATIONALE, SPLIT_RATIONALE_PREFIX } from '../src/judge.js';
import { humanOverride } from '../src/outcomes.js';
import { buildResultView, exitCodeOf } from '../src/result-view.js';
import { assessmentFailureOf, CODE_ONLY_ASSESSMENT, deriveRun, invalidCauseOf, judgeBasis, judgeFailure, NOT_MEASURED_CODES, SERVICE_REPLY_REASON } from '../src/run.js';

const world = { records: {}, writableFields: [], transientFailures: 0 };
type Card = Experiment['scenarios'][number];
type Result = MetricAssessment['result'];
const GOAL = 'goal_attainment';
const RULED = [{ ...goalAttainment }, { ...promptCompliance }, { ...replyQuality }, { ...simulatorFidelity }];
const SPLIT = `${SPLIT_RATIONALE_PREFIX} pass / fail. Основания каждой оценки сохранены в judgeAudit.`;

function card(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id, familyId: id, title: `Ситуация ${id}`, requirementIds: [], provenance: 'production', tier: 'regression', goalObservation: 'reply',
    user: { goal: 'g', facts: 'f', behavior: 'b', opening: 'o', maxFollowUps: 3 }, initialState: world, checks: [],
    metrics: [{ ...goalAttainment }, { ...replyQuality }, { ...simulatorFidelity }], split: 'dev', ...overrides,
  };
}
/** An undecided vote carries the judge's split sentence, as a stored one does. */
const vote = (metricId: string, result: Result): MetricAssessment =>
  ({ metricId, result, rationale: result === 'unknown' ? SPLIT : 'Обоснование.', evidence: result === 'unknown' ? [] : [1] });

/** One reactive attempt: the goal, reply quality and fidelity pass unless `results` says otherwise; a prompt-rule vote only when given. */
function attempt(scenarioId: string, results: Record<string, Result> = {}, overrides: Partial<Trial> = {}): Trial {
  const repeat = overrides.repeat ?? 0;
  const votes: Record<string, Result> = { [GOAL]: 'pass', reply_quality: 'pass', user_fidelity: 'pass', ...results };
  return {
    id: repeat ? `t-${scenarioId}-${repeat}` : `t-${scenarioId}`, revisionId: 'rev', scenarioId, familyId: scenarioId, repeat, userMode: 'reactive', split: 'dev',
    manifestHash: 'h', outcome: 'ungraded', reason: 'Диалог дошёл до конца.', checks: [],
    events: [
      { seq: 0, type: 'user', text: 'Здравствуйте' },
      { seq: 1, type: 'assistant', text: 'Ответ агента' },
      { seq: 2, type: 'simulator', result: { message: '', done: true } },
    ],
    initialState: world, finalState: world, usage: emptyUsage(), elapsedMs: 1,
    assessments: Object.entries(votes).map(([metricId, result]) => vote(metricId, result)),
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
const review = (trialId: string, verdict: HumanReview['verdict'], metricId?: string, extra: Partial<HumanReview> = {}): HumanReview =>
  ({ id: `h-${trialId}-${metricId ?? 'dialogue'}-${verdict}-${extra.source ?? 'full'}`, trialId, verdict, note: 'n', createdAt: '2026-09-17T00:00:00Z', ...(metricId ? { metricId } : {}), ...extra });
const quickReview = (trialId: string, verdict: HumanReview['verdict'], saw: 'pass' | 'fail') => review(trialId, verdict, GOAL, { source: 'quick', judgeVerdict: saw });
const twoRepeats = { settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 2 }) };
const ids = (trials: Trial[]) => trials.map(trial => trial.id);

test('deriveRun decides every situation by the counting rule and names its goal and prompt-rule halves', () => {
  const record = run([card('met', { metrics: RULED }), card('broke', { metrics: RULED }), card('goal'), card('legacy', { metrics: [{ ...replyQuality }] }), card('split')], [
    attempt('met', { prompt_compliance: 'pass' }),
    attempt('broke', { prompt_compliance: 'fail' }),
    attempt('goal', { [GOAL]: 'fail' }),
    attempt('legacy', {}, { assessments: [vote('reply_quality', 'fail')] }),
    attempt('split', { [GOAL]: 'unknown' }),
  ]);
  const derived = deriveRun(record);
  assert.equal(derived.record, record, 'an evaluate run is read as it is');
  assert.deepEqual(derived.situations.map(item => [item.scenario.id, item.outcome, item.goal, item.rules, item.reason ?? null, item.control, item.flaky]), [
    ['met', 'pass', 'pass', 'pass', null, false, false],
    ['broke', 'fail', 'pass', 'fail', null, false, false],
    ['goal', 'fail', 'fail', 'none', null, false, false],
    ['legacy', 'fail', 'none', 'none', null, false, false],
    ['split', 'unknown', 'unknown', 'none', 'judge_split', false, false],
  ]);
  assert.equal(derived.situation('broke'), derived.situations[1]);
  assert.equal(derived.situation('missing'), undefined);
  assert.deepEqual(derived.attempt('t-broke'), { trial: record.trials[1], usable: true, verdict: 'fail' });
  assert.equal(derived.attempt('t-missing'), undefined);
  assert.deepEqual(ids(derived.failedAttempts), ['t-broke', 't-goal', 't-legacy']);
});

test('reply quality never moves a situation, and an unusable attempt leaves it undecided', () => {
  const derived = deriveRun(run([card('quality'), card('deviated')], [
    attempt('quality', { reply_quality: 'fail' }), attempt('deviated', { [GOAL]: 'fail', user_fidelity: 'fail' }),
  ]));
  assert.deepEqual(derived.situations.map(item => [item.outcome, item.reason ?? null]), [['pass', null], ['unknown', 'simulator_deviated']]);
  assert.deepEqual(derived.attempt('t-deviated'), { trial: derived.record.trials[1], usable: false, verdict: 'unknown' });
  assert.deepEqual(derived.failedAttempts, [], 'neither is a failure of the number');
});

test('repeats that disagree make a situation flaky; it still fails, and only its failed attempt is a failure', () => {
  const derived = deriveRun(run([card('mixed'), card('steady'), card('half')], [
    attempt('mixed'), attempt('mixed', { [GOAL]: 'fail' }, { repeat: 1 }),
    attempt('steady'), attempt('steady', {}, { repeat: 1 }),
    attempt('half'), attempt('half', { [GOAL]: 'unknown' }, { repeat: 1 }),
  ], twoRepeats));
  assert.deepEqual(derived.situations.map(item => [item.scenario.id, item.outcome, item.flaky]), [
    ['mixed', 'fail', true], ['steady', 'pass', false], ['half', 'unknown', false]], 'an undecided repeat is not a disagreement');
  assert.deepEqual(derived.situation('mixed')!.attempts.map(item => item.verdict), ['pass', 'fail']);
  assert.deepEqual(ids(derived.failedAttempts), ['t-mixed-1'], 'the passing repeat is not a failure');
});

test('a control is decided by its goal alone and is never among the failed attempts', () => {
  const ruled = deriveRun(run([card('ctl', { metrics: RULED }), card('twin', { metrics: RULED }), card('bad')], [
    attempt('ctl', { prompt_compliance: 'fail' }), attempt('twin', { prompt_compliance: 'fail' }), attempt('bad', { [GOAL]: 'fail' }),
  ], { positiveControlScenarioIds: ['ctl'] }));
  assert.deepEqual(ruled.situations.map(item => [item.scenario.id, item.control, item.outcome, item.goal, item.rules]), [
    ['ctl', true, 'pass', 'pass', 'fail'], ['twin', false, 'fail', 'pass', 'fail'], ['bad', false, 'fail', 'fail', 'none']]);
  assert.deepEqual(ids(ruled.failedAttempts), ['t-twin', 't-bad']);
  const failedControl = deriveRun(run([card('ctl'), card('ok')], [attempt('ctl', { [GOAL]: 'fail' }), attempt('ok')], { positiveControlScenarioIds: ['ctl'] }));
  assert.equal(failedControl.situation('ctl')?.outcome, 'fail');
  assert.deepEqual(failedControl.failedAttempts, [], 'a failed control is an alarm, not a failure of the agent');
  const unknownId = deriveRun(run([card('a')], [attempt('a', { [GOAL]: 'fail' })], { positiveControlScenarioIds: ['missing'] }));
  assert.equal(unknownId.situations[0]?.control, false, 'a control id outside the set is ignored');
  assert.deepEqual(ids(unknownId.failedAttempts), ['t-a']);
});

test('failedAttempts are exactly the headline failures of counted situations, in record order', () => {
  const record = run([card('r', { metrics: RULED }), card('a'), card('q'), card('c'), card('u'), card('p')], [
    attempt('r', { prompt_compliance: 'fail' }),
    attempt('a', { [GOAL]: 'fail' }),
    attempt('q', { reply_quality: 'fail' }),
    attempt('c', { [GOAL]: 'fail' }),
    attempt('u', { [GOAL]: 'fail', user_fidelity: 'fail' }),
    attempt('p'),
  ], { positiveControlScenarioIds: ['c'] });
  const derived = deriveRun(record);
  assert.deepEqual(ids(derived.failedAttempts), ['t-r', 't-a'], 'a rules-only failure counts; reply quality, a control and an unusable attempt do not');
  assert.deepEqual(ids(derived.failedAttempts), buildResultView(record).failures.map(item => item.trialId), 'the same failures the result explains');
});

test('the human-override rule: a quick «не могу сказать» keeps the recorded result, a full «unknown» overrides, «invalid» excludes', () => {
  const quickUnknown = quickReview('t-f', 'unknown', 'fail');
  assert.deepEqual(humanOverride(undefined, 'fail'), { invalid: false, result: 'fail' });
  assert.deepEqual(humanOverride(undefined, undefined), { invalid: false, result: undefined });
  assert.deepEqual(humanOverride(quickUnknown, 'fail'), { invalid: false, result: 'fail' });
  assert.deepEqual(humanOverride(review('t-f', 'unknown', GOAL), 'fail'), { invalid: false, result: 'unknown' });
  assert.deepEqual(humanOverride(quickReview('t-f', 'pass', 'fail'), 'fail'), { invalid: false, result: 'pass' });
  assert.deepEqual(humanOverride(review('t-f', 'fail', GOAL), 'pass'), { invalid: false, result: 'fail' });
  assert.deepEqual(humanOverride(review('t-f', 'invalid', GOAL), 'pass'), { invalid: true, result: undefined });
  // The same rule through the derivation, on one failed situation.
  const failed = (reviews: HumanReview[]) => deriveRun(run([card('f')], [attempt('f', { [GOAL]: 'fail' })], { humanReviews: reviews }));
  const doubt = failed([quickUnknown]);
  assert.deepEqual([doubt.situations[0]?.outcome, ids(doubt.failedAttempts)], ['fail', ['t-f']], 'the owner’s doubt never takes a failure out of the number');
  const full = failed([review('t-f', 'unknown', GOAL)]);
  assert.deepEqual([full.situations[0]?.outcome, full.situations[0]?.reason, full.failedAttempts], ['unknown', 'human_unknown', []]);
  const invalidGoal = failed([review('t-f', 'invalid', GOAL)]);
  assert.deepEqual([invalidGoal.situations[0]?.outcome, invalidGoal.situations[0]?.reason], ['unknown', 'human_invalid']);
  const invalidDialogue = failed([review('t-f', 'invalid')]);
  assert.deepEqual([invalidDialogue.situations[0]?.reason, invalidDialogue.attempt('t-f')?.usable, invalidDialogue.attempt('t-f')?.verdict], ['human_invalid', false, 'unknown']);
  const overturned = failed([quickReview('t-f', 'pass', 'fail')]);
  assert.deepEqual([overturned.situations[0]?.outcome, overturned.failedAttempts], ['pass', []]);
  // The latest verdict on a target replaces the earlier one.
  assert.equal(failed([review('t-f', 'pass', GOAL), review('t-f', 'fail', GOAL, { id: 'h-later' })]).situations[0]?.outcome, 'fail');
});

test('invalidCauseOf: the typed cause wins; an older record’s reason decodes to turn_limit, simulator, service_reply or agent', () => {
  assert.equal(invalidCauseOf({ invalidCause: 'agent', reason: 'Разговор не завершился в отведённое число реплик.' }), 'agent');
  assert.equal(invalidCauseOf({ invalidCause: 'service_reply', reason: '' }), 'service_reply');
  assert.equal(invalidCauseOf({ reason: 'Разговор не завершился в отведённое число реплик. Состояние внешний агент не сообщил.' }), 'turn_limit');
  assert.equal(invalidCauseOf({ reason: 'реплика симулированного пользователя: timeout' }), 'simulator');
  assert.equal(invalidCauseOf({ reason: `${SERVICE_REPLY_REASON} «не получен ответ»: это не ответ агента, ситуация не измерена.` }), 'service_reply');
  assert.equal(invalidCauseOf({ reason: 'ответ испытуемого: HTTP 500' }), 'agent');
  assert.equal(invalidCauseOf({ reason: 'открытие сессии с испытуемым: ECONNREFUSED' }), 'agent');
  assert.equal(invalidCauseOf({ reason: '' }), 'agent');
  assert.equal(invalidCauseOf({ reason: `Ответ: ${SERVICE_REPLY_REASON}` }), 'agent', 'only the start of the reason is read');
});

/** A real zod message: the shape a rejected judge answer leaves in `assessmentError`. */
const ZOD_TEXT = z.strictObject({ result: z.enum(['pass', 'fail', 'unknown']) }).safeParse({ result: 'maybe' }).error!.message;

test('assessmentFailureOf: the typed failure wins; an older record’s label decodes by its fixed start', () => {
  assert.equal(assessmentFailureOf({}), undefined, 'no error, no failure');
  assert.equal(assessmentFailureOf({ assessmentFailure: 'unavailable', assessmentError: 'Judge response rejected; original responses and errors are preserved in judgeAudit' }), 'unavailable');
  assert.equal(assessmentFailureOf({ assessmentFailure: 'stopped' }), 'stopped');
  const legacy: [string, ReturnType<typeof assessmentFailureOf>][] = [
    [CODE_ONLY_ASSESSMENT, 'code_only'],
    ['Только точные проверки: рубрики не переоценивались.', 'code_only'],
    ['Metric assessment cancelled', 'stopped'],
    ['Model call budget exhausted.', 'stopped'],
    ['Experiment time limit reached.', 'stopped'],
    ['Pi provider response incomplete: rate limit', 'unavailable'],
    ['Pi request deadline exceeded', 'unavailable'],
    ['Запрос к openrouter/x не прошёл. …', 'unavailable'],
    ['Модель вернула пустой ответ.', 'unavailable'],
    ['Judge response rejected; original responses and errors are preserved in judgeAudit', 'rejected'],
    [ZOD_TEXT, 'rejected'],
    ['Запрос к openrouter/x', 'rejected'],
    ['Судья: Pi request deadline exceeded', 'rejected'],
  ];
  for (const [assessmentError, expected] of legacy) assert.equal(assessmentFailureOf({ assessmentError }), expected, assessmentError);
});

test('judgeFailure: an aborted signal or a Stopped error is a stop whatever the words; otherwise the label decides', () => {
  const live = new AbortController().signal;
  assert.equal(judgeFailure(new Error('Judge response rejected; original responses and errors are preserved in judgeAudit'), AbortSignal.abort()), 'stopped');
  assert.equal(judgeFailure(new Error('Pi request deadline exceeded'), AbortSignal.abort()), 'stopped');
  assert.equal(judgeFailure(new Stopped('budget', 'Model call budget exhausted.'), live), 'stopped');
  assert.equal(judgeFailure(new Stopped('cancelled', 'Judge response rejected'), live), 'stopped', 'a stop is known by its type, never by its words');
  assert.equal(judgeFailure(new Error('Metric assessment cancelled'), live), 'stopped');
  assert.equal(judgeFailure(new Error('Pi provider response incomplete: rate limit'), live), 'unavailable');
  assert.equal(judgeFailure(new Error('Pi request deadline exceeded'), live), 'unavailable');
  assert.equal(judgeFailure('Запрос к openrouter/x не прошёл. …', live), 'unavailable', 'a thrown string is read like a message');
  assert.equal(judgeFailure(new Error(ZOD_TEXT), live), 'rejected');
  assert.equal(judgeFailure(new Error(CODE_ONLY_ASSESSMENT), live), 'code_only');
});

test('judgeBasis reads the judge’s own fixed sentences: a split vote, an unsupported goal, or a judgment', () => {
  assert.equal(judgeBasis({ metricId: GOAL, rationale: SPLIT }), 'split');
  assert.equal(judgeBasis({ metricId: 'prompt_compliance', rationale: SPLIT }), 'split');
  assert.equal(judgeBasis({ metricId: GOAL, rationale: `${AGREED_RATIONALE_PREFIX} ${GOAL_UNSUPPORTED_RATIONALE}` }), 'unsupported');
  assert.equal(judgeBasis({ metricId: GOAL, rationale: GOAL_UNSUPPORTED_RATIONALE }), 'unsupported');
  assert.equal(judgeBasis({ metricId: 'prompt_compliance', rationale: GOAL_UNSUPPORTED_RATIONALE }), 'judged', 'only the goal can lack its evidence');
  assert.equal(judgeBasis({ metricId: GOAL, rationale: `${AGREED_RATIONALE_PREFIX} Условие не проверялось.` }), 'judged');
  assert.equal(judgeBasis({ metricId: GOAL, rationale: `Итог: ${SPLIT}` }), 'judged', 'the split sentence counts only at the start');
});

test('a strict legacy card is decided only on a finished run: until then it waits, or the run stopped before it', () => {
  const legacy = (phase: Experiment['phase']) => run([card('l', { metrics: [{ ...replyQuality }] }), card('g')],
    [attempt('l', {}, { assessments: [vote('reply_quality', 'pass')] }), attempt('g')], { phase });
  const verdict = (phase: Experiment['phase']) => {
    const item = deriveRun(legacy(phase)).situation('l')!;
    return [item.outcome, item.reason ?? null];
  };
  assert.deepEqual(verdict('results_review'), ['pass', null]);
  assert.deepEqual(verdict('complete'), ['pass', null]);
  assert.deepEqual(verdict('evaluating'), ['unknown', 'in_progress']);
  for (const phase of ['cancelled', 'interrupted', 'error'] as const) assert.deepEqual(verdict(phase), ['unknown', 'not_reached'], phase);
  assert.equal(deriveRun(legacy('evaluating')).situation('g')?.outcome, 'pass', 'a goal card is decided as soon as its attempts are in');
  const running = buildResultView(legacy('evaluating'));
  assert.deepEqual([running.pending, running.notMeasured.total], [1, 0], 'the waiting legacy card is pending, not unmeasured');
  const stopped = buildResultView(legacy('cancelled'));
  assert.deepEqual(stopped.notMeasured.reasons.map(reason => [reason.code, reason.scenarioIds]), [['not_reached', ['l']]]);
});

test('several reasons on one situation: the earlier code of NOT_MEASURED_CODES is named', () => {
  assert.ok(NOT_MEASURED_CODES.indexOf('judge_error') < NOT_MEASURED_CODES.indexOf('judge_unavailable'));
  assert.ok(NOT_MEASURED_CODES.indexOf('judge_unavailable') < NOT_MEASURED_CODES.indexOf('judge_stopped'));
  const reasonOf = (first: Partial<Trial>, second: Partial<Trial>) =>
    deriveRun(run([card('c')], [attempt('c', {}, first), attempt('c', {}, { repeat: 1, ...second })], twoRepeats)).situations[0]?.reason;
  assert.equal(reasonOf({ assessmentError: 'Pi request deadline exceeded' }, { assessmentError: 'Judge response rejected; original responses and errors are preserved in judgeAudit' }), 'judge_error');
  assert.equal(reasonOf({ assessmentFailure: 'stopped', assessmentError: 'x' }, { assessmentFailure: 'unavailable', assessmentError: 'y' }), 'judge_unavailable');
  assert.equal(reasonOf({ outcome: 'invalid', reason: 'ответ испытуемого: HTTP 500', assessments: undefined }, { assessmentError: 'Pi request deadline exceeded' }), 'agent_error');
});

test('deriveRun is remembered per snapshot: the same record gives the same object, a moved stamp recomputes', () => {
  const record = run([card('a'), card('b')], [attempt('a')]);
  const first = deriveRun(record);
  assert.equal(deriveRun(record), first, 'the same snapshot is derived once');
  assert.equal(first.situation('b')?.reason, 'not_reached');
  record.trials.push(attempt('b', { [GOAL]: 'fail' }));
  const added = deriveRun(record);
  assert.notEqual(added, first, 'an added trial moves the stamp');
  assert.equal(added.situation('b')?.outcome, 'fail');
  assert.deepEqual(ids(added.failedAttempts), ['t-b']);
  // Every change the lab makes moves the update time, so an edited verdict is read again.
  record.trials[1]!.assessments = record.trials[1]!.assessments!.map(item => item.metricId === GOAL ? { ...item, result: 'pass' as const } : item);
  record.updatedAt = 'later';
  const updated = deriveRun(record);
  assert.notEqual(updated, added);
  assert.equal(updated.situation('b')?.outcome, 'pass');
  record.humanReviews.push(review('t-b', 'fail', GOAL));
  const reviewed = deriveRun(record);
  assert.notEqual(reviewed, updated, 'a new human review moves the stamp');
  assert.equal(reviewed.situation('b')?.outcome, 'fail');
  record.positiveControlScenarioIds = ['b'];
  const controlled = deriveRun(record);
  assert.notEqual(controlled, reviewed, 'a new control set moves the stamp');
  assert.deepEqual([controlled.situation('b')?.control, controlled.failedAttempts], [true, []]);
  record.phase = 'complete';
  assert.notEqual(deriveRun(record), controlled, 'a phase change moves the stamp');
  // Another object with the same content is its own snapshot, derived the same way.
  const copy = structuredClone(record);
  assert.notEqual(deriveRun(copy), deriveRun(record));
  assert.deepEqual(deriveRun(copy).situations.map(item => item.outcome), deriveRun(record).situations.map(item => item.outcome));
});

test('the memo stamp holds what decides which trials are read: the workflow, the selected version, the control split and the plan', () => {
  const record = run([card('a')], [attempt('a', { [GOAL]: 'fail' })]);
  const evaluate = deriveRun(record);
  assert.deepEqual([evaluate.situations[0]?.outcome, ids(evaluate.failedAttempts)], ['fail', ['t-a']]);
  // A compare run is reduced to its selected version: none is selected yet, so no attempt is read.
  record.workflow = 'compare';
  const compare = deriveRun(record);
  assert.notEqual(compare, evaluate, 'a workflow change moves the stamp');
  assert.notEqual(compare.record, record, 'a compare run is read through its selected version');
  assert.deepEqual([compare.situations[0]?.outcome, compare.situations[0]?.reason, compare.failedAttempts], ['unknown', 'not_reached', []]);
  record.selectedRevisionId = 'rev';
  const selected = deriveRun(record);
  assert.notEqual(selected, compare, 'a new selected version moves the stamp');
  assert.equal(selected.situations[0]?.outcome, 'fail');
  record.controlConsumedAt = '2026-09-17T00:00:00Z';
  const control = deriveRun(record);
  assert.notEqual(control, selected, 'the consumed control split moves the stamp');
  assert.deepEqual(control.situations, [], 'the control split holds no card of this run');
  record.controlConsumedAt = null;
  record.manifestHash = 'h2';
  const replanned = deriveRun(record);
  assert.notEqual(replanned, control, 'a new plan moves the stamp');
  assert.deepEqual([replanned.situations[0]?.outcome, replanned.situations[0]?.reason], ['unknown', 'attempts_mismatch']);
});

test('exitCodeOf: 0 when every counted situation passed, 1 when one failed, 2 when the measurement is incomplete', () => {
  const code = (record: Experiment) => exitCodeOf(buildResultView(record));
  const two = [card('a'), card('b')];
  assert.equal(code(run(two, [attempt('a'), attempt('b')])), 0);
  assert.equal(code(run(two, [attempt('a'), attempt('b')], { phase: 'complete' })), 0);
  assert.equal(code(run(two, [attempt('a'), attempt('b', { [GOAL]: 'fail' })])), 1);
  assert.equal(code(run(two, [attempt('a'), attempt('b', { reply_quality: 'fail' })])), 0, 'reply quality never moves the number');
  // 2 takes precedence over an agent failure.
  assert.equal(code(run(two, [attempt('a', { [GOAL]: 'fail' }), attempt('b', { [GOAL]: 'unknown' })])), 2, 'a situation was not measured');
  assert.equal(code(run(two, [attempt('a', { [GOAL]: 'fail' })], { phase: 'evaluating' })), 2, 'a situation is still pending');
  assert.equal(code(run(two, [attempt('a'), attempt('b')], { phase: 'error' })), 2, 'the run did not finish');
  assert.equal(code(run(two, [], { phase: 'review' })), 2, 'nothing was decided');
  // A control alarm, even when every counted situation passed.
  const withControl = (control: Record<string, Result>, counted: Record<string, Result> = {}) =>
    run([card('a'), card('ctl')], [attempt('a', counted), attempt('ctl', control)], { positiveControlScenarioIds: ['ctl'] });
  assert.equal(code(withControl({ [GOAL]: 'fail' })), 2, 'a failed control');
  assert.equal(code(withControl({ [GOAL]: 'unknown' })), 2, 'an unmeasured control');
  assert.equal(code(withControl({ [GOAL]: 'fail' }, { [GOAL]: 'fail' })), 2, 'the alarm wins over a failure');
  assert.equal(code(withControl({})), 0, 'a passing control changes nothing');
  assert.equal(code(withControl({}, { [GOAL]: 'fail' })), 1);
});
