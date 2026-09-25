import { z } from 'zod';
import { CommandRefused } from '../errors.js';
import { text } from '../ids.js';
import type { TaskRunner } from '../llm/structured.js';
import { holdsMark, maskedSpans } from '../masking.js';
import type { BuilderModel } from '../miner/topic-map.js';
import type { CallContext } from '../runtime.js';
import { clip } from '../text.js';
import { contains, filledMessage, messageAt, sameEvent, type CardEvidence } from './checks.js';
import { fillKindSchema, type Card, type CardCommand, type EventRef, type Filled } from './schema.js';

/*
 * Masked values of a de-identified log, filled by Lab. An export writes a mark over what the customer typed
 * («с утра было # покупки, на * и *»); a test customer who sends the mark gives the agent words no customer wrote.
 * The harness finds every mark structurally (masking.ts), offers each as a slot with its id and the words around it,
 * and the model answers every slot with a plausible value of the same kind — the slots are the keys of the answer's
 * schema, so none is skipped and none invented. The harness writes the values in and keeps the rest of the message
 * character for character; the card records each value (`filled`), its brief says «подставлено вместо обезличенного»,
 * and it stays the logged situation: calibration compares it with its log, whose judge reads the marks (calibration-scope.ts).
 *
 *   at proposal time   the slots of the dialogue's customer messages ride the proposal call (proposal.ts, CARD_ROLE)
 *   an existing card   one builder call (MASK_FILL_ROLE) makes a `fill_masked` command the owner confirms once
 */

/** Marks one call offers at most; a mark past them stays, and the card's check says what is left. */
export const MASK_SLOT_LIMIT = 30;
/** Characters of context shown on each side of a mark. */
const CONTEXT = 60;

/** A mark the model fills: its id in the answer, the message and the mark's place in it, and the words around it. */
export interface MaskSlot { id: string; event: EventRef; span: number; mark: string; before: string; after: string }

/** The slots of messages, in message order, at most MASK_SLOT_LIMIT; `skip` leaves out marks already filled. */
export function maskSlots(messages: readonly { event: EventRef; content: string }[], skip: readonly Filled[] = []): MaskSlot[] {
  return messages.flatMap(({ event, content }) => maskedSpans(content).flatMap((span, index) => skip.some(item => sameEvent(item.event, event) && item.span === index) ? []
    : [{ id: `m${event.eventIndex}_${index}`, event, span: index, mark: span.mark,
      before: content.slice(Math.max(0, span.start - CONTEXT), span.start), after: content.slice(span.end, span.end + CONTEXT) }])).slice(0, MASK_SLOT_LIMIT);
}

/** What the model reads of a slot: no references, the message by its index. */
export const slotPayload = (slots: readonly MaskSlot[]) => slots.map(({ id, event, mark, before, after }) => ({ id, message: event.eventIndex, mark, before, after }));

const fillAnswerSchema = z.strictObject({ kind: fillKindSchema, value: text(80) });
export type FillAnswer = z.infer<typeof fillAnswerSchema>;

/** One answer per slot, under the slot's id: the schema itself asks for exactly the marks of this call. */
export const slotAnswersSchema = (slots: readonly MaskSlot[]) => z.strictObject(Object.fromEntries(slots.map(slot => [slot.id, fillAnswerSchema])));

const DIGIT_KINDS = new Set<FillAnswer['kind']>(['count', 'amount', 'date', 'time', 'phone', 'card_number', 'account']);
const isDigit = (char: string): boolean => char >= '0' && char <= '9';

/** Why a value cannot stand for its mark, in the model's words; the value's characters are read, never its meaning. */
export function fillSlip(id: string, answer: FillAnswer): string | undefined {
  const chars = [...answer.value];
  // A value that is a mark again («xxx», «ХХХ», «<PHONE>») or holds a character marks are written with is no value: written
  // in, it would leave the message masked and the card unusable. The one check of masking.ts, for a proposal and a later fill alike.
  if (holdsMark(answer.value)) return `${id}: "${answer.value}" still holds a masking character; write a concrete plausible value.`;
  if (answer.kind === 'count' && !chars.every(isDigit)) return `${id} is a count: write digits only, e.g. "3".`;
  if (DIGIT_KINDS.has(answer.kind) && !chars.some(isDigit)) return `${id} is a ${answer.kind}: write it with digits, e.g. "1 500 ₽", "12.03", "14:30".`;
  return undefined;
}

