import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { questionAnswers } from '../src/spreadsheet/answers.js';
import { importTable } from '../src/spreadsheet/dialogues.js';
import { readConfirmedTable } from '../src/spreadsheet/import.js';
import { proposalLines, questionText } from '../src/spreadsheet/lines.js';
import { importReadingsSchema, type TableChoices } from '../src/spreadsheet/mapping.js';
import { splitMessages } from '../src/spreadsheet/markers.js';
import { proposeTable, type TableProposal } from '../src/spreadsheet/proposal.js';
import { withoutRepeats } from '../src/spreadsheet/repeats.js';
import { readWorkbook, tableFileOf } from '../src/spreadsheet/workbook.js';
import { xlsxFile, type CellSpec } from './helpers/xlsx.js';

/*
 * Chunk I2: the owner's real export, as measured with its texts masked. Messages are joined by spaces with no
 * separator, each led by a whole-word CLIENT or AGENT; agents answer with Markdown code fences, so backticks
 * stand inside messages; and the export copies exchanges — the same pair two to six times in a row, or the
 * last exchange twice. Every sheet here is synthetic.
 */

/** The owner's shape: one conversation per row, its messages joined by spaces. */
const spoken = (...messages: string[]) => messages.join(' ');
const idOf = (i: number) => `c${String(i).padStart(4, '0')}-4c70-bf14`;
const FENCE = 'Проверьте настройки терминала:\n```json\n{"terminal": "T-100", "mode": "sbp"}\n```';

/** A conversation of the export; a fifth end an agent's code fence right before the client's next message, some name abbreviations or ACQUIRING_AGENT. */
function plain(i: number): string {
  if (i % 5 === 0) return spoken(`CLIENT Не проходит оплата по QR ${i}`, `AGENT ${FENCE}`, 'CLIENT Сделал, теперь работает', 'AGENT Отлично! Обращайтесь.');
  if (i % 4 === 0) return spoken(`CLIENT Где моя заявка ${i}?`, 'AGENT Заявку ведёт ACQUIRING_AGENT, срок — 2 дня', 'CLIENT Спасибо', 'AGENT Пожалуйста');
  const client = i % 3 === 0 ? `CLIENT Я ИП, пришло SMS с кодом ${i}` : `CLIENT Здравствуйте, вопрос ${i}`;
  return spoken(client, 'AGENT Добрый день! Чем помочь?', `CLIENT Нужен возврат по заказу ${i}`, 'AGENT Оформил возврат, деньги придут за 5 дней');
}
/** The export's copies: an exchange written four times, then the rest. */
const pairTimesFour = (i: number) => spoken(...Array.from({ length: 4 }, () => ['CLIENT Здравствуйте', 'AGENT Добрый день! Чем помочь?']).flat(), `CLIENT Нужен возврат по заказу ${i}`, 'AGENT Оформил возврат');
/** The export's copies: the last exchange twice. */
const lastTwice = (i: number) => spoken(`CLIENT Подключите СБП ${i}`, 'AGENT Подключил, проверьте', 'CLIENT Проверил, работает', 'AGENT Рад помочь', 'CLIENT Проверил, работает', 'AGENT Рад помочь');
/** A client who really says «Алло» twice: the agent answers differently, so it is no copied block. */
const saidTwice = spoken('CLIENT Алло', 'AGENT Слушаю вас', 'CLIENT Алло', 'AGENT Вас плохо слышно, напишите вопрос');

function sheetOf(count: number, text: (i: number) => string): CellSpec[][] {
  return [['Id диалога', 'Дата', 'Текст', 'agentCode'], ...Array.from({ length: count }, (_, k): CellSpec[] => [idOf(k + 1), '09.09.2026', text(k + 1), "['ACQUIRING_AGENT']"])];
}
/** 40 conversations, 14 of them with copies: 7 exchanges written four times, 7 last exchanges twice; conversation 3 is the real «Алло» twice. */
const withCopies = (i: number) => i % 6 === 1 ? pairTimesFour(i) : i % 6 === 2 ? lastTwice(i) : i === 3 ? saidTwice : plain(i);

