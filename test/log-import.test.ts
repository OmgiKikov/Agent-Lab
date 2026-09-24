import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInputSchema } from '../src/contracts.js';
import { detectionLines, detectProject } from '../src/detect.js';
import { parseImportText, readDialogueImport } from '../src/imports.js';
import { IMPORT_FILE_BYTES, LOG_CONVERSATIONS } from '../src/limits.js';
import { consentText, preparationConsent } from '../src/miner/plan.js';
import { logImport } from '../src/scenario-library.js';

/*
 * A log of JSON or JSON Lines as the owner has it: longer than one import, with a byte order mark, with a broken
 * line, in another encoding. A longer log gives the same sample every time — by a hash of what each conversation
 * is, never by where it stands or how it ended — and the owner sees it in the detector and in the consent; a broken
 * file is named with its line and character, in Russian. Invented conversations only.
 */

const conversation = (i: number, outcome = 'success', say = 'Здравствуйте, верните деньги за заказ') =>
  ({ id: `d${i}`, outcome, messages: [{ role: 'user', content: `${say} ${i}` }, { role: 'assistant', content: `Проверю заказ ${i}.` }] });
const rows = (count: number, make = (i: number) => conversation(i)) => Array.from({ length: count }, (_, i) => make(i + 1));
const jsonl = (items: readonly unknown[]) => items.map(item => JSON.stringify(item)).join('\n') + '\n';

async function folder(t: TestContext, files: Record<string, string | Buffer> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-lab-log-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), content);
  }
  return root;
}
const ids = (batch: { dialogues: { id: string }[] }) => batch.dialogues.map(item => item.id);

test('a log longer than one import gives the same sample of 300 by content hash, blind to where a conversation stands and how it ended', async t => {
  const root = await folder(t, { 'chats.jsonl': jsonl(rows(450)), 'chats.json': JSON.stringify(rows(450)) });
  const { originalImport: batch } = await readDialogueImport(join(root, 'chats.jsonl'));
  assert.equal(batch.dialogues.length, 300);
  assert.deepEqual(batch.sample, { dialogues: 450, usable: 450 });
  assert.equal((await readDialogueImport(join(root, 'chats.jsonl'))).originalImport.id, batch.id, 'the same file gives the same import');
  assert.equal((await readDialogueImport(join(root, 'chats.json'))).originalImport.id, batch.id, 'the same conversations as JSON give the same import');
  const numbers = ids(batch).map(id => Number(id.slice(1)));
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), 'the sample keeps the order of the log');
  assert.ok(numbers.some(n => n > 300) && numbers.some(n => n <= 150), 'not the head of the file: the sample is spread over the whole log');

  const reversed = logImport([...rows(450)].reverse()).batch;
  assert.deepEqual(new Set(ids(reversed)), new Set(ids(batch)), 'where a conversation stands does not choose it');
  const outcomes = logImport(rows(450, i => conversation(i, i % 3 ? 'failure' : 'success'))).batch;
  assert.deepEqual(ids(outcomes), ids(batch), 'how a conversation ended does not choose it');
});

test('a conversation id is taken once in the whole log, and the refused rows are counted, not sampled', () => {
  const log = [...rows(450), { ...conversation(7), messages: [{ role: 'user', content: 'Другой разговор с тем же id' }] }, { id: 'broken id!', messages: [] }];
  const { batch, verdicts } = logImport(log);
  assert.deepEqual(batch.sample, { dialogues: 452, usable: 450 });
  assert.deepEqual(verdicts[450], ['Повторяющийся id диалога']);
  assert.equal(new Set(ids(batch)).size, 300);
  assert.equal(batch.rejected.length, 0, 'the import holds the usable sample');
});

test('the detector and the consent say how a long log is taken', async t => {
  const root = await folder(t, { 'logs/chats.jsonl': jsonl(rows(450)) });
  const lines = detectionLines(await detectProject(root));
  assert.ok(lines.includes('  logs/chats.jsonl — 450 разговоров; в одну загрузку входит 300: Lab возьмёт 300 из 450 подходящих — по хешу содержимого, без отбора по исходу'), lines.join('\n'));

  const { originalImport } = await readDialogueImport(join(root, 'logs/chats.jsonl'));
  const input = createInputSchema.parse({ task: 'Проверить поддержку', mode: 'live', target: { kind: 'unconnected' }, scenarioCount: 0,
    materials: [{ name: 'Правила', content: 'Отвечать клиенту по существу вопроса.' }], originalImport, settings: { provider: 'fixture', model: 'builder' } });
  const consent = await preparationConsent({ readTopicMap: async () => undefined }, { input, situations: 15 });
  assert.deepEqual(consent.sample, { dialogues: 450, usable: 450 });
  assert.equal(consentText(consent, 'chats.jsonl').lines[0], 'В логах 450 разговоров, в одну загрузку входит 300: Lab возьмёт 300 из 450 подходящих — по хешу содержимого, без отбора по исходу.'
    + ' Из них подходят 300. Ситуаций будет не больше 15 — по одной на разговор, из всех тем логов.');
});