/** The characters of a mark a card keeps (schema.ts `filled.mark`): only shown beside its value, never matched, so a longer run of `*` is cut. */
const KEPT_MARK_CHARS = 60;
const keptMark = (mark: string): string => clip(mark, KEPT_MARK_CHARS);

/** The values of the slots as the card records them. */
export const slotFills = (slots: readonly MaskSlot[], answers: Readonly<Record<string, FillAnswer>>): Filled[] =>
  slots.flatMap(slot => {
    const answer = answers[slot.id];
    return answer ? [{ event: slot.event, span: slot.span, mark: keptMark(slot.mark), kind: answer.kind, value: answer.value }] : [];
  });

/** The customer's messages a card reads: its opening, its turn and every fact's message, once each. */
function cardEvents(card: Card): EventRef[] {
  const { writesSource, turn, knows } = card.client;
  const events = [writesSource, ...(turn ? [turn.source] : []), ...knows.map(fact => fact.source)]
    .flatMap(source => source.kind === 'dialogue' ? [source.event] : []);
  return events.filter((event, index) => events.findIndex(other => sameEvent(other, event)) === index);
}

const masked = (value: Card['client']['knows'][number]['value']): value is string => typeof value === 'string' && maskedSpans(value).length > 0;

/* ───────────────────────────── an existing card ───────────────────────────── */

/** One call filling the marks of one card: what the model reads, and what the harness binds its answer against. */
export interface UnmaskRequest {
  card: Pick<Card, 'id' | 'filled'>;
  slots: MaskSlot[];
  /** Facts whose value is a mark: the value they take, as their message now reads. */
  facts: { id: string; label: string; event: EventRef | null }[];
  /** The messages the slots and facts are in, as the log has them. */
  messages: { event: EventRef; content: string }[];
  payload: { wants: string; messages: { index: number; text: string }[]; slots: ReturnType<typeof slotPayload>; facts: { id: string; label: string; message: number | null }[] };
}

/** The marks of a card nobody filled yet; undefined when there are none. */
export function unmaskRequest(card: Card, evidence: CardEvidence): UnmaskRequest | undefined {
  const messages = cardEvents(card).flatMap(event => {
    const content = messageAt(evidence, event);
    return content === undefined ? [] : [{ event, content }];
  });
  const slots = maskSlots(messages, card.filled);
  const facts = card.client.knows.filter(fact => masked(fact.value))
    .map(fact => ({ id: fact.id, label: fact.label, event: fact.source.kind === 'dialogue' ? fact.source.event : null }));
  if (!slots.length && !facts.length) return undefined;
  const shown = messages.filter(message => slots.some(slot => sameEvent(slot.event, message.event)) || facts.some(fact => fact.event && sameEvent(fact.event, message.event)));
  return { card: { id: card.id, ...(card.filled ? { filled: card.filled } : {}) }, slots, facts, messages: shown,
    payload: { wants: card.client.wants, messages: shown.map(message => ({ index: message.event.eventIndex, text: message.content })), slots: slotPayload(slots),
      facts: facts.map(fact => ({ id: fact.id, label: fact.label, message: fact.event?.eventIndex ?? null })) } };
}

export function unmaskSchema(request: UnmaskRequest) {
  return z.strictObject({ slots: slotAnswersSchema(request.slots), facts: z.strictObject(Object.fromEntries(request.facts.map(fact => [fact.id, text(120)]))) });
}
export type UnmaskAnswer = z.infer<ReturnType<typeof unmaskSchema>>;

/** The answer's domain check: every value has its kind's shape, and a masked fact reads as its message does with the values in. */
export function unmaskProblem(request: UnmaskRequest, answer: UnmaskAnswer): string | undefined {
  const slips = Object.entries(answer.slots).flatMap(([id, fill]) => fillSlip(id, fill) ?? []);
  const filled = [...request.card.filled ?? [], ...slotFills(request.slots, answer.slots)];
  for (const fact of request.facts) {
    const value = answer.facts[fact.id]!;
    if (holdsMark(value)) slips.push(`facts.${fact.id}: "${value}" still holds a masking character.`);
    const message = fact.event && request.messages.find(item => sameEvent(item.event, fact.event!));
    if (message && !contains(filledMessage(message.content, filled, message.event), value)) {
      slips.push(`facts.${fact.id}: "${value}" is not in message ${message.event.eventIndex} with your values in place: copy it from there.`);
    }
  }
  return slips.length ? slips.join(' ') : undefined;
}

