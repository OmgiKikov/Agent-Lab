import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCommand, hostGrant, prepareCommand, requiredAuthority, type CommandContext, type HostGrant, type Prepared } from '../src/card/commands.js';
import { acceptLibraryV2 } from '../src/card/library.js';
import { planClaims } from '../src/card/review.js';
import type { CardCommand, LibraryV2 } from '../src/card/schema.js';
import { cardStatus, cardStatuses } from '../src/card/status.js';
import { changeText } from '../src/card/view.js';
import { CommandRefused, StaleRevisionError, UnknownReference } from '../src/errors.js';
import { libraryHash } from '../src/scenario-library.js';
import { cardDraft, cardNumbered, READY, reviewed, type CardDraft } from './helpers/card-library.js';
import { cardRun } from './helpers/cards.js';
import { refundRule } from './helpers/card-prep.js';
import { ExperimentStore } from '../src/store.js';

/*
 * C10: the owner's commands on a card draft. Each one is previewed (what changes in which brief, the cards it
 * touches, the claims asked again), applied only with a grant a host issued for that very preview, recorded
 * verbatim in a receipt, and refused on a draft that moved since the preview. A model's argument is no grant.
 */

const AT = '2026-09-23T12:00:00.000Z';
const context = (draft: CardDraft, extra: Partial<CommandContext> = {}): CommandContext => ({ evidence: draft.evidence, maxTurns: 3, via: 'pi-confirm', at: AT, ...extra });
const late = (library: LibraryV2) => cardNumbered(library, 1);
const known = (library: LibraryV2) => cardNumbered(library, 2);
const confirmed = (prepared: Prepared) => applyCommand(libraryOf(prepared), prepared, hostGrant(prepared, 'confirmed'));
const drafts = new WeakMap<Prepared, LibraryV2>();
const libraryOf = (prepared: Prepared) => drafts.get(prepared)!;
function prepare(library: LibraryV2, command: CardCommand, draft: CardDraft, extra: Partial<CommandContext> = {}): Prepared {
  const prepared = prepareCommand(library, command, context(draft, extra));
  drafts.set(prepared, library);
  return prepared;
}
const changes = (prepared: Prepared) => prepared.diff.flatMap(item => item.changes.map(changeText));

test('changing when the customer names a fact: preview, receipt, a new version of the card and its account kept true', () => {
  const draft = cardDraft();
  const card = late(draft.library);
  const prepared = prepare(draft.library, { kind: 'set_fact_disclosure', cardId: card.id, factId: 'f1', disclosure: 'unknown' }, draft);
  assert.equal(prepared.authority, 'owner-confirm');
  assert.deepEqual(prepared.scope, [card.id]);
  assert.deepEqual(changes(prepared), ['Знает: было «Номер терминала: 5678 — если спросят», стало «Номер терминала — не знает»']);
  const after = late(prepared.next);
  const keys = new Set(planClaims(after, { library: prepared.next, evidence: draft.evidence }).filter(claim => ['fact', 'expectation', 'leak', 'coverage'].includes(claim.kind)).map(claim => claim.key));
  assert.deepEqual(new Set(prepared.recheck), keys, 'the fact, the duties read with it, the leak and the account are asked again; the goal is not');

  const next = confirmed(prepared);
  const receipt = next.receipts.at(-1)!;
  assert.deepEqual(receipt, { id: receipt.id, at: AT, via: 'pi-confirm', command: { kind: 'set_fact_disclosure', cardId: card.id, factId: 'f1', disclosure: 'unknown' } });
  assert.deepEqual(late(next).client.knows[0]!.source, { kind: 'owner', receiptId: receipt.id });
  assert.deepEqual(late(next).coverage.map(entry => [entry.event.eventIndex, entry.as]), [[2, 'changed'], [4, 'stop']], 'the message the fact came from no longer backs it');
  assert.deepEqual([late(next).revision, next.revision, known(next)], [2, draft.library.revision + 1, known(draft.library)], 'only this card gets a new version');
});