test('JSON Lines of any size up to the cap is read in a stream; a JSON document over 4 MB says to save it as JSON Lines', async t => {
  const long = (i: number) => conversation(i, 'success', `${'Длинный вопрос о возврате денег за заказ. '.repeat(130)}`);
  const text = jsonl(rows(450, long));
  assert.ok(Buffer.byteLength(text) > IMPORT_FILE_BYTES, `${Buffer.byteLength(text)}`);
  const root = await folder(t, { 'big.jsonl': text, 'big.json': JSON.stringify(rows(450, long)) });
  const { originalImport } = await readDialogueImport(join(root, 'big.jsonl'));
  assert.deepEqual([originalImport.dialogues.length, originalImport.sample], [300, { dialogues: 450, usable: 450 }]);
  assert.equal(originalImport.id, logImport(rows(450, long)).batch.id, 'read in a stream, the same import as read whole');
  await assert.rejects(readDialogueImport(join(root, 'big.json')), /Файл логов больше 4 МБ: документ JSON Lab читает только целиком\. Сохраните логи в JSON Lines \(\.jsonl\) — по одному разговору в строке/);
  const lines = detectionLines(await detectProject(root));
  assert.ok(lines.some(line => line.startsWith('  big.jsonl — в начале файла ') && line.endsWith('дальше Lab не смотрел: файл больше 4 МБ, целиком его Lab прочитает при загрузке')), lines.join('\n'));
});

test('an archive of more conversations than a log holds is refused with what to do', async t => {
  const root = await folder(t, { 'archive.jsonl': '{}\n'.repeat(LOG_CONVERSATIONS + 1) });
  await assert.rejects(readDialogueImport(join(root, 'archive.jsonl')), {
    message: `В файле логов больше ${LOG_CONVERSATIONS.toLocaleString('ru-RU')} разговоров — это архив, а не логи одного периода. Выгрузите из системы период поменьше.` });
});

test('a byte order mark is not part of a log: JSON, JSON Lines and the detector read past it', async t => {
  const root = await folder(t, { 'logs/bom.json': `﻿${JSON.stringify(rows(2))}`, 'logs/bom.jsonl': `﻿${jsonl(rows(3))}` });
  assert.deepEqual(ids((await readDialogueImport(join(root, 'logs/bom.json'))).originalImport), ['d1', 'd2']);
  assert.deepEqual(ids((await readDialogueImport(join(root, 'logs/bom.jsonl'))).originalImport), ['d1', 'd2', 'd3']);
  const lines = detectionLines(await detectProject(root));
  assert.ok(lines.includes('  logs/bom.jsonl — 3 разговора') && lines.includes('  logs/bom.json — 2 разговора'), lines.join('\n'));
});

test('a broken line is named as the owner counts lines: every line break, the empty ones too', async t => {
  const text = `${JSON.stringify(conversation(1))}\n\n   \n{"id": "d4", "messages": [}\n`;
  assert.throws(() => parseImportText(text, true), /в строке 4 \(знак 27\) неожиданно стоит «\}»\. В файле \.jsonl каждая непустая строка — один разговор в JSON\./);
  const root = await folder(t, { 'broken.jsonl': `﻿${text}`, 'crlf.jsonl': text.replaceAll('\n', '\r\n') });
  await assert.rejects(readDialogueImport(join(root, 'broken.jsonl')), /в строке 4 \(знак 27\)/);
  await assert.rejects(readDialogueImport(join(root, 'crlf.jsonl')), /в строке 4 \(знак 27\)/);
});

test('a broken JSON document is named in Russian with its line and character, not in the parser\'s English', async t => {
  const text = '{\n  "dialogues": [\n    {"id": "a" "messages": []}\n  ]\n}\n';
  assert.throws(() => parseImportText(text, false), (error: Error) => {
    assert.equal(error.message, 'Файл логов не читается как JSON: в строке 3 (знак 16) неожиданно стоит «"». Проверьте там запятые, кавычки и скобки.');
    return true;
  });
  assert.throws(() => parseImportText('[{"id": "a"', false), /в строке 1 \(знак 12\) текст обрывается/);
  assert.throws(() => parseImportText('﻿  \n', false), /Файл логов пуст/);
  const cp1251 = Buffer.from([0x5b, 0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x22, 0x61, 0x22, 0x2c, 0x22, 0xf2, 0xe5, 0xea, 0xf1, 0xf2, 0x22, 0x3a, 0x31, 0x7d, 0x5d]);
  const root = await folder(t, { 'win.json': cp1251, 'win.jsonl': cp1251 });
  await assert.rejects(readDialogueImport(join(root, 'win.json')), /Файл логов не в кодировке UTF-8: сохраните его в UTF-8/);
  await assert.rejects(readDialogueImport(join(root, 'win.jsonl')), /Файл логов не в кодировке UTF-8/);
});
