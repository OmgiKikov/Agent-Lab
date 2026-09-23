import type { LogJudge } from '../../src/card/calibration.js';
import { judgeLogged, logProtocolHash } from '../../src/card/log-judge.js';

/*
 * A judge of recorded conversations for tests: the real two-vote protocol (card/log-judge.ts judgeLogged) over
 * scripted answers, so receipts, sidecars and keys are the product's own. No model is called; invented data.
 */

/** The judge's input of one vote, as far as a scripted answer reads it. */
export interface LogVoteInput {
  scenario: { metrics: { id: string }[]; execution: { expectations: { id: string; text: string }[] } };
  dialogue: { observation: string; events: { seq: number; type: string; content: string }[] };
}
/** What one vote says: a verdict on the agent's last reply, «the conversation never got there», «cannot tell», or a malformed answer. */
export type LogVote = 'pass' | 'fail' | 'not_reached' | 'unclear' | 'malformed';

/** A well-formed answer for `vote`: a pass or a fail cites the agent's last reply verbatim. */
export function logAnswer(data: LogVoteInput, vote: Exclude<LogVote, 'malformed'>): string {
  const reply = data.dialogue.events.filter(event => event.type === 'assistant').at(-1);
  const decided = vote === 'pass' || vote === 'fail';
  const conditions = vote === 'pass' ? ['met', 'not_met'] : vote === 'fail' ? ['not_met', 'met'] : vote === 'not_reached' ? ['not_met', 'not_met'] : ['unclear', 'unclear'];
  return JSON.stringify({ assessments: [{ metricId: data.scenario.metrics[0]!.id, passCondition: conditions[0], failCondition: conditions[1],
    rationale: `Сценарный голос: ${vote}.`, evidence: decided && reply ? [reply.seq] : [], citations: decided && reply ? [{ seq: reply.seq, quote: reply.content }] : [] }] });
}

/**
 * The log judge of a test: `decide` gives each vote (0-based over the whole judge, in request order); every request
 * passes the run's budget gate first, as a model call does, and is counted in `calls`.
 */
export function scriptedLogJudge(decide: (data: LogVoteInput, vote: number) => LogVote, calls = { count: 0 }): LogJudge {
  const model = { provider: 'fixture', id: 'log-judge' };
  return { provider: model.provider, model: model.id, protocolHash: logProtocolHash(),
    assess: (request, ctx) => judgeLogged(request, model, ctx, async (_prompt, input) => {
      ctx.beforeCall();
      const vote = decide(JSON.parse(input) as LogVoteInput, calls.count++);
      return vote === 'malformed' ? 'это не JSON' : logAnswer(JSON.parse(input) as LogVoteInput, vote);
    }) };
}

/**
 * The teaching refund reading of a logged conversation, the same reading the synthetic judge of card-prep.ts
 * applies: duty «не запрашивать повторно» fails when the agent asked for the number after the customer gave it;
 * duty «объяснить возврат» passes when the agent explained how to apply, and otherwise fails — or, when it
 * depends on the number and the conversation ended right after the customer named it, was never reached.
 */
export function refundReading(data: LogVoteInput): LogVote {
  const expectation = data.scenario.execution.expectations[0]!;
  const events = data.dialogue.events;
  let given = false, repeated = false;
  for (const event of events) {
    if (event.type === 'user' && event.content.includes('терминала: ')) given = true;
    if (event.type === 'assistant' && given && event.content.includes('номер терминала')) repeated = true;
  }
  // A card's duty А, or the first-format checkpoint it stands for.
  if (expectation.id === 'e1' || expectation.id === 'ask_once') return repeated ? 'fail' : 'pass';
  if (events.some(event => event.type === 'assistant' && event.content.includes('Подайте заявление'))) return 'pass';
  const last = events.at(-1);
  return last?.type === 'user' && last.content.includes('терминала: ') ? 'not_reached' : 'fail';
}
