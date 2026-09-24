import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { experimentSchema, type Experiment } from '../src/contracts.js';
import type { LibraryV1 } from '../src/scenario-contracts.js';
import { actionRow, briefChanges, briefRows, changeText, countsText, detailRows, dialogueNumbers, formatNote, listRows, plainSituationText, situationActions,
  situationViews, type SituationView } from '../src/card/view.js';
import { cardDraft, READY, type CardDraft } from './helpers/card-library.js';

/*
 * C12: one projection of a situation for every surface (ui-spec §3). A card of the card format, a variant of
 * the first library format and a scenario of a record made before libraries all read as the same brief; the
 * status chip, the one question with its numbered answers, the reasons a situation cannot be a test and «d».
 */

const doubt = { status: 'needs_owner' as const, reason: 'В исходном разговоре клиент назвал номер только после вопроса агента.' };
const blocked = { status: 'blocked' as const, reason: 'В ваших материалах нет правила, что агент должен делать в этом случае.' };
const draftRecord = (library: CardDraft['library']) => ({ librarySnapshot: library, scenarios: [], requirements: [], phase: 'review', trials: [] }) as unknown as Experiment;
function views(draft: CardDraft): SituationView[] {
  return situationViews(draftRecord(draft.library), { evidence: draft.evidence, numbers: dialogueNumbers([draft.batch]), maxTurns: 3 });
}
const text = (rows: Parameters<typeof plainSituationText>[0], width = 100) => plainSituationText(rows, width);

test('a list of cards: three lines each, the chip never cut, the lines cut instead of wrapped', () => {
  const draft = cardDraft({ verdict: (claim, card) => card.number === 1 && claim.alias === 'fact_f1' ? doubt : READY });
  const list = views(draft);
  assert.equal(countsText(list), '2 ситуации: 1 готова · 1 ждёт вашего ответа');
  const rows = list.flatMap((view, index) => listRows(view, { selected: index === 0 }));
  assert.equal(text(rows), [
    ' › 1  Возврат оплаты — номер по просьбе                                            ? нужен ваш ответ',
    '      Клиент: «Помогите с возвратом.»',
    '      Агент должен: не запрашивать номер терминала повторно, если клиент его уже назвал',
    '   2  Возврат оплаты — номер назван сразу                                                   ✓ готова',
    '      Клиент: «Номер терминала: 1234. Помогите с возвратом.»',
    '      Агент должен: не запрашивать номер терминала повторно, если клиент его уже назвал',
  ].join('\n'));
  assert.equal(text(rows, 70), [
    ' › 1  Возврат оплаты — номер по просьбе              ? нужен ваш ответ',
    '      Клиент: «Помогите с возвратом.»',
    '      Агент должен: не запрашивать номер терминала повторно, если кли…',
    '   2  Возврат оплаты — номер назван сразу                     ✓ готова',
    '      Клиент: «Номер терминала: 1234. Помогите с возвратом.»',
    '      Агент должен: не запрашивать номер терминала повторно, если кли…',
  ].join('\n'));
  assert.match(text(list.flatMap(view => listRows(view, { narrow: true })), 50), /\? ответ$/m, 'a narrow screen shortens the chip to its sign and first word');
});

test('an open card that waits for the owner: the brief, then one question with its numbered answers', () => {
  const draft = cardDraft({ verdict: (claim, card) => card.number === 1 && claim.alias === 'fact_f1' ? doubt : READY });
  const [card] = views(draft);
  assert.deepEqual(situationActions(card!).map(action => action.kind === 'answer' ? action.choice.command.kind : action.kind), ['settle_claim', 'set_fact_disclosure', 'remove_fact']);
  assert.equal(text(briefRows(card!)), [
    ' 1  Возврат оплаты — номер по просьбе                                              ? нужен ваш ответ',
    '    из диалога №1',
    '',
    ' Клиент',
    '    Хочет    Получить инструкцию по возврату оплаты',
    '    Пишет    «Помогите с возвратом.»',
    '    Знает    Номер терминала: 5678 — если спросят',
    '    Уходит   получил инструкцию по возврату или понял, что агент не поможет',
    '',
    ' Агент должен',
    '    1  не запрашивать номер терминала повторно, если клиент его уже назвал',
    '       правило: «Если номер терминала уже указан, не запрашивайте его повторно; объясните, как',
    '                 оформить возврат.»',
    '    2  объяснить, как оформить возврат',
    '',
    ' ? Клиент знал «Номер терминала» до разговора? В исходном разговоре клиент назвал номер только после',
    '   вопроса агента.',
    '',
    '   1  Да',
    '   2  Не знал',
    '   3  Убрать',
  ].join('\n'), 'a rule shared with the duty above is not repeated');
});

