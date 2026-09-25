import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitMessages } from '../src/spreadsheet/markers.js';
import { importTable, parseOrder } from '../src/spreadsheet/dialogues.js';
import { proposeTable, type TableProposal } from '../src/spreadsheet/proposal.js';
import { proposalLines } from '../src/spreadsheet/lines.js';
import type { TableChoices } from '../src/spreadsheet/mapping.js';
import { readWorkbook, tableFileOf } from '../src/spreadsheet/workbook.js';
import { xlsxFile, type CellSpec } from './helpers/xlsx.js';

/*
 * Chunk I: a spreadsheet of logs is read the way its owner confirms — the proposal Lab makes from the data,
 * the owner's choices checked against it, one question when Lab cannot decide, and the conversations as an
 * ordinary import. Every sheet here is synthetic.
 */

/** The shape of the owner's export: one conversation per row, its messages in one cell, marked and separated. */
const talk = (...messages: string[]) => messages.join(' ` ');
const HEADER = ['Id диалога', 'Дата', 'Текст', 'agentCode', 'Оператор'];
const idOf = (i: number) => `c${String(i).padStart(4, '0')}-4c70-bf14`;
const conversation = (i: number) => talk(`CLIENT Здравствуйте, вопрос ${i}`, 'AGENT Добрый день! Чем помочь?', `CLIENT Нужен возврат по заказу ${i}`, 'AGENT Оформил возврат, деньги придут за 5 дней');
function exportRows(count: number, special: Record<number, string> = {}): CellSpec[][] {
  return [HEADER, ...Array.from({ length: count }, (_, k): CellSpec[] => [idOf(k + 1), '09.09.2026', special[k + 1] ?? conversation(k + 1), 'SUPPORT_AGENT', (k + 1) % 3 ? 'FALSE' : 'TRUE'])];
}
function propose(rows: CellSpec[][], choices: TableChoices = {}): TableProposal {
  const bytes = xlsxFile([{ name: 'Данные', rows }]), file = tableFileOf('logs.xlsx', bytes);
  return proposeTable(readWorkbook(bytes, file), file, choices);
}
function proposeCsv(text: string, choices: TableChoices = {}): TableProposal {
  const bytes = Buffer.from(text), file = tableFileOf('chats.csv', bytes);
  return proposeTable(readWorkbook(bytes, file), file, choices);
}
function ready(proposal: TableProposal): Extract<TableProposal, { status: 'ready' }> {
  assert.equal(proposal.status, 'ready', JSON.stringify(proposal.status === 'refused' ? proposal.reason : proposal.status === 'question' ? proposal.question : ''));
  return proposal as Extract<TableProposal, { status: 'ready' }>;
}
const refusal = (proposal: TableProposal) => proposal.status === 'refused' ? [proposal.choice, proposal.reason] : [proposal.status];
/** The import a ready proposal makes, read again from the same bytes. */
function batchOf(rows: CellSpec[][], choices: TableChoices = {}) {
  const proposal = ready(propose(rows, choices));
  const bytes = xlsxFile([{ name: 'Данные', rows }]);
  return importTable(readWorkbook(bytes, tableFileOf('logs.xlsx', bytes)).sheets[0]!, proposal.mapping);
}
const messagesOf = (batch: ReturnType<typeof batchOf>['batch'], id: string) => batch.dialogues.find(item => item.id === id)?.events.map(event => [event.role, event.content]);

