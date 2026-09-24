import { countingRuleOf, headlineRule } from './card/expectations.js';
import type { Experiment, Scenario, ValidationExclusion } from './contracts.js';
import { isRunning } from './phases.js';
import { agentMetricResult, COUNTING_RULES, headlineMetricIds, latestHumanReviews, RULES_METRIC_ID } from './outcomes.js';
import { judgeAgreement, type JudgeAgreement } from './agreement.js';
import { judgeModel, stabilityAfterReassess, stabilityBetweenRuns, type Stability } from './comparison.js';
import { topicView, trafficCoverage, type TopicView } from './coverage.js';
import { failureExplanation, violatedRuleNumber, type FailureExplanation } from './explain.js';
import type { TopicCoverage } from './miner/coverage.js';
import { deriveRun, NOT_MEASURED_CODES, type CardPart, type NotMeasuredCode, type RunDerivation, type Verdict } from './run.js';
import { SMALL_SAMPLE, wilson } from './interval.js';
import { buildCalibration, type CalibrationView } from './card/calibration-view.js';
import type { DialogueNumbers } from './card/view.js';

export { COUNTING_RULES } from './outcomes.js';

/*
 * The one result model. Every surface — the chat block, the board, the CLI summary, the CI exit
 * code and the report — renders a `ResultView`, and a ResultView is built from `deriveRun` and
 * nothing else, so no two surfaces can disagree about a run. It holds numbers, typed reasons and
 * the owner's own quotes; the words around them live in result-text.ts. Pure: no I/O, no escaping.
 */

export { SMALL_SAMPLE, wilson } from './interval.js';

/** Why a situation was not measured, in the owner's words: the tail of «не измерено N — …». */
export const NOT_MEASURED_TEXT: Record<NotMeasuredCode, string> = {
  in_progress: 'ещё проверяется',
  not_reached: 'прогон остановился раньше',
  stopped: 'разговор остановлен',
  turn_limit: 'разговор не уложился в лимит реплик',
  simulator_error: 'сбой клиента, которого играет Lab',
  agent_error: 'агент не ответил',
  service_reply: 'вместо агента ответил стенд',
  attempts_mismatch: 'запись разговоров неполная',
  judge_error: 'судья ответил не по формату',
  judge_unavailable: 'судья не ответил — сбой связи или лимит запросов',
  judge_stopped: 'оценку прервали — кончились время или бюджет',
  human_invalid: 'вы отметили разговор как негодный',
  reset_unconfirmed: 'агент не подтвердил сброс состояния',
  simulator_deviated: 'клиент в симуляции отошёл от ситуации',
  simulator_unclear: 'судья не уверен, что клиент держался ситуации',
  human_unknown: 'вы не смогли решить',
  not_judged: 'судья не оценивал',
  judge_split: 'судья не уверен — его оценки разошлись',
  no_evidence: 'в ответе агента нет доказательства',
  judge_unclear: 'правила не дают однозначного ответа',
};

type ExclusionKind = ValidationExclusion['kind'];
const EXCLUSION_ORDER: ExclusionKind[] = ['unconfirmed', 'customer_data', 'masked', 'length'];
const EXCLUSION_TEXT: Record<ExclusionKind, string> = {
  unconfirmed: 'в правилах нет ожидаемого ответа',
  customer_data: 'нужны данные клиента',
  masked: 'реплика клиента скрыта',
  length: 'слишком длинный разговор или нет реплик клиента',
};

/** Non-zero exclusion kinds, most frequent first. The model-written reason is never used. */
export function exclusionCounts(exclusions: ValidationExclusion[]): { kind: ExclusionKind; label: string; count: number }[] {
  return EXCLUSION_ORDER
    .map(kind => ({ kind, label: EXCLUSION_TEXT[kind], count: exclusions.filter(item => item.kind === kind).length }))
    .filter(item => item.count > 0)
    .sort((a, b) => b.count - a.count || EXCLUSION_ORDER.indexOf(a.kind) - EXCLUSION_ORDER.indexOf(b.kind));
}

