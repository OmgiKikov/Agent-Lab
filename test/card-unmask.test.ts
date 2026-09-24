import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { cardExclusion } from '../src/card/calibration-scope.js';
import { applyCommand, hostGrant, prepareCommand, requiredAuthority, type CommandContext } from '../src/card/commands.js';
import { importEvidence, loggedMessages, problemText, unusableFindings } from '../src/card/checks.js';
import { addCard, createLibraryV2 } from '../src/card/library.js';
import { bindProposal, cardProposalProblem, cardProposalSchema, proposalCall, proposalPayload, type DialogueProposal, type ProposalCall } from '../src/card/proposal.js';
import { cardSchema, libraryV2Schema, type Card, type LibraryV2 } from '../src/card/schema.js';
import { cardStatus } from '../src/card/status.js';
import { unmaskCommand, unmaskProblem, unmaskRequest, unmaskSchema } from '../src/card/unmask.js';
import { briefRows, cardSituation, changeText } from '../src/card/view.js';
import { fingerprint } from '../src/contracts.js';
import { CommandRefused } from '../src/errors.js';
import { maskedSpans, withValues } from '../src/masking.js';
import { importBatch } from '../src/scenario-library.js';
import { cardDraft, cardNumbered } from './helpers/card-library.js';
import { policy, refundBasis, refundRule } from './helpers/card-prep.js';
import { strictSchemaProblems } from './helpers/strict-schema.js';

/*
 * UX1: a de-identified log writes marks over what the customer typed. Lab fills them — at proposal time in the same
 * call, for an existing card by one builder call the owner confirms — and keeps the rest of the message verbatim; the
 * check stays only for what could not be filled. Several changes of one card go as one series, checked and recorded once.
 * Invented data only.
 */

const OPENING = 'С утра было # покупки, на * и *, терминал пишет «нет связи».';
const batch = importBatch([{ id: 'masked', messages: [
  { role: 'user', content: OPENING },
  { role: 'assistant', content: 'Назовите номер терминала.' },
  { role: 'user', content: 'Номер терминала: ###' },
  { role: 'assistant', content: 'Перезагрузите терминал и попробуйте снова.' },
  { role: 'user', content: 'Спасибо!' },
] }]);
const dialogue = batch.dialogues[0]!;
const evidence = importEvidence([batch]);
const sources = [{ id: 'source-1', name: 'Правила возвратов', content: policy, hash: fingerprint(policy) }];
const call = (masked = true): ProposalCall => {
  const made = proposalCall({ source: { kind: 'dialogue', batchId: batch.id, dialogueId: dialogue.id }, messages: loggedMessages(dialogue), sources, maxTurns: 6 });
  return masked ? made : { ...made, masked: [] };
};
const duties: DialogueProposal['agentMust'] = [{ text: 'объяснить, как оформить возврат', basis: refundBasis, appliesWhen: null, observation: 'reply' }];
const FILLS = { m0_0: { kind: 'count', value: '3' }, m0_1: { kind: 'amount', value: '500 ₽' }, m0_2: { kind: 'amount', value: '1 200 ₽' }, m2_0: { kind: 'code', value: '4471' } } as const;
const proposal = (change: (proposal: DialogueProposal) => void = () => {}): DialogueProposal => {
  const made: DialogueProposal = { title: 'Терминал без связи', topic: 'Связь терминала', wants: 'Вернуть терминалу связь', clarity: 'clear', writesEvent: 0,
    knows: [{ label: 'Номер терминала', value: '4471', disclosure: 'on_request', from: 2, askedAs: 'номер терминала' }], plausibleKnows: [],
    leaves: 'получил инструкцию', turn: null, agentMust: structuredClone(duties), coverage: { 2: { as: 'fact', reason: null }, 4: { as: 'stop', reason: null } },
    masked: structuredClone(FILLS) };
  change(made);
  return made;
};

