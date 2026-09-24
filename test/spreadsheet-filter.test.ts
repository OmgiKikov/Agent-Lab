import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fingerprint } from '../src/contracts.js';
import { importTable } from '../src/spreadsheet/dialogues.js';
import { proposalLines, whereChoices } from '../src/spreadsheet/lines.js';
import type { TableChoices } from '../src/spreadsheet/mapping.js';
import { proposeTable, type TableProposal } from '../src/spreadsheet/proposal.js';
import { readWorkbook, tableFileOf } from '../src/spreadsheet/workbook.js';
import { xlsxFile, type CellSpec } from './helpers/xlsx.js';

/*
 * Chunk T2: the owner chooses which conversations to evaluate — the values of one column of categories, kept
 * exactly as written — and the import is read from those only, before its sample. Every sheet here is synthetic;
 * its shape follows an export whose `agentCode` lists the agents that answered a conversation.
 */

const talk = (...messages: string[]) => messages.join(' ` ');
const conversation = (i: number) => talk(`CLIENT Здравствуйте, вопрос ${i}`, 'AGENT Добрый день! Чем помочь?', `CLIENT Нужен возврат по заказу ${i}`, 'AGENT Оформил возврат');
const SINGLE = "['ACQUIRING_AGENT']";
const PAIR = "['ACQUIRING_AGENT', 'AGENT_GIGACHAT']";
const REVERSED = "['AGENT_GIGACHAT', 'ACQUIRING_AGENT']";
const ADVISOR = "['ACQUIRING_AGENT', 'SERVICE_PACK_ADVISOR']";
const idOf = (i: number) => `c${String(i).padStart(4, '0')}-4c70-bf14`;
const clock = (i: number) => `${String(10 + Math.floor(i / 3600)).padStart(2, '0')}:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`;

/** The owner's shape: 866 conversations, 398 answered by the acquiring agent alone; the agents are spread over the sheet, not in blocks. */
function export866(): CellSpec[][] {
  const agents = [...Array<string>(398).fill(SINGLE), ...Array<string>(300).fill(PAIR), ...Array<string>(120).fill(ADVISOR), ...Array<string>(48).fill(REVERSED)];
  return [['Id диалога', 'Дата', 'Время', 'Текст', 'agentCode', 'Оператор'],
    ...agents.map((_, k): CellSpec[] => [idOf(k + 1), '09.09.2026', clock(k + 1), conversation(k + 1), agents[(k * 7) % agents.length]!, k % 3 ? 'FALSE' : 'TRUE'])];
}
const ROWS = export866();
const BYTES = xlsxFile([{ name: 'Данные', rows: ROWS }]);
const FILE = tableFileOf('logs.xlsx', BYTES);
const SHEET = readWorkbook(BYTES, FILE).sheets[0]!;

const propose = (choices: TableChoices = {}): TableProposal => proposeTable(readWorkbook(BYTES, FILE), FILE, choices);
function ready(proposal: TableProposal): Extract<TableProposal, { status: 'ready' }> {
  assert.equal(proposal.status, 'ready', JSON.stringify(proposal.status === 'refused' ? proposal.reason : proposal.status === 'question' ? proposal.question : ''));
  return proposal as Extract<TableProposal, { status: 'ready' }>;
}
const refusal = (proposal: TableProposal) => proposal.status === 'refused' ? [proposal.choice, proposal.reason] : [proposal.status];
const agentsOf = (batch: ReturnType<typeof importTable>['batch']) => new Set(batch.dialogues.map(item => ((item.original as { columns: Record<string, string> }).columns).agentCode));

