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
import { customerMoves, type CustomerMoves } from './customer-moves.js';
import type { DialogueNumbers } from './card/view.js';
import { ruleBar, type RuleBar } from './card/rulebook.js';
import { judgeCheckSummary, type JudgeCheck, type JudgeCheckSummary } from './judge-check.js';
import { roleChoices } from './llm/models.js';

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
  measurement_error: 'подключение не показало, что нужно для проверки',
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

/** The reasons that name the owner, as a page for someone else says them: about the owner of the agent, never to them. */
export const NOT_MEASURED_ABOUT_OWNER: Partial<Record<NotMeasuredCode, string>> = {
  human_invalid: 'владелец агента отметил разговор как негодный',
  human_unknown: 'владелец агента не смог решить',
};

/**
 * On whose side a situation could not be measured, the one table of it: the agent (it did not answer, a stand replied,
 * its state was not reset), the customer Lab plays (it left the situation, failed, or the conversation outgrew the
 * limit), or the judge (it failed to answer); null where the reason is the run's, the record's or the owner's own.
 * Each side asks the owner a different decision (inbox.ts), and a customer's side is a problem of the test (problems.ts).
 */
export const NOT_MEASURED_SIDE: Record<NotMeasuredCode, 'agent' | 'client' | 'judge' | null> = {
  in_progress: null, not_reached: null, stopped: null, attempts_mismatch: null, human_invalid: null, human_unknown: null,
  agent_error: 'agent', service_reply: 'agent', measurement_error: 'agent', reset_unconfirmed: 'agent',
  turn_limit: 'client', simulator_error: 'client', simulator_deviated: 'client', simulator_unclear: 'client',
  judge_error: 'judge', judge_unavailable: 'judge', judge_stopped: 'judge',
  not_judged: null, judge_split: null, no_evidence: null, judge_unclear: null,
};

/**
 * From this share of the counted situations left unmeasured the number is not to be trusted yet, like after a failed
 * control: it stands on too few of the situations it names, and which ones fell out is not chance.
 */
export const UNMEASURED_ALARM = 0.2;

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
  notMeasured: {
    total: number; reasons: { code: NotMeasuredCode; label: string; count: number; scenarioIds: string[] }[];
    /** The counted situations the share is taken of: decided, not measured and still waiting. */
    of: number;
    /**
     * At least UNMEASURED_ALARM of the counted situations were not measured while some were decided: the number stands on
     * too few of them to be trusted yet. Every surface raises it above the number, like a failed control.
     */
    alarm: boolean;
  };
  /** The positive controls; `alarm` is set when one failed or could not be measured: then the number is not to be trusted yet. */
  control: { cards: ResultCard[]; alarm: 'failed' | 'unmeasured' | 'failed_or_unmeasured' | null };
  /**
   * The two halves of the headline over the counted situations: requests met of those decided, situations that broke a
   * prompt rule of those where the rules were decided, the rule broken more often than any other (named only with a
   * strict top count) and the counted situations without the prompt-rule check. Never changes the headline.
   */
  breakdown: { goal: { met: number; decided: number }; rules: { broken: number; decided: number; commonRule: number | null; commonRuleCount: number }; withoutRules: number };
  /**
   * Counted situations whose customer states the request and those who cannot (card `clarity`), each as handled of
   * decided; absent when no counted situation has a vague customer. Never changes the headline.
   */
  clarity?: { clear: { passed: number; decided: number }; vague: { passed: number; decided: number } };
  /** Logged conversations left out of a validation set, with the kinds; never in the denominator. */
  coverage: { examined: number; included: number; excluded: { kind: ExclusionKind; label: string; count: number }[] };
  cards: ResultCard[];
  /** One explanation per failed counted situation, in record order; built from stored data only. */
  failures: FailureExplanation[];
  /** Up to three failure causes, largest first; each names its distinct failed situations and carries one full explanation. */
  topCauses: { name: string; count: number; scenarioIds: string[]; example: FailureExplanation }[];
  /** Recorded causes of failed situations beyond the three in `topCauses`. */
  moreCauses: number;
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
  /** The judge checked with planted errors and untouched controls (judge-check.ts); absent when this run was never checked. Never changes the headline. */
  judgeCheck?: JudgeCheckSummary;
  /**
   * The judge is the model that built the situations, so the verdicts are not independent of the cards: read from the
   * models the judge's receipts recorded, else from the roles the run's settings resolve to (llm/models.ts roleChoices).
   */
  sameModelJudge?: true;
  /** What the customer Lab played did (customer-moves.ts); absent when no conversation recorded a controlled move. Never changes the headline. */
  customer?: CustomerMoves;
  /**
   * Counted situations the owner reviewed in full — a verdict on the whole dialogue or on a metric that
   * decides it, not a one-key mark — and among them those where the owner's verdict on the whole
   * dialogue says the opposite of the headline. A verdict on a metric moves the number; a verdict on
   * the whole dialogue does not (counting rule), so a contradiction is named, never silently absorbed.
   */
  reviewed: { situations: number; contradicted: number };
  /** The rules the counted situations were judged by, by source, and whether operator instructions bind; null for rules grounded before kinds. */
  bar: RuleBar | null;
  /** `target` is the agent version the owner or the adapter named; null when none was named (a fingerprint is not a name). */
  scope: { cards: number; synthetic: number; dialogues: number; judgeModel?: string; costUsd: number | null; target: string | null;
    /** Expectations of the counted situations observed on the agent's tool calls; absent when there are none. */
    toolExpectations?: number };
  /**
   * What this record's result does not prove (caveats.ts): its typed notes, and the notes a record written before they were
   * typed keeps; result-text.ts words them for their reader. Never changes the headline.
   */
  notes: Pick<Experiment, 'caveats' | 'limitations'>;
  /** Ordered: the recommended step first, then what can always be done with a finished result. */
  next: NextStep[];
}

