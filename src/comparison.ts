import { GOAL_UNSUPPORTED_RATIONALE, hasCompleteJudgment, observableSources, SPLIT_RATIONALE_PREFIX } from './judge.js';
import { agentIdentity, judgeSettingsIdentity, normalizeScenarioIdentity } from './normalize.js';
import { fingerprint, metricApplies, simulatorWasUsed, type Comparison, type Experiment, type HumanReview, type Scenario, type SourceIdentity, type Tier, type Trial, type UserMode } from './contracts.js';
import { agentMetricResult, agentRubricResult, automaticTrialResult, GOAL_METRIC_ID, graded, headlineMetricIds, headlineTrialResult, isAgentFailure, latestHumanReviews, markTargets, markUnderCurrentRule, measured, measurementUsable, observedRecord, RULES_METRIC_ID, runningPhases, simulatorUsable, trialAssessmentComplete } from './outcomes.js';
import { judgeAgreement } from './agreement.js';
export { observedRecord, agentRubricResult, isAgentFailure, trialAssessmentComplete, automaticTrialResult } from './outcomes.js';

/*
 * Pure statistics over persisted records. Nothing here performs I/O or model calls,
 * so every number shown in Pi, the CLI or an export comes from one place.
 *
 *   compareTrials      trials ──pair by (scenario, repeat)──► family deltas ──► delta · bootstrap interval · sign test
 *   evidenceSummary    the product verdict and any persisted candidate comparison
 */
function clusterInterval(values: number[], seed: string): [number, number] | null {
  if (values.length < 2) return null;
  let state = 2166136261;
  for (const c of seed) state = Math.imul(state ^ c.charCodeAt(0), 16777619) >>> 0;
  state ||= 1;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  const means: number[] = [];
  for (let i = 0; i < 4000; i += 1) {
    let sum = 0;
    for (let j = 0; j < values.length; j += 1) sum += values[Math.floor(random() * values.length)]!;
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return [means[99]!, means[3899]!];
}

export function compareTrials(input: {
  baselineId: string; candidateId: string; manifestHash: string; scenarios: Scenario[]; repeats: number;
  trials: Trial[]; split: 'dev' | 'control'; mode: 'demo' | 'live';
}): Comparison {
  const { baselineId, candidateId, manifestHash, repeats, split } = input;
  const scenarios = input.scenarios.filter(s => s.split === split);
  const validRepeats = Number.isInteger(repeats) && repeats >= 1 && repeats <= 5;
  const result: Comparison = {
    baselineId, candidateId, manifestHash, split, plannedPairs: validRepeats ? scenarios.length * repeats : 0, validPairs: 0,
    invalidPairs: 0, families: 0, baselinePasses: 0, candidatePasses: 0, fixed: 0, regressed: 0, tied: 0,
    delta: null, interval: null, verdict: 'insufficient', reasons: [], cases: [],
  };
  if (!validRepeats) return { ...result, verdict: 'incomparable', reasons: ['Repeats must be an integer from 1 to 5.'] };
  const relevant = input.trials.filter(t => (t.revisionId === baselineId || t.revisionId === candidateId) && t.split === split);
  const scenarioMap = new Map(scenarios.map(s => [s.id, s]));
  const initialStates = new Map(scenarios.map(s => [s.id, fingerprint(s.initialState)]));
  const seenTrialIds = new Set<string>();
  const trialMap = new Map<string, Trial[]>();
  let incompatible = scenarios.length !== scenarioMap.size;
  if (incompatible) result.reasons.push('Invalid or duplicate planned cases/repeats');
  for (const trial of relevant) {
    const scenario = scenarioMap.get(trial.scenarioId);
    if (seenTrialIds.has(trial.id)) incompatible = true;
    seenTrialIds.add(trial.id);
    if (!scenario || trial.familyId !== scenario.familyId || trial.manifestHash !== manifestHash || fingerprint(trial.initialState) !== initialStates.get(trial.scenarioId)
      || !Number.isInteger(trial.repeat) || trial.repeat < 0 || trial.repeat >= repeats) {
      incompatible = true;
      continue;
    }
    const key = `${trial.revisionId}:${trial.scenarioId}:${trial.repeat}`;
    const trials = trialMap.get(key) ?? [];
    trials.push(trial);
    trialMap.set(key, trials);
    if (trials.length > 1) incompatible = true;
  }
  if (incompatible) result.reasons.push('Reused/duplicate trials, unknown cases, or mismatched manifest/family/initial-state/repeat prevent a comparable experiment');
  const families = new Map<string, number[]>();
  for (const scenario of scenarios) {
    const row = { scenarioId: scenario.id, baselinePasses: 0, candidatePasses: 0, repeats };
    const deltas: number[] = [];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const base = trialMap.get(`${baselineId}:${scenario.id}:${repeat}`);
      const candidate = trialMap.get(`${candidateId}:${scenario.id}:${repeat}`);
      if (base?.length !== 1 || candidate?.length !== 1) continue;
      if (!trialAssessmentComplete(scenario, base[0]!) || !trialAssessmentComplete(scenario, candidate[0]!)) continue;
      const was = automaticTrialResult(scenario, base[0]!);
      const now = automaticTrialResult(scenario, candidate[0]!);
      if (was === 'unknown' || now === 'unknown') continue;
      const a = Number(was === 'pass');
      const b = Number(now === 'pass');
      result.validPairs += 1;
      result.baselinePasses += a;
      result.candidatePasses += b;
      row.baselinePasses += a;
      row.candidatePasses += b;
      if (b > a) result.fixed += 1;
      else if (b < a) result.regressed += 1;
      else result.tied += 1;
      deltas.push(b - a);
    }
    result.cases.push(row);
    if (deltas.length > 0) {
      const group = families.get(scenario.familyId) ?? [];
      group.push(deltas.reduce((sum, d) => sum + d, 0) / deltas.length);
      families.set(scenario.familyId, group);
    }
  }
  result.invalidPairs = result.plannedPairs - result.validPairs;
  const familyDeltas = [...families.values()].map(values => values.reduce((sum, v) => sum + v, 0) / values.length);
  result.families = familyDeltas.length;
  const positiveFamilies = familyDeltas.filter(delta => delta > 0).length;
  // With no regressions, the two-sided paired sign test has p = 2 / 2^positiveFamilies.
  const signP = positiveFamilies ? Math.min(1, 2 ** (1 - positiveFamilies)) : 1;
  if (familyDeltas.length) {
    result.delta = familyDeltas.reduce((sum, d) => sum + d, 0) / familyDeltas.length;
    result.interval = clusterInterval(familyDeltas, manifestHash);
  }
  result.reasons.push('Delta weights scenario families equally; 95% percentile interval resamples whole families. Repeats do not create independent families.');
  if (input.mode === 'demo') result.reasons.push('Scripted offline demonstration: observed repairs do not establish model quality or real-user performance.');
  else result.reasons.push('Synthetic user evidence does not establish performance with real users.');
  if (incompatible) result.verdict = 'incomparable';
  else if (result.invalidPairs > 0 || result.plannedPairs === 0) {
    result.verdict = 'insufficient';
    result.reasons.push(`${result.invalidPairs} planned pair(s) are missing, invalid, or cancelled; positive improvement claims are blocked.`);
  } else if (result.regressed > 0) {
    result.verdict = 'regressed';
    result.reasons.push('At least one previously passing trial now fails; conservative selection rejects this revision.');
  } else if (result.fixed === 0) result.verdict = 'no_change';
  else if (split === 'dev' || input.mode === 'demo' || result.families < 8 || signP > 0.05 || !result.interval || result.interval[0] <= 0) {
    result.verdict = 'insufficient';
    result.reasons.push('Observed fixes are descriptive; confirmation requires final control evaluation in live mode, at least eight independent families, a positive interval lower bound, and a two-sided paired sign-test p ≤ 0.05.');
    if (split === 'dev') result.reasons.push('Development data guides candidate selection; its uncertainty estimates are descriptive and cannot confirm an improvement independently.');
  } else {
    result.verdict = 'improved';
    result.reasons.push(`The no-regression family sign test has two-sided p = ${signP.toPrecision(3)} (ties excluded). This assumes independent case families.`);
  }
  return result;
}

