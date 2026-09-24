import { headlineRule, undecidedExpectation, type CountedExpectation } from './card/expectations.js';
import { directChecks } from './checkpoints.js';
import { fingerprint, type AssessmentFailure, type Experiment, type InvalidCause, type Scenario, type Trial } from './contracts.js';
import type { MetricAssessment } from './assessment.js';
import { isRunning } from './phases.js';
import { Stopped } from './errors.js';
import { GOAL_UNSUPPORTED_RATIONALE, SPLIT_RATIONALE_PREFIX } from './judge.js';
import { agentMetricResult, automaticTrialResult, expectationResult, GOAL_METRIC_ID, headlineMetricIds, headlineTrialResult, latestHumanReviews, measured, measurementUsable, observedRecord, RULES_METRIC_ID, simulatorVerdicts } from './outcomes.js';

/*
 * The one derivation of a run's result. Every surface — the chat block, the board, the CLI summary,
 * the CI exit code and the report — reads a run through `deriveRun`, so no two of them can count a
 * situation differently:
 *
 *   trials ──usable? human override──► attempt verdict ──every attempt, fail-first──► situation verdict
 *                                                        └─ undecided ──► one reason code (NOT_MEASURED_CODES)
 *
 * Reasons are typed where the failure happened (`trial.invalidCause`, `trial.assessmentFailure`).
 * Records written before those fields carry only the harness's own fixed sentences; the decoders
 * below read them and nothing else reads text. Pure: no I/O, no wording.
 */

export type Verdict = 'pass' | 'fail' | 'unknown';

/**
 * Why a situation has no verdict. The order is both the evaluation order of the code paths that
 * leave a situation `unknown` and the tie-break when two reasons are equally frequent.
 */
export const NOT_MEASURED_CODES = [
  'in_progress', 'not_reached', 'stopped', 'turn_limit', 'simulator_error', 'agent_error', 'service_reply', 'attempts_mismatch',
  'judge_error', 'judge_unavailable', 'judge_stopped', 'human_invalid', 'reset_unconfirmed', 'simulator_deviated', 'simulator_unclear',
  'human_unknown', 'not_judged', 'judge_split', 'no_evidence', 'judge_unclear',
] as const;
export type NotMeasuredCode = typeof NOT_MEASURED_CODES[number];

/** The start of the reason evaluation.ts writes for a service text instead of an agent reply; the marker itself follows it. */
export const SERVICE_REPLY_REASON = 'Стенд ответил служебным текстом';
/** What a reassessment that re-ran only the code checks writes instead of a judgment; older records start with the same words. */
export const CODE_ONLY_ASSESSMENT = 'Только точные проверки; рубрики не переоценивались.';
const CODE_ONLY_PREFIX = 'Только точные проверки';

// Reasons evaluation.ts wrote before `invalidCause` existed. They decode stored records only.
const LEGACY_TURN_LIMIT = 'Разговор не завершился в отведённое число реплик.';
const LEGACY_SIMULATOR_STAGE = 'реплика симулированного пользователя:';

/** Where the dialogue broke: the typed cause, or the legacy reason of an older record. */
export function invalidCauseOf(trial: Pick<Trial, 'invalidCause' | 'reason'>): InvalidCause {
  if (trial.invalidCause) return trial.invalidCause;
  return trial.reason.startsWith(LEGACY_TURN_LIMIT) ? 'turn_limit' : trial.reason.startsWith(LEGACY_SIMULATOR_STAGE) ? 'simulator'
    : trial.reason.startsWith(SERVICE_REPLY_REASON) ? 'service_reply' : 'agent';
}

/*
 * The fixed labels the harness writes into `assessmentError`: its own diagnostics, never provider or
 * model text (pi.ts keeps only a fixed category of a provider error, so credentials and URLs never
 * reach a record). Records keep them verbatim, so they are the only way to read an older record.
 */
const STOP_LABELS = ['Metric assessment cancelled', 'Cancelled by the user.', 'Model call budget exhausted.', 'Experiment time limit reached.', 'Application is closing.'];
const PROVIDER_LABELS = ['Pi provider response incomplete:', 'Pi request deadline exceeded', 'Pi session is closed', 'Pi session already has an active response',
  'Модель вернула пустой ответ.', 'Judge model unavailable:', 'Metric assessment is unavailable'];
