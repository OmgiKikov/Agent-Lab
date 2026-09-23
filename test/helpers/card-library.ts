import { importEvidence, loggedMessages, type CardEvidence } from '../../src/card/checks.js';
import { addCard, createLibraryV2, recordClaims } from '../../src/card/library.js';
import { bindProposal, proposalCall } from '../../src/card/proposal.js';
import { claimReceipts, pendingClaims, type Claim, type ReviewVerdict } from '../../src/card/review.js';
import type { Card, LibraryV2 } from '../../src/card/schema.js';
import { fingerprint } from '../../src/contracts.js';
import type { ImportBatch } from '../../src/scenario-contracts.js';
import { importBatch } from '../../src/scenario-library.js';
import { dialogues, policy, proposals, refundRule } from './card-prep.js';

/*
 * A draft of two cards built the way a preparation builds it — bound from the careful proposals of
 * card-prep.ts and reviewed — without a store or a runtime: №1 «late» (the number named on request,
 * the customer stops on «Спасибо!»), №2 «known» (the number in the first message). Invented data.
 */

export const READY: ReviewVerdict = { status: 'ready', reason: 'Подтверждено разговором и правилом владельца.' };

export interface CardDraft { library: LibraryV2; evidence: CardEvidence; batch: ImportBatch }

/** The draft with every claim answered by `verdict` (ready by default); `review: false` leaves the claims unanswered. */
export function cardDraft(options: { verdict?: (claim: Claim, card: Card) => ReviewVerdict; review?: boolean } = {}): CardDraft {
  const batch = importBatch(dialogues);
  const evidence = importEvidence([batch]);
  const sources = [{ id: 'source-1', name: 'Правила возвратов', content: policy, hash: fingerprint(policy) }];
  const requirements = [{ ...refundRule, sourceId: 'source-1' }];
  let library = createLibraryV2({ id: 'library_cards', imports: [{ id: batch.id, contentHash: batch.contentHash }], sources, requirements, createdAt: '2026-09-23T10:00:00.000Z' });
  for (const dialogue of batch.dialogues) {
    const call = proposalCall({ source: { kind: 'dialogue', batchId: batch.id, dialogueId: dialogue.id }, messages: loggedMessages(dialogue), requirements, maxTurns: 3 });
    const card = bindProposal(proposals[dialogue.id as 'late' | 'known'], call, library.nextNumber);
    library = addCard(library, card, { dialogueId: dialogue.id, batchId: batch.id, sourceIds: ['source-1'] });
  }
  if (options.review !== false) library = reviewed(library, evidence, options.verdict);
  return { library, evidence, batch };
}

/** Every claim no receipt answers yet, answered by `verdict`. */
export function reviewed(library: LibraryV2, evidence: CardEvidence, verdict: (claim: Claim, card: Card) => ReviewVerdict = () => READY): LibraryV2 {
  let next = library;
  for (const card of library.cards) {
    const claims = pendingClaims(card, { library: next, evidence });
    next = recordClaims(next, claimReceipts(claims, { verdicts: Object.fromEntries(claims.map(claim => [claim.alias, verdict(claim, card)])), model: 'fixture/reviewer' }));
  }
  return next;
}

export const cardNumbered = (library: LibraryV2, number: number): Card => library.cards.find(card => card.number === number)!;
