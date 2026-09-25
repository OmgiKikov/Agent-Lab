import { isCardExecution, type CardExecution, type Scenario, type Trial } from '../contracts.js';
import { expectationLetter } from './compile.js';
import { judgedByCheckpoints, projectedExpectations, projectedLetter } from './legacy-v1.js';

/*
 * How a card's verdict is counted, as a typed rule instead of an implicit convention. A compiled card is
 * counted by its expectations: it is «справился» only when every expectation passed in every attempt.
 * A first-format card judged again (repeat, reassessment) is counted the same way through its projection;
 * one whose attempts carry the checkpoint judge's verdicts keeps that frozen rule, like every other legacy
 * card without the goal rubric (`strict`). Old generated cards keep goal and prompt rules (`goal_rules`).
 * Pure: human verdicts are applied by the callers (outcomes.ts).
 *
 * The rules have editions. An attempt carries the edition it was recorded under (`Trial.countingVersion`), so a
 * stored run is read exactly as it was counted and every new run or re-assessment by the current edition:
 *
 *   edition 1 (no stamp)   every attempt must be a usable measurement before any verdict is read: one unmeasured
 *                          attempt leaves the situation «не измерено» even when another one failed; a tool
 *                          expectation stands only on a cited tool result.
 *   edition 2              a usable failure in any attempt fails the situation before usability is asked, and
 *                          usability guards only «справился». With a complete tool log a failed tool expectation
 *                          stands without a cited tool result — the log shows the call was never made — while a
 *                          pass still needs one.
 *   edition 3 (current)    as edition 2, and the heuristic checks of the customer Lab plays (a repeat, a value not in
 *                          its card) are notes for review: they take an attempt out of the count only once a person
 *                          confirms them. The judge's verdict that the customer left its situation still does.
 *
 * Each edition decides every situation the one before decides, the same way; each only stops hiding failures.
 */

export type Expectation = CardExecution['evaluatorView']['expectations'][number];
/** An expectation of the rule with the letter the owner reads it by (А, Б, В…). */
export type CountedExpectation = Expectation & { letter: string };

/** The edition of the counting rules every attempt is recorded under now; the stored attempt field accepts 2 and 3. */
export const COUNTING_VERSION = 3;
export type CountingVersion = 1 | 2 | typeof COUNTING_VERSION;
/** The edition one attempt is read by: the one it was recorded under, 1 when it carries none. */
export const editionOf = (trial: Pick<Trial, 'countingVersion'>): CountingVersion => trial.countingVersion ?? 1;

/**
 * The edition these attempts are counted by: the oldest one among them, as with a checkpoint verdict one older attempt
 * keeps the whole card on the older rule. A situation with no attempt yet waits for attempts of the current edition.
 */
export function countingVersionOf(trials: readonly Pick<Trial, 'countingVersion'>[]): CountingVersion {
  return trials.reduce<CountingVersion>((oldest, trial) => editionOf(trial) < oldest ? editionOf(trial) : oldest, COUNTING_VERSION);
}

export type HeadlineRule =
  /** A card, or a first-format card judged through its projection: every expectation, in every attempt. */
  | { kind: 'expectations'; version: CountingVersion; ids: string[]; labels: Record<string, string>; expectations: CountedExpectation[] }
  /** An old generated card: its goal and, where it has them, its prompt rules. */
  | { kind: 'goal_rules'; version: CountingVersion; ids: string[] }
  /** A legacy card without the goal rubric, including first-format attempts with checkpoint verdicts: the strict automatic result. */
  | { kind: 'strict'; version: CountingVersion };

/** The agent metric the headline reads first on an old generated card: whether the client's request was carried out. */
export const GOAL_METRIC_ID = 'goal_attainment';
/** The agent metric that says whether the agent kept the observable rules of its own prompt. */
export const RULES_METRIC_ID = 'prompt_compliance';

type CountedTrial = Pick<Trial, 'checkpoints' | 'checkpointReceipt' | 'countingVersion'>;

/**
 * The expectations these attempts of a card are judged by, with their letters; undefined when the card is
 * not judged by expectations. One attempt with a checkpoint verdict keeps the whole card on its frozen rule.
 */
function judgedExpectations(scenario: Scenario | undefined, trials: readonly CountedTrial[]): CountedExpectation[] | undefined {
  const execution = scenario?.execution;
  if (!execution) return undefined;
  if (isCardExecution(execution)) return execution.evaluatorView.expectations.map(expectation => ({ ...expectation, letter: expectationLetter(expectation.id) }));
  if (trials.some(judgedByCheckpoints)) return undefined;
  return projectedExpectations(execution).map((expectation, index) => ({ ...expectation, letter: projectedLetter(index) }));
}

