import { z } from 'zod';

/*
 * The planner's word on which variation of a topic's plan each of the topic's other conversations is in (DISCOVER). A
 * plan reads at most `perTopic` examples, and a topic's other selected conversations may not ask what those examples ask:
 * judged by the plan's duties anyway, a customer who wanted a terminal is found «not told about the smartphone app». So
 * every such conversation is fitted before it is judged: under the variation it is in — that variation's duties and the
 * shared ones apply — or under none, and one no variation fits is never judged by the plan (discover/analyze.ts).
 *
 *   plan question + variations + the conversations' customer words ──one call──► per conversation: a variation or «none»
 *   harness: every conversation answered exactly once; ids and variations are enums of the call
 */

/** One fit call: the plan's question and variations, and the conversations to fit, by the customers' own words only. */
export interface FitRequest {
  task: string;
  topic: string;
  question: string;
  variations: { id: string; title: string }[];
  conversations: { dialogueId: string; customer: string[] }[];
}

/** The answer for a conversation no variation of the plan fits. */
export const NO_FIT = 'none';
/** Conversations one fit call reads at most: the rest of a topic's go in the next call. */
export const FIT_BATCH = 16;

/** The planner's answer: for each conversation, the variation it is in or «none»; every reference an enum of this call. */
export function fitAnswerSchema(request: FitRequest) {
  const ids = request.conversations.map(conversation => conversation.dialogueId) as [string, ...string[]];
  const variations: [string, ...string[]] = [NO_FIT, ...request.variations.map(variation => variation.id)];
  return z.strictObject({
    fits: z.array(z.strictObject({
      dialogueId: z.enum(ids, { error: 'Not a conversation of this call: answer only dialogueIds from conversations.' }),
      variation: z.enum(variations, { error: `Answer a variation id of this plan or "${NO_FIT}".` }),
    })).min(1).max(ids.length),
  });
}
export type FitAnswer = z.infer<ReturnType<typeof fitAnswerSchema>>;

/** What keeps an answer from binding: a conversation left unanswered, or answered twice. Undefined when every one is answered once. */
export function fitProblem(answer: FitAnswer, request: FitRequest): string | undefined {
  const answered = new Map<string, number>();
  for (const fit of answer.fits) answered.set(fit.dialogueId, (answered.get(fit.dialogueId) ?? 0) + 1);
  const missing = request.conversations.filter(conversation => !answered.has(conversation.dialogueId)).map(conversation => conversation.dialogueId);
  const twice = [...answered].filter(([, times]) => times > 1).map(([dialogueId]) => dialogueId);
  const problems = [...missing.length ? [`Answer every conversation: missing ${missing.join(', ')}.`] : [],
    ...twice.length ? [`Answer each conversation once: ${twice.join(', ')} more than once.`] : []];
  return problems.length ? problems.join(' ') : undefined;
}
