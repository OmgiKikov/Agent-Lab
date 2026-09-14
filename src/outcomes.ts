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
export function latestHumanReviews(record: Experiment): Map<string, HumanReview> {
  const latest = new Map<string, HumanReview>();
  const trials = new Set(record.trials.map(t => t.id));
  for (const review of [...record.humanReviews].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (!trials.has(review.trialId)) continue;
    latest.set(`${review.trialId}|${review.metricId ? `metric:${review.metricId}` : review.checkId ? `check:${review.checkId}` : 'dialogue'}`, review);
  }
  return latest;
}

/** Rubric outcomes stay separate from objective checks everywhere they are presented. */
export function agentRubricResult(scenario: Scenario | undefined, trial: Trial): 'pass' | 'fail' | 'unknown' | undefined {
  const metrics = scenario?.metrics?.filter(m => m.subject === 'agent') ?? [];
  if (!metrics.length) return undefined;
  const results = metrics.map(m => trial.assessments?.find(a => a.metricId === m.id)?.result);
  return results.includes('fail') ? 'fail' : results.every(r => r === 'pass') ? 'pass' : 'unknown';
}
export function isAgentFailure(record: Experiment, trial: Trial): boolean {
  return !['invalid', 'cancelled'].includes(trial.outcome) && (trial.outcome === 'fail'
    || agentRubricResult(record.scenarios.find(s => s.id === trial.scenarioId), trial) === 'fail');
}
/** A candidate cannot be accepted on a partially scored agent rubric. */
export function trialAssessmentComplete(scenario: Scenario, trial: Trial): boolean {
  const simulated = simulatorWasUsed(trial);
  return !trial.assessmentError && (scenario.metrics ?? []).filter(m => m.subject === 'agent' || simulated)
    .every(m => { const result = trial.assessments?.find(a => a.metricId === m.id)?.result;
      return m.subject === 'simulator' ? result === 'pass' : result === 'pass' || result === 'fail'; });
}
/** The simulator rubric must have passed wherever it applied; otherwise the agent verdict of that dialogue is not usable. */
export function simulatorUsable(scenario: Scenario | undefined, trial: Trial): boolean {
  return !scenario?.metrics?.some(m => m.subject === 'simulator'
    && metricApplies(m, trial)
    && trial.assessments?.find(a => a.metricId === m.id)?.result !== 'pass');
}
/** Combined automatic result for triage, never a replacement for the separate code and rubric scores. */
export function automaticTrialResult(scenario: Scenario | undefined, trial: Trial): 'pass' | 'fail' | 'unknown' {
  if (!scenario || !measured(trial) || trial.assessmentError || !simulatorUsable(scenario, trial)) return 'unknown';
  const rubric = agentRubricResult(scenario, trial);
  if (trial.outcome === 'fail' || rubric === 'fail') return 'fail';
  return (!scenario.checks.length || trial.outcome === 'pass')
    && (rubric === 'pass' || (rubric === undefined && scenario.checks.length > 0)) ? 'pass' : 'unknown';
}