test('a disclosure that contradicts the first message is refused with what to pass together with it', () => {
  const draft = cardDraft();
  assert.throws(() => prepare(draft.library, { kind: 'set_fact_disclosure', cardId: late(draft.library).id, factId: 'f1', disclosure: 'initial' }, draft),
    (error: unknown) => error instanceof CommandRefused && /в первой реплике этого нет\. Передайте вместе с первой репликой, где это есть, — одной правкой\./.test(error.message));
  assert.throws(() => prepare(draft.library, { kind: 'set_fact_disclosure', cardId: known(draft.library).id, factId: 'f1', disclosure: 'on_request' }, draft),
    (error: unknown) => error instanceof CommandRefused && /уже есть в первой реплике\. Передайте вместе с первой репликой без этого — одной правкой\./.test(error.message));
});

test('a new fact gets the next id and never an id a removed fact had', () => {
  const draft = cardDraft();
  const cardId = late(draft.library).id;
  const added = confirmed(prepare(draft.library, { kind: 'set_fact', cardId, label: 'Сумма', value: 1200, disclosure: 'on_request' }, draft));
  assert.deepEqual(late(added).client.knows.map(fact => [fact.id, fact.label, fact.source.kind]), [['f1', 'Номер терминала', 'dialogue'], ['f2', 'Сумма', 'owner']]);
  const removed = confirmed(prepare(added, { kind: 'remove_fact', cardId, factId: 'f2' }, draft));
  assert.deepEqual(late(removed).client.knows.map(fact => fact.id), ['f1']);
  const again = prepare(removed, { kind: 'set_fact', cardId, label: 'Дата покупки', value: '12.03.2026', disclosure: 'on_request' }, draft);
  assert.deepEqual(late(again.next).client.knows.map(fact => fact.id), ['f1', 'f3']);
  assert.deepEqual(changes(again), ['Знает: добавлено «Дата покупки: 12.03.2026 — если спросят»']);
  assert.throws(() => prepare(removed, { kind: 'remove_fact', cardId, factId: 'f2' }, draft),
    (error: unknown) => error instanceof UnknownReference && error.what === 'fact' && error.allowed.join() === 'f1 Номер терминала');
});

test('in one series a removed fact\'s id is never given to the new one: the change reads «убрано» and «добавлено», not one fact rewritten', () => {
  const draft = cardDraft();
  const cardId = late(draft.library).id;
  const series = prepare(draft.library, { kind: 'edit_card', cardId, changes: [{ kind: 'remove_fact', factId: 'f1' },
    { kind: 'set_fact', label: 'Совсем другой факт', value: 'да', disclosure: 'on_request' }] }, draft);
  assert.deepEqual(late(series.next).client.knows.map(fact => [fact.id, fact.label]), [['f2', 'Совсем другой факт']]);
  assert.deepEqual(changes(series), ['Знает: убрано «Номер терминала: 5678 — если спросят»', 'Знает: добавлено «Совсем другой факт: да — если спросят»']);
  // An id the series gave out and took back is not given again within it either.
  const twice = prepare(draft.library, { kind: 'edit_card', cardId, changes: [{ kind: 'set_fact', label: 'Сумма', value: 1200, disclosure: 'on_request' },
    { kind: 'remove_fact', factId: 'f2' }, { kind: 'set_fact', label: 'Дата покупки', value: '12.03.2026', disclosure: 'on_request' }] }, draft);
  assert.deepEqual(late(twice.next).client.knows.map(fact => fact.id), ['f1', 'f3']);
  // Once recorded, the series' ids stay taken: the next new fact is after all of them.
  const next = prepare(confirmed(twice), { kind: 'set_fact', cardId, label: 'Канал', value: 'чат', disclosure: 'on_request' }, draft);
  assert.deepEqual(late(next.next).client.knows.map(fact => fact.id), ['f1', 'f3', 'f4']);
});

