import { countingRuleOf, editionOf, GOAL_METRIC_ID, headlineRule, recordedExpectationResult, type CountedExpectation, type CountingRule } from './card/expectations.js';
import { requiredCheckpointResult } from './checkpoints.js';
import { simulatorWasUsed, type Experiment, type HumanReview, type Scenario, type Trial } from './contracts.js';
import { metricApplies } from './assessment.js';
import { isRunning } from './phases.js';

/*
 * Outcome helpers shared by comparison.ts (verdict, evidence, run delta) and simulator.ts
 * (scorecard, mode value). Nothing here performs I/O; nothing here depends on either consumer,
 * so both can import it without a cycle.
 */
export const graded = (trial: Trial) => trial.outcome === 'pass' || trial.outcome === 'fail';
export const measured = (trial: Trial) => graded(trial) || trial.outcome === 'ungraded';

/** Legacy optimization runs contain several agents; their headline describes only the selected version. */
export function observedRecord(record: Experiment): Experiment {
  if (record.workflow !== 'compare') return record;
  const split = record.controlConsumedAt && !isRunning(record.phase) ? 'control' : 'dev';
  const selected = record.selectedRevisionId ?? record.revisions[0]?.id;
  const trials = record.trials.filter(t => t.revisionId === selected && t.split === split);
  const ids = new Set(trials.map(t => t.id));
  return { ...record, trials, scenarios: record.scenarios.filter(s => s.split === split), humanReviews: record.humanReviews.filter(r => ids.has(r.trialId)) };
}

/** The latest human verdict per review target (whole dialogue, one metric or one check); earlier verdicts on the same target are superseded. */
export function latestHumanReviews(record: Pick<Experiment, 'trials' | 'humanReviews'>): Map<string, HumanReview> {
  const latest = new Map<string, HumanReview>();
  const trials = new Set(record.trials.map(t => t.id));
  for (const review of record.humanReviews) {
    if (!trials.has(review.trialId)) continue;
    latest.set(`${review.trialId}|${review.metricId ? `metric:${review.metricId}` : review.checkId ? `check:${review.checkId}` : 'dialogue'}`, review);
  }
  return latest;
}

/**
 * The metric a one-key agreement mark lands on: goal attainment; else the first agent metric the
 * judge failed; else the first one it passed. Only `scenario.metrics` with `subject === 'agent'`
 * are considered — the RAG rubrics `assessmentRubrics` adds are diagnostic, never the main
 * judgment. Reads recorded assessments only, so a human verdict never moves the primary metric.
 */
export function primaryMetricId(scenario: Scenario | undefined, trial: Trial): string | undefined {
  const agent = (scenario?.metrics ?? []).filter(m => m.subject === 'agent');
  if (agent.some(m => m.id === 'goal_attainment')) return 'goal_attainment';
  const result = (id: string) => trial.assessments?.find(a => a.metricId === id)?.result;
  return agent.find(m => result(m.id) === 'fail')?.id ?? agent.find(m => result(m.id) === 'pass')?.id;
}

type Judged = 'pass' | 'fail' | 'unknown';

/**
 * The human-override rule — the only copy of it. The latest human verdict on a target (one metric,
 * one check) replaces the recorded result, with two exceptions. «Не понять» (`unknown`) is doubt, not a
 * verdict: whatever the path — a one-key mark, a full review, a blind label — it never takes the judge's
 * failure out of the count, so the owner's hesitation can never raise the number; a one-key doubt leaves
 * any recorded result as it is, a considered one (a full review, a blind label) leaves a pass undecided.
 * And «invalid» takes the target out of the judgment altogether (`invalid: true`, no result). The owner's
 * verdict on a logged conversation (card/calibration.ts LogReview) follows the same rule.
 */
export function humanOverride(review: Pick<HumanReview, 'verdict' | 'source'> | undefined, recorded: Judged | undefined): { invalid: boolean; result: Judged | undefined } {
  if (review?.verdict === 'invalid') return { invalid: true, result: undefined };
  if (!review) return { invalid: false, result: recorded };
  if (review.verdict === 'unknown') return { invalid: false, result: recorded === 'fail' || review.source === 'quick' ? recorded : 'unknown' };
  return { invalid: false, result: review.verdict };
}

/**
 * Whether a person found this expectation of an attempt wrong itself («ожидание само неверное»): the card's error, not
 * the agent's. It leaves the agent's count (allExpectations) and is counted apart (expectationsFoundWrong).
 */
export function expectationFoundWrong(trial: Trial, expectationId: string, reviews: HumanReview[] = []): boolean {
  return latestHumanReviews({ trials: [trial], humanReviews: reviews }).get(`${trial.id}|metric:${expectationId}`)?.verdict === 'invalid';
}