function propose(rows: CellSpec[][], choices: TableChoices = {}): TableProposal {
  const bytes = xlsxFile([{ name: 'Данные', rows }]), file = tableFileOf('export.xlsx', bytes);
  return proposeTable(readWorkbook(bytes, file), file, choices);
}
function ready(proposal: TableProposal): Extract<TableProposal, { status: 'ready' }> {
  assert.equal(proposal.status, 'ready', JSON.stringify(proposal.status === 'refused' ? proposal.reason : proposal.status === 'question' ? proposal.question : ''));
  return proposal as Extract<TableProposal, { status: 'ready' }>;
}
const refusal = (proposal: TableProposal) => proposal.status === 'refused' ? [proposal.choice, proposal.reason] : [proposal.status];
function read(rows: CellSpec[][], choices: TableChoices = {}) {
  const proposal = ready(propose(rows, choices));
  const bytes = xlsxFile([{ name: 'Данные', rows }]);
  return { proposal, ...importTable(readWorkbook(bytes, tableFileOf('export.xlsx', bytes)).sheets[0]!, proposal.mapping) };
}
const messagesOf = (batch: ReturnType<typeof read>['batch'], id: string) => batch.dialogues.find(item => item.id === id)?.events.map(event => [event.role, event.content]);

test('no separator: a message starts at every whole-word marker; backticks of code fences and the AGENT of ACQUIRING_AGENT start nothing', () => {
  const rows = sheetOf(40, plain);
  const { proposal, batch, preview } = read(rows);
  assert.deepEqual(proposal.mapping.layout, { kind: 'dialogue_per_row', markers: [{ token: 'AGENT', role: 'assistant' }, { token: 'CLIENT', role: 'user' }] }, 'no separator is stored');
  assert.deepEqual([preview.dialogues, preview.usable, preview.messages], [40, 40, [{ label: 'AGENT', role: 'assistant', count: 80 }, { label: 'CLIENT', role: 'user', count: 80 }]]);
  assert.deepEqual(messagesOf(batch, idOf(5)), [['user', 'Не проходит оплата по QR 5'], ['assistant', FENCE], ['user', 'Сделал, теперь работает'], ['assistant', 'Отлично! Обращайтесь.']]);
  assert.deepEqual(messagesOf(batch, idOf(4))?.[1], ['assistant', 'Заявку ведёт ACQUIRING_AGENT, срок — 2 дня']);
  assert.deepEqual(messagesOf(batch, idOf(3))?.[0], ['user', 'Я ИП, пришло SMS с кодом 3'], 'an abbreviation in a third of the conversations is a word, not a marker');
  const lines = proposalLines(proposal);
  assert.ok(lines.includes('  Текст — колонка «Текст»: сообщения ничем не отделены — новое начинается с каждой метки:'), lines.join('\n'));
  assert.ok(lines.includes('    AGENT — агент · 80 сообщений') && lines.includes('    CLIENT — клиент · 80 сообщений'), 'the preview counts messages per role');

  // The owner may still say how the export reads: the backtick as a separator finds no agent at all, and saying there is none reads the same as Lab's proposal.
  assert.deepEqual(refusal(propose(rows, { separator: '`' })), ['markers', 'Не видно сообщений агента: укажите, какой меткой они отмечены.']);
  assert.deepEqual(ready(propose(rows, { separator: null })).mapping, proposal.mapping);
});

test('a marker follows a space or opens the text; inside a word, after a bracket or as part of a longer word it is text', () => {
  assert.deepEqual(splitMessages('  CLIENT: Мне нужен ACQUIRING_AGENT AGENT Слушаю вас (AGENT) AGENTS тоже\nCLIENT Спасибо', undefined, ['CLIENT', 'AGENT']), [
    { marker: 'CLIENT', content: 'Мне нужен ACQUIRING_AGENT' },
    { marker: 'AGENT', content: 'Слушаю вас (AGENT) AGENTS тоже' },
    { marker: 'CLIENT', content: 'Спасибо' },
  ]);
  assert.equal(splitMessages('Здравствуйте AGENT привет', undefined, ['CLIENT', 'AGENT']), undefined, 'a text that does not start with a marker is not split by guess');
});