/** «Запрос к openrouter/model не прошёл. …» — the one provider label that names the model in the middle. */
const requestFailed = (text: string) => text.startsWith('Запрос к ') && text.includes(' не прошёл.');

function decodeAssessmentError(text: string): AssessmentFailure {
  if (text.startsWith(CODE_ONLY_PREFIX)) return 'code_only';
  if (STOP_LABELS.some(label => text.startsWith(label))) return 'stopped';
  if (PROVIDER_LABELS.some(label => text.startsWith(label)) || requestFailed(text)) return 'unavailable';
  // Everything else is the judge's own answer rejected (a malformed or unsupported judgment), as older records counted it.
  return 'rejected';
}

/** The typed failure a judgment error is recorded with. A stop is known by its signal, never by its words. */
export function judgeFailure(error: unknown, signal: AbortSignal): AssessmentFailure {
  if (signal.aborted || error instanceof Stopped) return 'stopped';
  return decodeAssessmentError(error instanceof Error ? error.message : String(error));
}

/** Why the judge left the attempt without a judgment: the typed failure, or the legacy text of an older record. */
export function assessmentFailureOf(trial: Pick<Trial, 'assessmentFailure' | 'assessmentError'>): AssessmentFailure | undefined {
  return trial.assessmentFailure ?? (trial.assessmentError === undefined ? undefined : decodeAssessmentError(trial.assessmentError));
}

/**
 * How the judge reached an undecided vote. The judge's assessment schema is frozen inside JUDGE_PROMPT
 * and every stored receipt, so the consensus cannot become a typed field without breaking them; the
 * judge states it in one of its own fixed sentences instead, read here and only here. `unsupported`:
 * the goal was not confirmed on the evidence channel the owner chose (an agreed prefix may precede it).
 */
export function judgeBasis(assessment: Pick<MetricAssessment, 'metricId' | 'rationale'>): 'split' | 'unsupported' | 'judged' {
  if (assessment.rationale.startsWith(SPLIT_RATIONALE_PREFIX)) return 'split';
  return assessment.metricId === GOAL_METRIC_ID && assessment.rationale.includes(GOAL_UNSUPPORTED_RATIONALE) ? 'unsupported' : 'judged';
}

/** Expected attempts, including all repeats. Missing/invalid attempts never disappear from a count. */
export function plannedTrials(record: Experiment): number {
  if (record.assessmentTrialIds) return record.assessmentTrialIds.length;
  return record.scenarios.reduce((sum, s) => sum + record.settings.userModes.filter(m => m !== 'scripted' || s.user.script !== undefined).length * record.settings.repeats, 0);
}
export const attemptKey = (trial: Trial) => `${trial.scenarioId}|${trial.userMode}|${trial.repeat}`;
export const expectedAttemptRows = (record: Experiment): { scenarioId: string; userMode: Trial['userMode']; repeat: number }[] => record.assessmentTrialIds
  ? record.trials.filter(t => record.assessmentTrialIds!.includes(t.id)).map(({ scenarioId, userMode, repeat }) => ({ scenarioId, userMode, repeat }))
  : record.scenarios.flatMap(s => record.settings.userModes.filter(m => m !== 'scripted' || s.user.script !== undefined)
    .flatMap(userMode => Array.from({ length: record.settings.repeats }, (_, repeat) => ({ scenarioId: s.id, userMode, repeat }))));
function expectedAttempts(record: Experiment): Set<string> {
  return new Set(expectedAttemptRows(record).map(row => `${row.scenarioId}|${row.userMode}|${row.repeat}`));
}

/** The phases in which a run's attempts are final. */
const FINISHED: ReadonlySet<Experiment['phase']> = new Set(['results_review', 'complete']);