test('rewriting a fact keeps how the agent\'s question about it is recognised; a new wording of it is its own line', () => {
  const draft = cardDraft();
  const cardId = late(draft.library).id;
  assert.equal(late(draft.library).client.knows[0]!.askedAs, 'номер терминала');
  const relabelled = prepare(draft.library, { kind: 'set_fact', cardId, factId: 'f1', label: 'Номер терминала', value: '8765', disclosure: 'on_request' }, draft);
  assert.equal(late(relabelled.next).client.knows[0]!.askedAs, 'номер терминала', 'a command that does not name it leaves it as it was');
  assert.deepEqual(changes(relabelled), ['Знает: было «Номер терминала: 5678 — если спросят», стало «Номер терминала: 8765 — если спросят»']);
  const asked = prepare(draft.library, { kind: 'set_fact', cardId, factId: 'f1', label: 'Номер терминала', value: '5678', disclosure: 'on_request', askedAs: 'номер кассы' }, draft);
  assert.deepEqual(changes(asked), ['Знает: Номер терминала: 5678 — если спросят: было «номер терминала», стало «номер кассы»']);
});

test('a duty\'s rule, its condition and a turn\'s kind are shown when they change, and the authority is the strictest of what changes', () => {
  const draft = cardDraft();
  const card = late(draft.library);
  const second = { id: 'rule_ask_number', text: 'Если номера нет, уточнить номер терминала.', quote: 'Если номера нет, уточните номер терминала.', critical: true, observable: true,
    kind: 'behavior' as const, sourceId: 'source-1' };
  const library = { ...draft.library, requirements: [...draft.library.requirements, second] };
  const rule = prepare(library, { kind: 'edit_expectation', cardId: card.id, expectationId: 'e1', requirementIds: [second.id] }, draft);
  assert.equal(rule.authority, 'owner-confirm');
  assert.deepEqual(changes(rule), [`Агент должен: не запрашивать номер терминала повторно, если клиент его уже назвал — правило: было «${refundRule.quote}», стало «${second.quote}»`]);
  // New words with a dropped condition: the words alone would be a wording, the dropped condition makes it a decision.
  const both = prepare(draft.library, { kind: 'edit_expectation', cardId: card.id, expectationId: 'e2', text: 'объяснить, куда подать заявление', appliesWhen: null }, draft,
    { ownerWords: 'объяснить, куда подать заявление' });
  assert.equal(both.authority, 'owner-confirm');
  assert.deepEqual(changes(both), ['Агент должен: было «объяснить, как оформить возврат», стало «объяснить, куда подать заявление»',
    'Агент должен: объяснить, куда подать заявление — когда: было «клиент назвал номер терминала», стало «всегда»']);
  assert.throws(() => applyCommand(draft.library, both, hostGrant(both, 'words')), CommandRefused, 'the owner\'s words never stand in for the confirmation of a dropped condition');
  assert.equal(confirmed(both).receipts.at(-1)!.ownerWords, 'объяснить, куда подать заявление');
  const turned = confirmed(prepare(draft.library, { kind: 'set_turn', cardId: card.id, turn: { kind: 'change_intent', after: 'агент объяснил возврат', says: 'А можно обменять?' } }, draft));
  const kind = prepare(turned, { kind: 'set_turn', cardId: card.id, turn: { kind: 'report', after: 'агент объяснил возврат', says: 'А можно обменять?' } }, draft);
  assert.deepEqual(changes(kind), ['Поворот: было «меняет намерение после «агент объяснил возврат»: «А можно обменять?»», стало «сообщает, что видит после «агент объяснил возврат»: «А можно обменять?»»']);
});

