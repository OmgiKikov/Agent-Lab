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
 */

export type Expectation = CardExecution['evaluatorView']['expectations'][number];
/** An expectation of the rule with the letter the owner reads it by (А, Б, В…). */
export type CountedExpectation = Expectation & { letter: string };

export type HeadlineRule =
  /** A card, or a first-format card judged through its projection: every expectation, in every attempt. */
  | { kind: 'expectations'; ids: string[]; labels: Record<string, string>; expectations: CountedExpectation[] }
  /** An old generated card: its goal and, where it has them, its prompt rules. */
  | { kind: 'goal_rules'; ids: string[] }
  /** A legacy card without the goal rubric, including first-format attempts with checkpoint verdicts: the strict automatic result. */
  | { kind: 'strict' };

/** The agent metric the headline reads first on an old generated card: whether the client's request was carried out. */
export const GOAL_METRIC_ID = 'goal_attainment';
/** The agent metric that says whether the agent kept the observable rules of its own prompt. */
export const RULES_METRIC_ID = 'prompt_compliance';

/**
 * The expectations these attempts of a card are judged by, with their letters; undefined when the card is
 * not judged by expectations. One attempt with a checkpoint verdict keeps the whole card on its frozen rule.
 */
function judgedExpectations(scenario: Scenario | undefined, trials: readonly Pick<Trial, 'checkpoints' | 'checkpointReceipt'>[]): CountedExpectation[] | undefined {
  const execution = scenario?.execution;
  if (!execution) return undefined;
  if (isCardExecution(execution)) return execution.evaluatorView.expectations.map(expectation => ({ ...expectation, letter: expectationLetter(expectation.id) }));
  if (trials.some(judgedByCheckpoints)) return undefined;
  return projectedExpectations(execution).map((expectation, index) => ({ ...expectation, letter: projectedLetter(index) }));
}

/** The counting rule of a card over these attempts. */
export function headlineRule(scenario: Scenario | undefined, trials: readonly Pick<Trial, 'checkpoints' | 'checkpointReceipt'>[]): HeadlineRule {
  const expectations = judgedExpectations(scenario, trials);
  if (expectations) return { kind: 'expectations', ids: expectations.map(expectation => expectation.id),
    labels: Object.fromEntries(expectations.map(expectation => [expectation.id, expectation.letter])), expectations };
  const agent = (scenario?.metrics ?? []).filter(metric => metric.subject === 'agent').map(metric => metric.id);
  if (!agent.includes(GOAL_METRIC_ID)) return { kind: 'strict' };
  return { kind: 'goal_rules', ids: agent.includes(RULES_METRIC_ID) ? [GOAL_METRIC_ID, RULES_METRIC_ID] : [GOAL_METRIC_ID] };
}

/**
 * The name of the counting rule a quick mark is stamped with, so a mark given under another rule is never
 * counted silently. `goal-and-rules-v2` is the name every mark was stamped with before cards; a first-format
 * card with checkpoint verdicts is counted by its frozen `library-v1` rule.
 */
export type CountingRule = 'all-expectations-v1' | 'goal-and-rules-v2' | 'library-v1';
export function countingRuleOf(scenario: Scenario | undefined, rule: HeadlineRule): CountingRule {
  return rule.kind === 'expectations' ? 'all-expectations-v1' : rule.kind === 'strict' && scenario?.execution ? 'library-v1' : 'goal-and-rules-v2';
}

/** The state was observed and its reset confirmed, so a state event proves something. */
const stateObserved = (trial: Trial): boolean => !!trial.observation && trial.observation.state !== 'missing'
  && (trial.observation.state === 'sandbox' || trial.observation.resetConfirmed === true);

/** The events of the agent's side of a dialogue: what it said and what its tool log shows. */
const AGENT_SIDE: ReadonlySet<Trial['events'][number]['type']> = new Set(['assistant', 'tool_call', 'tool_result']);

/**
 * The judge's own verdict on one expectation, read through the channel the expectation is observed on:
 * - reply: a pass or a fail stands only when the judge cited an agent reply;
 * - tool: only on a tool log the connection confirmed complete. A pass stands only when the judge cited a
 *   tool result: the agent saying it acted is not the action. A fail stands when the judge cited any event
 *   of the agent's side (a reply, a tool call or a tool result): on a complete log the missing call is proven
 *   by the log itself, and a reply claiming the action is evidence of that failure. Citing only the customer
 *   proves nothing; a partial log proves no absence.
 * - state: a pass or a fail stands only on a cited observed state whose reset was confirmed.
 * Otherwise it is unknown (`no_evidence`). The raw judgment stays stored as it was; only its reading is gated
 * here. The compiled rubric's TOOL_LOG_RULE is unchanged: it is sealed into accepted definition hashes.
 */
export function recordedExpectationResult(trial: Trial, expectation: Pick<Expectation, 'id' | 'observation'>): 'pass' | 'fail' | 'unknown' | undefined {
  const assessment = trial.assessments?.find(item => item.metricId === expectation.id);
  if (!assessment || assessment.result === 'unknown') return assessment?.result;
  const cited = trial.events.filter(event => assessment.evidence.includes(event.seq));
  const channel = expectation.observation === 'reply' ? cited.some(event => event.type === 'assistant')
    : expectation.observation === 'tool' ? trial.observation?.tools === 'complete'
      && cited.some(event => assessment.result === 'pass' ? event.type === 'tool_result' : AGENT_SIDE.has(event.type))
    : stateObserved(trial) && cited.some(event => event.state !== undefined);
  return channel ? assessment.result : 'unknown';
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
