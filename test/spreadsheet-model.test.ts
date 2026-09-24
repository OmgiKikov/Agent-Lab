import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ExperimentLab } from '../src/experiment.js';
import { questionAnswers } from '../src/spreadsheet/answers.js';
import { importTable } from '../src/spreadsheet/dialogues.js';
import { tableEvidence } from '../src/spreadsheet/evidence.js';
import { readExactly, type CompleteReading } from '../src/spreadsheet/exact.js';
import { readReadingFiles } from '../src/spreadsheet/files.js';
import { planTableReading, proposeReading, proposeTableImport, readConfirmedTable, readingConsent } from '../src/spreadsheet/import.js';
import { proposalLines } from '../src/spreadsheet/lines.js';
import type { TableProposal } from '../src/spreadsheet/proposal.js';
import { READING_CALLS, TABLE_READING_ROLE, type TableReader } from '../src/spreadsheet/reading-task.js';
import { readWorkbook, tableFileOf } from '../src/spreadsheet/workbook.js';
import { fixture, type Request } from './helpers/pi-fixture.js';
import { xlsxFile, type CellSpec } from './helpers/xlsx.js';

/*
 * Chunk I3: Lab's model proposes how to read a spreadsheet; the harness applies the proposal to every row and checks it
 * with numbers. The model is the offline Pi fixture — the real harness parses, validates and repairs its scripted replies.
 * The sheets are synthetic, shaped like the owner's export: no separator, CLIENT/AGENT markers, Markdown code fences with
 * backticks inside agents' replies, exchanges the export copied, a column of agent codes.
 */

const spoken = (...messages: string[]) => messages.join(' ');
const idOf = (i: number) => `c${String(i).padStart(4, '0')}-4c70-bf14`;
const FENCE = 'Проверьте настройки терминала:\n```json\n{"terminal": "T-100", "mode": "sbp"}\n```';
function conversation(i: number): string {
  if (i % 6 === 1) return spoken(...Array.from({ length: 4 }, () => ['CLIENT Здравствуйте', 'AGENT Добрый день! Чем помочь?']).flat(), `CLIENT Нужен возврат по заказу ${i}`, 'AGENT Оформил возврат');
  if (i % 5 === 0) return spoken(`CLIENT Не проходит оплата по QR ${i}`, `AGENT ${FENCE}`, 'CLIENT Сделал, теперь работает', 'AGENT Отлично! Обращайтесь.');
  const client = i % 3 === 0 ? `CLIENT Я ИП, пришло SMS с кодом ${i}` : `CLIENT Здравствуйте, вопрос ${i}`;
  return spoken(client, 'AGENT Добрый день! Чем помочь?', `CLIENT Нужен возврат по заказу ${i}`, 'AGENT Оформил возврат, деньги придут за 5 дней');
}
const SINGLE = "['SUPPORT_AGENT']";
const AGENTS = [SINGLE, "['SUPPORT_AGENT', 'AGENT_GIGACHAT']", "['SERVICE_PACK_ADVISOR']"];
const ROWS: CellSpec[][] = [['Id диалога', 'Дата', 'Текст', 'agentCode'], ...Array.from({ length: 40 }, (_, k): CellSpec[] => [idOf(k + 1), '09.09.2026', conversation(k + 1), AGENTS[k % 3]!])];
/** Words of the conversations: none may reach the model's answer or the owner's preview. */
const SAID = ['Здравствуйте', 'возврат', 'терминала', 'Обращайтесь'];

/** The reading the owner's export needs: no separator, the two markers, SMS a word, the copies the export's. */
const RIGHT = { sheet: 'Данные', id: 'Id диалога', text: 'Текст', repeats: 'export_copies',
  layout: { kind: 'dialogue_per_row', separator: null, markers: [{ token: 'CLIENT', role: 'user' }, { token: 'AGENT', role: 'assistant' }, { token: 'SMS', role: 'text' }] } };
/** The reading chunk I2 found Lab's own detection making on the real export: the backticks of code fences taken for the separator. */
const BACKTICK = { ...RIGHT, layout: { ...RIGHT.layout, separator: '`' } };