test('one conversation per row: Lab proposes the text column, its separator and markers, the id column, and keeps the other columns', () => {
  const proposal = ready(propose(exportRows(40)));
  assert.deepEqual(proposal.mapping, { version: 1, source: { format: 'xlsx', sheet: 'Данные' }, headerRow: 1,
    id: { index: 0, header: 'Id диалога' }, text: { index: 2, header: 'Текст' },
    layout: { kind: 'dialogue_per_row', separator: '`', markers: [{ token: 'AGENT', role: 'assistant' }, { token: 'CLIENT', role: 'user' }] }, maskVersion: 2 });
  assert.deepEqual(proposal.preview, { rows: 40, dialogues: 40, usable: 40, taken: 40, rejected: [],
    messages: [{ label: 'AGENT', role: 'assistant', count: 80 }, { label: 'CLIENT', role: 'user', count: 80 }], kept: ['Дата', 'agentCode', 'Оператор'] });
  const { batch } = batchOf(exportRows(40));
  assert.deepEqual(messagesOf(batch, idOf(3)), [['user', 'Здравствуйте, вопрос 3'], ['assistant', 'Добрый день! Чем помочь?'], ['user', 'Нужен возврат по заказу 3'], ['assistant', 'Оформил возврат, деньги придут за 5 дней']]);
  // The other columns travel with the conversation as written, like the extra fields of a JSON row.
  const original = batch.dialogues.find(item => item.id === idOf(3))!.original as Record<string, unknown>;
  assert.deepEqual([original.row, original.columns], [4, { Дата: '09.09.2026', agentCode: 'SUPPORT_AGENT', Оператор: 'TRUE' }]);
  assert.deepEqual(batch.dialogues[0]!.events[0]!.data, { role: 'user', content: 'Здравствуйте, вопрос 1', marker: 'CLIENT' });
});

test('a marker word inside a message, or a separator not followed by a marker, stays text of that message', () => {
  const text = 'CLIENT: Мне AGENT сказал, что CLIENT должен ждать ` AGENT Да, так и есть ` CLIENT Спасибо `за помощь` ` AGENTS тоже тут ` AGENT Пожалуйста:CLIENT';
  assert.deepEqual(splitMessages(text, '`', ['CLIENT', 'AGENT']), [
    { marker: 'CLIENT', content: 'Мне AGENT сказал, что CLIENT должен ждать' },
    { marker: 'AGENT', content: 'Да, так и есть' },
    { marker: 'CLIENT', content: 'Спасибо `за помощь` ` AGENTS тоже тут' },
    { marker: 'AGENT', content: 'Пожалуйста:CLIENT' },
  ]);
  assert.equal(splitMessages('Здравствуйте ` AGENT привет', '`', ['CLIENT', 'AGENT']), undefined, 'a text that does not start with a marker is not split by guess');
  // In a whole sheet the same text is one conversation of four messages; the words inside are not proposed as markers.
  const proposal = ready(propose(exportRows(20, { 5: text })));
  assert.deepEqual(proposal.mapping.layout.kind === 'dialogue_per_row' && proposal.mapping.layout.markers.map(item => item.token), ['AGENT', 'CLIENT']);
  assert.equal(messagesOf(batchOf(exportRows(20, { 5: text })).batch, idOf(5))?.length, 4);
});

test('a marker Lab does not know becomes one question; the answer completes the reading or keeps the word as text', () => {
  const special = Object.fromEntries([2, 9, 14, 21, 27].map(i => [i, talk(`CLIENT Хочу оператора ${i}`, 'AGENT Перевожу', 'OPERATOR Соединяю со специалистом', 'CLIENT Спасибо')]));
  const rows = exportRows(30, special);
  const asked = propose(rows);
  assert.equal(asked.status, 'question');
  assert.deepEqual(asked.status === 'question' && [asked.question.kind, asked.question.kind === 'marker' && [asked.question.token, asked.question.messages, asked.question.column.header], asked.found],
    ['marker', ['OPERATOR', 5, 'Текст'], 30]);
  const text = proposalLines(asked).join('\n');
  assert.match(text, /не знает, кто пишет сообщения с меткой OPERATOR в колонке «Текст» \(5 сообщений\): клиент, агент, служебное — или это не метка/);
  assert.ok(!text.includes('Соединяю') && !text.includes('Хочу оператора'), 'counts, never the conversations');

  const agent = ready(propose(rows, { markers: [{ token: 'OPERATOR', role: 'system' }] }));
  assert.deepEqual(agent.mapping.layout.kind === 'dialogue_per_row' && agent.mapping.layout.markers, [{ token: 'CLIENT', role: 'user' }, { token: 'AGENT', role: 'assistant' }, { token: 'OPERATOR', role: 'system' }]);
  assert.deepEqual(messagesOf(batchOf(rows, { markers: [{ token: 'OPERATOR', role: 'system' }] }).batch, idOf(9)),
    [['user', 'Хочу оператора 9'], ['assistant', 'Перевожу'], ['system', 'Соединяю со специалистом'], ['user', 'Спасибо']]);
  // «Not a marker»: the word stays inside the message before it.
  assert.deepEqual(messagesOf(batchOf(rows, { markers: [{ token: 'OPERATOR', role: 'text' }] }).batch, idOf(9)),
    [['user', 'Хочу оператора 9'], ['assistant', 'Перевожу ` OPERATOR Соединяю со специалистом'], ['user', 'Спасибо']]);
});