/** Rubric outcomes stay separate from objective checks everywhere they are presented; a human verdict applies by `humanOverride`. */
export function agentMetricResult(trial: Trial, metricId: string, reviews: HumanReview[] = [],
  /** The judge's result as it is read; a card expectation's is gated by its evidence channel (`expectationResult`). */
  recorded: Judged | undefined = trial.assessments?.find(a => a.metricId === metricId)?.result): Judged | undefined {
  const human = latestHumanReviews({ trials: [trial], humanReviews: reviews }).get(`${trial.id}|metric:${metricId}`);
  return humanOverride(human, recorded).result;
}

/** One card expectation in one attempt: the judge's result read through its evidence channel, then the human verdict over it. */
export function expectationResult(trial: Trial, expectation: CountedExpectation, reviews: HumanReview[] = []): 'pass' | 'fail' | 'unknown' | undefined {
  return agentMetricResult(trial, expectation.id, reviews, recordedExpectationResult(trial, expectation));
}
/**
 * Every expectation of one attempt the agent is counted by, fail-first: any fail fails, all pass passes, anything else is
 * unknown. An expectation a person found wrong itself is the card's error and leaves the count; with none left, nothing of
 * the agent is measured.
 */
function allExpectations(trial: Trial, expectations: CountedExpectation[], reviews: HumanReview[]): 'pass' | 'fail' | 'unknown' {
  const results = expectations.filter(expectation => !expectationFoundWrong(trial, expectation.id, reviews))
    .map(expectation => expectationResult(trial, expectation, reviews) ?? 'unknown');
  if (!results.length) return 'unknown';
  return results.includes('fail') ? 'fail' : results.every(result => result === 'pass') ? 'pass' : 'unknown';
}
/**
 * One usable attempt of a card counted by its expectations. A failed direct check (a first-format checkpoint's
 * exact check) fails it; with no expectation to judge, the checks alone decide.
 */
function expectationsTrialResult(trial: Trial, expectations: CountedExpectation[], reviews: HumanReview[]): 'pass' | 'fail' | 'unknown' {
  if (trial.outcome === 'fail') return 'fail';
  if (!expectations.length) return trial.outcome === 'pass' ? 'pass' : 'unknown';
  return allExpectations(trial, expectations, reviews);
}

export function agentRubricResult(scenario: Scenario | undefined, trial: Trial, reviews: HumanReview[] = []): 'pass' | 'fail' | 'unknown' | undefined {
  const rule = headlineRule(scenario, [trial]);
  if (rule.kind === 'expectations') return rule.expectations.length ? allExpectations(trial, rule.expectations, reviews) : undefined;
  const metrics = scenario?.metrics?.filter(m => m.subject === 'agent') ?? [];
  if (!metrics.length) return undefined;
  const results = metrics.flatMap(m => agentMetricResult(trial, m.id, reviews) ?? []);
  if (!results.length) return undefined;
  return results.includes('fail') ? 'fail' : results.every(r => r === 'pass') ? 'pass' : 'unknown';
}
export function isAgentFailure(record: Experiment, trial: Trial): boolean {
  const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
  return requiredCheckpointResult(scenario, trial) !== 'unknown' && measurementUsable(scenario, trial, record.humanReviews) && (requiredCheckpointResult(scenario, trial) === 'fail' || trial.outcome === 'fail'
    || agentRubricResult(scenario, trial, record.humanReviews) === 'fail');
}
/** A candidate cannot be accepted on a partially scored agent rubric; a rubric a human took out of the judgment is not waiting for a score. */
export function trialAssessmentComplete(scenario: Scenario, trial: Trial, reviews: HumanReview[] = []): boolean {
  const latest = latestHumanReviews({ trials: [trial], humanReviews: reviews });
  return measurementUsable(scenario, trial, reviews) && requiredCheckpointResult(scenario, trial) !== 'unknown' && (scenario.metrics ?? []).filter(m => m.subject === 'agent')
    .every(m => {
      const judged = humanOverride(latest.get(`${trial.id}|metric:${m.id}`), trial.assessments?.find(a => a.metricId === m.id)?.result);
      return judged.invalid || judged.result === 'pass' || judged.result === 'fail';
    });
}

/**
 * The simulated client's side of one attempt after human decisions: each code check on its replies
 * and each fidelity vote, as `humanOverride` leaves them. A target a human marked invalid no longer
 * counts against the measurement. Human decisions override interpretation, never the recorded check or judge response.
 */