/** What to do next, typed; each surface words it (chat asks in words, the board has a row, the CLI names a command). */
export type NextStep =
  /** A positive control failed or was not measured: the number cannot be trusted until the connection and the judge are checked. */
  | { kind: 'check_connection' }
  | { kind: 'wait' }
  /** The judge's failures and sampled passes still wait for the owner's «да» or «нет». */
  | { kind: 'review_judge'; failures: number; passes: number; unsure: number }
  /** Nothing was decided: the reasons of the unmeasured situations are the next thing to read. */
  | { kind: 'why_unmeasured'; count: number }
  | { kind: 'repeat' }
  | { kind: 'report' };

export interface ResultCard {
  scenarioId: string; title: string;
  /** The headline verdict; a control is decided by its goal alone. */
  outcome: Verdict; reason?: NotMeasuredCode;
  /** The goal and the prompt-rule halves of an old generated card's verdict; 'none' when the card has no such check. */
  goal: Verdict | 'none'; rules: Verdict | 'none';
  /**
   * The parts of the verdict in the owner's words: a card's expectations А, Б, В (each over every attempt),
   * or «Цель» and «Правила промпта»; empty for a legacy card decided by its strict result.
   */
  parts: CardPart[];
  control: boolean;
  /** Repeats inside this run disagreed (E6). */
  flaky: boolean;
  /** The verdict flipped against the source run of a repeat or a reassessment. */
  unstable: boolean;
  provenance: Scenario['provenance'];
}

export interface ResultView {
  runId: string;
  phase: Experiment['phase'];
  mode: Experiment['mode'];
  createdAt: string;
  /** The counting rules the counted situations are decided by (card/expectations.ts), in record order; the default rule on a run without them. */
  countingRules: string;
  /** Situations handled out of those decided, over the counted (non-control) situations. */
  headline: { passed: number; decided: number; accuracy: number | null; range: [number, number] | null; smallSample: boolean };
  /** Situations still waiting in a running phase; never part of notMeasured. */
  pending: number;
  notMeasured: { total: number; reasons: { code: NotMeasuredCode; label: string; count: number; scenarioIds: string[] }[] };
  /** The positive controls; `alarm` is set when one failed or could not be measured: then the number is not to be trusted yet. */
  control: { cards: ResultCard[]; alarm: 'failed' | 'unmeasured' | 'failed_or_unmeasured' | null };
  /**
   * The two halves of the headline over the counted situations: requests met of those decided, situations that broke a
   * prompt rule of those where the rules were decided, the rule broken more often than any other (named only with a
   * strict top count) and the counted situations without the prompt-rule check. Never changes the headline.
   */
  breakdown: { goal: { met: number; decided: number }; rules: { broken: number; decided: number; commonRule: number | null; commonRuleCount: number }; withoutRules: number };
  /** Logged conversations left out of a validation set, with the kinds; never in the denominator. */
  coverage: { examined: number; included: number; excluded: { kind: ExclusionKind; label: string; count: number }[] };
  cards: ResultCard[];
  /** One explanation per failed counted situation, in record order; built from stored data only. */
  failures: FailureExplanation[];
  /** Up to three failure causes, largest first; each names its distinct failed situations and carries one full explanation. */
  topCauses: { name: string; count: number; scenarioIds: string[]; example: FailureExplanation }[];
  /** Per-topic rows and the traffic-weighted estimate, when the run's situations come from at least two topics. */
  topics: TopicView | null;
  /** How much of the logs' traffic the counted situations cover: a run of cards sampled from logs whose topics were mapped; null otherwise. */
  topicCoverage: TopicCoverage | null;
  /** Found flips against the source run; absent when there is nothing to compare with. Never changes the headline. */
  stability?: Stability;
  /** How often the owner confirmed the judge's own decisions with one-key marks. Never changes the headline. */
  agreement: JudgeAgreement;
  /** The same situations judged on their recorded conversations (card/calibration-view.ts); absent without a calibration. Never changes the headline. */
  calibration?: CalibrationView;
  /**
   * Counted situations the owner reviewed in full — a verdict on the whole dialogue or on a metric that
   * decides it, not a one-key mark — and among them those where the owner's verdict on the whole
   * dialogue says the opposite of the headline. A verdict on a metric moves the number; a verdict on
   * the whole dialogue does not (counting rule), so a contradiction is named, never silently absorbed.
   */
  reviewed: { situations: number; contradicted: number };
  /** `target` is the agent version the owner or the adapter named; null when none was named (a fingerprint is not a name). */
  scope: { cards: number; synthetic: number; dialogues: number; judgeModel?: string; costUsd: number | null; target: string | null };
  /** Ordered: the recommended step first, then what can always be done with a finished result. */
  next: NextStep[];
}

