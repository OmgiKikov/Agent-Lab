import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, hostGrant, prepareCommand, type CommandContext } from '../src/card/commands.js';
import { cardMessage, importEvidence, loggedMessages, unusableFindings } from '../src/card/checks.js';
import { addCard, createLibraryV2 } from '../src/card/library.js';
import { bindProposal, proposalCall, type DialogueProposal, type ProposalCall } from '../src/card/proposal.js';
import { cardSchema, libraryV2Schema, type Card, type Filled, type LibraryV2 } from '../src/card/schema.js';
import { unmaskCommand, unmaskRequest } from '../src/card/unmask.js';
import { fingerprint } from '../src/contracts.js';
import { maskedSpans, withValues } from '../src/masking.js';
import { importBatch } from '../src/scenario-library.js';
import { policy, refundBasis, refundRule } from './helpers/card-prep.js';

/*
 * A value Lab filled in stands over the mark the table of marks it was counted by found. The first reading took every
 * lone «*» for a mark, «5 * 3» too; the table does not, so a card filled before it and read by the table would see its
 * values slide one mark over — the code of the order would land where the amount was. Its fills name no table
 * (version 1) and are read by it; what Lab fills now is counted by the table and says so. Invented data only.
 */

const OPENING = 'Пришло 5 * 3 = 15 штук вместо 5, а списали за * штук. Код заказа ###.';
const TURN = 'Ещё списали * рублей за доставку.';
const batch = importBatch([{ id: 'order', messages: [
  { role: 'user', content: OPENING },
  { role: 'assistant', content: 'Назовите код заказа.' },
  { role: 'user', content: TURN },
  { role: 'assistant', content: 'Проверю списания.' },
  { role: 'user', content: 'Спасибо!' },
] }]);
const dialogue = batch.dialogues[0]!;
const evidence = importEvidence([batch]);
const event = (eventIndex: number) => ({ batchId: batch.id, dialogueId: dialogue.id, eventIndex });
const sources = [{ id: 'source-1', name: 'Правила возвратов', content: policy, hash: fingerprint(policy) }];
const context: CommandContext = { evidence, maxTurns: 6, via: 'pi-confirm', at: '2026-09-25T12:00:00.000Z' };
const call = (): ProposalCall => proposalCall({ source: { kind: 'dialogue', batchId: batch.id, dialogueId: dialogue.id }, messages: loggedMessages(dialogue), sources, maxTurns: 6 });
const proposal: DialogueProposal = { title: 'Лишнее списание', topic: 'Возврат оплаты', wants: 'Вернуть деньги за лишние штуки', clarity: 'clear', writesEvent: 0,
  knows: [{ label: 'Код заказа', value: '4471', disclosure: 'initial', from: 0, askedAs: null }], plausibleKnows: [], leaves: 'получил инструкцию по возврату',
  turn: { kind: 'report', after: 'агент объяснил, как вернуть деньги', from: 2 },
  agentMust: [{ text: 'объяснить, как оформить возврат', basis: refundBasis, appliesWhen: null, observation: 'reply' }],
  coverage: { 2: { as: 'turn', reason: null }, 4: { as: 'stop', reason: null } } };

/** The opening as a Lab before the table filled it: the first reading took the product's «*» for a mark and gave it a value too. */
const V1_OPENING = 'Пришло 5 2 3 = 15 штук вместо 5, а списали за 20 штук. Код заказа 4471.';
const V1_FILLS: Filled[] = [
  { event: event(0), span: 0, mark: '*', kind: 'count', value: '2' },
  { event: event(0), span: 1, mark: '*', kind: 'count', value: '20' },
  { event: event(0), span: 2, mark: '###', kind: 'code', value: '4471' },
];

/** A draft as a Lab before the table stored it: the opening's marks filled by the first reading, the turn's mark not filled. */
function storedBeforeTable(): { library: LibraryV2; card: Card } {
  const bound = bindProposal(proposal, { ...call(), masked: [] }, 1);
  const card = cardSchema.parse({ ...bound, client: { ...bound.client, writes: V1_OPENING }, filled: V1_FILLS });
  const library = addCard(createLibraryV2({ id: 'library_order', imports: [{ id: batch.id, contentHash: batch.contentHash }], sources,
    requirements: [{ ...refundRule, sourceId: 'source-1' }], createdAt: '2026-09-24T21:00:00.000Z' }), card, { dialogueId: dialogue.id, batchId: batch.id, sourceIds: ['source-1'] });
  return { library, card };
}