function rubricReviewNote(scenario: Scenario | undefined, before: Trial, after: Trial): string | undefined {
  const replies = before.events.filter(e => e.type === 'assistant').map(e => e.text);
  const flipped = scenario?.metrics?.some(m => m.subject === 'agent'
    && before.assessments?.some(a => a.metricId === m.id && a.result !== 'unknown'
      && after.assessments?.some(b => b.metricId === m.id && b.result !== 'unknown' && b.result !== a.result)));
  return flipped && replies.length && fingerprint(replies) === fingerprint(after.events.filter(e => e.type === 'assistant').map(e => e.text))
    ? 'Ответы агента совпали, оценки по рубрикам различаются. Проверьте запросы пользователя, действия и критерии: рост оценки сам по себе не доказывает улучшение агента.' : undefined;
}
export interface VerdictNote { code: string; text: string; count?: number; detail?: string }
export interface HumanFinding {
  trialId: string; reviewId: string; target: string; subject: 'agent' | 'simulator' | 'check' | 'test';
  verdict: 'pass' | 'fail' | 'invalid'; automatic: 'pass' | 'fail' | 'unknown'; disagreement: boolean; note: string;
}
export interface RepeatResult {
  scenarioId: string; title: string; userMode: UserMode; planned: number; passed: number; failed: number; unknown: number;
  status: 'single' | 'mixed' | 'all_pass' | 'all_fail' | 'incomplete'; trialIds: string[];
}
export function humanFindingText(finding: HumanFinding): string {
  const label = { pass: 'пройдено', fail: 'не пройдено', unknown: 'неясно', invalid: 'невалидный тест' };
  return `${finding.subject === 'test' ? 'Тест' : finding.subject === 'simulator' ? 'Симулятор' : finding.subject === 'check' ? 'Кодовая проверка' : 'Агент'} · ${finding.target}: человек — ${label[finding.verdict]}, автоматически — ${label[finding.automatic]}.${finding.disagreement ? ' Расхождение оценок.' : ''} ${finding.note}`;
}
export function repeatResultText(row: RepeatResult): string {
  const label = { single: 'одна попытка', mixed: 'разные результаты', all_pass: 'все повторы пройдены', all_fail: 'все повторы провалены', incomplete: 'неполные данные' };
  return `${row.title} · ${row.userMode}: ${row.passed}/${row.planned} пройдено, ${row.failed} провалов, ${row.unknown} без оценки — ${label[row.status]}.`;
}
export interface VerdictSummary {
  headline: string; passed: number; graded: number; invalid: number; passRate: number | null;
  execution: { planned: number; completed: number; invalid: number; cancelled: number; missing: number; running: boolean };
  /** reviewed counts resolved whole-dialogue classifications, including invalid tests. */
  review: { status: 'not_started' | 'pending' | 'complete'; pending: number; reviewed: number; total: number;
    passed: number; failed: number; invalid: number; flagged: number; disagreements: number; findings: HumanFinding[] };
  repeats: RepeatResult[];
  /** Model rubric estimates over every completed dialogue, including those without objective checks. Unverified until humans agree. */
  rubric: { assessed: number; passed: number; failed: number; unknown: number };
  /** Completed dialogues where the model flagged the simulated user as breaking role. */
  simulatorFlagged: number;
  provenance: Record<Scenario['provenance'], { cards: number; passed: number; graded: number }>;
  /** Per job of the agent: which link of the chain broke, not just whether the chain broke. */
  stages: { stage: string; passed: number; evaluated: number }[];
  /** Per rung: smoke must never fail, regression must not get worse, frontier is where failures teach. */
  tiers: { tier: Tier; cards: number; passed: number; graded: number }[];
  weakSpots: { kind: 'check' | 'metric'; description: string; failures: number; stage?: string }[];
  confidenceReasons: VerdictNote[]; nextSteps: VerdictNote[];
}
/** Human reports and disagreements remain visible even when every automatic score is green. */
export function humanFindings(record: Experiment): HumanFinding[] {
  record = observedRecord(record);
  return [...latestHumanReviews(record).values()].flatMap(review => {
    const trial = record.trials.find(t => t.id === review.trialId);
    if (!trial || !['pass', 'fail', 'invalid'].includes(review.verdict)) return [];
    const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
    const metric = scenario?.metrics?.find(m => m.id === review.metricId);
    const simulatorCheck = trial.simulatorChecks?.find(c => c.id === review.checkId);
    const check = simulatorCheck ?? trial.checks.find(c => c.id === review.checkId);
    const automatic = !measured(trial) ? 'unknown' : review.metricId ? trial.assessments?.find(a => a.metricId === review.metricId)?.result ?? 'unknown'
      : review.checkId ? check ? check.passed ? 'pass' : 'fail' : 'unknown' : automaticTrialResult(scenario, trial, record.humanReviews);
    const disagreement = automatic !== 'unknown' && review.verdict !== automatic;
    // Confirming the judge is not a remark of the owner: a one-key «согласен» with a failure says
    // the failure is real, so reporting it back as «замечание человека» would double-count it.
    if (review.source === 'quick' && !disagreement) return [];
    if (review.verdict !== 'fail' && review.verdict !== 'invalid' && !disagreement) return [];
    return [{ trialId: trial.id, reviewId: review.id, target: metric?.name ?? check?.description ?? review.metricId ?? review.checkId ?? 'Весь диалог',
      subject: simulatorCheck ? 'simulator' : review.verdict === 'invalid' ? 'test' : review.checkId ? 'check' : metric?.subject ?? 'agent', verdict: review.verdict as 'pass' | 'fail' | 'invalid', automatic, disagreement, note: review.note }];
  });
}
/** Observed repeats of the same card and user mode; no independence or future-success probability is inferred. */
export function repeatResults(record: Experiment): RepeatResult[] {
  record = observedRecord(record);
  return record.scenarios.flatMap(scenario => record.settings.userModes.filter(mode => mode !== 'scripted' || scenario.user.script !== undefined).map(userMode => {
    const trials = record.trials.filter(t => t.scenarioId === scenario.id && t.userMode === userMode);
    const outcomes = Array.from({ length: record.settings.repeats }, (_, repeat) => {
      const matches = trials.filter(t => t.repeat === repeat);
      return matches.length === 1 ? automaticTrialResult(scenario, matches[0]!, record.humanReviews) : 'unknown';
    });
    const passed = outcomes.filter(o => o === 'pass').length;
    const failed = outcomes.filter(o => o === 'fail').length;
    const unknown = outcomes.length - passed - failed;
    const incompatible = runCompleteness({ ...record, scenarios: [scenario], trials, settings: { ...record.settings, userModes: [userMode] } }, true).length > 0;
    const status = unknown || incompatible ? 'incomplete' : outcomes.length === 1 ? 'single' : passed && failed ? 'mixed' : failed ? 'all_fail' : 'all_pass';
    return { scenarioId: scenario.id, title: scenario.title, userMode, planned: outcomes.length, passed, failed, unknown, status, trialIds: trials.map(t => t.id) };
  }));
}
/** A label on a passing or simulator criterion does not resolve an agent's failed criteria. */
export function awaitingVerdict(record: Experiment): Set<string> {
  record = observedRecord(record);
  const latest = latestHumanReviews(record);
  const decided = (key: string) => ['pass', 'fail'].includes(latest.get(key)?.verdict ?? '');
  return new Set(record.trials.filter(trial => {
    if (latest.get(`${trial.id}|dialogue`)?.verdict === 'invalid') return false;
    {
      const pending = [
        ...(simulatorWasUsed(trial) ? trial.simulatorChecks ?? [] : []).filter(c => !c.passed).map(c => `check:${c.id}`),
        ...(record.scenarios.find(s => s.id === trial.scenarioId)?.metrics ?? [])
          .filter(m => m.subject === 'simulator' && metricApplies(m, trial) && trial.assessments?.find(a => a.metricId === m.id)?.result !== 'pass').map(m => `metric:${m.id}`),
      ];
      if (pending.some(key => !['pass', 'fail', 'invalid'].includes(latest.get(`${trial.id}|${key}`)?.verdict ?? ''))) return true;
    }
    // Quick marks close a situation only when every metric that decided it is answered (CTX-18);
    // on a goal card other rubrics and objective checks are not part of the headline. Doubt
    // («не могу сказать») is not a decision, and a phase-3 mark on a two-target situation answered
    // the previous rule, so either leaves the judge's own failure in the queue. The simulator is
    // judged above, separately.
    {
      const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
      const targets = markTargets(scenario, trial);
      const quickClosed = !!targets && targets.metricIds.every(id => {
        const mark = latest.get(`${trial.id}|metric:${id}`);
        return mark?.source === 'quick' && ['pass', 'fail'].includes(mark.verdict) && markUnderCurrentRule(scenario, mark, targets.metricIds);
      });
      if (quickClosed) {
        if (headlineMetricIds(scenario).length) return false;
        // A legacy strict card: every other agent rubric the judge failed is part of its headline and still needs a decision.
        return (scenario?.metrics ?? []).some(m => m.subject === 'agent' && !targets.metricIds.includes(m.id)
          && trial.assessments?.some(a => a.metricId === m.id && a.result === 'fail') && !decided(`${trial.id}|metric:${m.id}`));
      }
    }
    if (!isAgentFailure(record, trial) || decided(`${trial.id}|dialogue`) || latest.get(`${trial.id}|dialogue`)?.verdict === 'invalid') return false;
    const failed = [
      ...trial.checks.filter(c => !c.passed).map(c => `check:${c.id}`),
      ...(record.scenarios.find(s => s.id === trial.scenarioId)?.metrics ?? [])
        .filter(m => m.subject === 'agent' && trial.assessments?.some(a => a.metricId === m.id && a.result === 'fail'))
        .map(m => `metric:${m.id}`),
    ];
    return !failed.length || failed.some(key => !decided(`${trial.id}|${key}`));
  }).map(t => t.id));
}