/** The source run to check stability against; the record's own parent or the run it reassessed. */
function stabilityOf(input: Experiment, before: Experiment | undefined): Stability | undefined {
  if (!before) return undefined;
  if (input.assessmentOf === before.id) return stabilityAfterReassess(input, before) ?? undefined;
  return stabilityBetweenRuns(before, input);
}

/**
 * The recorded failure clusters, counted in failed headline situations only. The example is the
 * explanation of the first failing cluster attempt whose goal failed (alone or with the rules), or
 * the situation's own one.
 */
function causesOf(run: RunDerivation, failures: FailureExplanation[]): ResultView['topCauses'] {
  const { record } = run;
  const failed = new Map(failures.map(item => [item.scenarioId, item]));
  return (record.failureModes ?? []).flatMap(mode => {
    const attempts = mode.trialIds.flatMap(id => run.attempt(id)?.trial ?? []).filter(trial => failed.has(trial.scenarioId));
    const [first] = attempts;
    if (!first) return [];
    const own = attempts.map(trial => failureExplanation(record, run.situation(trial.scenarioId)!.scenario, trial)).find(item => !!item && item.kind !== 'rules');
    const scenarioIds = [...new Set(attempts.map(trial => trial.scenarioId))];
    return [{ name: mode.name, count: scenarioIds.length, scenarioIds, example: own ?? failed.get(first.scenarioId)! }];
  })
    // Array.prototype.sort is stable: equal counts keep the recorded cluster order.
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
}

/**
 * The breakdown over the counted situations. The most frequent rule is read the way the explanation
 * names it — the first attempt of each rule-breaking situation whose rules the judge failed — and
 * named only when its count is strictly above every other named rule's.
 */
function breakdownOf(run: RunDerivation, counted: ResultCard[]): ResultView['breakdown'] {
  const { record } = run;
  const goal = { met: counted.filter(card => card.goal === 'pass').length, decided: counted.filter(card => card.goal === 'pass' || card.goal === 'fail').length };
  const tally = new Map<number, number>();
  for (const card of counted.filter(card => card.rules === 'fail')) {
    const attempt = run.situation(card.scenarioId)!.attempts.find(item => agentMetricResult(item.trial, RULES_METRIC_ID, record.humanReviews) === 'fail');
    const number = attempt ? violatedRuleNumber(record, attempt.trial) : null;
    if (number !== null) tally.set(number, (tally.get(number) ?? 0) + 1);
  }
  const [top, next] = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const commonRule = top && (!next || top[1] > next[1]) ? top[0] : null;
  return {
    goal,
    rules: { broken: counted.filter(card => card.rules === 'fail').length, decided: counted.filter(card => card.rules === 'pass' || card.rules === 'fail').length,
      commonRule, commonRuleCount: top && commonRule !== null ? top[1] : 0 },
    withoutRules: counted.filter(card => card.goal !== 'none' && card.rules === 'none').length,
  };
}

/**
 * The counted situations the owner reviewed in full, and their attempts: a current human verdict on
 * the whole dialogue or on a metric that decides the situation (the headline halves; every agent
 * rubric of a strict legacy card), never a one-key mark, which the agreement counts instead.
 */