test('which conversations to evaluate: the owner names a column of categories, Lab lists its values with their conversations — never a word of the conversations', () => {
  const asked = propose({ where: { column: 'agentCode' } });
  assert.equal(asked.status, 'question');
  assert.deepEqual(asked.status === 'question' && [asked.question, asked.found], [{ kind: 'where', column: asked.columns[4], values: [
    { value: SINGLE, dialogues: 398 }, { value: PAIR, dialogues: 300 }, { value: ADVISOR, dialogues: 120 }, { value: REVERSED, dialogues: 48 }], more: 0 }, 866]);
  const lines = proposalLines(asked);
  assert.deepEqual(lines, [
    'Таблица logs.xlsx · лист «Данные»', '',
    'Какие разговоры оценивать? Lab видит 866 разговоров; в колонке «agentCode» у них 4 разных значения — выберите одно или несколько.',
    "  1. «['ACQUIRING_AGENT']» — 398 разговоров",
    "  2. «['ACQUIRING_AGENT', 'AGENT_GIGACHAT']» — 300 разговоров",
    "  3. «['ACQUIRING_AGENT', 'SERVICE_PACK_ADVISOR']» — 120 разговоров",
    "  4. «['AGENT_GIGACHAT', 'ACQUIRING_AGENT']» — 48 разговоров",
  ]);
  assert.deepEqual(asked.status === 'question' && asked.question.kind === 'where' && whereChoices(asked.question).length, 4, 'the chat numbers the same answers');
  for (const words of ['Здравствуйте', 'возврат', 'Добрый день']) assert.ok(!lines.join('\n').includes(words), words);
});

test('the filter keeps exactly the values as written, applies before the sample, and the preview names both numbers', () => {
  const single = ready(propose({ where: { column: 'agentCode', values: [SINGLE] } }));
  assert.deepEqual(single.mapping.filter, { column: { index: 4, header: 'agentCode' }, values: [SINGLE] });
  assert.deepEqual([single.preview.dialogues, single.preview.selected, single.preview.usable, single.preview.taken], [866, 398, 398, 300]);
  const lines = proposalLines(single);
  const outcome = lines.slice(lines.indexOf('Что получится') + 1);
  assert.deepEqual(outcome, [
    "  Отбор: «agentCode» = «['ACQUIRING_AGENT']» — 398 из 866 разговоров.",
    '  398 разговоров: подходят 398.',
    '  В одну загрузку входит 300 разговоров: Lab возьмёт 300 из 398 подходящих — по хешу содержимого, без отбора по исходу.',
  ]);
  assert.ok(!lines.some(line => line.startsWith('  Разговоры можно отобрать')), 'a choice made is not offered again');
  const { batch } = importTable(SHEET, single.mapping);
  assert.equal(batch.dialogues.length, 300);
  assert.deepEqual(agentsOf(batch), new Set([SINGLE]), 'the sample is drawn from the chosen conversations only');

  // A list-like cell is one value, compared as written: neither a part of it nor its items in another order.
  const pair = ready(propose({ where: { column: 'agentCode', values: [PAIR] } }));
  assert.equal(pair.preview.selected, 300);
  assert.deepEqual(agentsOf(importTable(SHEET, pair.mapping).batch), new Set([PAIR]));
  assert.deepEqual(refusal(propose({ where: { column: 'agentCode', values: ['ACQUIRING_AGENT'] } })), ['where', 'В колонке «agentCode» нет значения «ACQUIRING_AGENT».']);
  assert.deepEqual(refusal(propose({ where: { column: 'agentCode', values: ["['acquiring_agent']"] } })), ['where', "В колонке «agentCode» нет значения «['acquiring_agent']»."]);
  assert.deepEqual(refusal(propose({ where: { column: 'agentCode', values: [''] } })), ['where', 'В колонке «agentCode» нет пустых ячеек.']);
});

test('several values are kept together; one choice is one mapping, whatever order the owner named them in', () => {
  const both = ready(propose({ where: { column: 'agentCode', values: [ADVISOR, SINGLE] } }));
  assert.deepEqual(both.mapping.filter?.values, [SINGLE, ADVISOR], 'in the order the question lists them');
  assert.equal(both.preview.selected, 518);
  assert.ok(proposalLines(both).includes("  Отбор: «agentCode» = «['ACQUIRING_AGENT']» или «['ACQUIRING_AGENT', 'SERVICE_PACK_ADVISOR']» — 518 из 866 разговоров."));
  assert.deepEqual(agentsOf(importTable(SHEET, both.mapping).batch), new Set([SINGLE, ADVISOR]));
  const again = ready(propose({ where: { column: 'agentCode', values: [SINGLE, ADVISOR] } }));
  assert.equal(fingerprint(again.mapping), fingerprint(both.mapping));
});