const MIN_GRADED = 5;
const TRUSTED_SAMPLE = 30;
export function verdictSummary(record: Experiment): VerdictSummary {
  record = observedRecord(record);
  const gradedTrials = record.trials.filter(graded);
  const passed = gradedTrials.filter(t => t.outcome === 'pass').length;
  const invalid = record.trials.filter(t => t.outcome === 'invalid').length;
  const gradedCount = gradedTrials.length;
  const provenance: VerdictSummary['provenance'] = { synthetic: { cards: 0, passed: 0, graded: 0 }, curated: { cards: 0, passed: 0, graded: 0 }, production: { cards: 0, passed: 0, graded: 0 } };
  for (const scenario of record.scenarios) provenance[scenario.provenance].cards += 1;
  for (const trial of gradedTrials) {
    const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
    if (!scenario) continue;
    provenance[scenario.provenance].graded += 1;
    if (trial.outcome === 'pass') provenance[scenario.provenance].passed += 1;
  }
  const tiers: VerdictSummary['tiers'] = (['smoke', 'regression', 'frontier'] as const)
    .map(tier => ({ tier, cards: record.scenarios.filter(s => s.tier === tier).length, passed: 0, graded: 0 }));
  const tierOf = (scenarioId: string) => record.scenarios.find(s => s.id === scenarioId)?.tier ?? 'regression';
  for (const trial of gradedTrials) {
    const row = tiers.find(t => t.tier === tierOf(trial.scenarioId))!;
    row.graded += 1;
    if (trial.outcome === 'pass') row.passed += 1;
  }
  // A smoke card is the floor of the product: if it fails, nothing above it is worth reading yet.
  const smokeFailures = record.trials.filter(t => isAgentFailure(record, t) && tierOf(t.scenarioId) === 'smoke').length;

  // Per stage: every criterion that named a job of the agent, counted where it was evaluated.
  const stageTally = new Map<string, { passed: number; evaluated: number }>();
  const countStage = (stage: string | undefined, ok: boolean) => {
    if (!stage) return;
    const row = stageTally.get(stage) ?? { passed: 0, evaluated: 0 };
    row.evaluated += 1;
    if (ok) row.passed += 1;
    stageTally.set(stage, row);
  };
  for (const trial of record.trials) {
    const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
    if (!scenario) continue;
    for (const result of trial.checks) countStage(scenario.checks.find(c => c.id === result.id)?.stage, result.passed);
    for (const metric of (scenario.metrics ?? []).filter(m => m.subject === 'agent')) {
      const result = agentMetricResult(trial, metric.id, record.humanReviews);
      if (result === 'pass' || result === 'fail') countStage(metric.stage, result === 'pass');
    }
  }
  const stages = [...stageTally.entries()].map(([stage, row]) => ({ stage, ...row }))
    .sort((a, b) => (a.passed / a.evaluated) - (b.passed / b.evaluated) || a.stage.localeCompare(b.stage));

  // Rubric estimates cover every completed dialogue, including those without objective checks. They are model estimates, never verified results.
  const completed = record.trials.filter(t => graded(t) || t.outcome === 'ungraded');
  const checkFailures = new Map<string, number>();
  const metricFailures = new Map<string, number>();
  const rubric = { assessed: 0, passed: 0, failed: 0, unknown: 0 };
  const failureStage = new Map<string, string>();
  let simulatorFlagged = 0;
  for (const trial of completed) {
    const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
    for (const check of trial.checks) if (!check.passed) {
      checkFailures.set(check.description, (checkFailures.get(check.description) ?? 0) + 1);
      const at = scenario?.checks.find(c => c.id === check.id)?.stage;
      if (at) failureStage.set(check.description, at);
    }
    if (scenario?.metrics?.some(m => m.subject === 'agent')) {
      rubric.assessed += 1;
      if (agentRubricResult(scenario, trial, record.humanReviews) === 'fail') rubric.failed += 1;
      else if (agentRubricResult(scenario, trial, record.humanReviews) !== 'pass') rubric.unknown += 1;
      else rubric.passed += 1;
    }
    if (!simulatorUsable(scenario, trial, record.humanReviews)) simulatorFlagged += 1;
    for (const metric of (scenario?.metrics ?? []).filter(m => m.subject === 'agent')) if (agentMetricResult(trial, metric.id, record.humanReviews) === 'fail') {
      const name = metric.name;
      metricFailures.set(name, (metricFailures.get(name) ?? 0) + 1);
      if (metric.stage) failureStage.set(name, metric.stage);
    }
  }
  const weakSpots = [
    ...[...checkFailures].map(([description, failures]) => ({ kind: 'check' as const, description, failures })),
    ...[...metricFailures].map(([description, failures]) => ({ kind: 'metric' as const, description, failures })),
  ].map((spot): VerdictSummary['weakSpots'][number] => {
    const at = failureStage.get(spot.description);
    return at ? { ...spot, stage: at } : spot;
  }).sort((a, b) => b.failures - a.failures).slice(0, 3);
  const allSynthetic = provenance.curated.cards + provenance.production.cards === 0;
  const humanVerdicts = record.humanReviews.length > 0;
  // Only the latest verdict per target counts, and only pass/fail decides anything; unknown and invalid record that a person looked and could not confirm the result.
  const decisive = (r: HumanReview) => r.verdict === 'pass' || r.verdict === 'fail';
  const current = [...latestHumanReviews(record).values()];
  const decisiveVerdicts = current.some(decisive);
  const finalized = !!record.resultsReviewedAt;
  // A failed dialogue is one that failed objectively or by the agent rubrics; every one of them needs a decisive human verdict before the result is trusted.
  const failedTrials = completed.filter(t => isAgentFailure(record, t));
  const pending = awaitingVerdict(record);
  const attempted = new Set(record.trials.map(attemptKey));
  const expected = expectedAttempts(record);
  const execution: VerdictSummary['execution'] = {
    planned: plannedTrials(record), completed: completed.length, invalid,
    cancelled: record.trials.filter(t => t.outcome === 'cancelled').length,
    missing: [...expected].filter(key => !attempted.has(key)).length,
    running: runningPhases.has(record.phase),
  };
  const review: VerdictSummary['review'] = {
    status: !record.trials.length ? 'not_started' : finalized && pending.size === 0 ? 'complete' : 'pending',
    pending: pending.size,
    reviewed: record.trials.filter(t => current.some(r => r.trialId === t.id && !r.metricId && !r.checkId && (decisive(r) || r.verdict === 'invalid'))).length,
    total: record.trials.length,
    passed: current.filter(r => !r.metricId && !r.checkId && r.verdict === 'pass').length,
    failed: current.filter(r => !r.metricId && !r.checkId && r.verdict === 'fail').length,
    invalid: current.filter(r => !r.metricId && !r.checkId && r.verdict === 'invalid').length,
    findings: humanFindings(record), flagged: 0, disagreements: 0,
  };
  review.flagged = new Set(review.findings.filter(f => f.verdict === 'fail').map(f => f.trialId)).size;
  review.disagreements = review.findings.filter(f => f.disagreement).length;
  const repeats = repeatResults(record);
  const mixed = repeats.filter(r => r.passed > 0 && r.failed > 0);
  const reviewsFor = (trialId: string) => current.filter(r => r.trialId === trialId);
  const unreviewed = failedTrials.filter(t => reviewsFor(t.id).length === 0).length;
  const undecided = failedTrials.filter(t => reviewsFor(t.id).length > 0 && pending.has(t.id)).length;
  const reasons: VerdictNote[] = [];
  const unaudited = completed.filter(t => record.mode === 'live' && record.scenarios.find(s => s.id === t.scenarioId)?.metrics?.length && !hasCompleteJudgment({ scenario: record.scenarios.find(s => s.id === t.scenarioId)!, sources: observableSources(record.sources, record.requirements), trial: t })).length;
  if (unaudited) reasons.push({ code: 'judge_unaudited', text: `${unaudited} диалог(ов) без сохранённых независимых оценок судьи. Воспроизводимость этих оценок неизвестна.`, count: unaudited });
  if (rubric.unknown) reasons.push({ code: 'judge_unknown', text: `${rubric.unknown} диалог(ов) с отсутствующей, противоречивой или неопределённой оценкой агента.`, count: rubric.unknown });
  if (review.disagreements) reasons.push({ code: 'human_disagreement', text: `Расхождений автоматической и ручной оценки: ${review.disagreements}. Проверьте основания каждого; это ещё не оценка точности судьи.`, count: review.disagreements });
  if (gradedCount === 0 && rubric.assessed === 0) reasons.push({ code: 'none_graded', text: 'Диалогов с оценкой ещё нет.' });
  else if (gradedCount === 0) reasons.push({ code: 'rubric_only', text: 'Только оценки модели по рубрикам, объективных проверок нет: кодом ничего не подтверждено.' });
  else if (gradedCount < MIN_GRADED) reasons.push({ code: 'few_graded', text: `Оценено ${gradedCount} диалог(ов) — слишком мало, чтобы судить об агенте.`, count: gradedCount });
  if (invalid) reasons.push({ code: 'invalid', text: `${invalid} диалог(ов) не удалось измерить: сломалась симуляция или инфраструктура.`, count: invalid });
  if (allSynthetic) reasons.push({ code: 'all_synthetic', text: 'Все карточки синтетические: ни реальных пользователей, ни проверенного golden set.' });
  if (simulatorFlagged) reasons.push({ code: 'simulator_flagged', text: `Есть неразрешённые замечания к симулятору в ${simulatorFlagged} диалог(ах) по кодовым проверкам или рубрике верности; оценки агента в них требуют проверки.`, count: simulatorFlagged });
  if (!humanVerdicts) reasons.push({ code: 'no_human', text: 'Ни одного вердикта человека: оценки модели никем не проверены.' });
  else if (!decisiveVerdicts) reasons.push({ code: 'no_decisive_verdicts', text: 'Нет решающей оценки качества агента. Невалидный тест требует исправления и повторного запуска.' });
  else if (!finalized) reasons.push({ code: 'not_finalized', text: 'Аудит результатов человеком не завершён.' });
  else {
    if (unreviewed) reasons.push({ code: 'unreviewed_failures', text: `${unreviewed} провалившихся диалог(ов) без вердикта человека.`, count: unreviewed });
    if (undecided) reasons.push({ code: 'undecided_failures', text: `${undecided} провалившихся диалог(ов) ещё без решающего вердикта на диалог или все проваленные критерии.`, count: undecided });
  }
  const uniqueCards = new Set(gradedTrials.map(t => t.scenarioId)).size;
  const families = new Set(gradedTrials.map(t => t.familyId)).size;
  const reviewedCards = new Set(record.trials.filter(t => current.some(r => r.trialId === t.id && !r.metricId && !r.checkId && decisive(r))).map(t => t.scenarioId)).size;
  if (gradedCount >= MIN_GRADED && uniqueCards < TRUSTED_SAMPLE) reasons.push({ code: 'small_sample', text: `Проверено ${uniqueCards} разных карточек. Для расширенного аудита ориентир — ${TRUSTED_SAMPLE}; повторы не расширяют покрытие.`, count: uniqueCards });
  if (families < 8 && gradedCount >= MIN_GRADED) reasons.push({ code: 'few_families', text: `Покрыто ${families} семейств ситуаций из ориентира 8.`, count: families });
  if (reviewedCards < TRUSTED_SAMPLE && gradedCount >= MIN_GRADED) reasons.push({ code: 'few_reviews', text: `Индивидуально разобрано ${reviewedCards} разных карточек из ${TRUSTED_SAMPLE}.`, count: reviewedCards });
  const incomplete = record.workflow === 'evaluate' ? runCompleteness(record) : [];
  if (incomplete.length && record.trials.length) reasons.push({ code: 'incomplete_run', text: 'Прогон неполный или содержит невалидные попытки: итог описывает только сохранённую часть.' });
  if (record.mode === 'demo') reasons.push({ code: 'demo', text: 'Сценарное демо проверяет механику, а не качество модели.' });
  const nextSteps: VerdictNote[] = [];
  if (record.phase === 'review') nextSteps.push(record.questions.length
    ? { code: 'clarify_requirements', text: 'Ответьте на вопросы по требованиям и подготовьте обновлённый черновик.' }
    : { code: 'approve_and_run', text: 'Посмотрите запрос и ожидаемый результат, затем запустите проверку из разговора. /agent-lab — подробности.' });
  else if (execution.running) nextSteps.push({ code: 'wait_for_run', text: 'Прогон продолжается. Дождитесь результата или остановите его; записанные диалоги сохранятся.' });
  else if (invalid) nextSteps.push({ code: 'repair_execution', text: `Исправьте сбой подключения или симуляции и повторите прогон. Причина: ${record.trials.find(t => t.outcome === 'invalid')?.reason || 'откройте невалидный диалог и его трассу'}`, count: invalid });
  else if (record.phase === 'error') nextSteps.push({ code: 'repair_preparation', text: `Исправьте причину сбоя и подготовьте новый черновик: ${record.error ?? record.message}` });
  else if (execution.cancelled || record.phase === 'cancelled' || record.phase === 'interrupted') nextSteps.push({ code: 'repeat_run', text: 'Сохранена только часть прогона. Откройте повтор, проверьте подключение и запустите набор заново.' });
  const hasResults = completed.length > 0 && !execution.running && record.phase !== 'review';
  if (hasResults && review.invalid) nextSteps.unshift({ code: 'repair_test', text: `Невалидных тестов: ${review.invalid}. Исправьте сценарий или ожидание и повторите проверку. Исходные оценки сохранены; они не подтверждают ошибку агента.`, count: review.invalid });
  if (hasResults && review.findings.length) nextSteps.push({ code: 'inspect_human_findings', text: `Разберите замечания человека (${review.flagged} диалогов) и расхождения с автоматикой (${review.disagreements} оценок). Откройте диалог в /agent-lab → 3; a — обсудить основания и исправление.`, count: review.findings.length });
  if (hasResults && mixed.length) nextSteps.push({ code: 'inspect_repeats', text: `На ${mixed.length} сочетаниях карточки и режима есть и успехи, и провалы. Сравните эти попытки; общий процент скрывает различия.`, count: mixed.length });
  if (hasResults && simulatorFlagged) nextSteps.push({ code: 'inspect_simulator', text: `Откройте ${simulatorFlagged} диалог(ов) с пометкой симулятора: утечка, выдуманное значение, повтор или нарушение роли. Оценки агента в них ненадёжны; опровергнуть пометку можно вердиктом по проверке.`, count: simulatorFlagged });
  // Automatic pass/fail is enough for the quality report. Existing human disagreements are already
  // surfaced by inspect_human_findings; only unresolved judge output still needs a verdict.
  const disputed = rubric.unknown;
  if (hasResults && disputed) nextSteps.push({ code: 'record_verdicts', count: disputed,
    text: `Разберите только спорные результаты: ${disputed} с неясной оценкой, расхождением или пометкой симулятора. Уверенные автоматические pass/fail уже входят в отчёт.` });
  if (hasResults && smokeFailures) nextSteps.push({ code: 'smoke_failed', text: `Провалено ${smokeFailures} попыток на дымовых карточках: сначала восстановите базовое поведение.`, count: smokeFailures });
  if (hasResults && weakSpots[0]) nextSteps.push({ code: 'fix_weakest', text: `Начните с самого слабого места${weakSpots[0].stage ? ` на этапе «${weakSpots[0].stage}»` : ''}: ${weakSpots[0].description} (${weakSpots[0].failures} провал(ов)).`, detail: weakSpots[0].description, count: weakSpots[0].failures });
  if (hasResults && allSynthetic) nextSteps.push({ code: 'add_real_data', text: 'Добавьте golden set или реальные диалоги, чтобы результат не держался на одной синтетике.' });
  if (hasResults && record.target.kind === 'sandbox') nextSteps.push({ code: 'connect_agent', text: 'Подключите своего агента вместо песочницы, чтобы проверять то, что реально работает.' });
  if (hasResults && gradedCount > 0 && uniqueCards < TRUSTED_SAMPLE) nextSteps.push({ code: 'run_more', text: `Добавьте новые ситуации: проверено ${uniqueCards} разных карточек; ориентир для аудита — ${TRUSTED_SAMPLE}. Это не статистическая гарантия.`, count: uniqueCards });
  const passRate = gradedCount ? passed / gradedCount : null;
  const estimates = rubric.assessed ? ` ${record.mode === 'demo' ? 'Сценарная оценка демо' : 'Оценка модели'} (не проверена): ${rubric.passed} из ${rubric.assessed} диалогов без замечаний по рубрикам агента.` : '';
  let headline = gradedCount ? `По кодовым проверкам пройдено ${passed} из ${gradedCount} диалогов (${Math.round((passRate ?? 0) * 100)}%).${estimates}`
    : rubric.assessed ? `${estimates.trim()} Провалов: ${rubric.failed}; неясно: ${rubric.unknown}. Объективных проверок нет.` : 'Диалогов с оценкой ещё нет.';
  if (record.phase === 'preparing') headline = 'Готовим карточки и критерии. Диалоги ещё не запущены.';
  else if (record.phase === 'review') headline = `Черновик готов: ${record.scenarios.length} карточек, ${execution.planned} диалогов после подтверждения.`;
  else if (execution.running) headline = `Идёт прогон: завершено ${execution.completed} из ${execution.planned} диалогов; сбоев ${invalid}.`;
  else if (!completed.length && invalid) headline = `Не удалось измерить агента: ${invalid} диалогов завершились сбоем. ${record.trials.find(t => t.outcome === 'invalid')?.reason ?? ''}`;
  else if (!completed.length && record.phase === 'error') headline = `Работа остановилась с ошибкой: ${record.error ?? record.message}`;
  else if (!completed.length && (execution.cancelled || record.phase === 'cancelled' || record.phase === 'interrupted')) headline = 'Прогон остановлен. Завершённых измерений нет; частичные диалоги сохранены.';
  if (hasResults && review.invalid) headline = `Невалидных тестов: ${review.invalid}. Качество агента по ним не установлено. Исходные оценки: ${headline}`;
  else if (hasResults && review.flagged) headline = `Человек отметил проблемы: ${review.flagged} диалог(ов). ${headline}`;
  else if (hasResults && review.disagreements) headline = `Есть расхождения с ручной оценкой: ${review.disagreements}. ${headline}`;
  return { headline, passed, graded: gradedCount, invalid, passRate, execution, review, repeats, rubric, simulatorFlagged, provenance, stages, tiers, weakSpots, confidenceReasons: reasons, nextSteps };
}