function fullyReviewed(run: RunDerivation): { situations: number; contradicted: number; trialIds: Set<string> } {
  const latest = latestHumanReviews(run.record);
  const trialIds = new Set<string>();
  let situations = 0, contradicted = 0;
  for (const item of run.situations) {
    if (item.control) continue;
    const ids = headlineMetricIds(item.scenario);
    const metrics = ids.length ? ids : (item.scenario.metrics ?? []).filter(metric => metric.subject === 'agent').map(metric => metric.id);
    const keys = ['dialogue', ...metrics.map(id => `metric:${id}`)];
    const own = item.attempts.filter(({ trial }) => keys.some(key => {
      const review = latest.get(`${trial.id}|${key}`);
      return !!review && review.source !== 'quick' && review.verdict !== 'invalid';
    }));
    if (own.length) situations++;
    for (const { trial } of own) trialIds.add(trial.id);
    const said = own.map(({ trial }) => latest.get(`${trial.id}|dialogue`)).filter(review => review?.source !== 'quick').map(review => review?.verdict);
    if ((item.outcome === 'pass' || item.outcome === 'fail') && said.some(verdict => (verdict === 'pass' || verdict === 'fail') && verdict !== item.outcome)) contradicted++;
  }
  return { situations, contradicted, trialIds };
}

/** A control the run could not measure: `unknown` with a recorded reason other than «still running». */
export function unmeasuredControl(card: Pick<ResultCard, 'outcome' | 'reason'>): boolean {
  return card.outcome === 'unknown' && !!card.reason && card.reason !== 'in_progress';
}

/**
 * The recommended step first — a control alarm, a run still going, the judge's review queue,
 * nothing decided, then fixing the agent when it failed — followed by what a finished result always
 * offers: the customer report and a repeat. A draft that never ran offers nothing.
 */
function nextSteps(view: Omit<ResultView, 'next'>, running: boolean, notStarted: boolean, reviewedTrials: Set<string>): NextStep[] {
  if (notStarted) return [];
  if (view.control.alarm) return [{ kind: 'check_connection' }];
  if (running) return [{ kind: 'wait' }];
  const { queueFailures, sampledPasses, marks } = view.agreement;
  // A situation the owner reviewed in full has been decided by the owner: it no longer waits for a one-key answer.
  const unmarked = view.agreement.unmarked.filter(id => !reviewedTrials.has(id));
  const failures = unmarked.filter(id => queueFailures.includes(id)).length;
  const passes = unmarked.filter(id => sampledPasses.includes(id)).length;
  // «Не могу сказать» keeps a situation in the queue: it is doubt, not a decision.
  const unsure = marks.filter(mark => !mark.stale && mark.answer === 'unsure' && (queueFailures.includes(mark.trialId) || sampledPasses.includes(mark.trialId))).length;
  const steps: NextStep[] = [];
  if (failures + passes + unsure > 0) steps.push({ kind: 'review_judge', failures, passes, unsure });
  if (!view.headline.decided && view.notMeasured.total) steps.push({ kind: 'why_unmeasured', count: view.notMeasured.total });
  if (!view.headline.decided) return steps;
  const failed = view.headline.decided > view.headline.passed;
  return [...steps, ...(failed ? [{ kind: 'repeat' } as const, { kind: 'report' } as const] : [{ kind: 'report' } as const, { kind: 'repeat' } as const])];
}

