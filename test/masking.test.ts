import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint } from '../src/contracts.js';
import { readDialogueImport, validationDialogueIssue } from '../src/imports.js';
import { hiddenMessage, holdsMark, maskedSpans, maskedThrough } from '../src/masking.js';
import { usableConversations } from '../src/miner/topic-map.js';
import { importBatch, MASKED_REASON } from '../src/scenario-library.js';
import { importTable } from '../src/spreadsheet/dialogues.js';
import { tableMappingSchema } from '../src/spreadsheet/mapping.js';
import { ExperimentStore } from '../src/store.js';

/*
 * One table of masking marks: every reading — the import's, the miner's, the values Lab fills in — follows it, and
 * words that only look like marks (a product, a number sign, a Roman numeral) are none. What was stored under the
 * first readings keeps them: a batch or a table's mapping without the table's version, and so the topic map of it.
 * Invented messages only.
 */

const WHOLE_MARKS = ['***', '###', '* * *', '[скрыто]', '[REDACTED]', '<ФИО>', '<PHONE>', 'хххх', 'XXXX XXXX', '*** # # ...'];
const conversation = (id: string, customer: string) => ({ id, messages: [{ role: 'user', content: 'Здравствуйте!' }, { role: 'assistant', content: 'Слушаю вас.' }, { role: 'user', content: customer }] });
const only = (id: string, customer: string) => ({ id, messages: [{ role: 'user', content: customer }, { role: 'assistant', content: 'Уточните, пожалуйста.' }] });

test('every reading takes the same marks for a message hidden entirely: the import refuses it, the miner leaves it out', () => {
  for (const content of WHOLE_MARKS) {
    assert.equal(maskedThrough(content), true, content);
    assert.equal(validationDialogueIssue({ messages: [{ role: 'user', content }] })?.kind, 'masked', content);
    assert.deepEqual(importBatch([only('hidden', content)]).rejected[0]?.reasons, [MASKED_REASON], content);
  }
  for (const content of ['x', 'Терминал **** не работает', 'Номер xxxx 1234 не проходит']) {
    assert.equal(maskedThrough(content), false, content);
    assert.equal(validationDialogueIssue({ messages: [{ role: 'user', content }] }), undefined, content);
  }
});

test('a product, a number sign and a Roman numeral are no marks; the marks around them still are', () => {
  for (const content of ['5 * 3 = 15', 'Заказ # 123', 'Заказ #123', 'в XXX веке', 'в ХХХ веке', '№#12', '*важно*']) assert.deepEqual(maskedSpans(content), [], content);
  assert.deepEqual(maskedSpans('Заказ # 123 на * рублей, номер +7 XXX XXX-XX-XX').map(span => span.mark), ['*', 'XXX', 'XXX']);
  assert.deepEqual(maskedSpans('Номер карты XXX XXX XXX').map(span => span.mark), ['XXX', 'XXX', 'XXX'], 'marks next to marks are no Roman numerals');
  assert.deepEqual(maskedSpans('с утра было # покупки, на * и *').map(span => span.mark), ['#', '*', '*']);
});

test('a value is checked against the same table: «xxx», «ХХХ» and a mark character are no values', () => {
  for (const value of ['xxx', 'ХХХ', '***', '<ФИО>', '5*3', '[скрыто]']) assert.equal(holdsMark(value), true, value);
  for (const value of ['Ирина', '1 500 ₽', '12.03', 'XXL', 'XX век']) assert.equal(holdsMark(value), false, value);
});

test('what was stored under the first readings keeps them: the batch, and so the conversations its topic map sorted', () => {
  const logged = [conversation('named', '<ФИО>'), conversation('hashed', '###'), conversation('plain', 'Верните деньги за заказ')];
  const first = importBatch(logged, new Map(), 1);
  assert.equal(first.maskVersion, undefined);
  assert.deepEqual(usableConversations(first).dialogueIds, ['named', 'plain'], 'the first reading left out «###» but not «<ФИО>»: a stored map sorted these two');
  const table = importBatch(logged);
  assert.equal(table.maskVersion, 2, 'the table reads these messages otherwise: the batch says so');
  assert.deepEqual([table.id, table.contentHash], [first.id, first.contentHash], 'the same rows, the same import id');
  assert.deepEqual(usableConversations(table).dialogueIds, ['plain']);
  assert.deepEqual(usableConversations(table).excluded.map(item => [item.dialogueId, item.kind]), [['named', 'masked'], ['hashed', 'masked']]);

  const alike = [conversation('a', 'Верните деньги'), conversation('b', '***')];
  const { createdAt: _a, ...read } = importBatch(alike), { createdAt: _b, ...stored } = importBatch(alike, new Map(), 1);
  assert.equal(fingerprint(read), fingerprint(stored), 'where both readings agree, the batch is the very one the first readings made');
});

test('the import the data folder keeps for the same conversations stays their import', async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lab-masks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logged = [conversation('named', '<ФИО>'), conversation('plain', 'Верните деньги за заказ')];
  const store = new ExperimentStore(join(root, 'data'));
  await store.init();
  try { await store.writeImport(importBatch(logged, new Map(), 1)); } finally { await store.close(); }
  await writeFile(join(root, 'logs.json'), JSON.stringify(logged));
  const { originalImport } = await readDialogueImport(join(root, 'logs.json'), { directory: join(root, 'data') });
  assert.equal(originalImport.maskVersion, undefined, 'the stored import, not a new reading of it');
  assert.deepEqual(usableConversations(originalImport).dialogueIds, ['named', 'plain']);
  assert.equal((await readDialogueImport(join(root, 'logs.json'))).originalImport.maskVersion, 2, 'a folder that keeps none reads by the table');
});

test('a table\'s mapping confirmed before the table keeps reading its import the first way', () => {
  const sheet = { name: 'Логи', rows: [['id', 'Текст'], ['c1', 'CLIENT ### AGENT Назовите номер'], ['c2', 'CLIENT Верните деньги AGENT Проверю']] };
  const mapping = { version: 1, source: { format: 'xlsx', sheet: 'Логи' }, headerRow: 1, id: { index: 0, header: 'id' }, text: { index: 1, header: 'Текст' },
    layout: { kind: 'dialogue_per_row', markers: [{ token: 'CLIENT', role: 'user' }, { token: 'AGENT', role: 'assistant' }] } };
  const stored = importTable(sheet, tableMappingSchema.parse(mapping));
  assert.deepEqual([stored.preview.usable, stored.batch.maskVersion], [2, undefined], 'the first reading kept «###»');
  const current = importTable(sheet, tableMappingSchema.parse({ ...mapping, maskVersion: 2 }));
  assert.deepEqual([current.preview.usable, current.preview.rejected], [1, [{ reason: MASKED_REASON, count: 1 }]]);
  assert.equal(current.batch.id, stored.batch.id, 'the same rows');
});

test('the miner reads a stored batch by its own table', () => {
  assert.equal(hiddenMessage('<ФИО>', 1), false);
  assert.equal(hiddenMessage('<ФИО>'), true);
  assert.equal(validationDialogueIssue({ messages: [{ role: 'user', content: '<ФИО>' }] }, 1), undefined);
});
