import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Runtime } from '../src/runtime.js';
import { ExperimentLab } from '../src/experiment.js';
import { draftHash } from '../src/lab/record.js';
import { readDialogueImport } from '../src/imports.js';
import { IMPORT_FILE_BYTES } from '../src/limits.js';
import { buildResultView } from '../src/result-view.js';
import { libraryHash } from '../src/scenario-library.js';
import { confirmTableImport, proposeTableImport, readConfirmedTable } from '../src/spreadsheet/import.js';
import { importReadingsSchema } from '../src/spreadsheet/mapping.js';
import { cardInput, cardRuntime, dialogues } from './helpers/card-prep.js';
import { xlsxFile, type CellSpec } from './helpers/xlsx.js';

/*
 * Chunk I, from the file to the store: the owner's confirmation stores the import with the reading next to it,
 * the same file reads back to the same conversations, and a spreadsheet's conversations prepare and run exactly
 * as the same conversations in JSON. The command line shows the proposal in counts and imports only on --yes.
 */

const talk = (...messages: string[]) => messages.join(' ` ');
const conversation = (i: number) => talk(`CLIENT Здравствуйте, вопрос ${i}`, 'AGENT Добрый день! Чем помочь?', `CLIENT Нужен возврат по заказу ${i}`, 'AGENT Оформил возврат');
const operatorTalk = (i: number) => talk(`CLIENT Позовите человека ${i}`, 'AGENT Перевожу на специалиста', 'OPERATOR Слушаю вас, специалист на связи');
const sheet = (count: number, text: (i: number) => string = conversation): CellSpec[][] =>
  [['Id диалога', 'Дата', 'Текст'], ...Array.from({ length: count }, (_, k): CellSpec[] => [`d${k + 1}`, '09.09.2026', text(k + 1)]), ['d99', '09.09.2026', 'без меток']];

async function folder(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-table-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function workbook(directory: string, name: string, rows: CellSpec[][]): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, xlsxFile([{ name: 'Данные', rows }]));
  return path;
}
async function withLab<T>(directory: string, work: (lab: ExperimentLab) => Promise<T>, runtime?: Runtime): Promise<T> {
  const lab = new ExperimentLab(directory, runtime);
  try { await lab.init(); return await work(lab); } finally { await lab.close(); }
}
const pause = () => new Promise(resolve => setTimeout(resolve, 5));

test('a confirmed table is stored with its reading, privately, and the same file reads back to the very same import', async t => {
  const root = await folder(t), data = join(root, 'data');
  const path = await workbook(root, 'logs.xlsx', sheet(10));
  const proposal = await proposeTableImport(path);
  assert.equal(proposal.status, 'ready');
  const { batch, reading } = await withLab(data, lab => confirmTableImport(lab.store, path, proposal));
  assert.deepEqual([batch.dialogues.length, batch.rejected.map(item => item.reasons[0])], [10, ['Текст не начинается с метки роли']]);
  const files = (await readdir(join(data, 'imports'))).sort();
  assert.deepEqual(files, [`${batch.id}.json`, `${batch.id}.mapping.json`]);
  for (const file of files) assert.equal((await stat(join(data, 'imports', file))).mode & 0o777, 0o600, file);
  const stored = importReadingsSchema.parse(JSON.parse(await readFile(join(data, 'imports', `${batch.id}.mapping.json`), 'utf8')));
  assert.deepEqual({ ...stored, readings: stored.readings.map(item => ({ ...item, confirmedAt: '' })) }, { formatVersion: 1, importId: batch.id, contentHash: batch.contentHash,
    readings: [{ ...reading, confirmedAt: '' }] });
  assert.deepEqual([reading.file.name, reading.file.format, reading.sheet], ['logs.xlsx', 'xlsx', { dialogues: 11, usable: 10, taken: 10, rejected: [{ reason: 'Текст не начинается с метки роли', count: 1 }] }]);

  // Confirming the same reading again records nothing new; reading the file back gives the same import.
  await withLab(data, lab => confirmTableImport(lab.store, path, proposal));
  assert.equal(importReadingsSchema.parse(JSON.parse(await readFile(join(data, 'imports', `${batch.id}.mapping.json`), 'utf8'))).readings.length, 1);
  assert.deepEqual([(await readConfirmedTable(path, data)).id, (await readConfirmedTable(path, data)).contentHash], [batch.id, batch.contentHash]);
  const imported = await readDialogueImport(path, { directory: data });
  assert.deepEqual([imported.originalImport.id, imported.dialogues.length, imported.dialogues[0]!.messages.length], [batch.id, 10, 4]);
  await assert.rejects(readDialogueImport(path), /Таблицу Lab читает только так, как вы подтвердили/);

  // The file changes: the old proposal no longer confirms it, and it has no confirmed reading.
  await workbook(root, 'logs.xlsx', sheet(11));
  await assert.rejects(withLab(data, lab => confirmTableImport(lab.store, path, proposal)), /изменился после того, как Lab показал разметку/);
  await assert.rejects(readConfirmedTable(path, data), /ещё не подтверждено/);
});