test('a conversation the import cannot use is refused with the reason the sheet shows; notes under the table are not conversations', () => {
  const rows: CellSpec[][] = [
    ...exportRows(12, { 3: 'просто текст без меток', 5: talk('CLIENT Здравствуйте', 'AGENT'), 8: '', 10: talk('CLIENT ***', 'AGENT Слушаю вас'), 11: talk('AGENT Добрый день, чем помочь?') }),
    [idOf(2), '10.09.2026', conversation(2), 'SUPPORT_AGENT', 'FALSE'],
    [null, '10.09.2026', conversation(99), 'SUPPORT_AGENT', 'FALSE'],
    [null, 'Итого: 14', null, null, null],
  ];
  const { batch, preview } = batchOf(rows);
  assert.deepEqual([preview.rows, preview.dialogues, preview.usable, preview.taken], [15, 14, 7, 7]);
  assert.deepEqual(Object.fromEntries(preview.rejected.map(item => [item.reason, item.count])), {
    'Текст не начинается с метки роли': 1, 'Пустое сообщение': 1, 'Пустой текст разговора': 1, 'Пользовательские реплики полностью замаскированы': 1,
    'Нет пользовательских реплик': 1, 'Повторяющийся id диалога': 1, 'Некорректный id диалога': 1,
  });
  assert.deepEqual(batch.rejected.map(item => [item.index, item.reasons[0]]), [
    [2, 'Текст не начинается с метки роли'], [4, 'Пустое сообщение'], [7, 'Пустой текст разговора'], [9, 'Пользовательские реплики полностью замаскированы'],
    [10, 'Нет пользовательских реплик'], [12, 'Повторяющийся id диалога'], [13, 'Некорректный id диалога']]);
  // The refused row keeps its text as evidence; its messages are never guessed.
  assert.deepEqual(batch.rejected[0]!.original, { id: idOf(3), row: 4, text: 'просто текст без меток', columns: { Дата: '09.09.2026', agentCode: 'SUPPORT_AGENT', Оператор: 'TRUE' } });
});

/** One message per row, rows of different conversations interleaved; fields with the delimiter, quotes and a line break. */
const CHATS = [
  'session;author;message;ts;channel',
  's1;client;"Здравствуйте; хочу вернуть деньги за заказ";09.09.2026 10:00:01;chat',
  's1;bot;"Добрый день!\nНазовите номер заказа, пожалуйста";09.09.2026 10:00:05;chat',
  's2;client;Подскажите, где сейчас мой заказ?;09.09.2026 10:01:00;voice',
  's1;client;"Номер заказа ""A-17"", оплачен вчера";09.09.2026 10:00:30;chat',
  's3;client;Как сменить тариф на годовой?;09.09.2026 10:02:00;chat',
  's2;bot;Проверяю статус вашего заказа;09.09.2026 10:01:10;voice',
  's1;bot;Оформил возврат, деньги придут за пять дней;09.09.2026 10:00:40;chat',
  's3;bot;Тариф меняется в личном кабинете;09.09.2026 10:02:30;chat',
].join('\r\n');