/** The source run to check stability against; the record's own parent or the run it reassessed. */
function stabilityOf(input: Experiment, before: Experiment | undefined): Stability | undefined {
  if (!before) return undefined;
  if (input.assessmentOf === before.id) return stabilityAfterReassess(input, before) ?? undefined;
  return stabilityBetweenRuns(before, input);
}

/** «Почему ошибается» names this many causes; the rest are only counted. */
const TOP_CAUSES = 3;

/**
 * The recorded failure clusters that hold a failed headline situation, largest first, counted in those situations
 * only. The example is the explanation of the first failing cluster attempt whose goal failed (alone or with the
 * rules), or the situation's own one.
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
    .sort((a, b) => b.count - a.count);
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
 * The recommended step first — a control alarm, a run still going, the reasons of too many unmeasured situations,
 * the judge's review queue, then fixing the agent when it failed — followed by what a finished result always offers:
 * a repeat and, while no alarm stands (a control, the unmeasured share, a judge that failed its check), the customer
 * report. Whenever a situation was not measured, why is always among the steps: first under the alarm, last below it.
 * A draft that never ran offers nothing.
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
  const { alarm, total } = view.notMeasured;
  const why: NextStep[] = total ? [{ kind: 'why_unmeasured', count: total }] : [];
  // Too many situations unmeasured: why is the first thing to read, before any verdict of the judge.
  const steps: NextStep[] = [...(alarm ? why : []), ...(failures + passes + unsure > 0 ? [{ kind: 'review_judge' as const, failures, passes, unsure }] : [])];
  const after = alarm ? [] : why;
  if (!view.headline.decided) return [...steps, ...after];
  const failed = view.headline.decided > view.headline.passed;
  // A report is offered only for a number that can be trusted.
  const report: NextStep[] = alarm || view.judgeCheck?.distrust ? [] : [{ kind: 'report' }];
  return [...steps, ...(failed ? [{ kind: 'repeat' } as const, ...report] : [...report, { kind: 'repeat' } as const]), ...after];
}

/** Clear and vague requests apart, over the counted situations whose card is in the run's library. */
function clarityOf(record: Experiment, counted: readonly ResultCard[]): ResultView['clarity'] {
  const library = record.librarySnapshot;
  if (library?.formatVersion !== 2) return undefined;
  const vague = new Set(library.cards.filter(card => card.clarity === 'vague').map(card => card.id));
  if (!counted.some(card => vague.has(card.scenarioId))) return undefined;
  const tally = (cards: readonly ResultCard[]) => {
    const passed = cards.filter(card => card.outcome === 'pass').length;
    return { passed, decided: passed + cards.filter(card => card.outcome === 'fail').length };
  };
  return { clear: tally(counted.filter(card => !vague.has(card.scenarioId))), vague: tally(counted.filter(card => vague.has(card.scenarioId))) };
}

/**
 * `numbers` places the logged dialogues of a card run in their imports («диалог №17»); without it a disagreement names the dialogue without its number.
 * `judgeCheck` is the run's sidecar as the store read it; a check of another run is ignored.
 */