async function folder(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-model-reading-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function exportFile(t: TestContext, rows: CellSpec[][] = ROWS): Promise<{ root: string; path: string }> {
  const root = await folder(t), path = join(root, 'export.xlsx');
  await writeFile(path, xlsxFile([{ name: 'Данные', rows }]));
  return { root, path };
}
/** The builder model of the offline fixture, answering `replies` in turn. */
async function scripted(t: TestContext, replies: unknown[]): Promise<{ reader: TableReader; requests: Request[] }> {
  const f = await fixture((_request, index) => JSON.stringify(replies[index] ?? replies.at(-1)));
  t.after(() => f.close());
  return { reader: f.adapter.tableReading!, requests: f.requests };
}
const textOf = (message: Request['messages'][number]): string => typeof message.content === 'string' ? message.content : message.content.map(part => part.type === 'text' ? part.text : '').join('');
const schemaOf = (request: Request) => JSON.parse(request.systemPrompt!.split('\n').find(line => line.startsWith('{"$schema"'))!);
function ready(proposal: TableProposal): Extract<TableProposal, { status: 'ready' }> {
  assert.equal(proposal.status, 'ready', JSON.stringify(proposal.status === 'refused' ? proposal.reason : proposal.status === 'question' ? proposal.question : ''));
  return proposal as Extract<TableProposal, { status: 'ready' }>;
}

test('the owner\'s export read by the model\'s reading: every row split at the whole-word markers, code fences kept, the copies read once', async t => {
  const { path } = await exportFile(t);
  const { reader, requests } = await scripted(t, [RIGHT]);
  const plan = (await planTableReading(path, reader.builder))!;
  // The first four rows, and row 6 for QR — the first candidate marker they do not hold.
  assert.equal(plan.rows, 5);
  assert.deepEqual(readingConsent(plan), { question: 'Предложить, как читать таблицу export.xlsx?', lines: [
    `Модель Lab прочитает названия и частые значения колонок и 5 строк таблицы — не больше ${READING_CALLS} вызовов модели.`,
    'По её разметке Lab сам прочитает и проверит каждую строку; таблица загрузится, только когда вы подтвердите разметку.'] });
  const proposed = await proposeReading(plan, reader, { timeoutMs: 1000 });
  assert.deepEqual([proposed.outcome.kind, proposed.usage.calls, requests.length], ['read', 1, 1]);

  // What the model was shown: counts over every row, candidate markers, and a few rows — the fewest that decide the reading.
  assert.ok(requests[0]!.systemPrompt!.startsWith(TABLE_READING_ROLE));
  const shown = JSON.parse(textOf(requests[0]!.messages[0]!));
  const text = shown.sheets[0].columns.find((column: { name: string }) => column.name === 'Текст');
  assert.deepEqual(text.markers.slice(0, 2).map((marker: { token: string }) => marker.token).sort(), ['AGENT', 'CLIENT']);
  assert.deepEqual(shown.sheets[0].columns.find((column: { name: string }) => column.name === 'agentCode').values.map((item: { value: string }) => item.value).sort(), [...AGENTS].sort());
  assert.deepEqual(shown.sheets[0].sample.map((row: { row: number }) => row.row), [2, 3, 4, 5, 6]);

  const proposal = ready(await proposeTableImport(path, {}, proposed));
  assert.deepEqual(proposal.basis, { kind: 'model', model: 'agent-lab-test/test-model', key: plan.key, rows: 5, repeats: 'export_copies' });
  assert.deepEqual(proposal.mapping.layout, { kind: 'dialogue_per_row', markers: [{ token: 'CLIENT', role: 'user' }, { token: 'AGENT', role: 'assistant' }] }, 'no separator; SMS is a word');
  assert.equal(proposal.mapping.collapseRepeats, true);
  assert.deepEqual([proposal.preview.dialogues, proposal.preview.usable, proposal.preview.repeats], [40, 40, { dialogues: 7, messages: 42 }]);
  const bytes = await readFile(path);
  const { batch } = importTable(readWorkbook(bytes, tableFileOf(path, bytes)).sheets[0]!, proposal.mapping);
  const messages = (id: string) => batch.dialogues.find(item => item.id === id)?.events.map(event => [event.role, event.content]);
  assert.deepEqual(messages(idOf(5)), [['user', 'Не проходит оплата по QR 5'], ['assistant', FENCE], ['user', 'Сделал, теперь работает'], ['assistant', 'Отлично! Обращайтесь.']]);
  assert.deepEqual(messages(idOf(3))?.[0], ['user', 'Я ИП, пришло SMS с кодом 3']);
  assert.equal(messages(idOf(1))?.length, 4, 'an exchange the export wrote four times is read once');

  const lines = proposalLines(proposal);
  assert.equal(lines[1], 'Разметку предложила модель Lab — она прочитала 5 строк таблицы; по этой разметке Lab сам прочитал и проверил каждую строку.');
  for (const line of ['  Текст — колонка «Текст»: сообщения ничем не отделены — новое начинается с каждой метки:', '    CLIENT — клиент · 80 сообщений',
    '  Повторы убраны: 42 сообщения в 7 разговорах — каждый обмен остался один раз.', '  Так решила модель Lab: это копии, которые сделала выгрузка.']) {
    assert.ok(lines.includes(line), `${line}\n---\n${lines.join('\n')}`);
  }
  for (const word of SAID) assert.ok(!lines.join('\n').includes(word), word);
});

test('a wrong reading is caught by the numbers and goes back with the exact reason; the repaired one is taken', async t => {
  const { path } = await exportFile(t);
  const { reader, requests } = await scripted(t, [BACKTICK, RIGHT]);
  const plan = (await planTableReading(path, reader.builder))!;
  const proposed = await proposeReading(plan, reader, { timeoutMs: 1000 });
  assert.deepEqual([proposed.outcome.kind, proposed.usage.calls], ['read', 2]);
  const repair = textOf(requests[1]!.messages.at(-1)!);
  assert.match(repair, /^Your previous answer was rejected\. Under this reading no message is the agent's \(assistant\): \d+ customer and 0 agent messages\. Check the markers and the separator\./, repair);
  assert.equal(ready(await proposeTableImport(path, {}, proposed)).mapping.layout.kind, 'dialogue_per_row');
});

test('a reading that leaves conversations out hears how many and why; a customer who wrote nothing is the data, not the reading', async t => {
  const rows: CellSpec[][] = [...ROWS, ...[41, 42, 43, 44, 45, 46, 47, 48].map((i): CellSpec[] => [idOf(i), '09.09.2026', 'AGENT Здравствуйте! Чем помочь?', AGENTS[0]!])];
  const { path } = await exportFile(t, rows);
  const { reader, requests } = await scripted(t, [{ ...RIGHT, id: 'Дата' }, RIGHT]);
  const proposed = await proposeReading((await planTableReading(path, reader.builder))!, reader, { timeoutMs: 1000 });
  assert.match(textOf(requests[1]!.messages.at(-1)!), /This reading leaves out 48 of 48 conversations: "Некорректный id диалога" — 48\. Every conversation needs its own id of letters, digits/);
  // Eight conversations where only the agent wrote: a sixth of the sheet, left out as the data they are, the reading taken.
  const proposal = ready(await proposeTableImport(path, {}, proposed));
  assert.deepEqual([proposal.preview.dialogues, proposal.preview.usable, proposal.preview.rejected], [48, 40, [{ reason: 'Нет пользовательских реплик', count: 8 }]]);
});

test('two failed readings leave the table to Lab\'s own reading, clearly marked, and its numbered questions go to the owner', async t => {
  const { path } = await exportFile(t);
  const { reader, requests } = await scripted(t, [BACKTICK, BACKTICK, RIGHT]);
  const plan = (await planTableReading(path, reader.builder))!;
  const proposed = await proposeReading(plan, reader, { timeoutMs: 1000 });
  assert.equal(requests.length, READING_CALLS, 'never more calls than the owner agreed to');
  assert.equal(proposed.outcome.kind, 'failed');
  const proposal = await proposeTableImport(path, {}, proposed);
  assert.ok(proposal.status === 'question' && proposal.question.kind === 'repeats', proposal.status);
  assert.deepEqual(proposal.basis, { kind: 'lab', why: 'model_failed' });
  assert.equal(proposalLines(proposal)[1], 'Модель Lab не нашла разметку, которая сходится с таблицей, — Lab предположил её сам, по частоте слов; проверьте её.');
  assert.equal(questionAnswers(proposal.question).length, 2, 'the existing numbered answers');
});

test('without a model the proposal is Lab\'s own reading, and it says so', async t => {
  const { path } = await exportFile(t);
  const proposal = await proposeTableImport(path, { collapseRepeats: true });
  assert.deepEqual([proposal.status, proposal.basis], ['ready', { kind: 'lab', why: 'no_model' }]);
  assert.equal(proposalLines(proposal)[1], 'Разметку Lab предположил сам, без модели, — по частоте слов в таблице; проверьте её.');
});

test('the model\'s answer can hold no text of a conversation: every string of its schema is an enum of the table\'s names, but a short separator', async t => {
  const { path } = await exportFile(t);
  // A marker that is a word of the messages is not a candidate: the schema rejects it before any check.
  const { reader, requests } = await scripted(t, [{ ...RIGHT, filter: null, layout: { ...RIGHT.layout, markers: [{ token: 'Здравствуйте', role: 'user' }, { token: 'AGENT', role: 'assistant' }] } },
    { ...RIGHT, filter: null }]);
  const proposed = await proposeReading((await planTableReading(path, reader.builder, 'только разговоры одного агента эквайринга'))!, reader, { timeoutMs: 1000 });
  assert.match(textOf(requests[1]!.messages.at(-1)!), /Not a candidate marker/);
  assert.equal(proposed.outcome.kind, 'read');
  const free: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) { node.forEach((item, i) => walk(item, `${path}[${i}]`)); return; }
    if (!node || typeof node !== 'object') return;
    const schema = node as Record<string, unknown>;
    if (schema.type === 'string' && schema.enum === undefined && schema.const === undefined) {
      free.push(path);
      assert.ok(Number(schema.maxLength) <= 8, `${path}: a free string must be short`);
    }
    for (const [key, value] of Object.entries(schema)) walk(value, `${path}.${key}`);
  };
  walk(schemaOf(requests[0]!), '');
  assert.ok(free.length > 0 && free.every(path => path.includes('separator')), free.join('\n'));
  assert.ok(JSON.stringify(schemaOf(requests[0]!)).includes('"filter"'), 'the owner\'s words allow a filter');
  for (const word of SAID) assert.ok(!JSON.stringify(proposed.outcome).includes(word), word);
});

