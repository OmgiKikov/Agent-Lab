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

/**
 * Rubric outcomes stay separate from objective checks everywhere they are presented. A human
 * verdict on a criterion is authoritative — except a one-key «не могу сказать», which is doubt,
 * not a verdict: it leaves the judge's own result in place, so the owner's hesitation can never
 * quietly take a failure out of the headline. A full review that says `unknown` still overrides.
 */
export function agentMetricResult(trial: Trial, metricId: string, reviews: HumanReview[] = []): 'pass' | 'fail' | 'unknown' | undefined {
  const human = latestHumanReviews({ trials: [trial], humanReviews: reviews }).get(`${trial.id}|metric:${metricId}`);
  const recorded = trial.assessments?.find(a => a.metricId === metricId)?.result;
  if (human?.source === 'quick' && human.verdict === 'unknown') return recorded;
  return human?.verdict === 'invalid' ? undefined : human?.verdict ?? recorded;
}

export function agentRubricResult(scenario: Scenario | undefined, trial: Trial, reviews: HumanReview[] = []): 'pass' | 'fail' | 'unknown' | undefined {
  const metrics = scenario?.metrics?.filter(m => m.subject === 'agent') ?? [];
  if (!metrics.length) return undefined;
  const results = metrics.flatMap(m => agentMetricResult(trial, m.id, reviews) ?? []);
  if (!results.length) return undefined;
  return results.includes('fail') ? 'fail' : results.every(r => r === 'pass') ? 'pass' : 'unknown';
}
export function isAgentFailure(record: Experiment, trial: Trial): boolean {
  const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
  return measurementUsable(scenario, trial, record.humanReviews) && (trial.outcome === 'fail'
    || agentRubricResult(scenario, trial, record.humanReviews) === 'fail');
}
/** A candidate cannot be accepted on a partially scored agent rubric. A quick «не могу сказать» is skipped here too: the judge's recorded result still decides. */
export function trialAssessmentComplete(scenario: Scenario, trial: Trial, reviews: HumanReview[] = []): boolean {
  const latest = latestHumanReviews({ trials: [trial], humanReviews: reviews });
  return measurementUsable(scenario, trial, reviews) && (scenario.metrics ?? []).filter(m => m.subject === 'agent')
    .every(m => { const human = latest.get(`${trial.id}|metric:${m.id}`);
      if (human && !(human.source === 'quick' && human.verdict === 'unknown')) return human.verdict !== 'unknown';
      const result = trial.assessments?.find(a => a.metricId === m.id)?.result;
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

/** The agent metric the headline reads first: whether the client's request was carried out. */
export const GOAL_METRIC_ID = 'goal_attainment';
/** The agent metric that says whether the agent kept the observable rules of its own prompt. */
export const RULES_METRIC_ID = 'prompt_compliance';
/**
 * The counting rule of the headline: a situation is «справился» only when the request was met
 * and, where the card carries the prompt-rule check, no rule was broken. The previous rule was
 * `goal-v1` (goal only). It is derived when a result is shown and stamped by the lab on quick
 * marks (03.1-02), never stored on a run record: every stored run is recounted by the current
 * rule. It lives here because experiment.ts needs it and must not import result-view.ts.
 */
export const COUNTING_RULES = 'goal-and-rules-v2';

/**
 * The agent metrics the headline counts for this card, goal first: [] for a legacy card without
 * the goal rubric (the strict card outcome decides it), [GOAL_METRIC_ID, RULES_METRIC_ID] when the
 * card also carries the prompt-rule check, else [GOAL_METRIC_ID]. Reply quality and the RAG
 * rubrics are never returned: they keep their own rows and never move the number.
 */
export function headlineMetricIds(scenario: Scenario | undefined): string[] {
  const agent = (scenario?.metrics ?? []).filter(m => m.subject === 'agent').map(m => m.id);
  if (!agent.includes(GOAL_METRIC_ID)) return [];
  return agent.includes(RULES_METRIC_ID) ? [GOAL_METRIC_ID, RULES_METRIC_ID] : [GOAL_METRIC_ID];
}

/**
 * One attempt decided by the headline rule: unknown when the measurement is unusable, the strict
 * automatic result for a legacy card, else the headline metrics combined fail-first — any fail is
 * a fail, all pass is a pass, anything else is unknown. Reads recorded assessments with the
 * human verdicts applied as in agentMetricResult.
 */
export function headlineTrialResult(scenario: Scenario | undefined, trial: Trial, reviews: HumanReview[] = []): 'pass' | 'fail' | 'unknown' {
  if (!scenario || !measurementUsable(scenario, trial, reviews)) return 'unknown';
  const ids = headlineMetricIds(scenario);
  if (!ids.length) return automaticTrialResult(scenario, trial, reviews);
  const results = ids.map(id => agentMetricResult(trial, id, reviews) ?? 'unknown');
  return results.includes('fail') ? 'fail' : results.every(r => r === 'pass') ? 'pass' : 'unknown';
}