test('the marks of a message are found by their shape and the values written in keep every other character', () => {
  assert.deepEqual(maskedSpans(OPENING).map(span => span.mark), ['#', '*', '*']);
  assert.deepEqual(maskedSpans('*важно*, 5*3, №#12, xxxx 1234, <PHONE>, [скрыто]').map(span => span.mark), ['xxxx', '<PHONE>', '[скрыто]'], 'a mark touching a letter or a digit is not a mask');
  assert.equal(withValues(OPENING, new Map([[0, '3'], [2, '1 200 ₽']])), 'С утра было 3 покупки, на * и 1 200 ₽, терминал пишет «нет связи».');
});

test('a masked opening is filled in the proposal call: one value per mark, the rest verbatim, the card marked and kept out of calibration', () => {
  const masked = call();
  assert.deepEqual(masked.masked.map(slot => slot.id), ['m0_0', 'm0_1', 'm0_2', 'm2_0'], 'every mark of the customer\'s messages, none of the agent\'s');
  const schema = cardProposalSchema(masked);
  assert.equal(schema.safeParse(proposal()).success, true);
  assert.equal(schema.safeParse(proposal(made => { delete made.masked!.m0_1; })).success, false, 'the schema asks for every mark');
  assert.equal(schema.safeParse(proposal(made => { (made.masked as Record<string, unknown>).m9_0 = { kind: 'count', value: '1' }; })).success, false, 'and for no other');
  assert.deepEqual(strictSchemaProblems(schema), []);
  assert.match(JSON.stringify(z.toJSONSchema(schema)), /"masked":\{"type":"object","properties":\{"m0_0":/);
  assert.deepEqual(proposalPayload({ task: 't', call: masked, topics: [], written: [] }).masked?.[0], { id: 'm0_0', message: 0, mark: '#', before: 'С утра было ', after: ' покупки, на * и *, терминал пишет «нет связи».' });
  assert.equal(proposalCall({ source: { kind: 'dialogue', batchId: batch.id, dialogueId: dialogue.id }, messages: [{ index: 0, role: 'user', content: 'Помогите с возвратом.' }], sources, maxTurns: 6 }).masked.length, 0);

  assert.equal(cardProposalProblem(proposal(), masked), undefined);
  const card = bindProposal(proposal(), masked, 1);
  assert.equal(card.client.writes, 'С утра было 3 покупки, на 500 ₽ и 1 200 ₽, терминал пишет «нет связи».');
  assert.deepEqual(card.filled!.map(item => [item.event.eventIndex, item.span, item.mark, item.kind, item.value]),
    [[0, 0, '#', 'count', '3'], [0, 1, '*', 'amount', '500 ₽'], [0, 2, '*', 'amount', '1 200 ₽'], [2, 0, '###', 'code', '4471']]);
  assert.deepEqual(unusableFindings(card, { evidence, maxTurns: 6 }), [], 'the fact reads from its message with the value in place');
  assert.equal(cardExclusion(card), 'situation_edited', 'the synthetic customer says what the log hid: not the logged situation');
  const rows = briefRows(cardSituation(createLibraryV2({ id: 'library_x', imports: [], sources, requirements: [], createdAt: '2026-09-24T10:00:00.000Z' }), card)).map(row => row.text).join('\n');
  assert.match(rows, /подставлено вместо обезличенного: «3», «500 ₽», «1 200 ₽», «4471»/);
});

test('a value of the wrong kind, a mark again or a masked fact goes back to the model with its reason', () => {
  const masked = call();
  assert.match(cardProposalProblem(proposal(made => { made.masked!.m0_0 = { kind: 'count', value: 'три' }; }), masked)!, /m0_0.*count: write digits only/);
  assert.match(cardProposalProblem(proposal(made => { made.masked!.m0_1 = { kind: 'amount', value: 'пятьсот' }; }), masked)!, /amount: write it with digits/);
  assert.match(cardProposalProblem(proposal(made => { made.masked!.m0_2 = { kind: 'other', value: '*' }; }), masked)!, /still holds a masking character/);
  // The table of masks reads «xxx» and «ХХХ» as marks: written in for a mark, they are a mark again.
  for (const value of ['xxx', 'ХХХ', 'Иван Хххх']) assert.match(cardProposalProblem(proposal(made => { made.masked!.m0_2 = { kind: 'other', value }; }), masked)!, /still holds a masking character/, value);
  assert.match(cardProposalProblem(proposal(made => { made.knows[0]!.value = '###'; }), masked)!, /knows\[0\] "Номер терминала": the value "###" is a masking mark/);
});

test('a product, a number sign and a Roman numeral are no masks: nothing is filled in, and the situation stays in the check against production', () => {
  const plain = importBatch([{ id: 'plain', messages: [
    { role: 'user', content: 'Заказ # 123: пришло 5 * 3 = 15 штук, как в XXX веке. Верните деньги за лишние.' },
    { role: 'assistant', content: 'Проверю заказ.' },
    { role: 'user', content: 'Спасибо!' },
  ] }]);
  const logged = plain.dialogues[0]!;
  const made = proposalCall({ source: { kind: 'dialogue', batchId: plain.id, dialogueId: logged.id }, messages: loggedMessages(logged), sources, maxTurns: 6 });
  assert.deepEqual(made.masked, [], 'no slot for the model to invent a value in');
  const unfilled = proposal(item => { delete item.masked; item.knows = []; item.coverage = { 2: { as: 'stop', reason: null } }; });
  const card = bindProposal(unfilled, made, 1);
  assert.equal(card.filled, undefined);
  assert.deepEqual(unusableFindings(card, { evidence: importEvidence([plain]), maxTurns: 6 }), []);
  assert.equal(cardExclusion(card), undefined, 'the logged situation, checked against production');
});

test('when filling fails the check stays: the opening keeps its marks, the card is not ready and says Lab can fill it', () => {
  const bare = call(false);
  const unfilled = proposal(made => { delete made.masked; made.knows = []; made.coverage = { 2: { as: 'ignored', reason: 'номер скрыт' }, 4: { as: 'stop', reason: null } }; });
  assert.equal(cardProposalProblem(unfilled, bare), undefined, 'a mark left is not the model\'s slip: no repair is spent on it');
  const card = bindProposal(unfilled, bare, 1);
  assert.equal(card.client.writes, OPENING);
  assert.equal(card.filled, undefined);
  const findings = unusableFindings(card, { evidence, maxTurns: 6 });
  assert.deepEqual(findings, [{ check: 'masked-opening' }]);
  assert.match(problemText(findings[0]!, card), /вместо значений знаки обезличивания.*Lab подставит правдоподобные значения/);
});

/** A draft of one card bound before its marks were filled: what an existing draft holds. */
function maskedDraft(): { library: LibraryV2; card: Card } {
  const unfilled = proposal(made => { delete made.masked; made.knows[0]!.value = '###'; });
  const card = bindProposal(unfilled, call(false), 1);
  let library = createLibraryV2({ id: 'library_masked', imports: [{ id: batch.id, contentHash: batch.contentHash }], sources,
    requirements: [{ ...refundRule, sourceId: 'source-1' }], createdAt: '2026-09-24T10:00:00.000Z' });
  library = addCard(library, card, { dialogueId: dialogue.id, batchId: batch.id, sourceIds: ['source-1'] });
  return { library, card };
}
const context: CommandContext = { evidence, maxTurns: 6, via: 'pi-confirm', at: '2026-09-24T12:00:00.000Z' };

test('an existing card is filled by one builder answer turned into one command the owner confirms once', () => {
  const { library, card } = maskedDraft();
  assert.deepEqual(unusableFindings(card, { evidence, maxTurns: 6 }).map(finding => finding.check), ['masked-opening', 'masked-fact']);
  const request = unmaskRequest(card, evidence)!;
  assert.deepEqual([request.slots.map(slot => slot.id), request.facts.map(fact => fact.id)], [['m0_0', 'm0_1', 'm0_2', 'm2_0'], ['f1']]);
  const answer = { slots: structuredClone(FILLS), facts: { f1: '4471' } };
  assert.equal(unmaskSchema(request).safeParse(answer).success, true);
  assert.match(unmaskProblem(request, { ...answer, facts: { f1: '9999' } })!, /facts\.f1: "9999" is not in message 2/, 'a fact reads as its message does with the values in');
  assert.equal(unmaskProblem(request, answer), undefined);

  const command = unmaskCommand(request, answer);
  assert.equal(requiredAuthority(command), 'owner-confirm');
  const prepared = prepareCommand(library, command, context);
  assert.deepEqual(prepared.diff[0]!.changes.map(changeText), [
    'Пишет: было ««С утра было # покупки, на * и *, терминал пишет «нет связи».»», стало ««С утра было 3 покупки, на 500 ₽ и 1 200 ₽, терминал пишет «нет связи».»»',
    'Знает: было «Номер терминала: ### — если спросят», стало «Номер терминала: 4471 — если спросят»']);
  assert.throws(() => applyCommand(library, prepared, hostGrant(prepared, 'words')), CommandRefused, 'Lab\'s values need the owner\'s confirmation');
  const next = applyCommand(library, prepared, hostGrant(prepared, 'confirmed'));
  const after = next.cards[0]!;
  assert.equal(after.client.writes, 'С утра было 3 покупки, на 500 ₽ и 1 200 ₽, терминал пишет «нет связи».');
  assert.deepEqual([after.client.knows[0]!.value, after.client.knows[0]!.source.kind, after.filled!.length, after.revision], ['4471', 'dialogue', 4, 2]);
  assert.deepEqual(next.receipts.map(receipt => receipt.command.kind), ['fill_masked'], 'one receipt for the whole fill');
  assert.equal(cardStatus(after, { library: next, evidence, maxTurns: 6 }).problems.length, 0, 'no masked finding is left');
  assert.equal(unmaskRequest(after, evidence), undefined, 'nothing is left to fill');
  assert.equal(cardExclusion(after), 'situation_edited');
  assert.throws(() => prepareCommand(library, { ...command, spans: [{ ...command.spans[0]!, span: 7 }] }, context), /нет такого обезличенного значения/);
});

test('a change that needs another field says to pass them together, and the series passes in one receipt', () => {
  const draft = cardDraft();
  const card = cardNumbered(draft.library, 1);
  const cardContext: CommandContext = { evidence: draft.evidence, maxTurns: 3, via: 'pi-confirm', at: '2026-09-24T12:00:00.000Z' };
  const writes = 'Помогите с возвратом, номер терминала 5678.';
  assert.throws(() => prepareCommand(draft.library, { kind: 'set_fact_disclosure', cardId: card.id, factId: 'f1', disclosure: 'initial' }, cardContext),
    /в первой реплике этого нет\. Передайте вместе с первой репликой, где это есть, — одной правкой\./);
  assert.throws(() => prepareCommand(draft.library, { kind: 'edit_client', cardId: card.id, writes }, cardContext),
    /уже есть в первой реплике\. Передайте вместе с первой репликой без этого — одной правкой\./);
  const series = { kind: 'edit_card' as const, cardId: card.id, changes: [{ kind: 'edit_client' as const, writes }, { kind: 'set_fact_disclosure' as const, factId: 'f1', disclosure: 'initial' as const }] };
  assert.equal(requiredAuthority(series), 'owner-confirm', 'a decision about the customer inside the series needs the confirmation');
  const prepared = prepareCommand(draft.library, series, cardContext);
  assert.deepEqual(prepared.diff.map(item => item.number), [1]);
  assert.deepEqual(prepared.diff[0]!.changes.map(change => change.field), ['Пишет', 'Знает'], 'the whole before → after of the situation in one preview');
  const next = applyCommand(draft.library, prepared, hostGrant(prepared, 'confirmed'));
  const after = cardNumbered(next, 1);
  assert.deepEqual([after.client.writes, after.client.knows[0]!.disclosure, after.revision], [writes, 'initial', 2]);
  assert.equal(next.receipts.length, draft.library.receipts.length + 1);
  assert.deepEqual(next.receipts.at(-1)!.command, series, 'the receipt keeps the series verbatim');
  assert.equal(requiredAuthority({ kind: 'edit_card', cardId: card.id, changes: [{ kind: 'edit_client', leaves: 'получил ответ' }] }), 'owner-words');
});

test('libraries written before fills and series parse unchanged', () => {
  const draft = cardDraft();
  const raw = JSON.parse(JSON.stringify(draft.library));
  assert.equal(fingerprint(libraryV2Schema.parse(raw)), fingerprint(raw));
  for (const card of draft.library.cards) assert.equal('filled' in cardSchema.parse(card), false);
});