/** What keeps a run's saved attempts from describing the planned run; empty when they do. */
export function runCompleteness(record: Experiment, allowPartial = false): string[] {
  const expected = expectedAttempts(record);
  const seen = new Set<string>();
  const ids = new Set<string>();
  let invalid = false;
  let unmeasured = false;
  for (const trial of record.trials) {
    const key = attemptKey(trial);
    const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
    if (!expected.has(key) || seen.has(key) || ids.has(trial.id) || !scenario
      || trial.familyId !== scenario.familyId || fingerprint(trial.initialState) !== fingerprint(scenario.initialState)
      || trial.split !== scenario.split
      || measured(trial) && (trial.checks.length !== directChecks(scenario, trial).length || new Set(trial.checks.map(c => c.id)).size !== directChecks(scenario, trial).length
        || trial.checks.some(c => !directChecks(scenario, trial).some(expected => expected.id === c.id)))
      || trial.outcome === 'pass' && (trial.checks.some(c => !c.passed) || !trial.checks.length && !scenario?.execution)
      || (record.manifestHash && trial.manifestHash !== record.manifestHash)) invalid = true;
    if (!measured(trial)) unmeasured = true;
    seen.add(key); ids.add(trial.id);
  }
  const notes: string[] = [];
  if (!FINISHED.has(record.phase)) notes.push('Прогон не завершён.');
  if (invalid || !expected.size) notes.push('Есть повторяющиеся или несовместимые попытки.');
  if (!allowPartial && (unmeasured || seen.size !== expected.size || record.trials.length !== expected.size)) notes.push('Есть пропущенные или невалидные попытки.');
  return notes;
}

/** The strict card result of a legacy card without the goal rubric: the full card must be complete. */
export function cardOutcome(record: Experiment, scenario: Scenario, allowPartial = false): Verdict {
  const trials = record.trials.filter(t => t.scenarioId === scenario.id);
  if (!trials.length || runCompleteness({ ...record, scenarios: [scenario], trials }, allowPartial).length) return 'unknown';
  const outcomes = trials.map(t => automaticTrialResult(scenario, t, record.humanReviews));
  return outcomes.includes('fail') ? 'fail' : outcomes.every(o => o === 'pass') ? 'pass' : 'unknown';
}

/**
 * The attempt gate every headline metric passes through: the expected `mode:repeat` set equals the
 * seen set and the counts (skipped when `partial`, which still requires at least one attempt), and
 * every attempt belongs to this card's family, split and plan. Usability is not part of it.
 */
function attemptsMatch(record: Experiment, scenario: Scenario, trials: Trial[], partial = false): boolean {
  if (!trials.length) return false;
  const modes = record.settings.userModes.filter(mode => mode !== 'scripted' || scenario.user.script !== undefined);
  const expected = new Set(modes.flatMap(mode => Array.from({ length: record.settings.repeats }, (_, repeat) => `${mode}:${repeat}`)));
  const seen = new Set(trials.map(trial => `${trial.userMode}:${trial.repeat}`));
  if (!partial && (!expected.size || trials.length !== expected.size || seen.size !== expected.size || [...expected].some(key => !seen.has(key)))) return false;
  return !trials.some(trial => trial.familyId !== scenario.familyId || trial.split !== scenario.split
    || record.manifestHash && trial.manifestHash !== record.manifestHash);
}

/**
 * One headline metric over the card: unknown unless the attempts match and every one of them is a
 * usable measurement, then fail-first over the attempts. Both headline metrics go through this
 * same gate, so an unusable card is unknown before any fail is read.
 */
function metricCardOutcome(record: Experiment, scenario: Scenario, metricId: string, partial = false): Verdict {
  const trials = record.trials.filter(trial => trial.scenarioId === scenario.id);
  if (!attemptsMatch(record, scenario, trials, partial) || trials.some(trial => !measurementUsable(scenario, trial, record.humanReviews))) return 'unknown';
  return failFirst(trials.map(trial => agentMetricResult(trial, metricId, record.humanReviews) ?? 'unknown'));
}

/** One part of a card's verdict: an expectation (label А, Б, В…, with its words), a legacy card's goal or prompt rules, or a card's exact checks. */
export interface CardPart { id: string; label: string; text?: string; outcome: Verdict }
type HeadlineOutcome = { outcome: Verdict; goal: Verdict | 'none'; rules: Verdict | 'none'; parts: CardPart[] };
const failFirst = (results: Verdict[]): Verdict => results.includes('fail') ? 'fail' : results.every(result => result === 'pass') ? 'pass' : 'unknown';