test('a ready card offers its actions; one that cannot be a test says why; an unchecked one says «проверяю» only while a check runs', () => {
  const ready = views(cardDraft())[1]!;
  assert.equal(text([actionRow(situationActions(ready))]), ' 1 Изменить  ·  2 Добавить похожую  ·  3 Не проверять');

  const unusable = views(cardDraft({ verdict: (claim, card) => card.number === 2 && claim.alias === 'goal' ? blocked : READY }))[1]!;
  assert.equal(unusable.status, 'unusable');
  assert.equal(text(listRows(unusable)), [
    '   2  Возврат оплаты — номер назван сразу                                    ✗ не подходит для теста',
    '      Клиент: «Номер терминала: 1234. Помогите с возвратом.»',
    '      В ваших материалах нет правила, что агент должен делать в этом случае.',
  ].join('\n'));
  assert.match(text(briefRows(unusable)), /\n Почему не подходит\n {4}В ваших материалах нет правила, что агент должен делать в этом случае\.$/);
  assert.equal(text([actionRow(situationActions(unusable))]), ' 1 Добавить правило  ·  2 Исключить из запуска');

  const unchecked = views(cardDraft({ review: false }))[0]!;
  assert.equal(unchecked.status, 'checking');
  assert.deepEqual(situationActions(unchecked), []);
  assert.match(text(listRows(unchecked)), /… ждёт проверки$/m);
  assert.match(text(listRows(unchecked, { running: true })), /⠋ проверяю$/m);
});

test('«d» shows how a card is run and judged: the customer\'s program, where each fact comes from, the account, the duties and the record', () => {
  const [card] = views(cardDraft());
  const lines = text(detailRows(card!)).split('\n');
  assert.deepEqual(lines.slice(0, 9), [
    ' Как это проверяется',
    '    Клиент в прогоне   если спросят «номер терминала» — называет «Номер терминала: 5678»',
    '                       на любой другой вопрос — отвечает «Этого я не знаю.»',
    '                       уходит, когда получил инструкцию по возврату или понял, что агент не поможет',
    '                       не больше 3 реплик после первой; один вопрос повторяет не больше 2 раз',
    '    Первая реплика     реплика №1 диалога',
    '    Откуда факт        Номер терминала: 5678 — реплика №3 диалога',
    '    Поздние реплики    реплика №3 — факт',
    '                       реплика №5 — здесь клиент уходит',
  ]);
  assert.ok(lines.some(line => line.includes('версия 1 · набор library_cards')));
});

