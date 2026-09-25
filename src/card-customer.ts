import { z } from 'zod';
import type { Trial } from './contracts.js';
import type { DialogueMessage } from './runtime.js';
import type { UserView } from './user-controller.js';
import { valueTokens } from './verbatim.js';
import { normalizeText } from './card/checks.js';

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
 * before a required turn. A press of one of the agent's buttons says the button's values as the customer's own, so they
 * must come from the brief or from the customer's own earlier words: what the agent offered is not what the customer
 * knows. The turn itself is the card's recorded words. Nothing here reads the meaning of the agent's reply.
 */

/**
 * The customer's protocol: its roles (prompts.ts CARD_CUSTOMER_ROLE, CUSTOMER_DECISION_ROLE), the checks of its words
 * below and what the harness sends in its name. Every move the customer makes is recorded with it, so a conversation is
 * read by the customer that played it. v3 covers two sets of roles (the buttons were added to them in place); v4 is
 * the roles with buttons and the checks that keep a press to what the customer knows.
 */
export const CARD_CUSTOMER_PROTOCOL = 'card-customer-free-v4';
export const CARD_CUSTOMER_PROTOCOLS = ['card-customer-free-v1', 'card-customer-free-v2', 'card-customer-free-v3', CARD_CUSTOMER_PROTOCOL] as const;

/** The protocols of the customer that played these conversations, as their moves recorded them, sorted; empty where no free customer played. */
export function customerProtocolsOf(trials: readonly Pick<Trial, 'events'>[]): string[] {
  const recorded = new Set<string>();
  for (const trial of trials) for (const event of trial.events) {
    const protocol = event.type === 'simulator' && event.result && typeof event.result === 'object' ? (event.result as { protocol?: unknown }).protocol : undefined;
    if (typeof protocol === 'string' && (CARD_CUSTOMER_PROTOCOLS as readonly string[]).includes(protocol)) recorded.add(protocol);
  }
  return [...recorded].sort();
}

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

/** A button the agent offered under its last reply: the text the customer sees, and the adapter's own value for it. */
export interface OfferedButton { text: string; value?: string }

/** The button a message presses: the offered button whose text it is, up to case and spacing; undefined for the customer's own words. */
export function pressedButton<B extends OfferedButton>(offered: readonly B[], message: string): { index: number; button: B } | undefined {
  const said = normalizeText(message);
  const index = offered.findIndex(button => normalizeText(button.text) === said);
  return index < 0 ? undefined : { index, button: offered[index]! };
}

/** Why a reply cannot go to the agent: in words for the model, which repairs it, and in the owner's words about the customer, when it stands. */
export interface CustomerProblem { model: string; owner: string }

/**
 * Why a reply cannot go to the agent, or undefined when it can. `offered`: the buttons under the agent's last reply; a
 * message that is one of them is its press.
 */
export function customerReplyIssue(reply: CustomerReply, brief: CustomerBrief, conversation: readonly DialogueMessage[], turned: boolean,
  offered: readonly OfferedButton[] = []): CustomerProblem | undefined {
  const controlProblem = customerDecisionProblem(reply, brief, turned);
  if (controlProblem) return { model: controlProblem, owner: 'выбрал ход, которого его ситуация сейчас не допускает' };
  if (reply.move === 'turn' || reply.move === 'leave') return undefined;
  if (!reply.message.trim()) return { model: 'The message is empty: write what the customer says.', owner: 'прислал пустую реплику' };
  const listed = (tokens: string[]) => tokens.map(token => `«${token}»`).join(', ');
  const press = pressedButton(offered, reply.message);
  if (press) {
    // What the agent offered, in its text or on its buttons, is not what the customer knows.
    const own = new Set(valueTokens([brief.goal, brief.opening, ...brief.knows, ...conversation.filter(item => item.role === 'user').map(item => item.content)].join('\n')));
    const unknown = [...valueTokens(press.button.text)].filter(token => !own.has(token));
    if (unknown.length) return { model: `The button "${press.button.text}" names ${unknown.map(token => `"${token}"`).join(', ')}, which the customer does not know: press a button only when its values are among your known facts or your own earlier words; otherwise answer in your own words or say you do not know.`,
      owner: `нажал кнопку «${press.button.text}» со значением ${listed(unknown)}, которого не знает` };
  }
  const allowed = new Set([...valueTokens([brief.goal, brief.opening, ...brief.knows].join('\n')), ...valueTokens(conversation.map(item => item.content).join('\n'))]);
  const invented = [...valueTokens(reply.message)].filter(token => !allowed.has(token));
  if (invented.length) return { model: `The message names ${invented.map(token => `"${token}"`).join(', ')}, which the customer does not know: use only values from knows or from the conversation, or say the customer does not know.`,
    owner: `назвал ${listed(invented)} — этого нет ни в его ситуации, ни в разговоре` };
  return undefined;
}

/** Why a reply cannot go to the agent, in words for the model, or undefined when it can (customerReplyIssue). */
export const customerReplyProblem = (...args: Parameters<typeof customerReplyIssue>): string | undefined => customerReplyIssue(...args)?.model;

/** The message the agent receives for a move that passed the check: the card's words for the turn, none for leaving. */
export const deliveredMessage = (reply: CustomerReply, brief: CustomerBrief): string =>
  reply.move === 'turn' ? brief.turn!.says : reply.move === 'leave' ? '' : reply.message.trim();