/**
 * A card counted by its expectations: each expectation is fail-first over the attempts (its part), and the
 * card passes only when every expectation passed in every attempt. Its exact checks, where it has them, are
 * one more part of the same AND. The attempt and usability gate comes first, as for every headline card.
 */
function expectationsCardOutcome(record: Experiment, scenario: Scenario, trials: Trial[], expectations: CountedExpectation[], partial: boolean): HeadlineOutcome {
  const gated = attemptsMatch(record, scenario, trials, partial) && trials.every(trial => measurementUsable(scenario, trial, record.humanReviews));
  const over = (result: (trial: Trial) => Verdict): Verdict => gated ? failFirst(trials.map(result)) : 'unknown';
  const parts: CardPart[] = expectations.map(expectation => ({ id: expectation.id, label: expectation.letter, text: expectation.text,
    outcome: over(trial => expectationResult(trial, expectation, record.humanReviews) ?? 'unknown') }));
  if (scenario.checks.length) parts.push({ id: 'checks', label: 'Точные проверки', outcome: over(trial => trial.outcome === 'pass' ? 'pass' : trial.outcome === 'fail' ? 'fail' : 'unknown') });
  return { outcome: over(trial => headlineTrialResult(scenario, trial, record.humanReviews)), goal: 'none', rules: 'none', parts };
}

/**
 * The headline card result by the card's counting rule (card/expectations.ts headlineRule). A card counted
 * by its expectations passes only when every expectation passed in every attempt. An old generated card is
 * counted by goal attainment and, when it has it, prompt compliance: it passes only when both pass in every
 * attempt, fails when either fails in any attempt, and stays unknown otherwise. Every part passes the same
 * attempt and usability gate before any fail is read, so an unusable card is «не измерено» whatever its parts
 * say. A legacy card without the goal rubric keeps the strict card outcome, with no parts. Reply quality and
 * the RAG rubrics never enter. `parts` name the verdict's parts in the owner's words (А, Б, В; Цель, Правила промпта).
 */
export function headlineCardOutcome(record: Experiment, scenario: Scenario, options: { partial?: boolean } = {}): HeadlineOutcome {
  const partial = options.partial ?? false;
  const trials = record.trials.filter(trial => trial.scenarioId === scenario.id);
  const rule = headlineRule(scenario, trials);
  if (rule.kind === 'expectations') return expectationsCardOutcome(record, scenario, trials, rule.expectations, partial);
  const ids = headlineMetricIds(scenario);
  if (!ids.length) return { outcome: cardOutcome(record, scenario, partial), goal: 'none', rules: 'none', parts: [] };
  const goal = metricCardOutcome(record, scenario, GOAL_METRIC_ID, partial);
  const rules = ids.includes(RULES_METRIC_ID) ? metricCardOutcome(record, scenario, RULES_METRIC_ID, partial) : 'none';
  const parts: CardPart[] = [{ id: GOAL_METRIC_ID, label: 'Цель', outcome: goal }, ...(rules === 'none' ? [] : [{ id: RULES_METRIC_ID, label: 'Правила промпта', outcome: rules }])];
  return { outcome: failFirst(parts.map(part => part.outcome)), goal, rules, parts };
}

/** The goal-only card result the positive control is decided by; a legacy card uses the strict card outcome. */
export function goalCardOutcome(record: Experiment, scenario: Scenario): Verdict {
  if (!headlineMetricIds(scenario).length) return cardOutcome(record, scenario);
  return metricCardOutcome(record, scenario, GOAL_METRIC_ID);
}

/**
 * Why one attempt leaves the card without a verdict; `ids` are the headline metrics and `expectations` the
 * card's counted expectations whose undecided verdicts are explained — for an expectation, from what was
 * recorded (its votes and its evidence channel), never from the judge's wording.
 */