export function simulatorVerdicts(scenario: Scenario | undefined, trial: Trial, reviews: HumanReview[] = []): { checks: boolean[]; fidelity: (Judged | undefined)[] } {
  const latest = latestHumanReviews({ trials: [trial], humanReviews: reviews });
  // From edition 3 a heuristic's suspicion is a note for review: only a person's word that the customer went astray
  // takes the attempt out (card/expectations.ts).
  const heuristicsDecide = editionOf(trial) < 3;
  const checks = (simulatorWasUsed(trial) ? trial.simulatorChecks ?? [] : []).map(c => {
    const review = latest.get(`${trial.id}|check:${c.id}`);
    const judged = humanOverride(review, c.passed || c.heuristic && !heuristicsDecide && !review ? 'pass' : 'fail');
    return judged.invalid || judged.result === 'pass';
  });
  const fidelity = (scenario?.metrics ?? []).filter(m => m.subject === 'simulator' && metricApplies(m, trial)).flatMap(m => {
    const judged = humanOverride(latest.get(`${trial.id}|metric:${m.id}`), trial.assessments?.find(a => a.metricId === m.id)?.result);
    return judged.invalid ? [] : [judged.result];
  });
  return { checks, fidelity };
}
export function simulatorUsable(scenario: Scenario | undefined, trial: Trial, reviews: HumanReview[] = []): boolean {
  const { checks, fidelity } = simulatorVerdicts(scenario, trial, reviews);
  return checks.every(Boolean) && fidelity.every(result => result === 'pass');
}
/** Shared eligibility for comparisons, CI and prompt proposals. Raw outcomes remain inspectable. */
export function measurementUsable(scenario: Scenario | undefined, trial: Trial, reviews: HumanReview[] = []): boolean {
  const latest = latestHumanReviews({ trials: [trial], humanReviews: reviews });
  return !!scenario && measured(trial) && !trial.assessmentError
    && latest.get(`${trial.id}|dialogue`)?.verdict !== 'invalid'
    && (!scenario.initialState.external || trial.observation?.resetConfirmed === true)
    && simulatorUsable(scenario, trial, reviews);
}
/** Combined automatic result for triage, never a replacement for the separate code and rubric scores. */
export function automaticTrialResult(scenario: Scenario | undefined, trial: Trial, reviews: HumanReview[] = []): 'pass' | 'fail' | 'unknown' {
  if (!scenario || !measurementUsable(scenario, trial, reviews)) return 'unknown';
  const rule = headlineRule(scenario, [trial]);
  if (rule.kind === 'expectations') return expectationsTrialResult(trial, rule.expectations, reviews);
  const checkpoint = requiredCheckpointResult(scenario, trial);
  if (checkpoint === 'fail') return 'fail';
  if (checkpoint === 'unknown') return 'unknown';
  const rubric = agentRubricResult(scenario, trial, reviews);
  if (trial.outcome === 'fail' || rubric === 'fail') return 'fail';
  return (!scenario.checks.length || trial.outcome === 'pass' || checkpoint === 'pass')
    && (rubric === 'pass' || (rubric === undefined && scenario.checks.length > 0)) ? 'pass' : 'unknown';
}

/**
 * The expectations a person found wrong themselves in the counted situations of a run, each once however many of its
 * attempts carry the mark: «ожиданий признано неверными: N», shown apart from the number they left.
 */
export function expectationsFoundWrong(record: Experiment): { scenarioId: string; expectationId: string }[] {
  const controls = new Set(record.positiveControlScenarioIds ?? []);
  return record.scenarios.filter(scenario => !controls.has(scenario.id)).flatMap(scenario => {
    const trials = record.trials.filter(trial => trial.scenarioId === scenario.id);
    const rule = headlineRule(scenario, trials);
    if (rule.kind !== 'expectations') return [];
    return rule.expectations.filter(expectation => trials.some(trial => expectationFoundWrong(trial, expectation.id, record.humanReviews)))
      .map(expectation => ({ scenarioId: scenario.id, expectationId: expectation.id }));
  });
}

export { GOAL_METRIC_ID, RULES_METRIC_ID } from './card/expectations.js';
/**
 * The counting rule of the headline on an old generated card: a situation is «справился» only when
 * the request was met and, where the card carries the prompt-rule check, no rule was broken. The
 * previous rule was `goal-v1` (goal only). Every quick mark was stamped with this name before cards
 * had their own rules (`countingRuleFor`); it is derived when a result is shown, never stored on a
 * run record. It lives here because the lab (lab/review.ts) needs it and must not import result-view.ts.
 */
export const COUNTING_RULES = 'goal-and-rules-v2';

/**
 * The goal and prompt-rule metrics an old generated card is counted by, goal first; [] for every
 * other card — a card counted by its expectations or by the strict legacy result. Reply quality
 * and the RAG rubrics are never returned: they keep their own rows and never move the number.
 */
export function headlineMetricIds(scenario: Scenario | undefined): string[] {
  const rule = headlineRule(scenario, []);
  return rule.kind === 'goal_rules' ? rule.ids : [];
}