/** `numbers` places the logged dialogues of a card run in their imports («диалог №17»); without it a disagreement names the dialogue without its number. */
export function buildResultView(input: Experiment, options: { before?: Experiment; numbers?: DialogueNumbers } = {}): ResultView {
  const run = deriveRun(input);
  const { record } = run;
  const found = stabilityOf(input, options.before);
  const unstableIds = new Set(found?.unstable.map(row => row.scenarioId) ?? []);
  const stability = found && { ...found, unstable: found.unstable.filter(row => !run.situation(row.scenarioId)?.control) };
  const cards: ResultCard[] = run.situations.map(item => ({
    scenarioId: item.scenario.id, title: item.scenario.title, outcome: item.outcome, ...(item.reason ? { reason: item.reason } : {}),
    goal: item.goal, rules: item.rules, parts: item.parts, control: item.control, flaky: item.flaky, unstable: unstableIds.has(item.scenario.id), provenance: item.scenario.provenance,
  }));
  const counted = cards.filter(card => !card.control);
  const countingRules = [...new Set(run.situations.filter(item => !item.control)
    .map(item => countingRuleOf(item.scenario, headlineRule(item.scenario, item.attempts.map(attempt => attempt.trial)))))].join(', ') || COUNTING_RULES;
  const failures = counted.filter(card => card.outcome === 'fail')
    .flatMap(card => failureExplanation(record, run.situation(card.scenarioId)!.scenario) ?? []);
  const passed = counted.filter(card => card.outcome === 'pass').length;
  const decided = passed + counted.filter(card => card.outcome === 'fail').length;
  const accuracy = decided ? passed / decided : null;
  // A draft that never ran has nothing pending and nothing unmeasured yet; its cards keep their reason.
  const notStarted = !record.trials.length && (record.phase === 'preparing' || record.phase === 'review');
  const reasons = notStarted ? [] : NOT_MEASURED_CODES.filter(code => code !== 'in_progress').map(code => {
    const scenarioIds = counted.filter(card => card.outcome === 'unknown' && card.reason === code).map(card => card.scenarioId);
    return { code, label: NOT_MEASURED_TEXT[code], count: scenarioIds.length, scenarioIds };
  }).filter(reason => reason.count > 0)
    // Array.prototype.sort is stable, so equal counts keep NOT_MEASURED_CODES order.
    .sort((a, b) => b.count - a.count);
  const controls = cards.filter(card => card.control);
  const controlFailed = controls.some(card => card.outcome === 'fail');
  const controlUnmeasured = controls.some(unmeasuredControl);
  const alarm = notStarted ? null : controlFailed && controlUnmeasured ? 'failed_or_unmeasured' : controlFailed ? 'failed' : controlUnmeasured ? 'unmeasured' : null;
  const exclusions = record.validationExclusions ?? [];
  const model = judgeModel(record);
  const reviewed = fullyReviewed(run);
  const view: Omit<ResultView, 'next'> = {
    runId: record.id, phase: record.phase, mode: record.mode, createdAt: record.createdAt, countingRules,
    headline: { passed, decided, accuracy, range: wilson(passed, decided), smallSample: decided > 0 && decided < SMALL_SAMPLE },
    pending: notStarted ? 0 : counted.filter(card => card.reason === 'in_progress').length,
    notMeasured: { total: reasons.reduce((n, reason) => n + reason.count, 0), reasons },
    control: { cards: controls, alarm },
    breakdown: breakdownOf(run, counted),
    coverage: { examined: record.dialogues.length + exclusions.length, included: record.dialogues.length, excluded: exclusionCounts(exclusions) },
    cards, failures, topCauses: causesOf(run, failures),
    topics: topicView(record, cards), topicCoverage: trafficCoverage(record, cards),
    agreement: judgeAgreement(input),
    reviewed: { situations: reviewed.situations, contradicted: reviewed.contradicted },
    scope: {
      cards: record.scenarios.length,
      synthetic: record.scenarios.filter(scenario => scenario.provenance === 'synthetic').length,
      dialogues: record.trials.length,
      ...(model ? { judgeModel: model } : {}),
      costUsd: record.usage.costUsd,
      target: record.targetVersion ?? record.targetRelease ?? null,
    },
    ...(stability ? { stability } : {}),
  };
  const calibration = buildCalibration(run, options.numbers ? { numbers: options.numbers } : {});
  return { ...view, ...(calibration ? { calibration } : {}), next: nextSteps(view, isRunning(record.phase), notStarted, reviewed.trialIds) };
}

/**
 * The CI exit status, read from the same view the owner reads: 2 when the measurement is incomplete
 * (the run did not finish, a situation was not measured or is still pending, or a control raised the
 * alarm) — it takes precedence over an agent failure; 1 when the agent failed a counted situation;
 * 0 when every counted situation was decided and handled.
 */
export function exitCodeOf(view: ResultView): 0 | 1 | 2 {
  const finished = view.phase === 'results_review' || view.phase === 'complete';
  if (!finished || view.notMeasured.total > 0 || view.pending > 0 || view.control.alarm || !view.headline.decided) return 2;
  return view.headline.passed < view.headline.decided ? 1 : 0;
}