/** The counting rule of a card over these attempts, in the edition they were recorded under. */
export function headlineRule(scenario: Scenario | undefined, trials: readonly CountedTrial[]): HeadlineRule {
  const version = countingVersionOf(trials);
  const expectations = judgedExpectations(scenario, trials);
  if (expectations) return { kind: 'expectations', version, ids: expectations.map(expectation => expectation.id),
    labels: Object.fromEntries(expectations.map(expectation => [expectation.id, expectation.letter])), expectations };
  const agent = (scenario?.metrics ?? []).filter(metric => metric.subject === 'agent').map(metric => metric.id);
  if (!agent.includes(GOAL_METRIC_ID)) return { kind: 'strict', version };
  return { kind: 'goal_rules', version, ids: agent.includes(RULES_METRIC_ID) ? [GOAL_METRIC_ID, RULES_METRIC_ID] : [GOAL_METRIC_ID] };
}

/**
 * The name of the counting rule a quick mark is stamped with and a result is counted by, so a mark given under
 * another rule is never counted silently. `goal-and-rules-v2` is the name every mark was stamped with before cards;
 * a first-format card with checkpoint verdicts is counted by its frozen `library-v1` rule, which has no later edition.
 * A card counted by its expectations is `all-expectations-v1` in edition 1 and `all-expectations-v2` in edition 2,
 * every other card `goal-and-rules-v2` and `goal-and-rules-v3`.
 */
export type CountingRule = 'all-expectations-v1' | 'all-expectations-v2' | 'all-expectations-v3' | 'goal-and-rules-v2' | 'goal-and-rules-v3' | 'goal-and-rules-v4' | 'library-v1';
export function countingRuleOf(scenario: Scenario | undefined, rule: HeadlineRule): CountingRule {
  if (rule.kind === 'expectations') return rule.version === 3 ? 'all-expectations-v3' : rule.version === 2 ? 'all-expectations-v2' : 'all-expectations-v1';
  if (rule.kind === 'strict' && scenario?.execution) return 'library-v1';
  return rule.version === 3 ? 'goal-and-rules-v4' : rule.version === 2 ? 'goal-and-rules-v3' : 'goal-and-rules-v2';
}

/** How a situation is counted under each rule, in the owner's words: the one line «Как считали» shows for it. */
export const COUNTING_RULE_TEXT: Record<CountingRule, string> = {
  'all-expectations-v3': 'Агент справился с ситуацией, если выполнил все её ожидания в каждой попытке. Ошибка в любой измеренной попытке — провал, даже если другую попытку измерить не удалось; при полном журнале инструментов пропущенный вызов — тоже ошибка. Подозрения к клиенту, которого играет Lab, — пометки на разбор: попытку убирает из счёта только подтверждённый сбой клиента.',
  'all-expectations-v2': 'Агент справился с ситуацией, если выполнил все её ожидания в каждой попытке. Ошибка в любой измеренной попытке — провал, даже если другую попытку измерить не удалось; при полном журнале инструментов пропущенный вызов — тоже ошибка.',
  'all-expectations-v1': 'Агент справился с ситуацией, если выполнил все её ожидания в каждой попытке, и провалил её при ошибке в любой попытке — но только когда измерены все попытки; иначе ситуация не измерена.',
  'goal-and-rules-v4': 'Агент справился с ситуацией, если в каждой попытке выполнил запрос клиента и не нарушил правила промпта. Ошибка в любой измеренной попытке — провал, даже если другую попытку измерить не удалось. Подозрения к клиенту, которого играет Lab, — пометки на разбор: попытку убирает из счёта только подтверждённый сбой клиента.',
  'goal-and-rules-v3': 'Агент справился с ситуацией, если в каждой попытке выполнил запрос клиента и не нарушил правила промпта. Ошибка в любой измеренной попытке — провал, даже если другую попытку измерить не удалось.',
  'goal-and-rules-v2': 'Агент справился с ситуацией, если в каждой попытке выполнил запрос клиента и не нарушил правила промпта, и провалил её при ошибке в любой попытке — но только когда измерены все попытки; иначе ситуация не измерена.',
  'library-v1': 'Ситуация первого формата: агент справился, если прошёл все обязательные контрольные точки так, как их оценил судья при прогоне; провал любой точки — провал ситуации.',
};