test('a real separator still wins when agents write code fences: it stands before every marker, the backticks of a fence before a few', () => {
  const separated = (i: number) => [`CLIENT Не проходит оплата ${i}`, `AGENT ${FENCE}`, 'CLIENT Сделал', 'AGENT Отлично'].join(' ` ');
  const { proposal, batch } = read(sheetOf(12, separated));
  assert.equal(proposal.mapping.layout.kind === 'dialogue_per_row' && proposal.mapping.layout.separator, '`');
  assert.deepEqual(messagesOf(batch, idOf(2)), [['user', 'Не проходит оплата 2'], ['assistant', FENCE], ['user', 'Сделал'], ['assistant', 'Отлично']]);
});

test('copied blocks: an exchange four times or the last one twice is read once; a message said again with another reply is kept', () => {
  const said = (role: string, content: string) => ({ role, content });
  const [hello, reply, refund, done] = [said('user', 'Здравствуйте'), said('assistant', 'Чем помочь?'), said('user', 'Нужен возврат'), said('assistant', 'Оформил')];
  assert.deepEqual(withoutRepeats([hello, reply, hello, reply, hello, reply, hello, reply, refund, done]), [hello, reply, refund, done]);
  assert.deepEqual(withoutRepeats([hello, reply, refund, done, refund, done]), [hello, reply, refund, done]);
  const [again, other] = [said('user', 'Алло'), said('assistant', 'Слушаю вас')];
  const differently = [again, other, again, said('assistant', 'Вас плохо слышно')];
  assert.deepEqual(withoutRepeats(differently), differently, 'a genuine repeat of the client is no copied block');
  assert.deepEqual(withoutRepeats([hello, reply, refund, hello, reply, refund]), [hello, reply, refund], 'a block of three');
  assert.deepEqual(withoutRepeats([said('user', 'Да'), said('assistant', 'Да')]), [said('user', 'Да'), said('assistant', 'Да')], 'the same words by the other side are no copy');
  assert.deepEqual(withoutRepeats([again, again, other]), [again, other], 'a block of one message');
});

test('frequent copies are one question; only the owner\'s answer drops them, and the preview says how many went', () => {
  const rows = sheetOf(40, withCopies);
  const asked = propose(rows);
  assert.ok(asked.status === 'question' && asked.question.kind === 'repeats', asked.status);
  assert.deepEqual([asked.question, asked.found], [{ kind: 'repeats', dialogues: 14, of: 40, messages: 56 }, 40]);
  assert.equal(questionText(asked.question, asked.found), 'В 14 из 40 разговоров один и тот же обмен повторяется подряд — убрать повторы? Копий — 56 сообщений; каждый обмен останется один раз.');
  const answers = questionAnswers(asked.question);
  assert.deepEqual(answers, [{ label: 'убрать повторы — каждый обмен один раз', choices: { collapseRepeats: true } }, { label: 'оставить как написано', choices: { collapseRepeats: false } }]);

  const collapsed = read(rows, answers[0]!.choices);
  assert.equal(collapsed.proposal.mapping.collapseRepeats, true, 'the choice is stored in the mapping');
  assert.deepEqual(collapsed.preview.repeats, { dialogues: 14, messages: 56 });
  assert.ok(proposalLines(collapsed.proposal).includes('  Повторы убраны: 56 сообщений в 14 разговорах — каждый обмен остался один раз.'));
  assert.deepEqual(messagesOf(collapsed.batch, idOf(1)), [['user', 'Здравствуйте'], ['assistant', 'Добрый день! Чем помочь?'], ['user', 'Нужен возврат по заказу 1'], ['assistant', 'Оформил возврат']]);
  assert.deepEqual(messagesOf(collapsed.batch, idOf(2)), [['user', 'Подключите СБП 2'], ['assistant', 'Подключил, проверьте'], ['user', 'Проверил, работает'], ['assistant', 'Рад помочь']]);
  assert.equal(messagesOf(collapsed.batch, idOf(3))?.length, 4, 'the client\'s real «Алло» twice stays');
  // The row says the sheet held more, so the evidence explains the difference.
  assert.deepEqual([(collapsed.batch.dialogues[0]!.original as { droppedRepeats?: number }).droppedRepeats, (collapsed.batch.dialogues[2]!.original as { droppedRepeats?: number }).droppedRepeats], [6, undefined]);

  const kept = read(rows, answers[1]!.choices);
  assert.equal(kept.proposal.mapping.collapseRepeats, undefined, 'nothing is dropped without the owner\'s yes');
  assert.equal(messagesOf(kept.batch, idOf(1))?.length, 10);
  assert.ok(proposalLines(kept.proposal).includes('  В 14 разговорах обмен повторяется подряд (копий — 56 сообщений); Lab читает их как написано.'));
  assert.notEqual(kept.batch.id, collapsed.batch.id);
  // The same file and the same answer read the very same conversations.
  assert.deepEqual([read(rows, { collapseRepeats: true }).batch.contentHash, read(rows, { collapseRepeats: true }).batch.id], [collapsed.batch.contentHash, collapsed.batch.id]);
});

