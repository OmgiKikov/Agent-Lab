import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint } from '../src/contracts.js';
import { importEvidence, loggedMessages } from '../src/card/checks.js';
import { addCard, createLibraryV2, recordClaims } from '../src/card/library.js';
import { bindProposal, proposalCall, type DialogueProposal } from '../src/card/proposal.js';
import { cardReviewSchema, claimReceipts, pendingClaims, planClaims, reviewRequests, type ReviewVerdict } from '../src/card/review.js';
import { libraryV2Schema, type Card, type LibraryV2 } from '../src/card/schema.js';
import { cardStatus, cardStatuses, type CardStatus } from '../src/card/status.js';
import { importBatch } from '../src/scenario-library.js';
import { strictSchemaProblems } from './helpers/strict-schema.js';
import { dialogues, policy, proposals, refundRule } from './helpers/card-prep.js';

/*
 * C8: every semantic claim of a card is one question with its own basis, answered once per key for the whole library;
 * the status and the one owner question are derived from the card and the receipts, never stored.
 */

// A long variant of the same dialogue: the agent's two replies alone take about thirty kilobytes.
const long = dialogues[0]!.messages.map((message, index) => index === 1 || index === 3 ? { ...message, content: `${message.content} ${'Подробности. '.repeat(590)}` } : message);
const batch = importBatch([...dialogues, { id: 'long', messages: long }]);
const evidence = importEvidence([batch]);
const rule = { ...refundRule, sourceId: 'source-1' };
const call = (dialogueId: string) => proposalCall({ source: { kind: 'dialogue', batchId: batch.id, dialogueId },
  messages: loggedMessages(batch.dialogues.find(dialogue => dialogue.id === dialogueId)!), requirements: [rule], maxTurns: 6 });

function draft(cards: [string, DialogueProposal][], content = policy): LibraryV2 {
  let library = createLibraryV2({ id: 'library_review', imports: [{ id: batch.id, contentHash: batch.contentHash }],
    sources: [{ id: 'source-1', name: 'Правила возвратов', content, hash: fingerprint(content) }], requirements: [rule] });
  for (const [dialogueId, proposal] of cards) {
    library = addCard(library, bindProposal(proposal, call(dialogueId), library.nextNumber), { dialogueId, batchId: batch.id, sourceIds: ['source-1'] });
  }
  return library;
}
const ready: ReviewVerdict = { status: 'ready', reason: 'Подтверждено разговором и правилом.' };
/** The reviewer answers the card's open claims: ready unless named otherwise. */
function answered(library: LibraryV2, card: Card, verdicts: Record<string, ReviewVerdict> = {}): LibraryV2 {
  const claims = pendingClaims(card, { library, evidence });
  return recordClaims(library, claimReceipts(claims, { verdicts: Object.fromEntries(claims.map(claim => [claim.alias, verdicts[claim.alias] ?? ready])), model: 'fixture/reviewer' }));
}
/** The library with one card replaced, as an owner's command would leave it. */
const replaced = (library: LibraryV2, card: Card, receipts = library.receipts): LibraryV2 =>
  libraryV2Schema.parse({ ...library, cards: library.cards.map(item => item.id === card.id ? card : item), receipts });
const settle = (library: LibraryV2, cardId: string, key: string, id = `receipt_${library.receipts.length + 1}`): LibraryV2['receipts'] =>
  [...library.receipts, { id, at: '2026-09-23T00:00:00.000Z', via: 'pi-confirm', command: { kind: 'settle_claim', cardId, key } }];
const status = (library: LibraryV2, card = library.cards[0]!): CardStatus => cardStatus(card, { library, evidence, maxTurns: 6 });
const claimKey = (library: LibraryV2, card: Card, alias: string) => planClaims(card, { library, evidence }).find(claim => claim.alias === alias)!.key;

