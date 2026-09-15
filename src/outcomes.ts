import { metricApplies, simulatorWasUsed, type Experiment, type HumanReview, type Scenario, type Trial } from './contracts.js';

/*
 * Outcome helpers shared by comparison.ts (verdict, evidence, run delta) and simulator.ts
 * (scorecard, mode value). Nothing here performs I/O; nothing here depends on either consumer,
 * so both can import it without a cycle.
 */
export const runningPhases = new Set(['preparing', 'evaluating', 'baseline', 'improving', 'control']);
export const mean = (values: number[]): number | null => values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
export const graded = (trial: Trial) => trial.outcome === 'pass' || trial.outcome === 'fail';
export const measured = (trial: Trial) => graded(trial) || trial.outcome === 'ungraded';

/** Legacy optimization runs contain several agents; their headline describes only the selected version. */
export function observedRecord(record: Experiment): Experiment {
  if (record.workflow !== 'compare') return record;
  const split = record.controlConsumedAt && !runningPhases.has(record.phase) ? 'control' : 'dev';
  const selected = record.selectedRevisionId ?? record.revisions[0]?.id;
  const trials = record.trials.filter(t => t.revisionId === selected && t.split === split);
  const ids = new Set(trials.map(t => t.id));
  return { ...record, trials, scenarios: record.scenarios.filter(s => s.split === split), humanReviews: record.humanReviews.filter(r => ids.has(r.trialId)) };
}

/** The latest human verdict per review target (whole dialogue, one metric or one check); earlier verdicts on the same target are superseded. */
export function latestHumanReviews(record: Pick<Experiment, 'trials' | 'humanReviews'>): Map<string, HumanReview> {
  const latest = new Map<string, HumanReview>();
  const trials = new Set(record.trials.map(t => t.id));
  for (const review of [...record.humanReviews].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (!trials.has(review.trialId)) continue;
    latest.set(`${review.trialId}|${review.metricId ? `metric:${review.metricId}` : review.checkId ? `check:${review.checkId}` : 'dialogue'}`, review);
  }
  return latest;
}

/** Rubric outcomes stay separate from objective checks everywhere they are presented. A human verdict on a criterion is authoritative. */
export function agentRubricResult(scenario: Scenario | undefined, trial: Trial, reviews: HumanReview[] = []): 'pass' | 'fail' | 'unknown' | undefined {
  const metrics = scenario?.metrics?.filter(m => m.subject === 'agent') ?? [];
  if (!metrics.length) return undefined;
  const latest = latestHumanReviews({ trials: [trial], humanReviews: reviews });
  const results = metrics.flatMap(m => {
    const human = latest.get(`${trial.id}|metric:${m.id}`)?.verdict;
    return human === 'invalid' ? [] : [human ?? trial.assessments?.find(a => a.metricId === m.id)?.result];
  });
  if (!results.length) return undefined;
  return results.includes('fail') ? 'fail' : results.every(r => r === 'pass') ? 'pass' : 'unknown';
}
export function isAgentFailure(record: Experiment, trial: Trial): boolean {
  const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
  return measurementUsable(scenario, trial, record.humanReviews) && (trial.outcome === 'fail'
    || agentRubricResult(scenario, trial, record.humanReviews) === 'fail');
}
/** A candidate cannot be accepted on a partially scored agent rubric. */
export function trialAssessmentComplete(scenario: Scenario, trial: Trial, reviews: HumanReview[] = []): boolean {
  return measurementUsable(scenario, trial, reviews) && (scenario.metrics ?? []).filter(m => m.subject === 'agent')
    .every(m => { const result = trial.assessments?.find(a => a.metricId === m.id)?.result;
      return result === 'pass' || result === 'fail'; });
}
/** Human decisions override interpretation, never the recorded check or judge response. */
export function simulatorUsable(scenario: Scenario | undefined, trial: Trial, reviews: HumanReview[] = []): boolean {
  const latest = latestHumanReviews({ trials: [trial], humanReviews: reviews });
  return (simulatorWasUsed(trial) ? trial.simulatorChecks ?? [] : []).every(c => {
    const review = latest.get(`${trial.id}|check:${c.id}`);
    return review?.verdict === 'invalid' || (review ? review.verdict === 'pass' : c.passed);
  }) && (scenario?.metrics ?? []).filter(m => m.subject === 'simulator' && metricApplies(m, trial)).every(m => {
    const review = latest.get(`${trial.id}|metric:${m.id}`);
    return review?.verdict === 'invalid' || (review?.verdict ?? trial.assessments?.find(a => a.metricId === m.id)?.result) === 'pass';
  });
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
  const rubric = agentRubricResult(scenario, trial, reviews);
  if (trial.outcome === 'fail' || rubric === 'fail') return 'fail';
  return (!scenario.checks.length || trial.outcome === 'pass')
    && (rubric === 'pass' || (rubric === undefined && scenario.checks.length > 0)) ? 'pass' : 'unknown';
}