test('one message per row: the role column, the id that groups messages, the text and the order column are proposed from the data', () => {
  const proposal = ready(proposeCsv(CHATS));
  assert.deepEqual(proposal.csv, { delimiter: ';', encoding: 'utf-8' });
  assert.deepEqual(proposal.mapping, { version: 1, source: { format: 'csv', delimiter: ';', encoding: 'utf-8' }, headerRow: 1,
    id: { index: 0, header: 'session' }, text: { index: 2, header: 'message' },
    layout: { kind: 'message_per_row', role: { index: 1, header: 'author' }, roles: [{ value: 'bot', role: 'assistant' }, { value: 'client', role: 'user' }], order: { index: 3, header: 'ts' } }, maskVersion: 2 });
  const bytes = Buffer.from(CHATS), { batch, preview } = importTable(readWorkbook(bytes, tableFileOf('chats.csv', bytes)).sheets[0]!, proposal.mapping);
  assert.deepEqual([preview.dialogues, preview.usable, preview.kept], [3, 3, ['channel']]);
  assert.deepEqual(batch.dialogues.map(item => item.id), ['s1', 's2', 's3']);
  assert.deepEqual(messagesOf(batch, 's1'), [['user', 'Здравствуйте; хочу вернуть деньги за заказ'], ['assistant', 'Добрый день!\nНазовите номер заказа, пожалуйста'],
    ['user', 'Номер заказа "A-17", оплачен вчера'], ['assistant', 'Оформил возврат, деньги придут за пять дней']]);
  assert.deepEqual(batch.dialogues[0]!.events[2]!.data, { role: 'user', content: 'Номер заказа "A-17", оплачен вчера', row: 5, value: 'client', order: '09.09.2026 10:00:30', columns: { channel: 'chat' } });
});

test('rows out of time order follow the sheet until the owner names the order column; a missing time or an unknown role is never guessed', () => {
  // Sorted by author: every conversation's rows are out of time order.
  const lines = CHATS.split('\r\n');
  const byAuthor = [lines[0], ...lines.slice(1).sort((a, b) => a.split(';')[1]!.localeCompare(b.split(';')[1]!))].join('\n');
  const rowsOrder = ready(proposeCsv(byAuthor));
  assert.equal(rowsOrder.mapping.layout.kind === 'message_per_row' && rowsOrder.mapping.layout.order, undefined, 'an order column that contradicts the rows is not proposed');
  const timed = ready(proposeCsv(byAuthor, { order: 'ts' }));
  const bytes = Buffer.from(byAuthor);
  const sheet = readWorkbook(bytes, tableFileOf('chats.csv', bytes)).sheets[0]!;
  assert.deepEqual(messagesOf(importTable(sheet, timed.mapping).batch, 's1')?.map(([role]) => role), ['user', 'assistant', 'user', 'assistant']);

  const operator = `${CHATS}\r\ns2;operator;Соединяю со специалистом;09.09.2026 10:01:20;voice\r\ns3;client;А если помесячно?;;chat`;
  const asked = proposeCsv(operator);
  assert.deepEqual(asked.status === 'question' && [asked.question, asked.found], [{ kind: 'role', column: asked.columns[1], value: 'operator', messages: 1 }, 3]);
  const answered = ready(proposeCsv(operator, { roles: [{ value: 'operator', role: 'system' }], order: 'ts' }));
  const withOperator = Buffer.from(operator);
  const { batch, preview } = importTable(readWorkbook(withOperator, tableFileOf('chats.csv', withOperator)).sheets[0]!, answered.mapping);
  assert.deepEqual(messagesOf(batch, 's2')?.map(([role]) => role), ['user', 'assistant', 'system']);
  assert.deepEqual(preview.rejected, [{ reason: 'У сообщения нет порядкового номера или времени', count: 1 }], 's3 has a message without its time');
});