function trialReasons(record: Experiment, scenario: Scenario, trial: Trial, ids: string[], expectations: CountedExpectation[]): NotMeasuredCode[] {
  const codes: NotMeasuredCode[] = [];
  const latest = latestHumanReviews({ trials: [trial], humanReviews: record.humanReviews });
  if (trial.outcome === 'cancelled') codes.push('stopped');
  else if (trial.outcome === 'invalid') codes.push(({ turn_limit: 'turn_limit', simulator: 'simulator_error', agent: 'agent_error', service_reply: 'service_reply' } as const)[invalidCauseOf(trial)]);
  const failure = assessmentFailureOf(trial);
  if (failure) codes.push(({ code_only: 'not_judged', stopped: 'judge_stopped', unavailable: 'judge_unavailable', rejected: 'judge_error' } as const)[failure]);
  if (latest.get(`${trial.id}|dialogue`)?.verdict === 'invalid'
    || ids.some(id => latest.get(`${trial.id}|metric:${id}`)?.verdict === 'invalid')) codes.push('human_invalid');
  if (scenario.initialState.external && trial.observation?.resetConfirmed !== true) codes.push('reset_unconfirmed');
  const simulator = simulatorVerdicts(scenario, trial, record.humanReviews);
  if (simulator.checks.some(usable => !usable) || simulator.fidelity.includes('fail')) codes.push('simulator_deviated');
  // Without any judgment the vote is missing because the judge never ran: that is `not_judged`, not an unsure judge.
  if (trial.assessments && simulator.fidelity.some(result => result !== 'pass' && result !== 'fail')) codes.push('simulator_unclear');
  for (const expectation of expectations) {
    const result = expectationResult(trial, expectation, record.humanReviews);
    if (result === 'pass' || result === 'fail') continue;
    const review = latest.get(`${trial.id}|metric:${expectation.id}`);
    codes.push(review?.verdict === 'invalid' ? 'human_invalid' : review?.verdict === 'unknown' && review.source !== 'quick' ? 'human_unknown' : undecidedExpectation(trial, expectation));
  }
  for (const id of ids) {
    const result = agentMetricResult(trial, id, record.humanReviews);
    if (result === 'pass' || result === 'fail') continue;
    const assessment = trial.assessments?.find(a => a.metricId === id);
    // A one-key «не могу сказать» leaves the judge's verdict in place, so it is never the reason a card has none.
    const metricReview = latest.get(`${trial.id}|metric:${id}`);
    if (metricReview?.verdict === 'unknown' && metricReview.source !== 'quick') codes.push('human_unknown');
    else if (!assessment) codes.push('not_judged');
    else codes.push(({ split: 'judge_split', unsupported: 'no_evidence', judged: 'judge_unclear' } as const)[judgeBasis(assessment)]);
  }
  return codes;
}

/**
 * One card decided by the counting rules, with the single reason when it has no verdict. `rule`
 * picks the headline verdict (the card's counting rule) or the goal-only one the positive control
 * is decided by; the reasons cover every undecided metric or expectation of the chosen rule.
 */
export function cardVerdict(record: Experiment, scenario: Scenario, rule: 'headline' | 'goal' = 'headline'): { outcome: Verdict; reason?: NotMeasuredCode } {
  const outcome = rule === 'goal' ? goalCardOutcome(record, scenario) : headlineCardOutcome(record, scenario).outcome;
  if (outcome !== 'unknown') return { outcome };
  const ids = rule === 'goal' ? headlineMetricIds(scenario).slice(0, 1) : headlineMetricIds(scenario);
  const trials = record.trials.filter(trial => trial.scenarioId === scenario.id);
  const counting = headlineRule(scenario, trials);
  // The strict card outcome decides a legacy card, and every card without a goal when only its goal is asked.
  const strict = rule === 'goal' ? !ids.length : counting.kind === 'strict';
  const codes = new Set<NotMeasuredCode>();
  if (!trials.length) codes.add(isRunning(record.phase) ? 'in_progress' : 'not_reached');
  // A strict card is decided only on a finished run: until then it waits, or the run stopped before deciding it.
  else if (strict && !FINISHED.has(record.phase)) codes.add(isRunning(record.phase) ? 'in_progress' : 'not_reached');
  else if (!attemptsMatch(record, scenario, trials)) codes.add('attempts_mismatch');
  const expectations = counting.kind === 'expectations' ? counting.expectations : [];
  for (const trial of trials) for (const code of trialReasons(record, scenario, trial, ids, expectations)) codes.add(code);
  return { outcome, reason: NOT_MEASURED_CODES.find(code => codes.has(code)) ?? 'judge_unclear' };
}

