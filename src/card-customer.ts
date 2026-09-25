import { z } from 'zod';
import type { DialogueMessage } from './runtime.js';
import type { UserView } from './user-controller.js';
import { valueTokens } from './verbatim.js';

/*
 * The customer of a card, played in the customer's own words. The card is the same one the owner prepared and
 * accepted: its goal, opening, facts, unknowns, turn and leaving condition, compiled into `userView`. A model speaks
 * for the customer from that brief, like a person with a note in hand, and the harness checks every message before
 * the agent sees it:
 *
 *   brief ─► model: { move, message } ─► check ─► agent
 *               ▲─── the exact reason (an invented value, a leave before the turn) ───┘
 *
 * The check is exact, never a guess about meaning: every value in the message (a token with a digit: a terminal,
 * a sum, a date) must come from the brief or from what was said in the conversation, and the customer may not leave
 * before a required turn. The turn itself is the card's recorded words. Nothing here reads the agent's reply.
 */

export const CARD_CUSTOMER_PROTOCOL = 'card-customer-free-v3';
export const CARD_CUSTOMER_PROTOCOLS = ['card-customer-free-v1', 'card-customer-free-v2', CARD_CUSTOMER_PROTOCOL] as const;

/** Observable policy conditions, not a free-form explanation or private reasoning. */
export const customerConditionsSchema = z.strictObject({
  leave: z.enum(['met', 'not_met', 'unclear']),
  turn: z.enum(['met', 'not_met', 'unclear', 'not_applicable']),
});

/** What the customer does this turn; `dunno` and `turn` keep the result's «клиент не знал ответа» and the card's turn countable. */
export const CUSTOMER_MOVES = ['answer', 'dunno', 'clarify', 'turn', 'leave'] as const;
export type CustomerMove = typeof CUSTOMER_MOVES[number];

export const customerReplySchema = z.strictObject({
  move: z.enum(CUSTOMER_MOVES),
  /** The customer's message in their own words; empty for `leave` and ignored for `turn` (the card's words are sent). */
  message: z.string().max(1500),
  /** Old/custom runtimes may omit this; the production model is required to report both conditions. */
  conditions: customerConditionsSchema.optional(),
});
export type CustomerReply = z.infer<typeof customerReplySchema>;

/** The policy reader cannot emit text to the agent. The speaker cannot read policy conditions. */
export const customerDecisionSchema = customerReplySchema.pick({ move: true }).extend({ conditions: customerConditionsSchema });
export const customerMessageSchema = customerReplySchema.pick({ message: true });

export function customerSpeechInput(brief: CustomerBrief, conversation: readonly DialogueMessage[], move: 'answer' | 'dunno' | 'clarify') {
  return {
    customer: { opening: brief.opening, knows: [...brief.knows], doesNotKnow: [...brief.doesNotKnow] },
    messages: conversation.map(({ role, content }) => ({ role, content })), move,
  };
}

/** The note the customer plays from: the card's brief, nothing of the expected answer. */
export interface CustomerBrief {
  goal: string;
  opening: string;
  knows: string[];
  doesNotKnow: string[];
  /** The card's turn: when it happens and the words the customer says then. */
  turn?: { when: string; says: string; required: boolean };
  leaves: string;
  maxFollowUps: number;
}

/** The brief of a compiled card, read from its sealed definition. */
export function customerBrief(view: UserView): CustomerBrief {
  const policy = view.policy;
  const turnAction = policy.actions.find(action => action.id === 'turn');
  const turnWhen = policy.transitions.find(transition => transition.actionId === 'turn')?.when;
  const leaves = policy.transitions.find(transition => transition.actionId === 'leave')?.when ?? 'получил ответ';
  return {
    goal: view.goal, opening: view.opening,
    knows: view.facts.map(fact => fact.statement), doesNotKnow: [...view.missing],
    ...(turnAction?.payload && turnWhen ? { turn: { when: turnWhen, says: turnAction.payload, required: turnAction.kind === 'change_intent' } } : {}),
    leaves, maxFollowUps: policy.maxFollowUps,
  };
}

/**
 * Why a reply cannot go to the agent, in words for the model, or undefined when it can. `turned` says whether the
 * card's turn already happened; `conversation` is everything said so far.
 */
export function customerDecisionProblem(reply: Pick<CustomerReply, 'move' | 'conditions'>, brief: CustomerBrief, turned: boolean): string | undefined {
  if (reply.conditions) {
    const turnAvailable = !!brief.turn && !turned;
    if (reply.conditions.turn === 'met' && !turnAvailable) return 'No unplayed turn exists: turn condition must be not_applicable.';
    if (turnAvailable && reply.conditions.turn === 'met' && reply.move !== 'turn') return 'The turn condition is met: choose turn now; do not write an answer or a clarification.';
    const turnTakesPriority = turnAvailable && (brief.turn!.required || reply.conditions.turn === 'met');
    if (reply.conditions.leave === 'met' && !turnTakesPriority && reply.move !== 'leave') return 'The leaving condition is met: choose leave with an empty message, not another customer reply.';
    if (reply.move === 'turn' && reply.conditions.turn !== 'met') return 'Choose turn only when its stated condition is met.';
    if (reply.move === 'leave' && reply.conditions.leave !== 'met') return 'Choose leave only when the stated leaving condition is met.';
  }
  if (reply.move === 'turn') {
    if (!brief.turn) return 'This card has no turn: choose another move.';
    if (turned) return 'The turn already happened: choose another move.';
    return undefined;
  }
  if (reply.move === 'leave') {
    return brief.turn?.required && !turned ? `The customer cannot leave yet: first make the turn («${brief.turn.says}») when ${brief.turn.when}.` : undefined;
  }
  return undefined;
}

export function customerReplyProblem(reply: CustomerReply, brief: CustomerBrief, conversation: readonly DialogueMessage[], turned: boolean): string | undefined {
  const controlProblem = customerDecisionProblem(reply, brief, turned);
  if (controlProblem) return controlProblem;
  if (reply.move === 'turn' || reply.move === 'leave') return undefined;
  if (!reply.message.trim()) return 'The message is empty: write what the customer says.';
  const allowed = new Set([...valueTokens([brief.goal, brief.opening, ...brief.knows].join('\n')), ...valueTokens(conversation.map(item => item.content).join('\n'))]);
  const invented = [...valueTokens(reply.message)].filter(token => !allowed.has(token));
  if (invented.length) return `The message names ${invented.map(token => `"${token}"`).join(', ')}, which the customer does not know: use only values from knows or from the conversation, or say the customer does not know.`;
  return undefined;
}

/** The message the agent receives for a move that passed the check: the card's words for the turn, none for leaving. */
export const deliveredMessage = (reply: CustomerReply, brief: CustomerBrief): string =>
  reply.move === 'turn' ? brief.turn!.says : reply.move === 'leave' ? '' : reply.message.trim();