test('merged and empty cells in an .xlsx: a merged id covers its messages, an empty message refuses its conversation', () => {
  const rows: CellSpec[][] = [
    ['Выгрузка чатов за сентябрь', null, null, null],
    ['Диалог', 'Кто', 'Сообщение', '№'],
    ['dlg-1', 'Клиент', 'Добрый день, не проходит оплата картой', 1],
    [null, 'Бот', 'Уточните, пожалуйста, какую ошибку видите', 2],
    [null, 'Клиент', 'Пишет «операция отклонена»', 3],
    ['dlg-2', 'Клиент', 'Как подключить терминал к кассе?', 1],
    [null, 'Бот', null, 2],
  ];
  const bytes = xlsxFile([{ name: 'Чаты', rows, merges: ['A1:D1', 'A3:A5', 'A6:A7'] }]), file = tableFileOf('chats.xlsx', bytes);
  const proposal = ready(proposeTable(readWorkbook(bytes, file), file));
  assert.deepEqual([proposal.headerRow, proposal.mapping.id?.header, proposal.mapping.text.header], [2, 'Диалог', 'Сообщение'], 'the merged title above the table is not the header');
  assert.deepEqual(proposal.mapping.layout.kind === 'message_per_row' && [proposal.mapping.layout.role.header, proposal.mapping.layout.roles, proposal.mapping.layout.order?.header],
    ['Кто', [{ value: 'Клиент', role: 'user' }, { value: 'Бот', role: 'assistant' }], '№']);
  const { batch } = importTable(readWorkbook(bytes, file).sheets[0]!, proposal.mapping);
  assert.deepEqual(messagesOf(batch, 'dlg-1')?.map(([role]) => role), ['user', 'assistant', 'user']);
  assert.deepEqual(batch.rejected.map(item => [item.id, item.reasons]), [['dlg-2', ['Пустое сообщение']]]);
});

test('a wrong choice is refused with its reason, and Lab puts nothing in its place', () => {
  const rows = exportRows(40);
  assert.deepEqual(refusal(propose(rows, { text: 'Дата' })), ['text', 'В колонке «Дата» нет разговоров: строки не начинаются с метки роли — слова заглавными буквами, вроде CLIENT или AGENT.']);
  assert.deepEqual(refusal(propose(rows, { id: 'agentCode' })), ['id', 'В колонке «agentCode» значения повторяются: 1 разное значение на 40 строк — это не id разговора.']);
  assert.deepEqual(refusal(propose(rows, { id: 'Дата' })), ['id', 'Значения колонки «Дата» не годятся как id разговора: нужны латинские буквы, цифры, «_» и «-», до 80 знаков.']);
  assert.deepEqual(refusal(propose(rows, { id: 'C' })), ['id', 'Колонка «Текст» уже выбрана как текст разговора.']);
  assert.deepEqual(refusal(propose(rows, { id: 'Номер' })), ['id', 'Колонки «Номер» нет в листе «Данные». Есть: «Id диалога», «Дата», «Текст», «agentCode», «Оператор».']);
  assert.deepEqual(refusal(propose(rows, { sheet: 'Лист1' })), ['sheet', 'Листа «Лист1» нет. Есть: «Данные».']);
  assert.deepEqual(refusal(propose(rows, { markers: [{ token: 'BOT', role: 'assistant' }] })), ['markers', 'Метка «BOT» не встречается в начале сообщений колонки «Текст».']);
  assert.deepEqual(refusal(propose(rows, { separator: '|' })), ['separator', 'Ни в одной колонке сообщения не отделены знаком «|» с меткой роли после него.']);
  assert.deepEqual(refusal(propose(rows, { markers: [{ token: 'CLIENT', role: 'assistant' }] })), ['markers', 'Не видно сообщений клиента: укажите, какой меткой они отмечены.']);
  assert.deepEqual(refusal(propose(rows, { role: 'Текст' })), ['role', 'В колонке «Текст» 40 разных значений — это не роль того, кто пишет.']);
  assert.deepEqual(refusal(proposeCsv(CHATS, { role: 'message' })), ['role', 'В колонке «message» длинные тексты — это не роль того, кто пишет.']);
  assert.deepEqual(refusal(proposeCsv(CHATS, { role: 'ts' })), ['role', 'В колонке «ts» числа или даты — это не роль того, кто пишет.']);
  assert.deepEqual(refusal(proposeCsv(CHATS, { order: 'channel' })), ['order', 'В колонке «channel» не числа и не даты — по ней нельзя упорядочить сообщения.']);
  assert.deepEqual(refusal(proposeCsv(CHATS, { order: 'message' })), ['order', 'Колонка «message» уже выбрана для другого.']);
  assert.deepEqual(refusal(proposeCsv(CHATS, { text: 'ts' })), ['text', 'В колонке «ts» числа или даты, а не текст сообщений.']);
  assert.deepEqual(refusal(proposeCsv(CHATS, { roles: [{ value: 'admin', role: 'system' }] })), ['roles', 'В колонке «author» нет значения «admin».']);
  assert.deepEqual(refusal(proposeCsv(CHATS, { role: 'author', markers: [{ token: 'CLIENT', role: 'user' }] })), ['role', 'Выберите одно: метки ролей в тексте разговора или колонку с ролью того, кто пишет.']);
});