test('another reading of the same file is another import; the file then reads the way it was confirmed last', async t => {
  const root = await folder(t), data = join(root, 'data');
  const path = await workbook(root, 'operator.xlsx', sheet(6, i => i % 2 ? operatorTalk(i) : conversation(i)));
  const asked = await proposeTableImport(path);
  assert.equal(asked.status, 'question');
  await assert.rejects(withLab(data, lab => confirmTableImport(lab.store, path, asked)), /сначала ответьте на вопрос Lab/);
  const asSystem = await withLab(data, async lab => confirmTableImport(lab.store, path, await proposeTableImport(path, { markers: [{ token: 'OPERATOR', role: 'system' }] })));
  await pause();
  const asText = await withLab(data, async lab => confirmTableImport(lab.store, path, await proposeTableImport(path, { markers: [{ token: 'OPERATOR', role: 'text' }] })));
  assert.notEqual(asSystem.batch.id, asText.batch.id);
  assert.equal((await readConfirmedTable(path, data)).id, asText.batch.id);
  assert.deepEqual((await readConfirmedTable(path, data)).dialogues[0]!.events.map(event => event.role), ['user', 'assistant']);
});

test('limits: a table over the import size is refused before it is read; other spreadsheet formats get the way to a readable one', async t => {
  const root = await folder(t);
  const big = join(root, 'big.csv');
  await writeFile(big, `id,text\n${'1,CLIENT привет\n'.repeat(Math.ceil((IMPORT_FILE_BYTES + 1) / 17))}`);
  await assert.rejects(proposeTableImport(big), /Файл больше 4 МБ/);
  const old = join(root, 'logs.xls');
  await writeFile(old, 'old workbook');
  await assert.rejects(proposeTableImport(old), /Excel 97–2003 \(\.xls\) сохраните как \.xlsx или \.csv/);
});

test('from a spreadsheet to the number: the same conversations as in JSON prepare the same situations and give the same result', async t => {
  const root = await folder(t), data = join(root, 'data');
  // The two refund conversations of the card fixtures, written the way the owner's export writes them.
  const rows: CellSpec[][] = [['Id', 'Текст', 'Канал'], ...dialogues.map(item => [item.id, talk(...item.messages.map(message => `${message.role === 'user' ? 'CLIENT' : 'AGENT'} ${message.content}`)), 'chat'])];
  const path = await workbook(root, 'refunds.xlsx', rows);
  await withLab(data, async lab => {
    await confirmTableImport(lab.store, path, await proposeTableImport(path));
    const { originalImport, dialogues: projected } = await readDialogueImport(path, { directory: data });
    assert.deepEqual(projected, dialogues.map(item => ({ ...item, outcome: 'unknown' })), 'the conversations are the ones the JSON fixtures hold');
    const draft = await lab.create(cardInput({ originalImport, dialogues: projected }), { cards: true });
    await lab.waitForIdle();
    const { library, experiment } = await lab.readCards(draft.id);
    assert.equal(experiment.phase, 'review', experiment.error ?? '');
    assert.deepEqual(library.cards.map(card => [card.number, card.title, card.client.writes]), [
      [1, 'Возврат оплаты — номер по просьбе', 'Помогите с возвратом.'], [2, 'Возврат оплаты — номер назван сразу', 'Номер терминала: 1234. Помогите с возвратом.']]);
    const accepted = await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id));
    await lab.start(draft.id, { approved: true, expectedHash: draftHash(accepted.experiment), requireAccepted: true });
    await lab.waitForIdle();
    const view = buildResultView(await lab.get(draft.id));
    assert.deepEqual([view.headline.passed, view.headline.decided], [1, 2]);
  }, cardRuntime());
});

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
async function agentLab(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args]);
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  return { code, stdout, stderr };
}