test('a column read as the conversation cannot choose it, and a column of texts is never listed: each is refused with the reason', () => {
  assert.deepEqual(refusal(propose({ where: { column: 'Текст' } })), ['where', 'Колонка «Текст» уже выбрана как текст разговора.']);
  assert.deepEqual(refusal(propose({ where: { column: 'A', values: [idOf(1)] } })), ['where', 'Колонка «Id диалога» уже выбрана как id разговора.']);
  assert.deepEqual(refusal(propose({ where: { column: 'Канал' } })), ['where', 'Колонки «Канал» нет в листе «Данные». Есть: «Id диалога», «Дата», «Время», «Текст», «agentCode», «Оператор».']);
  const notes = (i: number) => `Оператор подключился после ${i % 3 + 1}-й реплики клиента; клиент недоволен ожиданием и просит перезвонить ему позже, когда вопрос будет решён`;
  const rows: CellSpec[][] = [['Id', 'Текст', 'Заметка'], ...Array.from({ length: 12 }, (_, k): CellSpec[] => [`d${k + 1}`, conversation(k + 1), notes(k)])];
  const bytes = xlsxFile([{ name: 'Данные', rows }]), file = tableFileOf('notes.xlsx', bytes);
  const proposal = proposeTable(readWorkbook(bytes, file), file, { where: { column: 'Заметка' } });
  assert.deepEqual(refusal(proposal), ['where', 'В колонке «Заметка» длинные тексты — по ним разговоры не отбирают.']);
  assert.ok(!JSON.stringify(proposal).includes('недоволен'), 'a refused column\'s texts are not listed');
});

test('Lab offers the columns of categories; the same file and the same choice read the very same conversations', () => {
  const all = ready(propose());
  assert.deepEqual(all.selectable.map(column => column.header), ['agentCode', 'Оператор'], 'one date for every row and a time per row are not categories to choose by');
  assert.ok(proposalLines(all).includes('  Разговоры можно отобрать по колонкам «agentCode», «Оператор».'));
  assert.equal(all.mapping.filter, undefined);
  assert.equal(all.preview.selected, undefined);

  const choice = { where: { column: 'agentCode', values: [SINGLE] } };
  const first = importTable(SHEET, ready(propose(choice)).mapping).batch;
  const again = importTable(readWorkbook(xlsxFile([{ name: 'Данные', rows: export866() }]), FILE).sheets[0]!, ready(propose(choice)).mapping).batch;
  assert.deepEqual([again.id, again.contentHash], [first.id, first.contentHash]);
  assert.deepEqual({ ...again, createdAt: '' }, { ...first, createdAt: '' });
  assert.notEqual(importTable(SHEET, all.mapping).batch.id, first.id, 'the chosen conversations are another import than the whole sheet');
});

/** The owner's real export: 57 combinations of agents in `agentCode`, the acquiring agent alone in 398 of 866 conversations. */
function export57(): CellSpec[][] {
  const others = Array.from({ length: 56 }, (_, j) => `['ACQUIRING_AGENT', 'AGENT_${String(j + 1).padStart(2, '0')}']`);
  const agents = [...Array<string>(398).fill(SINGLE), ...others.flatMap((value, j) => Array<string>(j < 20 ? 9 : 8).fill(value))];
  return [['Id диалога', 'Текст', 'agentCode'], ...agents.map((_, k): CellSpec[] => [idOf(k + 1), conversation(k + 1), agents[(k * 7) % agents.length]!])];
}