test('markers the owner names are read as named, not only uppercase words: «Клиент:» and «Оператор:» open the messages', () => {
  const said = (k: number) => `Клиент: Здравствуйте, вопрос ${k}\nОператор: Добрый день!\nКлиент: Нужен возврат по заказу ${k}\nОператор: Оформил возврат`;
  const rows: CellSpec[][] = [['id', 'Диалог'], ...Array.from({ length: 12 }, (_, k): CellSpec[] => [`d${k + 1}`, said(k + 1)])];
  const markers = [{ token: 'Клиент:', role: 'user' as const }, { token: 'Оператор:', role: 'assistant' as const }];
  assert.ok(propose(rows).status !== 'ready', 'Lab alone sees no uppercase markers here');
  const proposal = ready(propose(rows, { markers }));
  assert.deepEqual(proposal.mapping.layout, { kind: 'dialogue_per_row', separator: '\n', markers });
  assert.deepEqual([proposal.preview.usable, proposal.preview.messages.map(item => [item.label, item.count])], [12, [['Клиент:', 24], ['Оператор:', 24]]]);
  assert.deepEqual(messagesOf(batchOf(rows, { markers }).batch, 'd3'), [['user', 'Здравствуйте, вопрос 3'], ['assistant', 'Добрый день!'], ['user', 'Нужен возврат по заказу 3'], ['assistant', 'Оформил возврат']]);
  assert.equal(ready(propose(rows, { markers, text: 'Диалог', separator: null })).mapping.layout.kind, 'dialogue_per_row', 'with the owner\'s word that nothing separates the messages');
  assert.deepEqual(refusal(propose(rows, { text: 'Диалог', markers: [{ token: 'Покупатель:', role: 'user' }, { token: 'Продавец:', role: 'assistant' }] })),
    ['markers', 'Метки «Покупатель:», «Продавец:» не открывают разговоры в колонке «Диалог»: строки начинаются не с них.']);
});

test('a sheet without conversations asks where their text is, with the columns that may hold it', () => {
  const proposal = propose([['Товар', 'Цена', 'Описание'], ['Терминал', 12000, 'Касса с эквайрингом для небольшого магазина'], ['Ридер', 3000, 'Считыватель карт']]);
  assert.deepEqual(proposal.status === 'question' && [proposal.question.kind, proposal.question.kind === 'text' && proposal.question.columns.map(column => column.header), proposal.found],
    ['text', ['Описание', 'Товар'], 0]);
});