test('the owner\'s words choose conversations through the model\'s filter; the owner\'s own choices change the stored reading for free', async t => {
  const { path } = await exportFile(t);
  const { reader, requests } = await scripted(t, [{ ...RIGHT, filter: { column: 'agentCode', values: [SINGLE] } }]);
  const proposed = await proposeReading((await planTableReading(path, reader.builder, 'только разговоры одного агента эквайринга'))!, reader, { timeoutMs: 1000 });
  const filtered = ready(await proposeTableImport(path, {}, proposed));
  assert.deepEqual([filtered.mapping.filter?.values, filtered.preview.selected], [[SINGLE], 14]);
  // Owner's choices over the stored reading: no call.
  const kept = ready(await proposeTableImport(path, { collapseRepeats: false, where: { column: 'agentCode', values: [AGENTS[2]!] } }, proposed));
  assert.deepEqual([kept.mapping.collapseRepeats, kept.mapping.filter?.values, kept.basis], [undefined, [AGENTS[2]], { kind: 'model', model: proposed.model, key: proposed.key, rows: proposed.rows }]);
  assert.ok(!proposalLines(kept).some(line => line.startsWith('  Так решила модель Lab')), 'the owner\'s own choice needs no reason');
  const asked = await proposeTableImport(path, { where: { column: 'agentCode' } }, proposed);
  assert.ok(asked.status === 'question' && asked.question.kind === 'where' && asked.basis?.kind === 'model', asked.status);
  // A change that leaves the model's layout is the owner's to finish: Lab's own reading, marked.
  const changed = await proposeTableImport(path, { role: 'agentCode' }, proposed);
  assert.deepEqual(changed.basis, { kind: 'lab', why: 'owner' });
  assert.equal(requests.length, 1);
});