export interface AttemptDerivation {
  trial: Trial;
  /** A usable measurement: measured, judged without an error, not marked invalid, reset confirmed where needed, the client kept to the card. */
  usable: boolean;
  /** The attempt by the headline rule, human verdicts applied. */
  verdict: Verdict;
}
export interface SituationDerivation {
  scenario: Scenario;
  /** A positive control: decided by its goal alone and never counted in the headline. */
  control: boolean;
  outcome: Verdict;
  reason?: NotMeasuredCode;
  /** The two halves of an old generated card's headline verdict; 'none' when the card has no such check (a legacy card has neither). */
  goal: Verdict | 'none'; rules: Verdict | 'none';
  /** The parts of the headline verdict in the owner's words: expectations А, Б, В, or «Цель» and «Правила промпта». */
  parts: CardPart[];
  attempts: AttemptDerivation[];
  /** Repeats disagree: one attempt passed and another failed. The situation still counts as failed (fail-first); this names why. */
  flaky: boolean;
}
export interface RunDerivation {
  /** The record the derivation read: a compare run is reduced to its selected version first. */
  record: Experiment;
  situations: SituationDerivation[];
  situation(scenarioId: string): SituationDerivation | undefined;
  attempt(trialId: string): AttemptDerivation | undefined;
  /** Attempts whose headline verdict failed in counted situations, in record order: exactly what the number calls a failure. */
  failedAttempts: Trial[];
}

/*
 * A record is read as a snapshot: every surface gets a fresh copy (the store parses one, the lab hands
 * out clones) and never changes the one it displays. The lab's own working copy changes while it runs,
 * and each save moves the update time. The stamp also holds the counts and every field that chooses
 * what is counted (the workflow, the selected version and split, the controls), so a remembered
 * derivation is reused only for the snapshot it was made from. Code that edits a record in place and
 * reads it again without saving — a test building states — derives a copy.
 */
const memo = new WeakMap<Experiment, { stamp: string; run: RunDerivation }>();
const stampOf = (record: Experiment) => [record.updatedAt, record.phase, record.workflow, record.controlConsumedAt, record.selectedRevisionId,
  record.manifestHash, record.trials.length, record.humanReviews.length, record.scenarios.length, record.positiveControlScenarioIds?.join(',') ?? ''].join('|');

export function deriveRun(input: Experiment): RunDerivation {
  const stamp = stampOf(input);
  const known = memo.get(input);
  if (known?.stamp === stamp) return known.run;
  const record = observedRecord(input);
  const controls = new Set((record.positiveControlScenarioIds ?? []).filter(id => record.scenarios.some(scenario => scenario.id === id)));
  const attempts = new Map<string, AttemptDerivation>();
  const situations = record.scenarios.map((scenario): SituationDerivation => {
    const control = controls.has(scenario.id);
    const verdict = cardVerdict(record, scenario, control ? 'goal' : 'headline');
    const parts = headlineCardOutcome(record, scenario);
    const own = record.trials.filter(trial => trial.scenarioId === scenario.id).map(trial => {
      const attempt = { trial, usable: measurementUsable(scenario, trial, record.humanReviews), verdict: headlineTrialResult(scenario, trial, record.humanReviews) };
      attempts.set(trial.id, attempt);
      return attempt;
    });
    const decided = new Set(own.map(attempt => attempt.verdict).filter(v => v !== 'unknown'));
    return { scenario, control, outcome: verdict.outcome, ...(verdict.reason ? { reason: verdict.reason } : {}), goal: parts.goal, rules: parts.rules,
      parts: parts.parts, attempts: own, flaky: decided.size > 1 };
  });
  const byScenario = new Map(situations.map(item => [item.scenario.id, item]));
  const failedAttempts = record.trials.filter(trial => {
    const situation = byScenario.get(trial.scenarioId);
    return !!situation && !situation.control && situation.outcome === 'fail' && attempts.get(trial.id)?.verdict === 'fail';
  });
  const run: RunDerivation = { record, situations, situation: id => byScenario.get(id), attempt: id => attempts.get(id), failedAttempts };
  memo.set(input, { stamp, run });
  return run;
}