test('the table reads «5 * 3» as no mark; the first reading, which fills written before the table were counted by, did', () => {
  assert.deepEqual(maskedSpans(OPENING, 1).map(span => span.mark), ['*', '*', '###']);
  assert.deepEqual(maskedSpans(OPENING).map(span => span.mark), ['*', '###']);
  assert.deepEqual(maskedSpans('5 * 3 = 15', 1).map(span => span.mark), ['*']);
  const [, amount, code] = maskedSpans(OPENING, 1);
  assert.equal(withValues(OPENING, [{ ...code!, value: '4471' }, { ...amount!, value: '20' }]), 'Пришло 5 * 3 = 15 штук вместо 5, а списали за 20 штук. Код заказа 4471.',
    'each value over its own place, in any order');
  assert.equal(withValues(OPENING, [{ ...code!, value: '1' }, { ...code!, value: '4471' }]), 'Пришло 5 * 3 = 15 штук вместо 5, а списали за * штук. Код заказа 4471.',
    'of two values over one mark, the later');
});

test('a card filled before the table, read again, has the same values at the same places — «5 * 3» and all', () => {
  const { library } = storedBeforeTable();
  const raw = JSON.parse(JSON.stringify(library));
  const read = libraryV2Schema.parse(raw);
  assert.equal(fingerprint(read), fingerprint(raw), 'the stored library parses unchanged: its hash still holds');
  const card = read.cards[0]!;
  assert.equal(card.filled!.some(fill => fill.maskVersion !== undefined), false, 'its fills name no table: the first reading');
  assert.equal(cardMessage(card, evidence, event(0)), V1_OPENING, 'the opening message reads as the card stored it, not «…за 2 штук. Код заказа 20.»');
  assert.deepEqual(unusableFindings(card, { evidence, maxTurns: 6 }), [{ check: 'masked-turn' }], 'the order code is read from its message; only the turn\'s mark is left');
  assert.deepEqual(unmaskRequest(card, evidence)?.slots.map(slot => [slot.id, slot.mark]), [['m2_0', '*']], 'no mark of the opening is offered again');
});

test('filling what such a card left counts by the table and says so; the values filled before stay where they are', () => {
  const { library, card } = storedBeforeTable();
  const command = unmaskCommand(unmaskRequest(card, evidence)!, { slots: { m2_0: { kind: 'amount', value: '150' } }, facts: {} });
  assert.deepEqual(command.spans.map(span => [span.event.eventIndex, span.span, span.maskVersion]), [[2, 0, 2]], 'the command says which table its places count by');
  const prepared = prepareCommand(library, command, context);
  const next = applyCommand(library, prepared, hostGrant(prepared, 'confirmed'));
  const after = next.cards[0]!;
  assert.deepEqual(after.filled!.map(fill => [fill.event.eventIndex, fill.span, fill.value, fill.maskVersion]),
    [[0, 0, '2', undefined], [0, 1, '20', undefined], [0, 2, '4471', undefined], [2, 0, '150', 2]]);
  assert.deepEqual([after.client.writes, after.client.turn?.says], [V1_OPENING, 'Ещё списали 150 рублей за доставку.'], 'the opening read anew is the one stored');
  assert.deepEqual(unusableFindings(after, { evidence, maxTurns: 6 }), []);
  assert.equal(unmaskRequest(after, evidence), undefined, 'nothing is left to fill');
  assert.deepEqual(next.receipts.at(-1)!.command, command, 'the receipt keeps the table with the places');
});

test('a card Lab fills now counts its marks by the table and records it: the product stays a product', () => {
  const masked = call();
  assert.deepEqual(masked.masked.map(slot => [slot.id, slot.mark]), [['m0_0', '*'], ['m0_1', '###'], ['m2_0', '*']]);
  const card = bindProposal({ ...proposal, masked: { m0_0: { kind: 'count', value: '20' }, m0_1: { kind: 'code', value: '4471' }, m2_0: { kind: 'amount', value: '150' } } }, masked, 1);
  assert.equal(card.client.writes, 'Пришло 5 * 3 = 15 штук вместо 5, а списали за 20 штук. Код заказа 4471.');
  assert.deepEqual(card.filled!.map(fill => [fill.event.eventIndex, fill.span, fill.maskVersion]), [[0, 0, 2], [0, 1, 2], [2, 0, 2]]);
  assert.deepEqual(unusableFindings(card, { evidence, maxTurns: 6 }), []);
  const raw = JSON.parse(JSON.stringify(card));
  assert.equal(fingerprint(cardSchema.parse(raw)), fingerprint(raw));
  assert.equal(cardMessage(cardSchema.parse(raw), evidence, event(0)), card.client.writes, 'read again, by the table it names');
});