test('one message per row: every value of the role column must get a role; the model is told which it left out', async t => {
  const root = await folder(t), path = join(root, 'chats.csv');
  await writeFile(path, ['session;author;message;ts',
    ...['s1', 's2', 's3'].flatMap((session, i) => [`${session};client;Здравствуйте, вопрос ${i};09.09.2026 10:0${i}:01`, `${session};bot;Добрый день, отвечаю ${i};09.09.2026 10:0${i}:05`,
      `${session};operator;Подключился специалист ${i};09.09.2026 10:0${i}:09`])].join('\r\n'));
  const reading = (roles: { value: string; role: string }[]) => ({ sheet: 'chats', id: 'session', text: 'message', repeats: 'none',
    layout: { kind: 'message_per_row', role: 'author', roles, order: 'ts' } });
  const two = [{ value: 'client', role: 'user' }, { value: 'bot', role: 'assistant' }];
  const { reader, requests } = await scripted(t, [reading(two), reading([...two, { value: 'operator', role: 'system' }])]);
  const proposed = await proposeReading((await planTableReading(path, reader.builder))!, reader, { timeoutMs: 1000 });
  assert.match(textOf(requests[1]!.messages.at(-1)!), /Values "operator" of the role column "author" have no role in roles: give each of them one\./);
  const proposal = ready(await proposeTableImport(path, {}, proposed));
  assert.deepEqual(proposal.mapping.layout, { kind: 'message_per_row', role: { index: 1, header: 'author' },
    roles: [{ value: 'client', role: 'user' }, { value: 'bot', role: 'assistant' }, { value: 'operator', role: 'system' }], order: { index: 3, header: 'ts' } });
  assert.deepEqual([proposal.preview.dialogues, proposal.preview.usable], [3, 3]);
});

