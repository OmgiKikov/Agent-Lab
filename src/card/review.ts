import { z } from 'zod';
import { fingerprint } from '../contracts.js';
import { text } from '../ids.js';
import { workInputIssue } from '../limits.js';
import { messageAt, type CardEvidence, type LoggedMessage } from './checks.js';
import type { Card, ClaimReceipt, EventRef, LibraryV2 } from './schema.js';

/*
 * The semantic claims of a card (docs/design/card-v2-spec.md §2.5). Each is one question to an independent reviewer with its own
 * basis — exactly the content the answer depends on — and is addressed by it: key = digest(kind, subject, basis).
 * A receipt answers its key for the whole library, so a similar card with the same fact reuses its parent's
 * answer, and an edit asks again exactly the claims whose basis it changed. The reviewer reads the brief, the full
 * source dialogue and every rule and article read for that dialogue — not only the ones the card cites — and never
 * sees earlier answers.
 */

export type ClaimKind = ClaimReceipt['kind'];
export interface Claim { kind: ClaimKind; subject: string; alias: string; basisHash: string; key: string }

export interface ReviewContext { library: LibraryV2; evidence: CardEvidence }

type Sourced = Card['client']['writesSource'] | Card['client']['knows'][number]['source'] | NonNullable<Card['client']['turn']>['source'];
const eventOf = (source: Sourced): EventRef | undefined => source.kind === 'dialogue' ? source.event : undefined;

/** The logged dialogue a card stands on: its origin, or for a card made from another, the dialogue its opening, facts or account cite. */
export function sourceDialogue(card: Card): { batchId: string; dialogueId: string } | undefined {
  if (card.origin.kind === 'dialogue') return { batchId: card.origin.batchId, dialogueId: card.origin.dialogueId };
  const { writesSource, knows, turn } = card.client;
  const event = [eventOf(writesSource), ...knows.map(fact => eventOf(fact.source)), turn && eventOf(turn.source), card.coverage[0]?.event].find(item => item !== undefined);
  return event && { batchId: event.batchId, dialogueId: event.dialogueId };
}

/**
 * What was read for the card's dialogue: the articles of its reading row plus the sources of the rules it cites,
 * and every rule from those articles. A card with no row (from the owner's rules) was read against all of them.
 */
function reading(card: Card, library: LibraryV2) {
  const dialogue = sourceDialogue(card);
  const row = library.readingManifest.find(item => item.cardIds.includes(card.id))
    ?? (dialogue && library.readingManifest.find(item => item.dialogueId === dialogue.dialogueId && item.batchId === dialogue.batchId));
  const cited = new Set(card.agentMust.flatMap(expectation => expectation.requirementIds));
  const ids = new Set([...(row ? row.sourceIds : library.sources.map(source => source.id)),
    ...library.requirements.filter(requirement => cited.has(requirement.id)).map(requirement => requirement.sourceId)]);
  return { sources: library.sources.filter(source => ids.has(source.id)), requirements: library.requirements.filter(requirement => ids.has(requirement.sourceId)) };
}

/** The receipt of the owner's decision a fact stands on, when the library holds it. */
const ownerReceipt = (library: LibraryV2, source: Card['client']['knows'][number]['source']) =>
  source.kind === 'owner' ? library.receipts.find(receipt => receipt.id === source.receiptId) : undefined;

/**
 * The claims of a card, each with the basis its answer depends on:
 *   goal         — what the customer wants and writes, and the whole source dialogue
 *   clarity      — only on a card marked vague: that the customer never states a clear request; the opening and the dialogue
 *   fact fN      — the fact, the message it cites (or the owner's receipt) and the opening
 *   expectation  — the duty, the rules it cites, the articles read, and what the customer wants, writes and knows
 *   coverage     — the account of the later messages, the turn and those messages
 *   leak         — every word the customer says or leaves on, the duties and the values the customer does not know
 * A clear card has no clarity claim: its goal claim holds that the opening states the request, so every card marked
 * clear before the claim existed keeps its answers.
 */