export function buildResultView(input: Experiment, options: { before?: Experiment; numbers?: DialogueNumbers; judgeCheck?: JudgeCheck | null } = {}): ResultView {
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
  // A situation without an attempt is counted by no rule yet; only when nothing has run do the rules it will be counted by stand in.
  const ruled = run.situations.filter(item => !item.control);
  const countingRules = [...new Set((ruled.some(item => item.attempts.length) ? ruled.filter(item => item.attempts.length) : ruled)
    .map(item => countingRuleOf(item.scenario, headlineRule(item.scenario, item.attempts.map(attempt => attempt.trial)))))].join(', ') || COUNTING_RULES;
  const failures = counted.filter(card => card.outcome === 'fail')
    .flatMap(card => failureExplanation(record, run.situation(card.scenarioId)!.scenario) ?? []);
  const passed = counted.filter(card => card.outcome === 'pass').length;
  const decided = passed + counted.filter(card => card.outcome === 'fail').length;
  const accuracy = decided ? passed / decided : null;
  // A draft that never ran has nothing pending and nothing unmeasured yet; its cards keep their reason.
  const notStarted = !record.trials.length && (record.phase === 'preparing' || record.phase === 'checking' || record.phase === 'review');
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
  const toolExpectations = run.situations.filter(item => !item.control).reduce((n, item) => {
    const rule = headlineRule(item.scenario, item.attempts.map(attempt => attempt.trial));
    return n + (rule.kind === 'expectations' ? rule.expectations.filter(expectation => expectation.observation === 'tool').length : 0);
  }, 0);
  const unmeasured = reasons.reduce((n, reason) => n + reason.count, 0);
  const causes = causesOf(run, failures);
  const view: Omit<ResultView, 'next'> = {
    runId: record.id, phase: record.phase, mode: record.mode, createdAt: record.createdAt, countingRules,
    headline: { passed, decided, accuracy, range: wilson(passed, decided), smallSample: decided > 0 && decided < SMALL_SAMPLE },
    pending: notStarted ? 0 : counted.filter(card => card.reason === 'in_progress').length,
    notMeasured: { total: unmeasured, reasons, of: counted.length,
      alarm: decided > 0 && unmeasured > 0 && unmeasured >= UNMEASURED_ALARM * counted.length },
    control: { cards: controls, alarm },
    breakdown: breakdownOf(run, counted),
    coverage: { examined: record.dialogues.length + exclusions.length, included: record.dialogues.length, excluded: exclusionCounts(exclusions) },
    cards, failures, topCauses: causes.slice(0, TOP_CAUSES), moreCauses: Math.max(0, causes.length - TOP_CAUSES),
    topics: topicView(record, cards), topicCoverage: trafficCoverage(record, cards),
    agreement: judgeAgreement(input),
    reviewed: { situations: reviewed.situations, contradicted: reviewed.contradicted },
    bar: ruleBar(run.situations.filter(item => !item.control).map(item => item.scenario), record.sources,
      record.librarySnapshot?.formatVersion === 2 ? record.librarySnapshot.rulebook : undefined),
    scope: {
      cards: record.scenarios.length,
      synthetic: record.scenarios.filter(scenario => scenario.provenance === 'synthetic').length,
      dialogues: record.trials.length,
      ...(model ? { judgeModel: model } : {}),
      costUsd: record.usage.costUsd,
      target: record.targetVersion ?? record.targetRelease ?? null,
      ...(toolExpectations ? { toolExpectations } : {}),
    },
    notes: { ...(record.caveats ? { caveats: structuredClone(record.caveats) } : {}), limitations: [...record.limitations] },
    ...(stability ? { stability } : {}),
  };
  const clarity = clarityOf(record, counted);
  if (clarity) view.clarity = clarity;
  const calibration = buildCalibration(run, options.numbers ? { numbers: options.numbers } : {});
  if (calibration) view.calibration = calibration;
  const customer = customerMoves(run);
  if (customer) view.customer = customer;
  const judgeCheck = judgeCheckSummary(options.judgeCheck, record);
  if (judgeCheck) view.judgeCheck = judgeCheck;
  if (judgedByBuilder(record)) view.sameModelJudge = true;
  return { ...view, next: nextSteps(view, isRunning(record.phase), notStarted, reviewed.trialIds) };
}

/**
 * Whether the model that built the situations judged them: the models the judge's receipts (or older full audits)
 * recorded when there are any, else the judge the run's settings resolve to. A teaching run calls no model, and a
 * record that names no builder model claims nothing.
 */
function judgedByBuilder(record: Experiment): boolean {
  if (record.mode === 'demo' || !record.trials.length || !record.settings) return false;
  const { builder, judge } = roleChoices(record.settings);
  if (!builder.provider || !builder.model) return false;
  const recorded = record.trials.flatMap(trial => {
    const judged = trial.judgeReceipt ?? trial.judgeAudit;
    return judged ? [{ provider: judged.provider, model: judged.model }] : [];
  });
  return (recorded.length ? recorded : [judge]).some(choice => choice.provider === builder.provider && choice.model === builder.model);
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