/** The command of an answer: what the owner confirms. */
export const unmaskCommand = (request: UnmaskRequest, answer: UnmaskAnswer): Extract<CardCommand, { kind: 'fill_masked' }> => ({
  kind: 'fill_masked', cardId: request.card.id,
  spans: slotFills(request.slots, answer.slots).map(({ mark: _mark, ...fill }) => fill),
  facts: request.facts.map(fact => ({ factId: fact.id, value: answer.facts[fact.id]! })),
});

/**
 * Writes a `fill_masked` command into a card: each value over its mark in the card's own messages, the opening and the
 * turn read anew from their messages, the masked facts given their values. The deterministic checks then hold each fact
 * to its message as it reads with the values in.
 */
export function applyFill(draft: Card, command: Extract<CardCommand, { kind: 'fill_masked' }>, evidence: CardEvidence): void {
  const events = cardEvents(draft);
  let filled = [...draft.filled ?? []];
  for (const item of command.spans) {
    if (!events.some(event => sameEvent(event, item.event))) throw new CommandRefused('Подставить значение можно только в реплики клиента этой ситуации.');
    const content = messageAt(evidence, item.event);
    const span = content === undefined ? undefined : maskedSpans(content)[item.span];
    if (!span) throw new CommandRefused('В этой реплике клиента нет такого обезличенного значения.');
    filled = [...filled.filter(other => !(sameEvent(other.event, item.event) && other.span === item.span)), { ...item, mark: keptMark(span.mark) }];
  }
  filled.sort((a, b) => a.event.eventIndex - b.event.eventIndex || a.span - b.span);
  if (filled.length) draft.filled = filled;
  const read = (event: EventRef) => {
    const content = messageAt(evidence, event);
    return content === undefined ? undefined : filledMessage(content, filled, event).trim();
  };
  const { writesSource, turn } = draft.client;
  if (writesSource.kind === 'dialogue') draft.client.writes = read(writesSource.event) ?? draft.client.writes;
  if (turn?.source.kind === 'dialogue') turn.says = read(turn.source.event) ?? turn.says;
  for (const { factId, value } of command.facts) {
    const fact = draft.client.knows.find(item => item.id === factId);
    if (!fact) throw new CommandRefused(`У ситуации №${draft.number} нет такого факта.`);
    if (!masked(fact.value)) throw new CommandRefused(`«${fact.label}» не обезличен: подставлять нечего.`);
    fact.value = value;
  }
}

/* ───────────────────────────── the builder's call ───────────────────────────── */

export const MASK_FILL_ROLE = `You fill the de-identified values of ONE test situation drawn from a real customer dialogue.
The export replaced values the customer wrote with marks (#, *, xxxx, <PHONE>, [скрыто]); a test customer cannot send such marks to the agent under test. Each listed slot is one mark in a customer message, with the text right before and after it.
slots: answer every slot with kind and value: one plausible concrete value of the kind the mark hides, written as this customer would write it — a count as digits ("3"), an amount as customers write money ("1 500 ₽"), a date or a time ("12.03", "14:30"), a first name ("Ирина"), a phone, a card or an account number with plausible digits, an address, a code. The value must fit the words around the mark (grammar, case, number) and agree with the other slots and with what the customer wants; never a mark again, never real personal data, never the answer the agent must give.
facts: each listed fact has a mark for its value; write its value exactly as its message reads with your values in place.
All words are Russian where the customer's are.`;

/** The builder of masked values: its model, and the one call that fills a card's marks. */
export interface MaskFiller {
  builder: BuilderModel;
  fill(request: UnmaskRequest, ctx: CallContext): Promise<UnmaskAnswer>;
}

/** One card's marks filled by the builder; a value of the wrong shape or a fact that does not read so goes back with its reason. */
export function fillWithModel(request: UnmaskRequest, work: { run: TaskRunner; ctx: CallContext }): Promise<UnmaskAnswer> {
  return work.run({ id: 'mask-fill', label: 'Значения вместо обезличенных', role: 'builder', instructions: MASK_FILL_ROLE,
    output: unmaskSchema(request), check: value => unmaskProblem(request, value) }, request.payload, work.ctx);
}