test('agent-lab import shows the proposal in counts, answers questions through flags and imports only on --yes', { timeout: 60000 }, async t => {
  const root = await folder(t), data = join(root, 'data');
  const logs = await workbook(root, 'logs.xlsx', sheet(10));
  const shown = await agentLab(['import', '--file', logs, '--data-dir', data]);
  assert.equal(shown.code, 0, shown.stderr);
  const lines = shown.stdout.split('\n');
  for (const line of ['Таблица logs.xlsx · лист «Данные» · 11 строк', '  Один разговор — одна строка; id разговора — колонка «Id диалога».', '    CLIENT — клиент · 20 сообщений',
    '  11 разговоров: подходят 10, не подошли 1 (текст не начинается с метки роли — 1).', 'Загрузить: та же команда с --yes.']) assert.ok(lines.includes(line), `${line}\n---\n${shown.stdout}`);
  for (const words of ['Здравствуйте', 'возврат по заказу', 'без меток']) assert.ok(!shown.stdout.includes(words), `never a conversation's words: ${words}`);
  await assert.rejects(readdir(data), { code: 'ENOENT' }, 'nothing is written before --yes');

  const refused = await agentLab(['import', '--file', logs, '--data-dir', data, '--text-column', 'Дата']);
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /В колонке «Дата» нет разговоров: строки не начинаются с метки роли/);
  assert.match(refused.stdout, /Поправьте выбор и повторите команду\./);

  const json = await agentLab(['import', '--file', logs, '--data-dir', data, '--json']);
  assert.equal(JSON.parse(json.stdout).status, 'ready');

  const operator = await workbook(root, 'operator.xlsx', sheet(6, i => i % 2 ? operatorTalk(i) : conversation(i)));
  const asked = await agentLab(['import', '--file', operator, '--data-dir', data, '--yes']);
  assert.equal(asked.code, 1, 'a question is not a confirmation, even with --yes');
  assert.match(asked.stdout, /не знает, кто пишет сообщения с меткой OPERATOR в колонке «Текст» \(3 сообщения\)/);
  assert.match(asked.stdout, /Ответ: та же команда с --markers OPERATOR=клиент\|агент\|служебное\|текст\./);
  const wrongWord = await agentLab(['import', '--file', operator, '--data-dir', data, '--markers', 'OPERATOR=человек']);
  assert.equal(wrongWord.code, 1);
  assert.match(wrongWord.stderr, /--markers: ожидается МЕТКА=клиент\|агент\|служебное\|текст, через запятую\./);

  const imported = await agentLab(['import', '--file', operator, '--data-dir', data, '--markers', 'OPERATOR=служебное', '--yes']);
  assert.equal(imported.code, 0, imported.stderr);
  assert.match(imported.stdout, /Загружено: 6 разговоров\. Lab запомнил, как читать эту таблицу: тот же файл даст те же разговоры\./);
  const files = await readdir(join(data, 'imports'));
  assert.equal(files.filter(file => file.endsWith('.mapping.json')).length, 1);
  assert.deepEqual((await readConfirmedTable(operator, data)).dialogues.length, 6);
});

/** Conversations answered by one agent alone and by two: the export lists the agents in one cell, as written. */
const SINGLE = "['ACQUIRING_AGENT']", PAIR = "['ACQUIRING_AGENT', 'AGENT_GIGACHAT']";
const agents = (): CellSpec[][] => [['Id диалога', 'Текст', 'agentCode'], ...Array.from({ length: 12 }, (_, k): CellSpec[] => [`d${k + 1}`, conversation(k + 1), (k + 1) % 3 ? SINGLE : PAIR])];