test('an answer needs what it is and what it does: words given to an answer that takes none never make its decision a wording', () => {
  const doubt = { status: 'needs_owner' as const, reason: 'В правиле не сказано, что номер спрашивают один раз.' };
  const draft = cardDraft({ verdict: (claim, card) => card.number === 1 && claim.alias === 'expectation_e1' ? doubt : READY });
  const card = late(draft.library);
  const question = cardStatus(card, { library: draft.library, evidence: draft.evidence, maxTurns: 3 }).question!;
  // «Убрать» removes the duty: a decision, whatever words ride along with the answer.
  const removal = prepare(draft.library, { kind: 'answer_question', cardId: card.id, questionId: question.id, choice: 'b', text: 'убрать это' }, draft);
  assert.deepEqual([removal.command.kind, removal.authority], ['remove_expectation', 'owner-confirm']);
  assert.throws(() => applyCommand(draft.library, removal, hostGrant(removal, 'words')), CommandRefused);
  assert.equal(confirmed(removal).receipts.at(-1)!.ownerWords, undefined, 'words the answer did not take are not kept as the owner\'s wording');
});

test('removing the fact a message backs marks that message changed; the stop stays', () => {
  const draft = cardDraft();
  const next = confirmed(prepare(draft.library, { kind: 'remove_fact', cardId: late(draft.library).id, factId: 'f1' }, draft));
  assert.deepEqual(late(next).coverage.map(entry => [entry.event.eventIndex, entry.as, entry.reason ?? null]), [[2, 'changed', 'Факт «Номер терминала» убрали вы.'], [4, 'stop', null]]);
});

test('duties: wording is the owner\'s words, the rules must exist, the last duty cannot go', () => {
  const draft = cardDraft();
  const card = late(draft.library);
  const worded = prepare(draft.library, { kind: 'edit_expectation', cardId: card.id, expectationId: 'e2', text: 'объяснить, куда подать заявление на возврат' }, draft, { ownerWords: 'объяснить, куда подать заявление на возврат' });
  assert.equal(worded.authority, 'owner-words');
  assert.deepEqual(changes(worded), ['Агент должен: было «объяснить, как оформить возврат», стало «объяснить, куда подать заявление на возврат»']);
  const next = applyCommand(draft.library, worded, hostGrant(worded, 'words'));
  assert.equal(next.receipts.at(-1)!.ownerWords, 'объяснить, куда подать заявление на возврат');
  assert.equal(late(next).agentMust[1]!.appliesWhen, 'клиент назвал номер терминала', 'what was not named stays');
  assert.throws(() => prepare(draft.library, { kind: 'edit_expectation', cardId: card.id, expectationId: 'e1', requirementIds: ['no_such_rule'] }, draft),
    (error: unknown) => error instanceof UnknownReference && error.what === 'requirement' && error.allowed[0]!.startsWith(refundRule.id));
  assert.throws(() => prepare(draft.library, { kind: 'edit_expectation', cardId: card.id, expectationId: 'e3', text: 'x' }, draft),
    (error: unknown) => error instanceof UnknownReference && error.what === 'expectation');
  const one = confirmed(prepare(draft.library, { kind: 'remove_expectation', cardId: card.id, expectationId: 'e1' }, draft));
  assert.deepEqual(late(one).agentMust.map(item => item.id), ['e2'], 'ids are never renumbered');
  assert.throws(() => prepare(one, { kind: 'remove_expectation', cardId: card.id, expectationId: 'e2' }, draft), CommandRefused);
});

test('the customer\'s words: a new opening must keep what the customer says at once', () => {
  const draft = cardDraft();
  const card = known(draft.library);
  assert.equal(requiredAuthority({ kind: 'edit_client', cardId: card.id, writes: 'x' }), 'owner-words');
  assert.throws(() => prepare(draft.library, { kind: 'edit_client', cardId: card.id, writes: 'Помогите с возвратом.' }, draft), CommandRefused);
  const writes = 'Здравствуйте! Номер терминала: 1234, хочу вернуть деньги.';
  const prepared = prepare(draft.library, { kind: 'edit_client', cardId: card.id, writes, leaves: 'получил инструкцию' }, draft, { ownerWords: writes });
  const next = applyCommand(draft.library, prepared, hostGrant(prepared, 'words'));
  assert.deepEqual([known(next).client.writes, known(next).client.writesSource.kind, known(next).client.leaves], [writes, 'owner', 'получил инструкцию']);
  assert.deepEqual(changes(prepared), [`Пишет: было ««Номер терминала: 1234. Помогите с возвратом.»», стало ««${writes}»»`, 'Уходит: было «получил инструкцию по возврату или понял, что агент не поможет», стало «получил инструкцию»']);
});