export interface EvidenceSummary {
  verdict: VerdictSummary;
  comparison: { observed: string; status: string } | null;
  notes: string[];
}
/** The one object every surface renders: the plain verdict first, observed numbers next, then what they cannot yet support. */
export function evidenceSummary(record: Experiment): EvidenceSummary {
  const final = record.comparisons.findLast(c => c.split === 'control');
  const fmt = (n: number | null) => n === null ? 'unknown' : n.toFixed(2);
  const comparison = final ? {
    observed: `Candidate fixed ${final.fixed} of ${final.validPairs} valid pairs (${final.plannedPairs} planned) with ${final.regressed} regression(s); family-weighted delta ${fmt(final.delta)}${final.interval ? ` (95% interval ${fmt(final.interval[0])} to ${fmt(final.interval[1])})` : ''} across ${final.families} declared families.`,
    status: `Verdict ${final.verdict}: ${final.reasons[0] ?? 'no reason recorded'}`,
  } : null;
  const notes = record.limitations.filter(l => l.startsWith('Scripted mode skipped'));
  return { verdict: verdictSummary(record), comparison, notes };
}

/**
 * Two runs of the same cards, before and after a change. This is the everyday question —
 * "did my edit help?" — and a single average answers it badly: an improvement on easy cards
 * hides a regression on the one that matters. So the comparison is per card, per stage and
 * per rung, and it states out loud when the two runs are not actually comparable.
 */