test('a reading that drops the export\'s copies is checked as it reads: copies never count against it, a long conversation is the data', () => {
  // Fifteen conversations wrote one exchange thirty times: 62 messages as written, over the 60 an import keeps only with the copies.
  const copied = (i: number) => spoken(`CLIENT Вопрос ${i}`, ...Array.from({ length: 30 }, () => ['CLIENT Здравствуйте', 'AGENT Добрый день! Чем помочь?']).flat(), 'AGENT Оформил возврат');
  // Five conversations really are longer than an import keeps: seventy different messages.
  const long = (i: number) => spoken(...Array.from({ length: 70 }, (_, k) => k % 2 ? `AGENT Ответ ${k} по заказу ${i}` : `CLIENT Вопрос ${k} по заказу ${i}`));
  const rows: CellSpec[][] = [['Id диалога', 'Дата', 'Текст', 'agentCode'], ...Array.from({ length: 50 }, (_, k): CellSpec[] =>
    [idOf(k + 1), '09.09.2026', k < 15 ? copied(k + 1) : k < 20 ? long(k + 1) : conversation(k + 1), AGENTS[k % 3]!])];
  const bytes = xlsxFile([{ name: 'Данные', rows }]), file = tableFileOf('export.xlsx', bytes);
  const outcome = readExactly(readWorkbook(bytes, file), file, { ...RIGHT, collapseRepeats: true } as CompleteReading, 'export_copies');
  assert.ok('proposal' in outcome && outcome.proposal.status === 'ready', JSON.stringify(outcome));
  const { mapping, preview } = outcome.proposal as Extract<TableProposal, { status: 'ready' }>;
  assert.equal(mapping.collapseRepeats, true);
  assert.deepEqual([preview.dialogues, preview.usable, preview.rejected], [50, 45, [{ reason: 'Пустые события или превышен лимит событий', count: 5 }]]);
  assert.ok(preview.repeats && preview.repeats.dialogues >= 15, JSON.stringify(preview.repeats));
});