test('a column of many values still chooses: a value the owner names is kept with its count, and the question lists the most frequent and how many more', () => {
  const bytes = xlsxFile([{ name: 'Данные', rows: export57() }]), file = tableFileOf('logs.xlsx', bytes);
  const wide = (choices: TableChoices) => proposeTable(readWorkbook(bytes, file), file, choices);
  const named = ready(wide({ where: { column: 'agentCode', values: [SINGLE] } }));
  assert.deepEqual([named.preview.dialogues, named.preview.selected], [866, 398]);
  assert.ok(proposalLines(named).includes(`  Отбор: «agentCode» = «${SINGLE}» — 398 из 866 разговоров.`), proposalLines(named).join('\n'));
  assert.deepEqual(refusal(wide({ where: { column: 'agentCode', values: ["['NO_SUCH_AGENT']"] } })), ['where', "В колонке «agentCode» нет значения «['NO_SUCH_AGENT']»."]);

  const asked = wide({ where: { column: 'agentCode' } });
  assert.ok(asked.status === 'question' && asked.question.kind === 'where', asked.status);
  assert.deepEqual([asked.question.values.length, asked.question.more, asked.question.values[0]], [30, 27, { value: SINGLE, dialogues: 398 }]);
  const lines = proposalLines(asked);
  assert.equal(lines[2], 'Какие разговоры оценивать? Lab видит 866 разговоров; в колонке «agentCode» у них 57 разных значений — выберите одно или несколько; ниже 30 самых частых.');
  assert.equal(lines[3], `  1. «${SINGLE}» — 398 разговоров`);
  assert.equal(lines.at(-1), '  …ещё 27 значений — назовите нужное сами');
  assert.equal(lines.length, 3 + 30 + 1, 'thirty numbered answers and one line for the rest');
  assert.ok(ready(wide({})).selectable.some(column => column.header === 'agentCode'), 'a column of many categories is offered too');
});

/** One message per row, with a column that names each conversation's channel on its rows. */
const CHATS = [
  'session;author;message;ts;channel',
  's1;client;Здравствуйте, хочу вернуть деньги за заказ;09.09.2026 10:00:01;chat',
  's1;bot;Назовите номер заказа, пожалуйста;09.09.2026 10:00:05;chat',
  's2;client;Подскажите, где сейчас мой заказ?;09.09.2026 10:01:00;voice',
  's2;bot;Проверяю статус вашего заказа;09.09.2026 10:01:10;voice',
  's3;client;Как сменить тариф на годовой?;09.09.2026 10:02:00;chat',
  's3;bot;Тариф меняется в личном кабинете;09.09.2026 10:02:30;chat',
  's1;client;Номер A-17, оплачен вчера;09.09.2026 10:00:30;chat',
  's1;bot;Оформил возврат, деньги придут за пять дней;09.09.2026 10:00:40;chat',
];
const proposeCsv = (text: string, choices: TableChoices = {}) => {
  const bytes = Buffer.from(text), file = tableFileOf('chats.csv', bytes);
  return { proposal: proposeTable(readWorkbook(bytes, file), file, choices), sheet: readWorkbook(bytes, file).sheets[0]! };
};

test('one message per row: a conversation is chosen whole by the value its rows write; rows that disagree cannot choose it', () => {
  const voice = proposeCsv(CHATS.join('\n'), { where: { column: 'channel', values: ['voice'] } });
  const chosen = ready(voice.proposal);
  assert.deepEqual([chosen.preview.dialogues, chosen.preview.selected, chosen.preview.usable], [3, 1, 1]);
  assert.deepEqual(importTable(voice.sheet, chosen.mapping).batch.dialogues.map(item => [item.id, item.events.length]), [['s2', 2]]);

  // The channel written once, on a conversation's first row: the blank rows below it write nothing, and the conversation stays whole.
  const once = CHATS.map((line, i) => i > 1 && line.startsWith('s1;') ? line.replace(/;chat$/, ';') : line).join('\n');
  const chat = proposeCsv(once, { where: { column: 'channel', values: ['chat'] } });
  assert.deepEqual(importTable(chat.sheet, ready(chat.proposal).mapping).batch.dialogues.map(item => [item.id, item.events.length]), [['s1', 4], ['s3', 2]]);

  const mixed = proposeCsv([...CHATS, 's1;client;Спасибо;09.09.2026 10:00:50;voice'].join('\n'), { where: { column: 'channel' } });
  assert.deepEqual(refusal(mixed.proposal), ['where', 'В колонке «channel» у 1 разговора разные значения в разных строках — по ней не отобрать разговоры целиком.']);
  assert.deepEqual(refusal(proposeCsv(CHATS.join('\n'), { where: { column: 'ts' } }).proposal), ['where', 'Колонка «ts» уже выбрана как порядок сообщений.']);
  assert.deepEqual(refusal(proposeCsv(CHATS.join('\n'), { where: { column: 'author' } }).proposal), ['where', 'Колонка «author» уже выбрана как роль того, кто пишет.']);
});