export interface RunComparison {
  headline: string; comparable: boolean;
  pairs: { scenarioId: string; userMode: UserMode; repeat: number; beforeTrialId: string; afterTrialId: string;
    change: 'fixed' | 'regressed' | 'unchanged' | 'unknown'; reviewNote?: string }[];
  coverage: { plannedPairs: number; validPairs: number; excludedPairs: number; missingBefore: number; missingAfter: number; invalidBefore: number; invalidAfter: number;
    /** Each excluded pair once, by its first reason; the parts add up to `excludedPairs`. Absent when nothing was paired. */
    excludedBy?: ExcludedBy };
  cards: { shared: number; onlyBefore: string[]; onlyAfter: string[] };
  fixed: { scenarioId: string; title: string; tier: Tier }[];
  regressed: { scenarioId: string; title: string; tier: Tier }[];
  incomparable: { scenarioId: string; title: string; tier: Tier; userMode: UserMode; repeat: number;
    beforeTrialId?: string; afterTrialId?: string; reason: string }[];
  unchanged: { passing: number; failing: number };
  ungraded: number; includesRubrics: boolean;
  stages: { stage: string; before: number | null; after: number | null }[];
  tiers: { tier: Tier; before: { passed: number; graded: number }; after: { passed: number; graded: number } }[];
  notes: string[];
}

/** Expected attempts, including all repeats. Missing/invalid attempts never disappear from a comparison. */
export interface ExcludedBy { invalidBefore: number; missingBefore: number; invalidAfter: number; missingAfter: number; judgeIncomplete: number; other: number }

export function plannedTrials(record: Experiment): number {
  if (record.assessmentTrialIds) return record.assessmentTrialIds.length;
  return record.scenarios.reduce((sum, s) => sum + record.settings.userModes.filter(m => m !== 'scripted' || s.user.script !== undefined).length * record.settings.repeats, 0);
}
const attemptKey = (trial: Trial) => `${trial.scenarioId}|${trial.userMode}|${trial.repeat}`;
const expectedAttemptRows = (record: Experiment): { scenarioId: string; userMode: UserMode; repeat: number }[] => record.assessmentTrialIds
  ? record.trials.filter(t => record.assessmentTrialIds!.includes(t.id)).map(({ scenarioId, userMode, repeat }) => ({ scenarioId, userMode, repeat }))
  : record.scenarios.flatMap(s => record.settings.userModes.filter(m => m !== 'scripted' || s.user.script !== undefined)
    .flatMap(userMode => Array.from({ length: record.settings.repeats }, (_, repeat) => ({ scenarioId: s.id, userMode, repeat }))));