test('what the model is shown stays small: a few rows, long cells cut, and the cut named', () => {
  const long = (i: number) => spoken(...Array.from({ length: 60 }, (_, k) => k % 2 ? `AGENT Ответ ${k} по заказу ${i}` : `CLIENT Вопрос ${k} по заказу ${i}`));
  const rows: CellSpec[][] = [['Id', 'Текст'], ...Array.from({ length: 300 }, (_, k): CellSpec[] => [`d${k}`, long(k)])];
  const bytes = xlsxFile([{ name: 'Логи', rows }]);
  const evidence = tableEvidence(readWorkbook(bytes, tableFileOf('big.xlsx', bytes)));
  const sample = evidence.sheets[0]!.sample;
  assert.ok(sample.length >= 1 && sample.length <= 8, `${sample.length}`);
  assert.ok(Buffer.byteLength(JSON.stringify(sample)) <= 24_000);
  assert.ok(sample.every(row => row.cut?.includes('Текст') && row.cells['Текст']!.length === 1200));
  assert.deepEqual(evidence.sheets[0]!.columns.map(column => [column.name, column.kind]), [['Id', 'text'], ['Текст', 'text']]);
});

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
async function agentLab(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args]);
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  return { code, stdout, stderr };
}

test('agent-lab import with a task\'s model: the consent first, then the stored proposal is shown for free and --yes stores exactly it', { timeout: 60000 }, async t => {
  const { root, path } = await exportFile(t);
  const data = join(root, 'data'), task = join(root, 'task.json');
  await writeFile(task, JSON.stringify({ task: 'Проверить агента', settings: { provider: 'agent-lab-test', model: 'test-model' } }));
  const consent = await agentLab(['import', '--file', path, '--input', task, '--data-dir', data]);
  assert.equal(consent.code, 0, consent.stderr);
  const plan = (await planTableReading(path, { provider: 'agent-lab-test', id: 'test-model' }))!;
  assert.deepEqual(consent.stdout.trimEnd().split('\n'), [readingConsent(plan).question, '', ...readingConsent(plan).lines, '', 'Предложить: та же команда с --yes. Без него ничего не записано и не потрачено.']);
  assert.deepEqual(await readdir(data).catch(() => []), [], 'nothing written or spent');

  // What --yes would have paid for, made here by the offline model and stored as the command stores it.
  const { reader } = await scripted(t, [RIGHT]);
  const lab = new ExperimentLab(data);
  await lab.init();
  try { await lab.store.writeProposedReading(await proposeReading(plan, reader, { timeoutMs: 1000 })); } finally { await lab.close(); }
  const shown = await agentLab(['import', '--file', path, '--input', task, '--data-dir', data]);
  assert.equal(shown.code, 0, shown.stderr);
  assert.ok(shown.stdout.includes('Разметку предложила модель Lab — она прочитала 5 строк таблицы'), shown.stdout);
  assert.ok(shown.stdout.split('\n').includes('Загрузить: та же команда с --yes.'), shown.stdout);
  const stored = await agentLab(['import', '--file', path, '--input', task, '--data-dir', data, '--yes']);
  assert.equal(stored.code, 0, stored.stderr);
  assert.ok(stored.stdout.includes('Загружено: 40 разговоров.'), stored.stdout);
  const batch = await readConfirmedTable(path, data);
  assert.equal(batch.dialogues.find(item => item.id === idOf(1))?.events.length, 4, 'the model\'s reading, copies read once');
  const [confirmed] = (await readReadingFiles(data))[0]!.readings;
  assert.deepEqual(confirmed!.proposedBy, { kind: 'model', model: 'agent-lab-test/test-model', key: plan.key, rows: 5, repeats: 'export_copies' }, 'the import remembers who proposed its reading');

  const plain = await agentLab(['import', '--file', path, '--data-dir', join(root, 'other'), '--collapse-repeats']);
  assert.ok(plain.stdout.split('\n').includes('Разметку Lab предположил сам, без модели, — по частоте слов в таблице; проверьте её.'), plain.stdout);
});
