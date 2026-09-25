import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, hostGrant, prepareCommand, type CommandContext, type Prepared } from '../src/card/commands.js';
import { acceptLibraryV2 } from '../src/card/library.js';
import type { CardCommand, LibraryV2 } from '../src/card/schema.js';
import { cardStatus } from '../src/card/status.js';
import type { Reference } from '../src/reference.js';
import { libraryHash } from '../src/scenario-library.js';
import { cardDraft, cardNumbered, reviewed, type CardDraft } from './helpers/card-library.js';

/*
 * A reference on a library card: the article the agent must retrieve and/or the fact it must convey. The owner sets
 * it with a confirmed command, a model's proposal waits for the owner's word, and the accepted card runs the checks.
 */

const AT = '2026-09-25T12:00:00.000Z';
const context = (draft: CardDraft): CommandContext => ({ evidence: draft.evidence, maxTurns: 3, via: 'pi-confirm', at: AT });
const article: Reference = { id: 'assessor_rag', origin: 'assessor', confirmed: true, source: { doc: '24' } };
const proposal: Reference = { id: 'proposed_1', origin: 'proposed', confirmed: false, text: 'Код услуги нужен до 15:00' };

function apply(draft: CardDraft, library: LibraryV2, command: CardCommand): { prepared: Prepared; next: LibraryV2 } {
  const prepared = prepareCommand(library, command, context(draft));
  return { prepared, next: applyCommand(library, prepared, hostGrant(prepared, 'confirmed')) };
}

test('setting references is the owner\'s confirmed decision and makes a new version of the card', () => {
  const draft = cardDraft();
  const card = cardNumbered(draft.library, 1);
  const { prepared, next } = apply(draft, draft.library, { kind: 'set_references', cardId: card.id, references: [article] });
  assert.equal(prepared.authority, 'owner-confirm');
  assert.deepEqual(cardNumbered(next, 1).references, [article]);
  assert.equal(cardNumbered(next, 1).revision, card.revision + 1);
  assert.deepEqual(next.receipts.at(-1)!.command, { kind: 'set_references', cardId: card.id, references: [article] });
});

test('an empty list removes the references and leaves the card as a card without them', () => {
  const draft = cardDraft();
  const card = cardNumbered(draft.library, 1);
  const { next: withReference } = apply(draft, draft.library, { kind: 'set_references', cardId: card.id, references: [article] });
  const { next } = apply(draft, withReference, { kind: 'set_references', cardId: card.id, references: [] });
  assert.equal('references' in cardNumbered(next, 1), false);
});

test('a model proposal holds the card for the owner, who confirms or removes it', () => {
  const draft = cardDraft();
  const card = cardNumbered(draft.library, 1);
  const { next } = apply(draft, draft.library, { kind: 'set_references', cardId: card.id, references: [article, proposal] });
  const library = reviewed(next, draft.evidence);
  const status = cardStatus(cardNumbered(library, 1), { library, evidence: draft.evidence, maxTurns: 3 });
  assert.equal(status.status, 'needs_owner');
  assert.match(status.question!.text, /Lab предлагает эталон: «Код услуги нужен до 15:00»/);
  const [keep, drop] = status.question!.choices;
  assert.deepEqual(keep!.command, { kind: 'set_references', cardId: card.id, references: [article, { ...proposal, confirmed: true }] });
  assert.deepEqual(drop!.command, { kind: 'set_references', cardId: card.id, references: [article] });
});

test('an accepted card with a reference runs the reference checks and the judge rubric', () => {
  const draft = cardDraft();
  const card = cardNumbered(draft.library, 1);
  const text: Reference = { id: 'owner_1', origin: 'owner', confirmed: true, text: 'Код услуги нужен до 15:00' };
  const { next } = apply(draft, draft.library, { kind: 'set_references', cardId: card.id, references: [article, text] });
  const library = reviewed(next, draft.evidence);
  const { scenarios } = acceptLibraryV2(library, libraryHash(library), [card.id], { evidence: draft.evidence, maxTurns: 3 });
  const scenario = scenarios.find(item => item.id === card.id)!;
  assert.deepEqual(scenario.checks.map(check => [check.id, check.kind]), [['ref_assessor_rag_source', 'source_retrieved'], ['ref_owner_1_tokens', 'answer_reference_tokens']]);
  assert.ok(scenario.metrics?.some(metric => metric.id === 'reference_match'));
});