export function planClaims(card: Card, context: ReviewContext): Claim[] {
  const { library, evidence } = context;
  const { wants, writes, knows, leaves, turn } = card.client;
  const dialogue = sourceDialogue(card);
  const said = (event: EventRef) => messageAt(evidence, event) ?? null;
  const read = reading(card, library);
  const claim = (kind: ClaimKind, subject: string, alias: string, basis: unknown): Claim => {
    const basisHash = fingerprint(basis);
    return { kind, subject, alias, basisHash, key: fingerprint({ kind, subject, basisHash }) };
  };
  const logged = dialogue ? { ...dialogue, messages: evidence.messages(dialogue.batchId, dialogue.dialogueId) ?? null } : null;
  return [
    claim('goal', '', 'goal', { wants, writes, dialogue: logged }),
    ...(card.clarity === 'vague' ? [claim('clarity', '', 'clarity', { clarity: card.clarity, writes, dialogue: logged })] : []),
    // The owner's word on a plausible fact's label vouches for it without changing what the reviewer checks: its receipt is not in the basis.
    ...knows.map(fact => claim('fact', fact.id, `fact_${fact.id}`, { fact: fact.source.kind === 'plausible' ? { ...fact, source: { kind: 'plausible' } } : fact, writes,
      message: fact.source.kind === 'dialogue' ? said(fact.source.event) : null, owner: ownerReceipt(library, fact.source) ?? null })),
    // The duties are read with what the customer knows, not with who vouched for it: an owner's confirmation re-asks only its fact.
    ...card.agentMust.map(expectation => claim('expectation', expectation.id, `expectation_${expectation.id}`, { expectation, wants, writes,
      knows: knows.map(({ source: _source, ...fact }) => fact),
      requirements: expectation.requirementIds.map(id => library.requirements.find(requirement => requirement.id === id) ?? null),
      articles: read.sources.map(source => ({ id: source.id, hash: source.hash })) })),
    ...(card.coverage.length || turn ? [claim('coverage', '', 'coverage', { coverage: card.coverage, turn: turn ?? null, later: card.coverage.map(entry => said(entry.event)) })] : []),
    claim('leak', '', 'leak', { writes, leaves, says: turn?.says ?? null, duties: card.agentMust.map(expectation => expectation.text),
      unknown: knows.filter(fact => fact.disclosure === 'unknown').map(fact => fact.value ?? null) }),
  ];
}

/** The claims of a card no receipt answers yet: what a review call must ask. */
export const pendingClaims = (card: Card, context: ReviewContext): Claim[] =>
  planClaims(card, context).filter(claim => !context.library.claims.some(receipt => receipt.key === claim.key));

const verdictSchema = z.strictObject({ status: z.enum(['ready', 'needs_owner', 'blocked']), reason: text(240) });
/**
 * The reviewer's answer on one claim. On the account of the later messages it may name the one message its doubt is
 * about (`message`, an enum of the card's later messages), so the owner is asked about that message and no other.
 */
export type ReviewVerdict = z.infer<typeof verdictSchema> & { message?: number | null };

/**
 * One verdict under each claim's alias: the schema itself asks for exactly the claims of this call. `later`: the card's
 * later customer messages (their indexes), the ones a doubt about the account may name; an answer without the field names none.
 */
export function cardReviewSchema(aliases: readonly string[], later: readonly number[] = []) {
  const coverage = later.length ? verdictSchema.extend({ message: z.literal(later).nullable().default(null) }) : verdictSchema;
  return z.strictObject({ claims: z.strictObject(Object.fromEntries(aliases.map(alias => [alias, alias === 'coverage' ? coverage : verdictSchema]))) });
}

/** The later customer messages a review call's verdict on the account may name: the ones the brief it reads accounts for. */
export const laterMessages = (request: Pick<CardReviewRequest, 'aliases' | 'payload'>): number[] =>
  request.aliases.includes('coverage') ? request.payload.card.coverage.map(entry => entry.message) : [];

/** The brief as the reviewer reads it: no receipts, message numbers instead of references, the owner's own words for the facts they vouched for. */
export function reviewedBrief(card: Card, library: LibraryV2) {
  const { wants, writes, writesSource, knows, leaves, turn } = card.client;
  const from = (source: Sourced) => eventOf(source)?.eventIndex ?? null;
  return {
    // Whether the customer states the request: «vague» is the author's mark the clarity claim asks about.
    title: card.title, topic: card.topic, wants, clarity: card.clarity ?? 'clear', writes, writesFrom: from(writesSource),
    knows: knows.map(fact => {
      const receipt = ownerReceipt(library, fact.source);
      return { id: fact.id, label: fact.label, value: fact.value ?? null, disclosure: fact.disclosure, askedAs: fact.askedAs ?? null,
        from: from(fact.source), owner: receipt ? { confirmed: true, words: receipt.ownerWords ?? null } : null,
        ...(fact.source.kind === 'plausible' ? { plausible: true } : {}) };
    }),
    leaves, turn: turn ? { kind: turn.kind, after: turn.after, says: turn.says, from: from(turn.source) } : null,
    agentMust: card.agentMust.map(({ id, text, requirementIds, appliesWhen, observation, tool }) => ({ id, text, requirementIds, appliesWhen: appliesWhen ?? null, observation,
      ...(tool !== undefined ? { tool } : {}) })),
    coverage: card.coverage.map(entry => ({ message: entry.event.eventIndex, as: entry.as, reason: entry.reason ?? null })),
    // The values Lab wrote over the log's masking marks: the reviewer reads the marks in the dialogue and these in the card.
    ...(card.filled ? { filled: card.filled.map(item => ({ message: item.event.eventIndex, mark: item.mark, value: item.value })) } : {}),
  };
}