test('the owner\'s choice of conversations is stored with the reading: the same file reads back to the same chosen conversations', async t => {
  const root = await folder(t), data = join(root, 'data');
  const path = await workbook(root, 'agents.xlsx', agents());
  const chosen = await proposeTableImport(path, { where: { column: 'agentCode', values: [SINGLE] } });
  const { batch, reading } = await withLab(data, lab => confirmTableImport(lab.store, path, chosen));
  assert.deepEqual(batch.dialogues.map(item => item.id), ['d1', 'd2', 'd4', 'd5', 'd7', 'd8', 'd10', 'd11']);
  assert.deepEqual([reading.mapping.filter, reading.sheet], [{ column: { index: 2, header: 'agentCode' }, values: [SINGLE] },
    { dialogues: 12, selected: 8, usable: 8, taken: 8, rejected: [] }]);
  const stored = importReadingsSchema.parse(JSON.parse(await readFile(join(data, 'imports', `${batch.id}.mapping.json`), 'utf8')));
  assert.deepEqual(stored.readings[0]!.mapping.filter, reading.mapping.filter);
  const again = await readConfirmedTable(path, data);
  assert.deepEqual([again.id, again.contentHash, again.dialogues.length], [batch.id, batch.contentHash, 8]);

  // Every conversation of the same file is another import; the file then reads the way it was confirmed last.
  await pause();
  const all = await withLab(data, async lab => confirmTableImport(lab.store, path, await proposeTableImport(path)));
  assert.notEqual(all.batch.id, batch.id);
  assert.deepEqual([all.reading.sheet.selected, (await readConfirmedTable(path, data)).dialogues.length], [undefined, 12]);
});

test('agent-lab import --where asks which values to keep, refuses a column that cannot choose, and imports only the chosen conversations', { timeout: 60000 }, async t => {
  const root = await folder(t), data = join(root, 'data');
  const logs = await workbook(root, 'agents.xlsx', agents());
  const offered = await agentLab(['import', '--file', logs, '--data-dir', data]);
  assert.ok(offered.stdout.includes('  Разговоры можно отобрать по колонке «agentCode».'), offered.stdout);
  assert.ok(offered.stdout.includes('Отобрать разговоры: --where "КОЛОНКА" покажет её значения, --where "КОЛОНКА=ЗНАЧЕНИЕ|ЗНАЧЕНИЕ" оставит только их.'), offered.stdout);

  const asked = await agentLab(['import', '--file', logs, '--data-dir', data, '--where', 'agentCode', '--yes']);
  assert.equal(asked.code, 1, 'a question is not a confirmation');
  const lines = asked.stdout.split('\n');
  for (const line of ['Какие разговоры оценивать? Lab видит 12 разговоров; в колонке «agentCode» у них 2 разных значения — выберите одно или несколько.',
    "  1. «['ACQUIRING_AGENT']» — 8 разговоров", "  2. «['ACQUIRING_AGENT', 'AGENT_GIGACHAT']» — 4 разговора",
    `Ответ: та же команда с --where "agentCode=${SINGLE}" — значение как написано в таблице; несколько — через |. Все разговоры — без --where.`]) assert.ok(lines.includes(line), `${line}\n---\n${asked.stdout}`);
  await assert.rejects(readdir(data), { code: 'ENOENT' }, 'nothing is written before a complete proposal is confirmed');

  const refused = await agentLab(['import', '--file', logs, '--data-dir', data, '--where', 'Текст=CLIENT']);
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /Колонка «Текст» уже выбрана как текст разговора\./);
  const blank = await agentLab(['import', '--file', logs, '--data-dir', data, '--where', '=x']);
  assert.equal(blank.code, 1);
  assert.match(blank.stderr, /--where: ожидается КОЛОНКА=ЗНАЧЕНИЕ, несколько значений — через \|; одна КОЛОНКА покажет её значения\./);

  const imported = await agentLab(['import', '--file', logs, '--data-dir', data, '--where', `agentCode=${PAIR}|${SINGLE}`, '--yes']);
  assert.equal(imported.code, 0, imported.stderr);
  assert.ok(imported.stdout.includes(`  Отбор: «agentCode» = «${SINGLE}» или «${PAIR}» — 12 из 12 разговоров.`), imported.stdout);
  const only = await agentLab(['import', '--file', logs, '--data-dir', data, '--where', `agentCode=${PAIR}`, '--yes']);
  assert.equal(only.code, 0, only.stderr);
  assert.ok(only.stdout.includes(`  Отбор: «agentCode» = «${PAIR}» — 4 из 12 разговоров.`), only.stdout);
  assert.match(only.stdout, /Загружено: 4 разговора\./);
  assert.deepEqual((await readConfirmedTable(logs, data)).dialogues.map(item => item.id), ['d3', 'd6', 'd9', 'd12']);
});