test('an edit asks again exactly the claims whose basis it changed', () => {
  const library = draft([['late', proposals.late]]);
  const card = library.cards[0]!;
  const before = new Map(planClaims(card, { library, evidence }).map(claim => [claim.alias, claim.key]));
  assert.deepEqual([...before.keys()], ['goal', 'fact_f1', 'expectation_e1', 'expectation_e2', 'coverage', 'leak']);
  const changed = (edit: (card: Card) => void) => {
    const edited = structuredClone(card);
    edit(edited);
    return planClaims(edited, { library, evidence }).filter(claim => before.get(claim.alias) !== claim.key).map(claim => claim.alias);
  };
  assert.deepEqual(changed(edited => { edited.client.knows[0]!.askedAs = 'номер терминала оплаты'; }), ['fact_f1', 'expectation_e1', 'expectation_e2'], 'a fact: its own claim and the duties read with the brief');
  assert.deepEqual(changed(edited => { edited.client.knows[0]!.disclosure = 'unknown'; }), ['fact_f1', 'expectation_e1', 'expectation_e2', 'leak'], 'a value the customer no longer knows is watched for leaks');
  assert.deepEqual(changed(edited => { edited.agentMust[1]!.text = 'рассказать, как вернуть деньги'; }), ['expectation_e2', 'leak']);
  assert.deepEqual(changed(edited => { edited.client.wants = 'Вернуть деньги'; }), ['goal', 'expectation_e1', 'expectation_e2']);
  assert.deepEqual(changed(edited => { edited.coverage[1] = { ...edited.coverage[1]!, as: 'ignored', reason: 'благодарность' }; }), ['coverage']);
  assert.deepEqual(changed(edited => { edited.title = 'Другое название'; edited.number = 9; }), [], 'a name or a number is no claim\'s basis');
});

test('a blocked claim leaves the card unusable, and no owner answer lifts it', () => {
  let library = draft([['late', proposals.late]]);
  const card = library.cards[0]!;
  library = answered(library, card, { goal: { status: 'blocked', reason: 'Цели клиента в разговоре нет.' } });
  assert.deepEqual(status(library), { status: 'unusable', problems: ['Цели клиента в разговоре нет.'] });
  library = replaced(library, card, settle(library, card.id, claimKey(library, card, 'goal')));
  assert.equal(status(library).status, 'unusable');
});

test('one question at a time, with two or three answers, each a typed command; a card waits for the reviewer before asking', () => {
  const unconfirmed: DialogueProposal = { ...proposals.late, knows: [...proposals.late.knows, { label: 'Сумма покупки', value: '1200', disclosure: 'on_request', from: null, askedAs: null }] };
  let library = draft([['late', unconfirmed]]);
  let card = library.cards[0]!;
  assert.deepEqual(status(library), { status: 'checking', problems: [] }, 'no receipts yet');
  library = answered(library, card, { goal: { status: 'needs_owner', reason: 'Клиент мог хотеть отмену.' },
    expectation_e2: { status: 'needs_owner', reason: 'Правило не говорит, как объяснять.' } });
  const asked: string[] = [];
  const shape = (current: CardStatus) => {
    assert.equal(current.status, 'needs_owner');
    const question = current.question!;
    assert.ok(question.choices.length >= 2 && question.choices.length <= 3, question.text);
    assert.deepEqual(question.choices.map(choice => choice.id), ['a', 'b', 'c'].slice(0, question.choices.length));
    assert.ok(question.text.length <= 300);
    asked.push(question.text);
    return question;
  };
  // An unconfirmed fact comes first: only the owner can say whether the customer knows it.
  const fact = shape(status(library));
  assert.equal(fact.text, 'Клиент знает «Сумма покупки: 1200»?');
  assert.deepEqual(fact.choices.map(choice => [choice.label, choice.command]), [
    ['Да, скажет, если спросят', { kind: 'set_fact_disclosure', cardId: card.id, factId: 'f2', disclosure: 'on_request' }],
    ['Нет, не знает', { kind: 'set_fact_disclosure', cardId: card.id, factId: 'f2', disclosure: 'unknown' }],
    ['Убрать', { kind: 'remove_fact', cardId: card.id, factId: 'f2' }]]);
  // The owner vouches for it: the fact now stands on the owner's receipt, and its claim is asked again.
  card = structuredClone(card);
  card.client.knows[1]!.source = { kind: 'owner', receiptId: 'receipt_fact' };
  library = replaced(library, card, [{ id: 'receipt_fact', at: '2026-09-23T00:00:00.000Z', via: 'pi-confirm', command: fact.choices[0]!.command }]);
  assert.equal(status(library).status, 'checking');
  library = answered(library, card);
  // Then the doubts, in order: what the customer wants before what the agent must do.
  const goal = shape(status(library));
  assert.equal(goal.text, 'Клиент хочет именно «Получить инструкцию по возврату оплаты»? Клиент мог хотеть отмену.');
  assert.deepEqual(goal.choices.map(choice => [choice.label, choice.command, choice.needsText]), [
    ['Да', { kind: 'settle_claim', cardId: card.id, key: goal.id }, undefined],
    ['Сказать иначе', { kind: 'edit_client', cardId: card.id, wants: card.client.wants }, true]]);
  library = replaced(library, card, settle(library, card.id, goal.id));
  const duty = shape(status(library));
  assert.equal(duty.text, 'Агент должен «объяснить, как оформить возврат»? Проверяющий сомневается: Правило не говорит, как объяснять.');
  assert.deepEqual(duty.choices.map(choice => choice.command.kind), ['settle_claim', 'remove_expectation', 'edit_expectation']);
  library = replaced(library, card, settle(library, card.id, duty.id));
  assert.deepEqual(status(library), { status: 'ready', problems: [] });
  assert.equal(asked.length, 3);
});