test('the same logs read the same: the import is deterministic, and a larger log is sampled by content, not by position', () => {
  const first = batchOf(exportRows(40)), again = batchOf(exportRows(40));
  assert.deepEqual([again.batch.id, again.batch.contentHash], [first.batch.id, first.batch.contentHash]);
  assert.deepEqual({ ...again.batch, createdAt: '' }, { ...first.batch, createdAt: '' });

  const large = batchOf(exportRows(350));
  assert.deepEqual([large.preview.dialogues, large.preview.usable, large.preview.taken, large.batch.dialogues.length], [350, 350, 300, 300]);
  const taken = new Set(large.batch.dialogues.map(item => item.id));
  const index = (id: string) => Number(id.slice(1, 5));
  assert.ok([...taken].some(id => index(id) > 300) && Array.from({ length: 300 }, (_, i) => idOf(i + 1)).some(id => !taken.has(id)), 'not the first 300 rows');
  assert.deepEqual(large.batch.dialogues.map(item => index(item.id)), [...taken].map(index).sort((a, b) => a - b), 'kept in the order of the sheet');
  // The same conversations in another order give the same sample.
  const [header, ...body] = exportRows(350);
  const reversed = batchOf([header!, ...body.reverse()]);
  assert.deepEqual(new Set(reversed.batch.dialogues.map(item => item.id)), taken);
  assert.match(proposalLines(ready(propose(exportRows(350)))).join('\n'), /В одну загрузку входит 300 разговоров: Lab возьмёт 300 из 350 подходящих — по хешу содержимого, без отбора по исходу\./);
});

test('order values: sequence numbers, Excel day counts and written dates; anything else is not an order', () => {
  assert.deepEqual(parseOrder('12'), { kind: 'number', value: 12 });
  assert.deepEqual(parseOrder('45909,4375'), { kind: 'number', value: 45909.4375 });
  assert.deepEqual(parseOrder('09.09.2026 10:00:05'), { kind: 'date', value: Date.UTC(2026, 8, 9, 10, 0, 5) });
  assert.deepEqual(parseOrder('2026-09-09T10:00:05Z'), { kind: 'date', value: Date.UTC(2026, 8, 9, 10, 0, 5) });
  for (const text of ['', 'вчера', '31.02.2026', '10:00', '1.2.3']) assert.equal(parseOrder(text), undefined, text);
});

test('the proposal in the owner\'s words: how the table is read and what comes out, in counts only', () => {
  const lines = proposalLines(ready(propose(exportRows(40, { 7: 'без меток' }))));
  assert.deepEqual(lines, [
    'Таблица logs.xlsx · лист «Данные» · 40 строк', '',
    'Как Lab прочитает таблицу',
    '  Один разговор — одна строка; id разговора — колонка «Id диалога».',
    '  Текст — колонка «Текст»: сообщения отделены знаком «`», каждое начинается с метки:',
    '    AGENT — агент · 78 сообщений',
    '    CLIENT — клиент · 78 сообщений',
    '  Колонки «Дата», «agentCode», «Оператор» Lab сохранит при разговорах как есть; в оценке они не участвуют.',
    '  Разговоры можно отобрать по колонке «Оператор».', '',
    'Что получится',
    '  40 разговоров: подходят 39, не подошли 1 (текст не начинается с метки роли — 1).',
  ]);
  const csv = proposalLines(ready(proposeCsv(CHATS)));
  assert.deepEqual(csv.slice(0, 9), [
    'Таблица chats.csv · разделитель «;» · UTF-8 · 8 строк', '',
    'Как Lab прочитает таблицу',
    '  Одно сообщение — одна строка; id разговора — колонка «session».',
    '  Кто пишет — колонка «author»:',
    '    «bot» — агент · 4 сообщения',
    '    «client» — клиент · 4 сообщения',
    '  Текст — колонка «message»; порядок сообщений — по колонке «ts».',
    '  Колонку «channel» Lab сохранит при разговорах как есть; в оценке она не участвует.',
  ]);
});