test('a first-format variant reads as the same brief: its place in the list, its dialogue, what the customer knows and when, its required checkpoints', async () => {
  const run = experimentSchema.parse(JSON.parse(await readFile(new URL('./fixtures/library-v1/run.json', import.meta.url), 'utf8')));
  const [first, second] = situationViews(run, { maxTurns: 3 });
  assert.deepEqual([first!.format, first!.number, first!.brief.source, first!.brief.knows, first!.status], ['variant', 1, 'из диалога №1', [{ what: 'Номер терминала: 1234', when: 'сразу' }], 'ready']);
  assert.deepEqual([second!.brief.knows, second!.version, situationActions(second!)], [[{ what: 'Номер терминала: 5678', when: 'если спросят' }], 2, []], 'the first format is only read');
  assert.equal(text(listRows(second!)), [
    '   2  Номер раскрывается по просьбе                                              ✓ готова · версия 2',
    '      Клиент: «Помогите с возвратом.»',
    '      Агент должен: Если номер уже сообщён, не запрашивать его повторно независимо от формулировки …',
  ].join('\n'));
  assert.deepEqual(second!.brief.must.map(duty => duty.text.slice(0, 40)), ['Если номер уже сообщён, не запрашивать е', 'Объяснить пользователю, как оформить воз']);
  assert.match(text(detailRows(second!)), /Откуда факт {8}Номер терминала: 5678 — вы подтвердили/);
});

test('a first-format draft is marked as the old format, and its checker\'s question is shown without answers', async () => {
  const run = experimentSchema.parse(JSON.parse(await readFile(new URL('./fixtures/library-v1/run.json', import.meta.url), 'utf8')));
  const library = structuredClone(run.librarySnapshot) as LibraryV1;
  const variant = library.variants[1]!;
  variant.quality = 'needs_review';
  variant.issues = [{ code: 'semantic_finding', severity: 'needs_review', path: `variants.${variant.id}.userState.facts.terminal`, message: 'Классификация initial требует подтверждения.' }];
  const draft = { ...run, phase: 'review', trials: [], librarySnapshot: library } as Experiment;
  assert.equal(formatNote(draft), 'Старый формат: эти ситуации можно посмотреть, но не изменить — их можно продолжить в новом формате.');
  assert.equal(formatNote(run), undefined, 'a finished run is not a draft');
  const view = situationViews(draft, { maxTurns: 3 })[1]!;
  assert.equal(view.status, 'needs_owner');
  assert.match(text(briefRows(view)), /\n \? Факт «Номер терминала: 5678»: Классификация знал заранее требует подтверждения\.\n {3}Старый формат: здесь вопрос только показан\.$/);
});

test('a record made before libraries reads with the same brief, ready as it is', async () => {
  const draft = experimentSchema.parse(JSON.parse(await readFile(new URL('./fixtures/legacy-demo-draft.json', import.meta.url), 'utf8')));
  const list = situationViews(draft, { maxTurns: 3 });
  assert.equal(list.length, draft.scenarios.length);
  assert.ok(list.every(view => view.format === 'scenario' && view.status === 'ready'));
  assert.equal(text(briefRows(list[1]!)), [
    ' 2  Change preference after the first response                                              ✓ готова',
    '    по вашим правилам',
    '',
    ' Клиент',
    '    Хочет   Move appointment A109 to 18:00.',
    '    Пишет   «Move appointment A109 to 10:00.»',
    '    Знает   Appointment ID A109 — сразу',
    '            Desired time 18:00 — сразу',
    '            Whether the backend will accept the change before it answers — не знает',
    '',
    ' Агент должен',
    '    1  Move appointment A109 to 18:00. Preserve the appointment owner and booking status, and report',
    '       only actions supported by tool results.',
    '       правило: «Before changing an appointment, read its current record and update only its time',
    '                 field to the user’s requested time.»',
  ].join('\n'));
});

test('«было → стало» matches facts and duties by id, and names only what changed', () => {
  const [before] = views(cardDraft());
  const after: SituationView = { ...before!, brief: { ...before!.brief,
    knows: [{ what: 'Номер терминала: 5678', when: '?' }], must: [before!.brief.must[0]!, { text: 'объяснить, куда подать заявление', rule: null }] } };
  assert.deepEqual(briefChanges(before, after).map(changeText), [
    'Знает: Номер терминала: 5678 — было «если спросят», стало «?»',
    'Агент должен: было «объяснить, как оформить возврат», стало «объяснить, куда подать заявление»',
  ]);
  assert.deepEqual(briefChanges(before, undefined).map(changeText), ['Ситуация: убрано «№1 Возврат оплаты — номер по просьбе»']);
});