function expectedAttempts(record: Experiment): Set<string> {
  return new Set(expectedAttemptRows(record).map(row => `${row.scenarioId}|${row.userMode}|${row.repeat}`));
}
function runCompleteness(record: Experiment, allowPartial = false): string[] {
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
      || measured(trial) && (trial.checks.length !== scenario.checks.length || new Set(trial.checks.map(c => c.id)).size !== scenario.checks.length
        || trial.checks.some(c => !scenario.checks.some(expected => expected.id === c.id)))
      || trial.outcome === 'pass' && (!trial.checks.length || trial.checks.some(c => !c.passed))
      || (record.manifestHash && trial.manifestHash !== record.manifestHash)) invalid = true;
    if (!measured(trial)) unmeasured = true;
    seen.add(key); ids.add(trial.id);
  }
  const notes: string[] = [];
  if (!['results_review', 'complete'].includes(record.phase)) notes.push('Прогон не завершён.');
  if (invalid || !expected.size) notes.push('Есть повторяющиеся или несовместимые попытки.');
  if (!allowPartial && (unmeasured || seen.size !== expected.size || record.trials.length !== expected.size)) notes.push('Есть пропущенные или невалидные попытки.');
  return notes;
}
/** The full card must be complete; comparisons explicitly report only their matched sample. */
export function cardOutcome(record: Experiment, scenario: Scenario, allowPartial = false): 'pass' | 'fail' | 'unknown' {
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
function metricCardOutcome(record: Experiment, scenario: Scenario, metricId: string, partial = false): 'pass' | 'fail' | 'unknown' {
  const trials = record.trials.filter(trial => trial.scenarioId === scenario.id);
  if (!attemptsMatch(record, scenario, trials, partial) || trials.some(trial => !measurementUsable(scenario, trial, record.humanReviews))) return 'unknown';
  const results = trials.map(trial => agentMetricResult(trial, metricId, record.humanReviews) ?? 'unknown');
  return results.includes('fail') ? 'fail' : results.every(result => result === 'pass') ? 'pass' : 'unknown';
}

export type HeadlineOutcome = { outcome: 'pass' | 'fail' | 'unknown'; goal: 'pass' | 'fail' | 'unknown' | 'none'; rules: 'pass' | 'fail' | 'unknown' | 'none' };

/**
 * The headline card result (counting rule COUNTING_RULES): goal attainment and, when the card has
 * it, prompt compliance; the card passes only when both pass in every attempt, fails when either
 * fails in any attempt, and stays unknown otherwise. Both metrics pass the same attempt and
 * usability gate before any fail is read, so an unusable card is «не измерено» whatever the rules
 * say. A legacy card without the goal rubric keeps the strict card outcome, with no goal and no
 * rules part. Reply quality and the RAG rubrics never enter.
 */
export function headlineCardOutcome(record: Experiment, scenario: Scenario, options: { partial?: boolean } = {}): HeadlineOutcome {
  const partial = options.partial ?? false;
  const ids = headlineMetricIds(scenario);
  if (!ids.length) return { outcome: cardOutcome(record, scenario, partial), goal: 'none', rules: 'none' };
  const goal = metricCardOutcome(record, scenario, GOAL_METRIC_ID, partial);
  const rules = ids.includes(RULES_METRIC_ID) ? metricCardOutcome(record, scenario, RULES_METRIC_ID, partial) : 'none';
  const parts = rules === 'none' ? [goal] : [goal, rules];
  const outcome = parts.includes('fail') ? 'fail' : parts.every(part => part === 'pass') ? 'pass' : 'unknown';
  return { outcome, goal, rules };
}

/**
 * The goal-only card result, used for the positive control (decided by its goal alone) and the
 * breakdown row; legacy cards without the goal rubric use the strict card outcome.
 */
export function goalCardOutcome(record: Experiment, scenario: Scenario): 'pass' | 'fail' | 'unknown' {
  if (!headlineMetricIds(scenario).length) return cardOutcome(record, scenario);
  return metricCardOutcome(record, scenario, GOAL_METRIC_ID);
}

/**
 * Why a card has no verdict. The order is both the evaluation order of the code paths that
 * leave a card `unknown` and the tie-break when two reasons are equally frequent.
 */
export const NOT_MEASURED_CODES = [
  'in_progress', 'not_reached', 'stopped', 'turn_limit', 'simulator_error', 'agent_error', 'attempts_mismatch',
  'judge_error', 'judge_stopped', 'human_invalid', 'reset_unconfirmed', 'simulator_deviated', 'simulator_unclear',
  'human_unknown', 'not_judged', 'judge_split', 'no_evidence', 'judge_unclear',
] as const;
export type NotMeasuredCode = typeof NOT_MEASURED_CODES[number];

// Prefixes of reasons written by evaluation.ts and experiment.ts.
const TURN_LIMIT_REASON = 'Разговор не завершился в отведённое число реплик.';
const SIMULATOR_STAGE_REASON = 'реплика симулированного пользователя:';
const CODE_ONLY_ASSESSMENT = 'Только точные проверки';

/** Why one attempt leaves the card without a verdict; `ids` are the headline metrics whose undecided votes are explained. */
function trialReasons(record: Experiment, scenario: Scenario, trial: Trial, ids: string[]): NotMeasuredCode[] {
  const codes: NotMeasuredCode[] = [];
  const latest = latestHumanReviews({ trials: [trial], humanReviews: record.humanReviews });
  if (trial.outcome === 'cancelled') codes.push('stopped');
  else if (trial.outcome === 'invalid') codes.push(trial.reason.startsWith(TURN_LIMIT_REASON) ? 'turn_limit'
    : trial.reason.startsWith(SIMULATOR_STAGE_REASON) ? 'simulator_error' : 'agent_error');
  if (trial.assessmentError) codes.push(trial.assessmentError.startsWith(CODE_ONLY_ASSESSMENT) ? 'not_judged'
    : /cancel|budget exhausted|time limit|closing/i.test(trial.assessmentError) ? 'judge_stopped' : 'judge_error');
  if (latest.get(`${trial.id}|dialogue`)?.verdict === 'invalid'
    || ids.some(id => latest.get(`${trial.id}|metric:${id}`)?.verdict === 'invalid')) codes.push('human_invalid');
  if (scenario.initialState.external && trial.observation?.resetConfirmed !== true) codes.push('reset_unconfirmed');
  // Mirrors simulatorUsable: a human verdict overrides the check or the fidelity vote.
  const checksDeviate = (simulatorWasUsed(trial) ? trial.simulatorChecks ?? [] : []).some(c => {
    const review = latest.get(`${trial.id}|check:${c.id}`);
    return !(review?.verdict === 'invalid' || (review ? review.verdict === 'pass' : c.passed));
  });
  const fidelity = (scenario.metrics ?? []).filter(m => m.subject === 'simulator' && metricApplies(m, trial)).flatMap(m => {
    const review = latest.get(`${trial.id}|metric:${m.id}`);
    return review?.verdict === 'invalid' ? [] : [review?.verdict ?? trial.assessments?.find(a => a.metricId === m.id)?.result];
  });
  if (checksDeviate || fidelity.includes('fail')) codes.push('simulator_deviated');
  // Without any judgment the vote is missing because the judge never ran: that is `not_judged`, not an unsure judge.
  if (trial.assessments && fidelity.some(result => result !== 'pass' && result !== 'fail')) codes.push('simulator_unclear');
  for (const id of ids) {
    const result = agentMetricResult(trial, id, record.humanReviews);
    if (result === 'pass' || result === 'fail') continue;
    const assessment = trial.assessments?.find(a => a.metricId === id);
    // A one-key «не могу сказать» leaves the judge's verdict in place, so it is never the reason a card has none.
    const metricReview = latest.get(`${trial.id}|metric:${id}`);
    if (metricReview?.verdict === 'unknown' && metricReview.source !== 'quick') codes.push('human_unknown');
    else if (!assessment) codes.push('not_judged');
    else if (assessment.rationale.startsWith(SPLIT_RATIONALE_PREFIX)) codes.push('judge_split');
    // Agreed votes carry a prefix, so the unsupported-goal sentence is matched anywhere; it is a goal sentence only.
    else if (id === GOAL_METRIC_ID && assessment.rationale.includes(GOAL_UNSUPPORTED_RATIONALE)) codes.push('no_evidence');
    else codes.push('judge_unclear');
  }
  return codes;
}

/**
 * One card decided by the counting rules, with the single reason when it has no verdict. `rule`
 * picks the headline verdict (goal and prompt rules) or the goal-only one the positive control
 * is decided by; the reasons cover every undecided metric of the chosen rule.
 */
export function cardVerdict(record: Experiment, scenario: Scenario, rule: 'headline' | 'goal' = 'headline'): { outcome: 'pass' | 'fail' | 'unknown'; reason?: NotMeasuredCode } {
  const outcome = rule === 'goal' ? goalCardOutcome(record, scenario) : headlineCardOutcome(record, scenario).outcome;
  if (outcome !== 'unknown') return { outcome };
  const ids = rule === 'goal' ? headlineMetricIds(scenario).slice(0, 1) : headlineMetricIds(scenario);
  const trials = record.trials.filter(trial => trial.scenarioId === scenario.id);
  const codes = new Set<NotMeasuredCode>();
  if (!trials.length) codes.add(runningPhases.has(record.phase) ? 'in_progress' : 'not_reached');
  else if (!attemptsMatch(record, scenario, trials)) codes.add('attempts_mismatch');
  for (const trial of trials) for (const code of trialReasons(record, scenario, trial, ids)) codes.add(code);
  return { outcome, reason: NOT_MEASURED_CODES.find(code => codes.has(code)) ?? 'judge_unclear' };
}

/** The judge model named on result screens: the recorded audit first, then the configured role. */
export function judgeModel(record: Experiment): string | undefined {
  return record.trials.map(t => (t.judgeAudit ?? t.judgeReceipt)?.model).find(Boolean) ?? record.settings.roles?.judge?.model ?? record.settings.judge?.model;
}

/** One situation whose headline verdict flipped between two decided verdicts. */
export interface StabilityRow { scenarioId: string; title: string; before: 'pass' | 'fail'; after: 'pass' | 'fail' }
/**
 * Found instability only: `checked` situations had a decided verdict on both sides, `unstable`
 * lists the flips. `skipped` names why nothing was compared; it never means «stable».
 */
export interface Stability { basis: 'repeat' | 'reassess'; comparedWith: string; checked: number; unstable: StabilityRow[]; skipped: string | null }

type Decided = 'pass' | 'fail';

/*
 * A source run rebuilt from embedded evidence (artifacts.ts embeddedBefore) is a copy of the
 * current record with the source attempts swapped in: its agent, evaluator and card fields are
 * the current ones. Stability must never compare the current record with itself, so a rebuilt
 * source is registered here and checked against the identity the derived record embedded.
 */
const reconstructedSources = new WeakSet<Experiment>();
const SOURCE_UNAVAILABLE = 'исходный прогон недоступен';
/** Marks a run rebuilt from embedded evidence; stability then trusts only `sourceEvidence.identity`. */
export function markReconstructedSource(run: Experiment): Experiment {
  reconstructedSources.add(run);
  return run;
}
/** undefined: `source` is a real run. null: rebuilt without a recorded identity, so nothing can be compared. */
function reconstructedIdentity(source: Experiment, derived: Experiment): SourceIdentity | null | undefined {
  if (!reconstructedSources.has(source)) return undefined;
  const evidence = derived.sourceEvidence;
  return evidence?.runId === source.id && evidence.identity ? evidence.identity : null;
}
/** The card the source attempts were judged against: from the embedded identity when the source was rebuilt. */
function sourceCardIdentity(source: Experiment, card: Scenario, identity: SourceIdentity | undefined): string | undefined {
  return identity ? identity.scenarios[card.id] : fingerprint(normalizeScenarioIdentity(card, source.target.kind));
}
const isDecided = (outcome: 'pass' | 'fail' | 'unknown'): outcome is Decided => outcome !== 'unknown';

/**
 * A repeat of the same set against its source run. Gated on comparability and on the same agent,
 * so a change of the agent, the judge or the criteria is never called instability. Uses the headline
 * verdict (goal and prompt rules, CTX-21), so «нестабильно» matches the number; reply quality and the
 * RAG rubrics never flip a card here.
 */
export function stabilityBetweenRuns(before: Experiment, after: Experiment): Stability {
  const result: Stability = { basis: 'repeat', comparedWith: before.id, checked: 0, unstable: [], skipped: null };
  const identity = reconstructedIdentity(before, after);
  if (identity === null) return { ...result, skipped: SOURCE_UNAVAILABLE };
  if (!compareRuns(before, after).comparable) return { ...result, skipped: 'прогоны несравнимы' };
  const agent = identity ?? { ...before, agent: agentIdentity(before) };
  if (agent.targetFingerprint !== after.targetFingerprint || agent.targetVersion !== after.targetVersion
    || agent.agent !== agentIdentity(after)) return { ...result, skipped: 'агент изменился между прогонами' };
  const source = observedRecord(before), repeat = observedRecord(after);
  for (const card of repeat.scenarios) {
    const sourceCard = source.scenarios.find(item => item.id === card.id);
    if (!sourceCard) continue;
    // A card edited since the source attempts were judged is another question, not a repeat of it.
    if (fingerprint(normalizeScenarioIdentity(card, after.target.kind)) !== sourceCardIdentity(before, sourceCard, identity)) continue;
    const was = headlineCardOutcome(source, sourceCard).outcome, now = headlineCardOutcome(repeat, card).outcome;
    if (!isDecided(was) || !isDecided(now)) continue;
    result.checked++;
    if (was !== now) result.unstable.push({ scenarioId: card.id, title: card.title, before: was, after: now });
  }
  return result;
}

/**
 * A reassessment of saved answers against its source run: pass↔fail flips of the headline verdict
 * (goal and prompt rules) on the same attempts, the same criteria and the same judge (model, routing
 * and protocol). Null when the record is not a reassessment of `source`.
 * compareRuns is not used here: it always marks a reassessment as incomparable.
 */
export function stabilityAfterReassess(record: Experiment, source: Experiment): Stability | null {
  if (record.assessmentOf !== source.id || !record.evidenceHash) return null;
  const result: Stability = { basis: 'reassess', comparedWith: source.id, checked: 0, unstable: [], skipped: null };
  const identity = reconstructedIdentity(source, record);
  if (identity === null) return { ...result, skipped: SOURCE_UNAVAILABLE };
  // The judge, not the whole evaluator: an Agent Lab upgrade with the same judge still compares.
  const protocols = (run: Experiment) => [...new Set(run.trials.flatMap(trial => {
    const judge = trial.judgeAudit ?? trial.judgeReceipt;
    return judge ? [judge.protocolHash] : [];
  }))].sort();
  const sourceProtocols = protocols(source), recordProtocols = protocols(record);
  if (judgeSettingsIdentity(record.settings) !== (identity?.judge ?? judgeSettingsIdentity(source.settings))
    || sourceProtocols.length && recordProtocols.length && fingerprint(sourceProtocols) !== fingerprint(recordProtocols)) {
    return { ...result, skipped: 'судья или его настройки изменились' };
  }
  const sourceTrialIds = new Set(source.trials.map(trial => trial.id));
  for (const card of record.scenarios) {
    const sourceCard = source.scenarios.find(item => item.id === card.id);
    if (!sourceCard) continue;
    // A rebuilt source holds the current cards, so the source card identity comes from the embedded record of it.
    if (fingerprint(normalizeScenarioIdentity(card, record.target.kind)) !== sourceCardIdentity(source, sourceCard, identity)) continue;
    const trialIds = new Set(record.trials.filter(trial => trial.scenarioId === card.id).map(trial => trial.id));
    // Only a card whose every source attempt was reassessed, and nothing else, compares the same answers.
    if ([...trialIds].some(id => !sourceTrialIds.has(id))
      || source.trials.some(trial => trial.scenarioId === card.id && !trialIds.has(trial.id))) continue;
    const was = headlineCardOutcome(source, sourceCard).outcome, now = headlineCardOutcome(record, card).outcome;
    if (!isDecided(was) || !isDecided(now)) continue;
    result.checked++;
    if (was !== now) result.unstable.push({ scenarioId: card.id, title: card.title, before: was, after: now });
  }
  return result;
}

const JUDGE_INCOMPLETE = 'Судья не завершил оценку этой попытки.';

const CONTROL_NOTE = 'Контрольные ситуации не сравниваются: они не входят в главное число.';
/** Named whenever a shared card carries the prompt-rule check, so a reader knows which rule the before/after counts by (CTX-22). */
const RULE_NOTE = 'Сравнение считает «справился» как главное число: запрос выполнен и правила промпта соблюдены.';

export function compareRuns(before: Experiment, after: Experiment): RunComparison {
  // A rebuilt source carries the current cards; its embedded identity says what the source cards were.
  // Taken from the original records: a stripped copy is not a registered rebuilt source.
  const identity = reconstructedIdentity(before, after) ?? undefined;
  const controls = new Set([...before.positiveControlScenarioIds ?? [], ...after.positiveControlScenarioIds ?? []]);
  let result: RunComparison;
  if (!controls.size) result = compareRunsAgainst(before, after, identity);
  else {
    // A control never enters the headline (CTX-11), and a repeat runs it as one turn, so it is not a pair either.
    result = compareRunsAgainst(withoutControls(before, controls), withoutControls(after, controls), identity);
    result.notes.push(CONTROL_NOTE);
  }
  // Marks given under the previous counting rule are named, never mixed in silently (CTX-21). Informational: `comparable` is untouched.
  for (const run of [before, after]) {
    const stale = judgeAgreement(run).staleRule;
    if (stale > 0) result.notes.push(`В прогоне ${run.id.slice(0, 8)} есть отметки по прежнему правилу подсчёта: ${stale}.`);
  }
  return result;
}

/** A shallow copy of a run without its control situations: cards, attempts, selection and reassessed attempts. */
function withoutControls(run: Experiment, controls: Set<string>): Experiment {
  const trials = run.trials.filter(trial => !controls.has(trial.scenarioId));
  const copy: Experiment = { ...run, scenarios: run.scenarios.filter(scenario => !controls.has(scenario.id)), trials };
  delete copy.positiveControlScenarioIds;
  const selected = run.selectedScenarioIds?.filter(id => !controls.has(id));
  if (selected?.length) copy.selectedScenarioIds = selected;
  else delete copy.selectedScenarioIds;
  if (run.assessmentTrialIds) {
    const kept = new Set(trials.map(trial => trial.id));
    copy.assessmentTrialIds = run.assessmentTrialIds.filter(id => kept.has(id));
  }
  return copy;
}

function compareRunsAgainst(before: Experiment, after: Experiment, identity: SourceIdentity | undefined): RunComparison {
  if (after.parentRunId === before.id && after.selectedScenarioIds?.length
    && after.scenarios.length < before.scenarios.length
    && after.scenarios.length === after.selectedScenarioIds.length
    && after.scenarios.every(s => after.selectedScenarioIds!.includes(s.id) && before.scenarios.some(b => b.id === s.id))) {
    const selected = new Set(after.selectedScenarioIds);
    const result = compareRunsAgainst({ ...before, scenarios: before.scenarios.filter(s => selected.has(s.id)), trials: before.trials.filter(t => selected.has(t.scenarioId)) }, after, identity);
    result.cards.onlyBefore = before.scenarios.filter(s => !selected.has(s.id)).map(s => s.id);
    result.headline = `Выбранные тесты (${selected.size}/${before.scenarios.length}). ${result.headline}`;
    result.notes.push('Сравнение относится только к явно выбранным тестам. Остальной регрессионный набор не проверен.');
    return result;
  }
  const beforeIds = new Set(before.scenarios.map(s => s.id));
  const afterIds = new Set(after.scenarios.map(s => s.id));
  const shared = after.scenarios.filter(s => beforeIds.has(s.id));
  const beforeReviews = latestHumanReviews(before), afterReviews = latestHumanReviews(after);
  const validBefore = (t: Trial) => measured(t) && beforeReviews.get(`${t.id}|dialogue`)?.verdict !== 'invalid';
  const validAfter = (t: Trial) => measured(t) && afterReviews.get(`${t.id}|dialogue`)?.verdict !== 'invalid';
  const result: RunComparison = {
    headline: '', comparable: false, pairs: [], cards: { shared: shared.length,
      onlyBefore: before.scenarios.filter(s => !afterIds.has(s.id)).map(s => s.id),
      onlyAfter: after.scenarios.filter(s => !beforeIds.has(s.id)).map(s => s.id) },
    fixed: [], regressed: [], incomparable: [], unchanged: { passing: 0, failing: 0 }, ungraded: 0,
    includesRubrics: shared.some(s => s.metrics?.some(m => m.subject === 'agent')),
    stages: [], tiers: [], notes: [],
    coverage: { plannedPairs: plannedTrials(before), validPairs: 0, excludedPairs: plannedTrials(before),
      missingBefore: Math.max(0, plannedTrials(before) - before.trials.length), missingAfter: Math.max(0, plannedTrials(after) - after.trials.length),
      invalidBefore: before.trials.filter(t => !validBefore(t)).length, invalidAfter: after.trials.filter(t => !validAfter(t)).length },
  };
  const { notes } = result;
  const addIncomparable = (row: { scenarioId: string; userMode: UserMode; repeat: number }, reason: string, beforeTrialId?: string, afterTrialId?: string) => {
    const scenario = after.scenarios.find(s => s.id === row.scenarioId) ?? before.scenarios.find(s => s.id === row.scenarioId);
    if (!scenario || result.incomparable.some(item => item.scenarioId === row.scenarioId && item.userMode === row.userMode && item.repeat === row.repeat)) return;
    result.incomparable.push({ ...row, title: scenario.title, tier: scenario.tier ?? 'regression',
      ...(beforeTrialId ? { beforeTrialId } : {}), ...(afterTrialId ? { afterTrialId } : {}), reason });
  };
  const expectedRows = [...expectedAttemptRows(before), ...expectedAttemptRows(after)]
    .filter((row, index, rows) => rows.findIndex(value => value.scenarioId === row.scenarioId && value.userMode === row.userMode && value.repeat === row.repeat) === index);
  if (before.id === after.id) notes.push('Выбран один и тот же прогон.');
  if (before.workflow !== 'evaluate' || after.workflow !== 'evaluate') notes.push('Сравнение поддерживает отдельные оценочные прогоны.');
  if (before.mode !== after.mode) notes.push('Демо и живые прогоны несравнимы.');
  const rejudgedPair = !!before.assessmentOf && !!after.assessmentOf && before.assessmentOf !== after.assessmentOf
    && after.sourceEvidence?.runId === after.assessmentOf && after.sourceEvidence.parentRunId === before.assessmentOf;
  if (fingerprint(before.target) !== fingerprint(after.target) && after.parentRunId !== before.id && !rejudgedPair) notes.push('Испытуемый в прогонах разный: выберите повтор того же агента.');
  if (fingerprint(before.settings) !== fingerprint(after.settings)) notes.push('Настройки, модель, режимы пользователя или число повторов отличаются.');
  if ((before.assessmentOf || after.assessmentOf) && !rejudgedPair) notes.push('Это переоценка сохранённых ответов. Для сравнения версий переоцените оба исходных прогона в одинаковых условиях.');
  if (before.evaluatorVersion !== after.evaluatorVersion) notes.push('Версия оценщика или его инструкций отличается. Сначала переоцените сохранённые трассы в одинаковых условиях.');
  if (fingerprint(before.sources) !== fingerprint(after.sources) || fingerprint(before.requirements) !== fingerprint(after.requirements)) notes.push('Материалы или требования изменились.');
  if (result.cards.onlyBefore.length || result.cards.onlyAfter.length) notes.push('Набор карточек изменился.');
  // External agents: a legacy card without a channel is judged on the reply, so it equals the same card with `reply`.
  const changed = shared.filter(s => {
    const b = before.scenarios.find(item => item.id === s.id)!;
    const now = fingerprint(normalizeScenarioIdentity(s, after.target.kind));
    return now !== sourceCardIdentity(before, b, identity);
  });
  if (changed.length) notes.push(`Содержимое карточек изменилось: ${changed.map(s => s.title).join(', ')}.`);
  for (const [name, record] of [['До', before], ['После', after]] as const) notes.push(...runCompleteness(record, true).map(n => `${name}: ${n}`));
  // A rejected judgment is a problem of its own pair, not a second protocol inside the run.
  const judgeIdentities = (record: Experiment) => [...new Set(record.trials.filter(t => measured(t) && !t.assessmentError
    && record.scenarios.find(s => s.id === t.scenarioId)?.metrics?.length).map(t => {
    // A legacy full audit and a receipt from the same judge are one identity.
    const judge = t.judgeAudit ?? t.judgeReceipt;
    return judge ? fingerprint({ protocol: judge.protocolHash, provider: judge.provider, model: judge.model }) : 'unrecorded';
  }))].sort();
  const beforeJudges = judgeIdentities(before), afterJudges = judgeIdentities(after);
  if (beforeJudges.length > 1 || afterJudges.length > 1) notes.push('Внутри прогона смешаны разные протоколы судьи.');
  if (beforeJudges.length && afterJudges.length && fingerprint(beforeJudges) !== fingerprint(afterJudges)) notes.push('Протокол или модель судьи отличаются; оценки нельзя приписать изменению агента.');
  if (notes.length) {
    for (const row of expectedRows) addIncomparable(row, notes.join(' '),
      before.trials.find(t => attemptKey(t) === `${row.scenarioId}|${row.userMode}|${row.repeat}`)?.id,
      after.trials.find(t => attemptKey(t) === `${row.scenarioId}|${row.userMode}|${row.repeat}`)?.id);
    result.headline = `Прогоны несравнимы: ${result.incomparable.length} пар. Исправления и регрессии не подсчитываются.`;
    return result;
  }
  // The judge saw observable sources (evaluation.ts), so its receipt is checked against the same input, one pair at a time.
  const auditRequired = before.mode === 'live' && result.includesRubrics;
  const judged = (run: Experiment, trial: Trial) => {
    const scenario = run.scenarios.find(s => s.id === trial.scenarioId);
    return !!scenario && hasCompleteJudgment({ scenario, sources: observableSources(run.sources, run.requirements), trial });
  };
  const beforeAttempts = new Map<string, Trial[]>(), afterAttemptGroups = new Map<string, Trial[]>();
  for (const trial of before.trials) beforeAttempts.set(attemptKey(trial), [...beforeAttempts.get(attemptKey(trial)) ?? [], trial]);
  for (const trial of after.trials) afterAttemptGroups.set(attemptKey(trial), [...afterAttemptGroups.get(attemptKey(trial)) ?? [], trial]);
  const excludedBy: ExcludedBy = { invalidBefore: 0, missingBefore: 0, invalidAfter: 0, missingAfter: 0, judgeIncomplete: 0, other: 0 };
  for (const row of expectedRows) {
    const key = `${row.scenarioId}|${row.userMode}|${row.repeat}`;
    const a = beforeAttempts.get(key) ?? [], b = afterAttemptGroups.get(key) ?? [];
    if (a.length !== 1) { if (!a.length) excludedBy.missingBefore++; addIncomparable(row, a.length ? 'Несколько попыток «до» с одним ключом.' : 'Нет попытки «до».', a[0]?.id, b[0]?.id); }
    else if (!validBefore(a[0]!)) { excludedBy.invalidBefore++; addIncomparable(row, 'Попытка «до» невалидна или не измерена.', a[0]!.id, b[0]?.id); }
    else if (b.length !== 1) { if (!b.length) excludedBy.missingAfter++; addIncomparable(row, b.length ? 'Несколько попыток «после» с одним ключом.' : 'Нет попытки «после».', a[0]!.id, b[0]?.id); }
    else if (!validAfter(b[0]!)) { excludedBy.invalidAfter++; addIncomparable(row, 'Попытка «после» невалидна или не измерена.', a[0]!.id, b[0]!.id); }
    else if (auditRequired && (!judged(before, a[0]!) || !judged(after, b[0]!))) { excludedBy.judgeIncomplete++; addIncomparable(row, JUDGE_INCOMPLETE, a[0]!.id, b[0]!.id); }
  }
  const afterAttempts = new Map([...afterAttemptGroups].flatMap(([key, trials]) => trials.length === 1 ? [[key, trials[0]!] as const] : []));
  const pairs = before.trials.filter(t => {
    const following = afterAttempts.get(attemptKey(t));
    return validBefore(t) && !!following && validAfter(following) && (!auditRequired || (judged(before, t) && judged(after, following)));
  });
  result.coverage.validPairs = pairs.length;
  result.coverage.excludedPairs -= pairs.length;
  // Duplicated keys and attempts outside the plan are the remainder, so the parts always add up.
  const named = excludedBy.invalidBefore + excludedBy.missingBefore + excludedBy.invalidAfter + excludedBy.missingAfter + excludedBy.judgeIncomplete;
  excludedBy.other = Math.max(0, result.coverage.excludedPairs - named);
  result.coverage.excludedBy = excludedBy;
  if (result.coverage.excludedPairs) notes.push(`Сопоставлено ${pairs.length} из ${result.coverage.plannedPairs} пар попыток. Исключено ${result.coverage.excludedPairs}: до — ${excludedBy.invalidBefore} невалидных и ${excludedBy.missingBefore} пропущенных; после — ${excludedBy.invalidAfter} невалидных и ${excludedBy.missingAfter} пропущенных`
    + `${excludedBy.judgeIncomplete ? `; без завершённой оценки судьи — ${excludedBy.judgeIncomplete}` : ''}${excludedBy.other ? `; повторённые или лишние попытки — ${excludedBy.other}` : ''}. Сбои могут скрывать регрессии; вывод относится только к сопоставленной части.`);
  if (!pairs.length) { result.headline = 'Нет совпадающих валидных попыток. Повторите неудавшиеся диалоги, чтобы получить сравнение.'; return result; }
  result.pairs = pairs.map(trial => {
    const scenario = shared.find(s => s.id === trial.scenarioId);
    // The headline rule per attempt (goal and prompt rules); a legacy card falls back to the strict trial result.
    const was = headlineTrialResult(scenario, trial, before.humanReviews);
    const following = afterAttempts.get(attemptKey(trial))!;
    const now = headlineTrialResult(scenario, following, after.humanReviews);
    let change: RunComparison['pairs'][number]['change'] = was === 'unknown' || now === 'unknown' ? 'unknown'
      : was === now ? 'unchanged' : now === 'pass' ? 'fixed' : 'regressed';
    const reviewNote = rubricReviewNote(scenario, trial, following);
    if (reviewNote) change = 'unknown';
    if (reviewNote) notes.push(`${scenario!.title} · ${trial.userMode} #${trial.repeat + 1}: ${reviewNote}`);
    if (change === 'unknown') addIncomparable({ scenarioId: trial.scenarioId, userMode: trial.userMode, repeat: trial.repeat },
      reviewNote ?? 'У пары нет решающей автоматической или человеческой оценки.', trial.id, following.id);
    return { scenarioId: trial.scenarioId, userMode: trial.userMode, repeat: trial.repeat,
      beforeTrialId: trial.id, afterTrialId: following.id, change, ...(reviewNote ? { reviewNote } : {}) };
  });
  // Open the actual changed attempt, not an unchanged repeat of a changed card.
  const rank = { regressed: 0, fixed: 1, unchanged: 2, unknown: 2 };
  result.pairs.sort((a, b) => rank[a.change] - rank[b.change]);
  before = { ...before, trials: pairs };
  after = { ...after, trials: pairs.map(t => afterAttempts.get(attemptKey(t))!) };
  result.comparable = true;
  for (const scenario of shared) {
    if (result.pairs.some(p => p.scenarioId === scenario.id && p.reviewNote)) { result.ungraded++; continue; }
    // The headline rule over the matched attempts (partial gate); a legacy card reaches the strict cardOutcome(…, true) through it.
    const was = headlineCardOutcome(before, scenario, { partial: true }).outcome;
    const now = headlineCardOutcome(after, scenario, { partial: true }).outcome;
    if (was === 'unknown' || now === 'unknown') { result.ungraded++; continue; }
    const row = { scenarioId: scenario.id, title: scenario.title, tier: scenario.tier ?? 'regression' };
    if (was === 'fail' && now === 'pass') result.fixed.push(row);
    else if (was === 'pass' && now === 'fail') result.regressed.push(row);
    else if (now === 'pass') result.unchanged.passing++;
    else result.unchanged.failing++;
  }
  const bv = verdictSummary(before);
  const av = verdictSummary(after);
  const rate = (v: VerdictSummary, stage: string) => { const s = v.stages.find(s => s.stage === stage); return s ? s.passed / s.evaluated : null; };
  result.stages = [...new Set([...bv.stages, ...av.stages].map(s => s.stage))].sort().map(stage => ({ stage, before: rate(bv, stage), after: rate(av, stage) }));
  result.tiers = av.tiers.map(row => ({ tier: row.tier, before: bv.tiers.find(t => t.tier === row.tier)!, after: row }));
  const compared = shared.length - result.ungraded;
  result.headline = compared ? `${result.includesRubrics ? `Оценка выросла у ${result.fixed.length}, снизилась у ${result.regressed.length}` : `Исправлено ${result.fixed.length}, сломалось ${result.regressed.length}`}, без изменений ${result.unchanged.passing + result.unchanged.failing} из ${compared} карточек.` : 'Общих оценённых карточек нет, сравнивать нечего.';
  if (result.coverage.excludedPairs) result.headline = `Частичное сравнение (${pairs.length}/${result.coverage.plannedPairs} пар). ${result.headline}`;
  if (result.includesRubrics) result.headline = `Предварительно: ${result.headline}`;
  const disputed = result.pairs.filter(p => p.reviewNote).length;
  if (disputed) result.headline += ` Пар с совпавшими ответами и разными оценками: ${disputed}. Нужна проверка.`;
  if (result.ungraded) notes.push(`${result.ungraded} карточек без решающей оценки; они не считаются пройденными.`);
  if (result.includesRubrics) notes.push('Сравнение включает предварительные оценки по рубрикам. Это не подтверждённое улучшение.');
  if (shared.some(s => headlineMetricIds(s).includes(RULES_METRIC_ID))) notes.push(RULE_NOTE);
  const smoke = result.regressed.filter(r => r.tier === 'smoke').length;
  if (smoke) notes.push(`Сломано ${smoke} дымовых карточек: сначала восстановите базовое поведение.`);
  if (compared < TRUSTED_SAMPLE) notes.push(`Сравнение по ${compared} карточкам: разница может быть случайной. Повторы не создают новые ситуации.`);
  if (before.target.kind !== 'sandbox' && (!(before.targetVersion || before.targetRelease) || !(after.targetVersion || after.targetRelease))) notes.push('Не все версии внешнего агента названы. Локальный отпечаток не учитывает удалённые сервисы и переменные окружения.');
  return result;
}

/** Shared CLI exit status: infrastructure/incomplete measurement takes precedence over an agent failure. */
export function evaluationExitCode(record: Experiment): 0 | 1 | 2 {
  const v = verdictSummary(record);
  const incomplete = !['results_review', 'complete'].includes(record.phase) || v.execution.invalid > 0 || v.execution.cancelled > 0
    || v.execution.missing > 0 || v.rubric.unknown > 0 || v.simulatorFlagged > 0
    || record.trials.some(t => automaticTrialResult(record.scenarios.find(s => s.id === t.scenarioId), t, record.humanReviews) === 'unknown');
  return incomplete ? 2 : record.trials.some(t => isAgentFailure(record, t)) ? 1 : 0;
}