test('a turn is a later message of the dialogue word for word, or the owner\'s words; removing it marks its message changed', () => {
  const draft = cardDraft();
  const card = late(draft.library);
  const event = { batchId: draft.batch.id, dialogueId: 'late', eventIndex: 4 };
  assert.throws(() => prepare(draft.library, { kind: 'set_turn', cardId: card.id, turn: { kind: 'report', after: 'агент объяснил возврат', says: 'Спасибо', event } }, draft),
    (error: unknown) => error instanceof CommandRefused && /дословно/.test(error.message));
  const logged = prepare(draft.library, { kind: 'set_turn', cardId: card.id, turn: { kind: 'report', after: 'агент объяснил возврат', says: 'Спасибо!', event } }, draft);
  assert.equal(logged.authority, 'owner-confirm');
  const turned = confirmed(logged);
  assert.deepEqual(late(turned).client.turn?.source, { kind: 'dialogue', event });
  assert.deepEqual(late(turned).coverage.map(entry => [entry.event.eventIndex, entry.as]), [[2, 'fact'], [4, 'turn']]);
  const removed = confirmed(prepare(turned, { kind: 'set_turn', cardId: card.id, turn: null }, draft));
  assert.equal(late(removed).client.turn, undefined);
  assert.deepEqual(late(removed).coverage.map(entry => [entry.event.eventIndex, entry.as]), [[2, 'fact'], [4, 'changed']]);
  assert.equal(requiredAuthority({ kind: 'set_turn', cardId: card.id, turn: { kind: 'change_intent', after: 'x', says: 'y' } }), 'owner-words');
});

test('a doubt is settled only as an answer to the question the card asks now; the answer\'s receipt keeps the question\'s basis', () => {
  const doubt = { status: 'needs_owner' as const, reason: 'В правиле не сказано, что номер спрашивают один раз.' };
  const draft = cardDraft({ verdict: (claim, card) => card.number === 1 && claim.alias === 'expectation_e1' ? doubt : READY });
  const card = late(draft.library);
  const status = cardStatus(card, { library: draft.library, evidence: draft.evidence, maxTurns: 3 });
  assert.equal(status.status, 'needs_owner');
  const question = status.question!;
  assert.deepEqual(question.choices.map(choice => [choice.id, choice.label, choice.command.kind]), [['a', 'Да, это правило', 'settle_claim'], ['b', 'Убрать', 'remove_expectation'], ['c', 'Сказать иначе', 'edit_expectation']]);

  assert.throws(() => prepare(draft.library, { kind: 'answer_question', cardId: card.id, questionId: 'f'.repeat(64), choice: 'a' }, draft), StaleRevisionError);
  assert.throws(() => prepare(draft.library, { kind: 'answer_question', cardId: card.id, questionId: question.id, choice: 'c' }, draft), (error: unknown) => error instanceof CommandRefused && /ваши слова/.test(error.message));
  const answer = prepare(draft.library, { kind: 'answer_question', cardId: card.id, questionId: question.id, choice: 'a' }, draft);
  assert.deepEqual([answer.authority, answer.command.kind, answer.diff[0]!.changes, late(answer.next).revision], ['owner-confirm', 'settle_claim', [], 1], 'a settled doubt changes no word and no version');
  const settled = confirmed(answer);
  assert.deepEqual(settled.receipts.at(-1)!.basisHash, question.basisHash);
  assert.equal(cardStatus(late(settled), { library: settled, evidence: draft.evidence, maxTurns: 3 }).status, 'ready');
  assert.throws(() => prepare(settled, question.choices[0]!.command, draft), StaleRevisionError, 'the same doubt is not settled twice');

  const reworded = prepare(draft.library, { kind: 'answer_question', cardId: card.id, questionId: question.id, choice: 'c', text: 'спросить номер терминала один раз' }, draft);
  assert.deepEqual([reworded.authority, reworded.command.kind, late(reworded.next).agentMust[0]!.text], ['owner-words', 'edit_expectation', 'спросить номер терминала один раз']);
  const written = applyCommand(draft.library, reworded, hostGrant(reworded, 'words'));
  assert.deepEqual([written.receipts.at(-1)!.ownerWords, written.receipts.at(-1)!.basisHash], ['спросить номер терминала один раз', question.basisHash]);
});