test('an expectation that is the card\'s only duty cannot be removed from it: two answers', () => {
  const single: DialogueProposal = { ...proposals.late, agentMust: [proposals.late.agentMust[1]!] };
  let library = draft([['late', single]]);
  library = answered(library, library.cards[0]!, { expectation_e1: { status: 'needs_owner', reason: 'Сомнение.' } });
  assert.deepEqual(status(library).question!.choices.map(choice => choice.label), ['Да, это правило', 'Сказать иначе']);
});

test('a settlement answers its key; a changed basis opens the question again', () => {
  let library = draft([['late', proposals.late]]);
  let card = library.cards[0]!;
  library = answered(library, card, { expectation_e2: { status: 'needs_owner', reason: 'Сомнение в применимости.' } });
  const first = status(library).question!;
  assert.equal(first.id, claimKey(library, card, 'expectation_e2'), 'a question is its claim\'s key');
  library = replaced(library, card, settle(library, card.id, first.id));
  assert.equal(status(library).status, 'ready');
  card = structuredClone(card);
  card.agentMust[1]!.text = 'объяснить, как оформить возврат по выписке';
  library = replaced(library, card);
  assert.equal(status(library, card).status, 'checking', 'the changed duty is not answered yet');
  library = answered(library, card, { expectation_e2: { status: 'needs_owner', reason: 'Сомнение в применимости.' } });
  const again = status(library, card);
  assert.equal(again.status, 'needs_owner', 'the old settlement answered another basis');
  assert.notEqual(again.question!.id, first.id);
});

test('a similar card reuses every answer whose basis it shares and is asked only the rest', () => {
  let library = draft([['late', proposals.late]]);
  const parent = library.cards[0]!;
  library = answered(library, parent);
  const similar: Card = { ...structuredClone(parent), id: `card_${'5'.repeat(64)}`, number: library.nextNumber, title: 'Возврат — потом спрашивает про чек',
    origin: { kind: 'similar', parentId: parent.id, change: { kind: 'turn', turn: { kind: 'report', after: 'агент объяснил возврат', says: 'А если чек потерян?' } } },
    client: { ...structuredClone(parent.client), turn: { kind: 'report', after: 'агент объяснил возврат', says: 'А если чек потерян?', source: { kind: 'owner', receiptId: 'receipt_turn' } } } };
  library = libraryV2Schema.parse({ ...library, cards: [...library.cards, similar], nextNumber: library.nextNumber + 1,
    receipts: [{ id: 'receipt_turn', at: '2026-09-23T00:00:00.000Z', via: 'pi-confirm', ownerWords: 'Потом клиент спрашивает про потерянный чек',
      command: { kind: 'add_similar', parentId: parent.id, change: { kind: 'turn', turn: { kind: 'report', after: 'агент объяснил возврат', says: 'А если чек потерян?' } } } }] });
  assert.deepEqual(pendingClaims(similar, { library, evidence }).map(claim => claim.alias), ['coverage', 'leak'], 'the goal, the fact and the duties are answered already');
  assert.equal(status(library, similar).status, 'checking');
  library = answered(library, similar);
  assert.equal(status(library, similar).status, 'ready');
});