/** One review call: the claims it answers, by alias, and what the reviewer reads. */
export interface CardReviewRequest {
  aliases: string[];
  payload: {
    card: ReturnType<typeof reviewedBrief>;
    dialogue: { messages: readonly LoggedMessage[] } | null;
    requirements: { id: string; text: string; quote: string; sourceId: string }[];
    articles: { id: string; name: string; content: string }[];
    claims: { alias: string; kind: ClaimKind; subject: string }[];
  };
}

/** The reviewer's answers and the model that gave them, as the runtime reports them. */
export interface CardReview { verdicts: Record<string, ReviewVerdict>; model: string }

/** A card whose review cannot fit one request even split in two; it can never be checked, so it is never kept. */
export class ReviewTooLarge extends Error {}

/**
 * The calls that answer these claims: one when it fits the request limit; otherwise the story (goal, facts,
 * account, leak — with the dialogue) and the duties (expectations — with the rules and articles) apart.
 */
export function reviewRequests(card: Card, claims: readonly Claim[], context: ReviewContext): CardReviewRequest[] {
  if (!claims.length) return [];
  const { library, evidence } = context;
  const dialogue = sourceDialogue(card);
  const messages = dialogue && evidence.messages(dialogue.batchId, dialogue.dialogueId);
  const read = reading(card, library);
  const brief = reviewedBrief(card, library);
  const request = (part: readonly Claim[], story: boolean, duties: boolean): CardReviewRequest => ({
    aliases: part.map(claim => claim.alias),
    payload: { card: brief, dialogue: story && messages ? { messages } : null,
      requirements: duties ? read.requirements.map(({ id, text, quote, sourceId }) => ({ id, text, quote, sourceId })) : [],
      articles: duties ? read.sources.map(({ id, name, content, kind }) => ({ id, name: kind === 'prompt' ? `${name} (промпт агента)` : name, content })) : [],
      claims: part.map(({ alias, kind, subject }) => ({ alias, kind, subject })) },
  });
  const whole = request(claims, true, true);
  if (!workInputIssue(whole.payload)) return [whole];
  const duties = claims.filter(claim => claim.kind === 'expectation'), story = claims.filter(claim => claim.kind !== 'expectation');
  const parts = [...(story.length ? [request(story, true, false)] : []), ...(duties.length ? [request(duties, false, true)] : [])];
  if (parts.some(part => workInputIssue(part.payload))) throw new ReviewTooLarge(`Ситуация «${card.title}» и её исходный разговор не помещаются в запрос проверки.`);
  return parts;
}

/** Unsupported or ambiguous generated claims, with the reviewer's reason: what a revision must resolve. */
export function revisionClaims(card: Card, context: ReviewContext): { claim: string; reason: string }[] {
  return planClaims(card, context).flatMap(claim => {
    const receipt = context.library.claims.find(item => item.key === claim.key);
    return receipt && (receipt.status === 'blocked' || receipt.status === 'needs_owner') ? [{ claim: claim.alias, reason: receipt.reason }] : [];
  });
}

/** The reviewer's answers as receipts, one per claim, keyed by content; a doubt about the account keeps the message it named. */
export function claimReceipts(claims: readonly Claim[], review: CardReview): ClaimReceipt[] {
  return claims.map(claim => {
    const verdict = review.verdicts[claim.alias];
    if (!verdict) throw new Error(`Проверяющий не ответил на утверждение ${claim.alias}.`);
    const message = claim.kind === 'coverage' && verdict.status !== 'ready' && typeof verdict.message === 'number' ? { message: verdict.message } : {};
    return { key: claim.key, kind: claim.kind, subject: claim.subject, basisHash: claim.basisHash, status: verdict.status, reason: verdict.reason,
      reviewer: { protocol: 'card-review-v1', model: review.model }, ...message };
  });
}