/** The owner's line for a rule a result names (`ResultView.countingRules` lists them joined by «, »); undefined for a name it does not know. */
export const countingRuleText = (rule: string): string | undefined =>
  Object.hasOwn(COUNTING_RULE_TEXT, rule) ? COUNTING_RULE_TEXT[rule as CountingRule] : undefined;

/** The state was observed and its reset confirmed, so a state event proves something. */
const stateObserved = (trial: Trial): boolean => !!trial.observation && trial.observation.state !== 'missing'
  && (trial.observation.state === 'sandbox' || trial.observation.resetConfirmed === true);

/** What the events a verdict cites show: an agent reply, results of tools (by name; undefined where the record names none), an observed state. */
export interface CitedChannels { reply: boolean; tools: readonly (string | undefined)[]; state: boolean }
/** What a conversation's record can show at all: a complete tool log, an observed state, and the edition of the rules it is read by. */
export interface ChannelScope { toolsComplete: boolean; stateObserved: boolean; edition: CountingVersion }

/**
 * The channel rule of a verdict — the one rule of both judgments, of a run's attempt and of a logged conversation
 * (log-judge.ts): a pass or a fail stands only on its expectation's channel. A reply on a cited agent reply; a state on a
 * cited state of a conversation whose state was observed; a tool only on a complete tool log — a pass on a cited result
 * of the tool the expectation names (of any tool when it names none: another tool's call proves nothing about it, and the
 * agent's words never prove an action), and from edition 2 a failure without one: a complete log holds every call the
 * agent made, so the call the expectation asks for was never made.
 */
export function channelHolds(expectation: Pick<Expectation, 'observation' | 'tool'>, result: 'pass' | 'fail', cited: CitedChannels, scope: ChannelScope): boolean {
  switch (expectation.observation) {
    case 'reply': return cited.reply;
    case 'tool': return scope.toolsComplete && (cited.tools.some(tool => expectation.tool === undefined || tool === expectation.tool) || result === 'fail' && scope.edition >= 2);
    case 'state': return scope.stateObserved && cited.state;
  }
}

/**
 * The judge's own verdict on one expectation, read through the channel the expectation is observed on (channelHolds):
 * otherwise it is unknown (`no_evidence`). The raw judgment stays stored as it was; only its reading is gated here.
 */
export function recordedExpectationResult(trial: Trial, expectation: Pick<Expectation, 'id' | 'observation' | 'tool'>): 'pass' | 'fail' | 'unknown' | undefined {
  const assessment = trial.assessments?.find(item => item.metricId === expectation.id);
  if (!assessment || assessment.result === 'unknown') return assessment?.result;
  const cited = trial.events.filter(event => assessment.evidence.includes(event.seq));
  const holds = channelHolds(expectation, assessment.result, {
    reply: cited.some(event => event.type === 'assistant'), tools: cited.filter(event => event.type === 'tool_result').map(event => event.tool), state: cited.some(event => event.state !== undefined),
  }, { toolsComplete: trial.observation?.tools === 'complete', stateObserved: stateObserved(trial), edition: editionOf(trial) });
  return holds ? assessment.result : 'unknown';
}

/** The votes one expectation received, from the receipt or the full audit; a vote that failed has no result. */
function votes(trial: Trial, metricId: string): ('pass' | 'fail' | 'unknown' | undefined)[] {
  if (trial.judgeReceipt) return trial.judgeReceipt.votes.filter(vote => vote.metricId === metricId).map(vote => vote.result);
  return (trial.judgeAudit?.attempts ?? []).filter(attempt => attempt.metricId === metricId && !attempt.superseded).map(attempt => attempt.assessments?.[0]?.result);
}

/**
 * Why the judge's reading of one expectation decided nothing, from what was recorded rather than from its
 * wording: no judgment at all, two votes that disagreed, a verdict without evidence on its channel, or a
 * judge that could not tell.
 */
export function undecidedExpectation(trial: Trial, expectation: Pick<Expectation, 'id' | 'observation'>): 'not_judged' | 'judge_split' | 'no_evidence' | 'judge_unclear' {
  const assessment = trial.assessments?.find(item => item.metricId === expectation.id);
  if (!assessment) return 'not_judged';
  if (assessment.result !== 'unknown') return 'no_evidence';
  const [first, second, ...more] = votes(trial, expectation.id);
  return !more.length && first !== undefined && second !== undefined && first !== second ? 'judge_split' : 'judge_unclear';
}