test('rare copies are not asked: the sheet is read as written, and the owner may still drop them', () => {
  const rows = sheetOf(40, i => i === 7 ? pairTimesFour(i) : plain(i));
  const proposal = ready(propose(rows));
  assert.deepEqual([proposal.mapping.collapseRepeats, proposal.preview.repeats], [undefined, { dialogues: 1, messages: 6 }]);
  assert.ok(proposalLines(proposal).includes('  В 1 разговоре обмен повторяется подряд (копий — 6 сообщений); Lab читает их как написано.'));
  assert.equal(ready(propose(rows, { collapseRepeats: true })).preview.messages.find(item => item.label === 'CLIENT')?.count, 80);
  assert.equal(ready(propose(sheetOf(40, plain))).preview.repeats, undefined, 'no copies, no line');
});

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
async function agentLab(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args]);
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  return { code, stdout, stderr };
}
async function folder(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('agent-lab import asks about copies, --collapse-repeats answers, and the stored reading reads back the same conversations', { timeout: 60000 }, async t => {
  const root = await folder(t), data = join(root, 'data'), logs = join(root, 'export.xlsx');
  await writeFile(logs, xlsxFile([{ name: 'Данные', rows: sheetOf(40, withCopies) }]));
  const asked = await agentLab(['import', '--file', logs, '--data-dir', data, '--yes']);
  assert.equal(asked.code, 1, 'a question is not a confirmation, even with --yes');
  for (const line of ['В 14 из 40 разговоров один и тот же обмен повторяется подряд — убрать повторы? Копий — 56 сообщений; каждый обмен останется один раз.',
    'Ответ: та же команда с --collapse-repeats — убрать повторы, или с --keep-repeats — оставить как написано.']) assert.ok(asked.stdout.split('\n').includes(line), `${line}\n---\n${asked.stdout}`);
  const both = await agentLab(['import', '--file', logs, '--data-dir', data, '--collapse-repeats', '--keep-repeats']);
  assert.equal(both.code, 1);
  assert.match(both.stderr, /Выберите одно: --collapse-repeats или --keep-repeats\./);

  const imported = await agentLab(['import', '--file', logs, '--data-dir', data, '--collapse-repeats', '--yes']);
  assert.equal(imported.code, 0, imported.stderr);
  for (const line of ['  Текст — колонка «Текст»: сообщения ничем не отделены — новое начинается с каждой метки:', '  Повторы убраны: 56 сообщений в 14 разговорах — каждый обмен остался один раз.',
    'Загружено: 40 разговоров. Lab запомнил, как читать эту таблицу: тот же файл даст те же разговоры.']) assert.ok(imported.stdout.split('\n').includes(line), `${line}\n---\n${imported.stdout}`);
  const batch = await readConfirmedTable(logs, data);
  assert.deepEqual(batch.dialogues.find(item => item.id === idOf(1))?.events.length, 4);
  const stored = importReadingsSchema.parse(JSON.parse(await readFile(join(data, 'imports', `${batch.id}.mapping.json`), 'utf8'))).readings[0]!;
  assert.deepEqual([stored.mapping.collapseRepeats, stored.mapping.layout, stored.sheet.repeats], [true,
    { kind: 'dialogue_per_row', markers: [{ token: 'AGENT', role: 'assistant' }, { token: 'CLIENT', role: 'user' }] }, { dialogues: 14, messages: 56 }]);
});