test('a similar card copies its parent with one change, reuses the parent\'s answered claims and joins its reading', () => {
  const draft = cardDraft();
  const parent = late(draft.library);
  const prepared = prepare(draft.library, { kind: 'add_similar', parentId: parent.id, change: { kind: 'turn', turn: { kind: 'change_intent', after: 'агент объяснил возврат', says: 'А можно лучше обменять?' } } }, draft);
  assert.equal(prepared.authority, 'owner-words');
  const similar = cardNumbered(prepared.next, 3);
  assert.deepEqual([similar.origin.kind, similar.title, similar.revision, prepared.next.nextNumber, prepared.scope], ['similar', 'Возврат оплаты — номер по просьбе — с поворотом', 1, 4, [similar.id]]);
  assert.deepEqual(similar.client.knows, parent.client.knows, 'the facts are the parent\'s');
  const claims = planClaims(similar, { library: prepared.next, evidence: draft.evidence });
  assert.deepEqual(claims.filter(claim => prepared.recheck.includes(claim.key)).map(claim => claim.kind).sort(), ['coverage', 'leak'], 'only the claims the turn touches are asked');
  assert.deepEqual(prepared.next.readingManifest.find(row => row.dialogueId === 'late')!.cardIds, [parent.id, similar.id]);
  assert.deepEqual(changes(prepared), ['Ситуация: добавлено «№3 Возврат оплаты — номер по просьбе — с поворотом»']);
  const next = applyCommand(draft.library, prepared, hostGrant(prepared, 'words'));
  assert.equal(cardStatuses({ library: reviewed(next, draft.evidence), evidence: draft.evidence, maxTurns: 3 }).get(similar.id)?.status, 'ready');
});

test('a similar card where the customer does not know what they wrote at once needs a new first message', () => {
  const draft = cardDraft();
  const parent = known(draft.library);
  const change = { kind: 'disclosure' as const, factId: 'f1', disclosure: 'unknown' as const };
  assert.throws(() => prepare(draft.library, { kind: 'add_similar', parentId: parent.id, change }, draft), (error: unknown) => error instanceof CommandRefused && /первая реплика без этого/.test(error.message));
  const prepared = prepare(draft.library, { kind: 'add_similar', parentId: parent.id, change: { ...change, writes: 'Помогите с возвратом, номер терминала не помню.' } }, draft);
  assert.equal(prepared.authority, 'owner-confirm', 'what the customer knows is the owner\'s decision, whatever the words');
  const similar = cardNumbered(prepared.next, 3);
  assert.deepEqual([similar.client.knows[0]!.disclosure, similar.client.knows[0]!.source.kind, similar.client.writesSource.kind], ['unknown', 'owner', 'owner']);
});

test('removing a card takes it out of the draft and its reading; the import is not touched', () => {
  const draft = cardDraft();
  const card = known(draft.library);
  const prepared = prepare(draft.library, { kind: 'remove_card', cardId: card.id }, draft);
  assert.deepEqual([prepared.authority, changes(prepared)], ['owner-confirm', ['Ситуация: убрано «№2 Возврат оплаты — номер назван сразу»']]);
  const next = confirmed(prepared);
  assert.deepEqual(next.cards.map(item => item.number), [1]);
  assert.deepEqual(next.readingManifest.find(row => row.dialogueId === 'known')!.cardIds, []);
  assert.deepEqual([next.imports, next.nextNumber], [draft.library.imports, 3], 'a number is never given twice');
});