/** The counting rule a quick mark on this attempt is stamped with. */
export function countingRuleFor(scenario: Scenario | undefined, trial: Trial): CountingRule {
  return countingRuleOf(scenario, headlineRule(scenario, [trial]));
}

/**
 * One attempt decided by the headline rule: unknown when the measurement is unusable, the strict
 * automatic result for a legacy card, else the headline metrics combined fail-first — any fail is
 * a fail, all pass is a pass, anything else is unknown. Reads recorded assessments with the
 * human verdicts applied as in agentMetricResult.
 */
export function headlineTrialResult(scenario: Scenario | undefined, trial: Trial, reviews: HumanReview[] = []): 'pass' | 'fail' | 'unknown' {
  if (!scenario || !measurementUsable(scenario, trial, reviews)) return 'unknown';
  const rule = headlineRule(scenario, [trial]);
  if (rule.kind === 'expectations') return expectationsTrialResult(trial, rule.expectations, reviews);
  const checkpoint = requiredCheckpointResult(scenario, trial);
  if (checkpoint === 'fail') return 'fail';
  if (checkpoint === 'unknown') return 'unknown';
  const ids = headlineMetricIds(scenario);
  if (!ids.length) return automaticTrialResult(scenario, trial, reviews);
  const results = ids.map(id => agentMetricResult(trial, id, reviews) ?? 'unknown');
  return results.includes('fail') ? 'fail' : results.every(r => r === 'pass') ? 'pass' : 'unknown';
}

/** The judge's own result for a metric. Never `agentMetricResult`: a human verdict must not move the baseline it is compared with. */
export function recordedResult(trial: Trial, metricId: string | undefined): 'pass' | 'fail' | 'unknown' | undefined {
  return metricId ? trial.assessments?.find(a => a.metricId === metricId)?.result : undefined;
}

/**
 * The judge's recorded verdict of the situation by the headline rule, and the metrics a one-key
 * agreement mark answers: the headline metrics whose recorded result equals that verdict, goal
 * first. A goal card is failed when any headline metric is recorded `fail` — a double failure has
 * two targets, a goal-only or rules-only failure one — and passed when every headline metric is
 * `pass` (two targets on a card with prompt rules); anything else is no decision, so undefined.
 * A card counted by its expectations is failed on its failed expectations and passed on all of
 * them (read through their evidence channels); a failed direct check leaves no judgment to answer.
 * A legacy card keeps today's single primary metric. Reads recorded assessments only: a human
 * verdict never moves what a mark is measured against.
 */
export function markTargets(scenario: Scenario | undefined, trial: Trial): { verdict: 'pass' | 'fail'; metricIds: string[] } | undefined {
  const rule = headlineRule(scenario, [trial]);
  if (rule.kind === 'expectations') {
    const results = rule.expectations.map(expectation => recordedExpectationResult(trial, expectation));
    if (results.includes('fail')) return { verdict: 'fail', metricIds: rule.ids.filter((_, i) => results[i] === 'fail') };
    return results.length && trial.outcome !== 'fail' && results.every(result => result === 'pass') ? { verdict: 'pass', metricIds: rule.ids } : undefined;
  }
  const ids = headlineMetricIds(scenario);
  if (!ids.length) {
    const id = primaryMetricId(scenario, trial);
    const result = recordedResult(trial, id);
    return id && (result === 'pass' || result === 'fail') ? { verdict: result, metricIds: [id] } : undefined;
  }
  const results = ids.map(id => recordedResult(trial, id));
  const verdict = results.includes('fail') ? 'fail' : results.every(r => r === 'pass') ? 'pass' : undefined;
  if (!verdict) return undefined;
  return { verdict, metricIds: ids.filter((_, i) => results[i] === verdict) };
}

/**
 * Whether a quick mark answers the question the counting rule of its attempt asks. On a card counted by
 * its expectations only a mark stamped with that rule, in its edition, does: edition 2 reads more of the judge's
 * failures as decided. On any older card a mark stamped with COUNTING_RULES or the card's own rule does — its
 * editions ask the same per-attempt question; an unstamped mark was given under the previous goal-only
 * rule and counts only where both rules ask the same thing: on a legacy strict card, or on a situation
 * whose only mark target is the goal. Anywhere else it is a mark under another rule and stays out of the count.
 */
export function markUnderCurrentRule(scenario: Scenario | undefined, trial: Trial, review: HumanReview, metricIds: string[]): boolean {
  const counting = headlineRule(scenario, [trial]);
  const rule = countingRuleOf(scenario, counting);
  if (counting.kind === 'expectations') return review.countingRules === rule;
  if (review.countingRules === COUNTING_RULES || review.countingRules === rule) return true;
  if (review.countingRules !== undefined) return false;
  return !headlineMetricIds(scenario).length || (metricIds.length === 1 && metricIds[0] === GOAL_METRIC_ID);
}
