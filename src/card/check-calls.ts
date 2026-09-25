import type { Experiment } from '../contracts.js';
import { PROPOSAL_ATTEMPTS, REVIEW_CALLS } from './budget.js';
import type { CardEvidence } from './checks.js';
import { CARD_PROTOCOL, pendingReviewCalls } from './prepare.js';
import { blockedClaims, pendingClaims, type ReviewContext } from './review.js';
import type { Card, LibraryV2 } from './schema.js';

/*
 * What the owner's explicit check of a draft's situations may spend (card/prepare.ts reviewCards): the «до N вызовов» of
 * its button, and the number its budget question compares with the draft's limit. It is counted as every budget of
 * situations is, each answer passing the first time (card/budget.ts):
 *
 *   every claim no receipt answers yet              its review requests
 *   a card still owed its one revision — blocked    the proposal of the new card (one request of its unit's allowance)
 *   now, or with a review to come that may block it   and the review of that card (at most REVIEW_CALLS requests)
 */

/** A revision's calls: the proposal of the new card and its review. */
const REVISION_CALLS = 1 + REVIEW_CALLS;

/** The most model calls the owner's check of `library` makes: its reviews, and the revisions it owes. */
export function checkCalls(record: Pick<Experiment, 'preparationProgress' | 'originalImport'>, library: LibraryV2, evidence: CardEvidence): number {
  const context: ReviewContext = { library, evidence };
  const revisions = library.cards.filter(card => owedRevision(record, library, card, evidence)
    && (blockedClaims(card, context).length > 0 || pendingClaims(card, context).length > 0)).length;
  return pendingReviewCalls(library, evidence) + revisions * REVISION_CALLS;
}

/**
 * Whether the check owes `card` the one revision its preparation's consent promised, by the rule card/prepare.ts keeps
 * (Preparation.check and revise): a card a preparation of this Lab proposed — from a conversation of the draft's import,
 * or from the rules — whose unit has spent neither its revision nor its proposal allowance, and that no command of the
 * owner names: an owner's card is theirs, and no model writes it over.
 */
function owedRevision(record: Pick<Experiment, 'preparationProgress' | 'originalImport'>, library: LibraryV2, card: Card, evidence: CardEvidence): boolean {
  const progress = record.preparationProgress;
  if (progress?.protocol !== CARD_PROTOCOL) return false;
  const unit = progress.cards?.find(item => item.cardId === card.id)?.dialogueId;
  const spent = unit === undefined ? undefined : progress.generationAttempts?.find(item => item.dialogueId === unit);
  if (unit === undefined || !spent || spent.calls >= PROPOSAL_ATTEMPTS || progress.revised?.includes(unit)) return false;
  // A card of a logged conversation is written again only beside that conversation, read from the draft's own import.
  if (card.origin.kind === 'dialogue' && !(record.originalImport && evidence.messages(record.originalImport.id, unit))) return false;
  return !library.receipts.some(({ command }) => 'cardId' in command ? command.cardId === card.id
    : command.kind === 'decide_plausible' && command.facts.some(fact => fact.cardId === card.id));
}