test('a command drops an acceptance: what was accepted is no longer what the draft says', () => {
  const draft = cardDraft();
  const { library: accepted } = acceptLibraryV2(draft.library, libraryHash(draft.library), draft.library.cards.map(card => card.id), { evidence: draft.evidence, maxTurns: 3 });
  assert.ok(accepted.acceptance);
  const next = confirmed(prepare(accepted, { kind: 'remove_card', cardId: known(accepted).id }, draft));
  assert.equal(next.acceptance, undefined);
  assert.equal(next.revision, accepted.revision + 1);
});

test('no grant, no change: a model\'s flag, a copy of a grant, a grant for another preview or words where a confirmation is needed', () => {
  const draft = cardDraft();
  const card = late(draft.library);
  const prepared = prepare(draft.library, { kind: 'set_fact_disclosure', cardId: card.id, factId: 'f1', disclosure: 'unknown' }, draft);
  const refused = (grant: HostGrant) => assert.throws(() => applyCommand(draft.library, prepared, grant), CommandRefused);
  refused({ previewHash: prepared.previewHash, via: 'pi-confirm', basis: 'confirmed', approved: true } as HostGrant);
  refused({ ...hostGrant(prepared, 'confirmed') });
  const other = prepare(draft.library, { kind: 'remove_card', cardId: card.id }, draft);
  refused(hostGrant(other, 'confirmed'));
  refused(hostGrant(prepared, 'words'));
  refused(hostGrant({ previewHash: prepared.previewHash, via: 'board' }, 'confirmed'));
  const forged = { ...prepared, next: { ...prepared.next, cards: [] } };
  assert.throws(() => applyCommand(draft.library, forged, hostGrant(forged, 'confirmed')), CommandRefused, 'the preview binds the library it shows');
});

test('a preview made on an older draft is refused as stale, with both states named', () => {
  const draft = cardDraft();
  const first = prepare(draft.library, { kind: 'remove_card', cardId: known(draft.library).id }, draft);
  const second = prepare(draft.library, { kind: 'set_fact_disclosure', cardId: late(draft.library).id, factId: 'f1', disclosure: 'unknown' }, draft);
  const moved = confirmed(first);
  assert.throws(() => applyCommand(moved, second, hostGrant(second, 'confirmed')),
    (error: unknown) => error instanceof StaleRevisionError && error.expectedHash === libraryHash(draft.library) && error.actualHash === libraryHash(moved));
});

test('the authority of every command is decided once, the same for every surface', () => {
  const cardId = 'card_x';
  const table: [CardCommand, string][] = [
    [{ kind: 'set_fact_disclosure', cardId, factId: 'f1', disclosure: 'on_request' }, 'owner-confirm'],
    [{ kind: 'set_fact', cardId, label: 'Сумма', value: 1200, disclosure: 'on_request' }, 'owner-confirm'],
    [{ kind: 'remove_fact', cardId, factId: 'f1' }, 'owner-confirm'],
    [{ kind: 'edit_expectation', cardId, expectationId: 'e1', text: 'x' }, 'owner-words'],
    [{ kind: 'edit_expectation', cardId, expectationId: 'e1', requirementIds: ['r'] }, 'owner-confirm'],
    [{ kind: 'edit_expectation', cardId, expectationId: 'e1', appliesWhen: null }, 'owner-confirm'],
    [{ kind: 'edit_expectation', cardId, expectationId: 'e1', appliesWhen: 'клиент назвал номер' }, 'owner-words'],
    [{ kind: 'edit_expectation', cardId, expectationId: 'e1', text: 'x', appliesWhen: null }, 'owner-confirm'],
    [{ kind: 'edit_expectation', cardId, expectationId: 'e1', text: 'x', requirementIds: ['r'] }, 'owner-confirm'],
    [{ kind: 'edit_expectation', cardId, expectationId: 'e1', text: 'x', appliesWhen: 'y' }, 'owner-words'],
    [{ kind: 'edit_card', cardId, changes: [{ kind: 'edit_expectation', expectationId: 'e1', text: 'x', appliesWhen: null }] }, 'owner-confirm'],
    [{ kind: 'remove_expectation', cardId, expectationId: 'e1' }, 'owner-confirm'],
    [{ kind: 'edit_client', cardId, wants: 'x' }, 'owner-words'],
    [{ kind: 'set_turn', cardId, turn: null }, 'owner-confirm'],
    [{ kind: 'settle_claim', cardId, key: 'a'.repeat(64) }, 'owner-confirm'],
    [{ kind: 'answer_question', cardId, questionId: 'a'.repeat(64), choice: 'a' }, 'owner-confirm'],
    [{ kind: 'answer_question', cardId, questionId: 'a'.repeat(64), choice: 'c', text: 'x' }, 'owner-words'],
    [{ kind: 'add_similar', parentId: cardId, change: { kind: 'opening', writes: 'x' } }, 'owner-words'],
    [{ kind: 'add_similar', parentId: cardId, change: { kind: 'turn', turn: null } }, 'owner-confirm'],
    [{ kind: 'remove_card', cardId }, 'owner-confirm'],
  ];
  for (const [command, authority] of table) assert.equal(requiredAuthority(command), authority, command.kind);
});