test('twins: the later card asks whether to keep both, and a settlement keeps it', () => {
  let library = draft([['late', proposals.late], ['late', { ...proposals.late, title: 'Та же ситуация под другим названием' }]]);
  const [first, second] = library.cards as [Card, Card];
  library = answered(library, first);
  assert.deepEqual(pendingClaims(second, { library, evidence }), [], 'the same brief is the same claims');
  const statuses = cardStatuses({ library, evidence, maxTurns: 6 });
  assert.equal(statuses.get(first.id)!.status, 'ready');
  const twin = statuses.get(second.id)!.question!;
  assert.equal(twin.text, 'Совпадает с №1. Оставить обе?');
  assert.deepEqual(twin.choices.map(choice => [choice.label, choice.command]), [
    ['Оставить', { kind: 'settle_claim', cardId: second.id, key: twin.id }], ['Убрать эту', { kind: 'remove_card', cardId: second.id }]]);
  assert.deepEqual(status(library, second).question, twin, 'one card or all of them: the same answer');
  library = replaced(library, second, settle(library, second.id, twin.id));
  assert.equal(status(library, second).status, 'ready');
});

test('the reviewer reads the whole dialogue and every rule read for it; a review too large for one request goes as the story and the duties', () => {
  const library = draft([['late', proposals.late]]);
  const card = library.cards[0]!;
  const [request, ...rest] = reviewRequests(card, pendingClaims(card, { library, evidence }), { library, evidence });
  assert.equal(rest.length, 0);
  assert.deepEqual(request!.aliases, ['goal', 'fact_f1', 'expectation_e1', 'expectation_e2', 'coverage', 'leak']);
  assert.deepEqual(request!.payload.dialogue!.messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant', 'user'], 'the agent\'s replies too');
  assert.deepEqual(request!.payload.requirements.map(item => item.id), ['refund_rule']);
  assert.deepEqual(request!.payload.card.knows[0], { id: 'f1', label: 'Номер терминала', value: '5678', disclosure: 'on_request', askedAs: 'номер терминала', from: 2, owner: null });
  assert.doesNotMatch(JSON.stringify(request!.payload), /card_|receipt|basisHash|fixture\/reviewer/, 'no ids, receipts or earlier answers');

  const large = draft([['long', proposals.late]], `${policy} ${'Прочие условия возврата. '.repeat(900)}`);
  const parts = reviewRequests(large.cards[0]!, pendingClaims(large.cards[0]!, { library: large, evidence }), { library: large, evidence });
  assert.deepEqual(parts.map(part => part.aliases), [['goal', 'fact_f1', 'coverage', 'leak'], ['expectation_e1', 'expectation_e2']]);
  assert.deepEqual(parts.map(part => [!!part.payload.dialogue, part.payload.articles.length]), [[true, 0], [false, 1]]);

  const schema = cardReviewSchema(['goal', 'fact_f1']);
  assert.deepEqual(strictSchemaProblems(schema), []);
  assert.equal(schema.safeParse({ claims: { goal: ready } }).success, false, 'every listed claim is answered');
  assert.equal(schema.safeParse({ claims: { goal: ready, fact_f1: ready, leak: ready } }).success, false, 'and no other');
  assert.equal(schema.safeParse({ claims: { goal: ready, fact_f1: { status: 'maybe', reason: 'x' } } }).success, false);
});