test('agent-lab cards: the same situations in the terminal, a preview without --yes, the owner\'s answer and command written with it', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cards-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const doubt = { status: 'needs_owner' as const, reason: 'В исходном разговоре клиент назвал номер только после вопроса агента.' };
  const draft = cardDraft({ verdict: (claim, card) => card.number === 1 && claim.alias === 'fact_f1' ? doubt : READY });
  const store = new ExperimentStore(directory);
  await store.init();
  try {
    await store.writeImport(draft.batch);
    await store.publishLibrary(cardRun([], [], 1, { id: 'cards_cli', phase: 'review', createdAt: AT, updatedAt: AT, reviewedAt: null, reviewMode: null, manifestHash: null }), draft.library);
  } finally { await store.close(); }
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const call = async (...args: string[]) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, 'cards', '--data-dir', directory, '--id', 'cards_cli', ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    return { code, stdout, stderr };
  };
  const library = async () => (await new ExperimentStore(directory).get('cards_cli')).librarySnapshot as LibraryV2;

  const shown = await call();
  assert.equal(shown.code, 0, shown.stderr);
  assert.match(shown.stdout, /2 ситуации: 1 готова · 1 ждёт вашего ответа/);
  assert.match(shown.stdout, /1 {2}Возврат оплаты — номер по просьбе +\? нужен ваш ответ/);
  const listed = JSON.parse((await call('--json')).stdout);
  assert.deepEqual(listed.situations.map((item: { id: string }) => item.id), [late(draft.library).id, known(draft.library).id], 'a command file names its card by the id the JSON shows');
  assert.deepEqual(listed.situations[0].question.answers.map((answer: { label: string }) => answer.label), ['Да', 'Не знал', 'Убрать']);

  // Without --yes a command only shows what it would change.
  const file = join(directory, 'remove.json');
  await writeFile(file, JSON.stringify({ kind: 'remove_card', cardId: known(draft.library).id }));
  const before = libraryHash(await library());
  const preview = await call('--input', file);
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /Записать: та же команда с --yes\./);
  assert.equal(libraryHash(await library()), before, 'a preview writes nothing');

  // The owner's answer, confirmed by --yes: the doubt is settled and the situation is ready.
  const answered = await call('--card', '1', '--choice', 'a', '--yes');
  assert.equal(answered.code, 0, answered.stderr);
  assert.match(answered.stdout, /1 {2}Возврат оплаты — номер по просьбе +✓ готова/, 'the answered situation is shown as it is now');
  const settled = await library();
  assert.deepEqual([settled.receipts.at(-1)!.via, settled.receipts.at(-1)!.command.kind], ['cli-yes', 'settle_claim']);

  const removed = await call('--input', file, '--yes');
  assert.equal(removed.code, 0, removed.stderr);
  assert.deepEqual((await library()).cards.map(card => card.number), [1]);
});
