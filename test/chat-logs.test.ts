import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { TOOL } from '../extensions/steps.ts';
import { ExperimentLab } from '../src/experiment.js';
import { questionAnswers, withAnswer } from '../src/spreadsheet/answers.js';
import { proposeTableImport } from '../src/spreadsheet/import.js';
import { proposalLines, whereChoices } from '../src/spreadsheet/lines.js';
import { ExperimentStore } from '../src/store.js';
import { cardRuntime, dialogues, policy } from './helpers/card-prep.js';
import { output, registered } from './helpers/pi-session.js';
import { xlsxFile, type CellSpec } from './helpers/xlsx.js';

/*
 * Logs and the owner's rules become situations in the chat (chunk T): Lab finds what the request did not name, asks
 * natively only what it cannot settle — which log file of several, how to read a spreadsheet — and every paid
 * preparation passes one consent with its ceiling. The model never passes a setting or a consent. Invented data only.
 */

async function folder(t: TestContext): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-chat-logs-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}
/** The chat with the deterministic card runtime; `picks` answer the native dialogs in order, recorded in `asked`. */
function chat(t: TestContext, cwd: string, picks: (string | undefined)[]) {
  const session = registered(undefined, { createLab: directory => new ExperimentLab(directory, cardRuntime()) });
  t.after(session.shutdown);
  const asked: { title: string; options: string[] }[] = [];
  const ctx = { cwd, mode: 'tui', hasUI: true, model: { provider: 'fixture', id: 'fixture-model' },
    ui: { select: async (title: string, options: string[]) => { asked.push({ title, options }); return picks.shift(); }, editor: async () => undefined, notify() {}, setStatus() {}, setWidget() {} } } as unknown as ExtensionContext;
  const prepare = async (params: Record<string, unknown>) => output(await (session.tools.get(TOOL.prepare) as ToolDefinition).execute('prepare', params, undefined, undefined, ctx));
  return { prepare, asked, store: new ExperimentStore(join(cwd, '.agent-lab')) };
}
const talk = (...messages: string[]) => messages.join(' ` ');
/** The two refund conversations of the card fixtures, the way the owner's export writes them: one row each. */
const refundRows: CellSpec[][] = [['Id диалога', 'Текст'], ...dialogues.map((item): CellSpec[] => [item.id, talk(...item.messages.map(message => `${message.role === 'user' ? 'CLIENT' : 'AGENT'} ${message.content}`))])];
/** The same export where an operator joins three conversations: a marker Lab does not know. */
const operatorRows: CellSpec[][] = [...refundRows, ...[1, 2, 3].map((i): CellSpec[] => [`op${i}`, talk(`CLIENT Позовите человека ${i}`, 'AGENT Перевожу на специалиста', 'OPERATOR Слушаю вас')])];
const request = { task: 'Проверить возвраты', rules: policy };

test('the table question is numbered answers the owner picks; each answer adds its choice to the reading', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-answers-'));
  try {
    await writeFile(join(cwd, 'logs.xlsx'), xlsxFile([{ name: 'Данные', rows: operatorRows }]));
    const asked = await proposeTableImport(join(cwd, 'logs.xlsx'));
    assert.equal(asked.status, 'question');
    const answers = asked.status === 'question' ? questionAnswers(asked.question) : [];
    assert.deepEqual(answers.map(answer => answer.label), ['клиент', 'агент', 'служебное', 'не метка — слово в тексте сообщения']);
    assert.deepEqual(answers[2]!.choices, { markers: [{ token: 'OPERATOR', role: 'system' }] });
    // Decisions add up; a later answer about the same marker replaces the earlier one; a column is replaced.
    const both = withAnswer(withAnswer({ id: 'A', markers: [{ token: 'BOT', role: 'assistant' }] }, answers[2]!.choices), { markers: [{ token: 'OPERATOR', role: 'text' }], id: 'B' });
    assert.deepEqual(both, { id: 'B', markers: [{ token: 'BOT', role: 'assistant' }, { token: 'OPERATOR', role: 'text' }] });
    assert.equal((await proposeTableImport(join(cwd, 'logs.xlsx'), answers[2]!.choices)).status, 'ready');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('«Какие разговоры оценивать?» is numbered answers too: each value of the chosen column, labelled as the preview counts it', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-answers-'));
  try {
    const agents = ["['ACQUIRING_AGENT']", "['ACQUIRING_AGENT', 'AGENT_GIGACHAT']"];
    const rows: CellSpec[][] = [[...refundRows[0]!, 'agentCode'], ...refundRows.slice(1).map((row, i): CellSpec[] => [...row, agents[i % 2]!])];
    await writeFile(join(cwd, 'logs.xlsx'), xlsxFile([{ name: 'Данные', rows }]));
    const asked = await proposeTableImport(join(cwd, 'logs.xlsx'), { where: { column: 'agentCode' } });
    assert.ok(asked.status === 'question' && asked.question.kind === 'where', `a question about the column, not ${asked.status}`);
    const answers = questionAnswers(asked.question);
    assert.deepEqual(answers.map(answer => answer.label), whereChoices(asked.question));
    assert.deepEqual(answers.map(answer => answer.choices.where?.values), asked.question.values.map(item => [item.value]), 'one value per answer, as written in the cell');
    assert.equal((await proposeTableImport(join(cwd, 'logs.xlsx'), answers[0]!.choices)).status, 'ready');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('a spreadsheet in the chat: Lab\'s question is one native numbered choice, only «Прочитать так» stores the import, and the same file is not asked about again', async t => {
  const cwd = await folder(t);
  await writeFile(join(cwd, 'export.xlsx'), xlsxFile([{ name: 'Данные', rows: operatorRows }]));
  const { prepare, asked } = chat(t, cwd, ['3  служебное', 'Прочитать так', 'Не сейчас', 'Не сейчас']);
  const first = await prepare({ ...request, logs: 'export.xlsx' });
  assert.equal(first.cancelled, true, 'the consent was declined: nothing is prepared');
  const [question, reading, consent] = asked;
  const proposal = await proposeTableImport(join(cwd, 'export.xlsx'));
  assert.equal(question!.title, proposalLines(proposal).join('\n'), 'the question in the owner\'s words: counts and structure, never a message');
  assert.deepEqual(question!.options, ['1  клиент', '2  агент', '3  служебное', '4  не метка — слово в тексте сообщения', 'Не сейчас']);
  const answered = await proposeTableImport(join(cwd, 'export.xlsx'), { markers: [{ token: 'OPERATOR', role: 'system' }] });
  assert.equal(reading!.title, ['Прочитать таблицу так?', '', ...proposalLines(answered)].join('\n'), 'the whole reading, with the owner\'s answer in it');
  assert.match(reading!.title, /OPERATOR — служебное · 3 сообщения/);
  assert.deepEqual(reading!.options, ['Прочитать так', 'Не сейчас']);
  assert.match(consent!.title, /^Собрать 5 ситуаций из export\.xlsx\?\n\nВ логах 5 разговоров, подходят 5\./);
  const stored = await readdir(join(cwd, '.agent-lab', 'imports'));
  assert.equal(stored.filter(file => file.endsWith('.mapping.json')).length, 1, 'the owner\'s reading is stored with the import');
  // The same file again: its confirmed reading is used, the owner is asked only for the consent.
  await prepare({ ...request, logs: 'export.xlsx' });
  assert.equal(asked.length, 4);
  assert.match(asked[3]!.title, /^Собрать 5 ситуаций из export\.xlsx\?/);
});

test('«Какие разговоры оценивать?» from the chat: the model names the column the owner meant, the host asks for the values natively, and only the owner confirms the reading', async t => {
  const cwd = await folder(t);
  const agents = ["['ACQUIRING_AGENT']", "['ACQUIRING_AGENT', 'AGENT_GIGACHAT']"];
  const rows: CellSpec[][] = [[...refundRows[0]!, 'agentCode'], ...refundRows.slice(1).map((row, i): CellSpec[] => [...row, agents[i % 2]!])];
  await writeFile(join(cwd, 'export.xlsx'), xlsxFile([{ name: 'Данные', rows }]));
  const question = await proposeTableImport(join(cwd, 'export.xlsx'), { where: { column: 'agentCode' } });
  assert.ok(question.status === 'question' && question.question.kind === 'where', question.status);
  const labels = whereChoices(question.question).map((label, i) => `${i + 1}  ${label}`);
  const single = labels.find(label => label.includes(`«${agents[0]}»`))!;
  const { prepare, asked } = chat(t, cwd, [single, 'Прочитать так', 'Не сейчас', 'Прочитать так', 'Не сейчас']);
  assert.equal((await prepare({ ...request, logs: 'export.xlsx', table: { where: { column: 'agentCode' } } })).cancelled, true);
  assert.equal(asked[0]!.title, proposalLines(question).join('\n'), 'the question in the owner\'s words: the values and their conversations');
  assert.deepEqual(asked[0]!.options, [...labels, 'Не сейчас']);
  assert.match(asked[1]!.title, /^Прочитать таблицу так\?/);
  assert.ok(asked[1]!.title.includes(`  Отбор: «agentCode» = «${agents[0]}» — 1 из 2 разговоров.`), asked[1]!.title);
  assert.match(asked[2]!.title, /^Собрать 1 ситуацию из export\.xlsx\?\n\nВ логах 1 разговор, подходят 1\./, 'the consent counts the chosen conversations only');
  // Values the owner named in words skip the question, never the confirmation of the whole reading.
  await prepare({ ...request, logs: 'export.xlsx', table: { where: { column: 'agentCode', values: [agents[1]!] } } });
  assert.deepEqual(asked.slice(3).map(item => item.title.split('\n')[0]), ['Прочитать таблицу так?', 'Собрать 1 ситуацию из export.xlsx?']);
  assert.ok(asked[3]!.title.includes(`  Отбор: «agentCode» = «${agents[1]}» — 1 из 2 разговоров.`), asked[3]!.title);
});

test('from a spreadsheet to situations: the reading, one consent, then the situations of its conversations', async t => {
  const cwd = await folder(t);
  await writeFile(join(cwd, 'refunds.xlsx'), xlsxFile([{ name: 'Данные', rows: refundRows }]));
  const { prepare, asked, store } = chat(t, cwd, ['Прочитать так', 'Собрать ситуации']);
  const prepared = await prepare({ ...request, logs: 'refunds.xlsx' });
  assert.deepEqual(asked.map(item => item.title.split('\n')[0]), ['Прочитать таблицу так?', 'Собрать 2 ситуации из refunds.xlsx?']);
  assert.equal(prepared.counts, '2 ситуации: 2 готовы');
  const record = await store.get(prepared.run);
  assert.deepEqual([record.phase, record.target.kind, record.originalImport?.id !== undefined], ['review', 'unconnected', true]);
});

test('a declined reading and a reading the file does not allow write nothing, and the second says why', async t => {
  const cwd = await folder(t);
  await writeFile(join(cwd, 'export.xlsx'), xlsxFile([{ name: 'Данные', rows: operatorRows }]));
  const { prepare, asked } = chat(t, cwd, ['Не сейчас']);
  const declined = await prepare({ ...request, logs: 'export.xlsx' });
  assert.equal(declined.cancelled, true); assert.equal(asked.length, 1);
  const refused = await prepare({ ...request, logs: 'export.xlsx', table: { text: 'Нет такой колонки' } });
  assert.match(refused.refused, /Нет такой колонки/);
  assert.equal(asked.length, 1, 'a refused reading asks nothing');
  assert.deepEqual(await readdir(join(cwd, '.agent-lab')).then(files => files.filter(file => file !== '.lock' && file !== 'exports')), [], 'no import, no record');
});

test('without a named file Lab takes the one log it finds, asks which of several, and asks the owner when there is none', async t => {
  const cwd = await folder(t);
  const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  const none = chat(t, cwd, []);
  const asked = await none.prepare(request);
  assert.equal(asked.status, 'needs_owner_input'); assert.match(asked.message, /начать без логов/);
  await writeFile(join(cwd, 'support.jsonl'), jsonl(dialogues));
  const one = chat(t, cwd, ['Не сейчас']);
  await one.prepare(request);
  assert.match(one.asked[0]!.title, /^Собрать 2 ситуации из support\.jsonl\?/, 'the one log of the folder is the one proposed');
  await mkdir(join(cwd, 'old'));
  await writeFile(join(cwd, 'old', 'march.jsonl'), jsonl(dialogues.slice(0, 1)));
  const several = chat(t, cwd, ['Без логов — по вашим правилам', 'Не сейчас']);
  await several.prepare(request);
  assert.match(several.asked[0]!.title, /^Из каких логов собрать ситуации\?/);
  assert.deepEqual(several.asked[0]!.options, ['support.jsonl — 2 разговора', 'old/march.jsonl — 1 разговор', 'Без логов — по вашим правилам', 'Не сейчас']);
  assert.match(several.asked[1]!.title, /^Собрать 5 ситуаций по вашим правилам\?/, 'the owner\'s pick without logs goes on from the rules');
  assert.equal((await none.store.list()).length, 0, 'no question and no declined consent writes anything');
});

test('a preparation from the owner\'s rules alone is paid, so it asks one consent with its ceiling; declining spends and writes nothing', async t => {
  const cwd = await folder(t);
  const { prepare, asked, store } = chat(t, cwd, ['Не сейчас', 'Собрать ситуации']);
  const declined = await prepare({ ...request, withoutLogs: true, situations: 2 });
  assert.deepEqual([declined.cancelled, declined.spent], [true, 0]);
  assert.equal((await store.list()).length, 0);
  const [consent] = asked;
  assert.equal(consent!.title, ['Собрать 2 ситуации по вашим правилам?', '',
    'Логов нет: ситуации строятся только по правилам — без выдуманных разговоров и личных данных клиента.',
    'Расход — не больше 15 вызовов модели на всю подготовку. Это потолок, а не прогноз; агент не запускается.',
    'Правила: ваши слова из разговора — 1 документ.', 'Как запускать агента, Lab спросит перед прогоном.'].join('\n'));
  assert.deepEqual(consent!.options, ['Собрать ситуации', 'Не сейчас']);
  const prepared = await prepare({ ...request, withoutLogs: true, situations: 2 });
  const record = await store.get(prepared.run);
  assert.deepEqual([record.phase, record.settings.maxCalls, record.settings.provider, record.settings.model], ['review', 30, 'fixture', 'fixture-model'], 'the settings are the host\'s: the draft\'s limit is the run\'s budget');
  assert.ok(record.usage.calls <= 15, 'the preparation stays under the ceiling the owner agreed to');
  assert.equal(prepared.situations.length, 2);
});

test('the consent says what is read and what it may cost; the whole import is kept and the legacy projection bounded', async t => {
  const cwd = await folder(t);
  const rows = Array.from({ length: 300 }, (_, index) => JSON.stringify({ id: `dialogue_${index}`, outcome: index % 2 ? 'success' : 'failure',
    messages: [{ role: 'user', content: `Вопрос ${index}` }, { role: 'assistant', content: `Старый ответ ${index}` }] }));
  await writeFile(join(cwd, 'logs.jsonl'), rows.join('\n') + '\n');
  const create = ExperimentLab.prototype.create;
  let captured: Parameters<ExperimentLab['create']> | undefined;
  ExperimentLab.prototype.create = async function(...args) { captured = args; throw new Error('captured'); };
  t.after(() => { ExperimentLab.prototype.create = create; });
  const { prepare, asked } = chat(t, cwd, ['Собрать ситуации']);
  await assert.rejects(prepare({ ...request, logs: 'logs.jsonl' }), /captured/);
  const [input, options] = captured!;
  assert.equal(input.originalImport!.dialogues.length, 300, 'the whole outcome-blind export is kept as the import');
  assert.equal(input.dialogues!.length, 200, 'the legacy projection is bounded');
  assert.deepEqual(options, { situations: 15, callCeiling: 115 }, 'the ceiling the owner agreed to goes to the lab, which stops the preparation there');
  const { settings } = input;
  assert.deepEqual([settings!.maxCalls, settings!.timeoutMs, settings!.maxTurns, settings!.userModes, settings!.repeats], [385, 600000, 6, ['reactive'], 1]);
  assert.match(asked[0]!.title, /^Собрать 15 ситуаций из logs\.jsonl\?\n\nВ логах 300 разговоров, подходят 300\. Ситуаций будет не больше 15/);
  assert.match(asked[0]!.title, /не больше 115 вызовов модели на всю подготовку, из них 9 — на разметку тем/,
    'the preparation\'s own ceiling: the map, the rules read once, per situation its proposal allowance and review — the draft\'s limit of 385 is the run\'s');
  assert.doesNotMatch(asked[0]!.title, /validation set|outcome-blind/i, 'the owner is asked in plain words');
});

test('the rules come from the project when none are named; a project without any is a question', async t => {
  const cwd = await folder(t);
  await writeFile(join(cwd, 'logs.jsonl'), dialogues.map(dialogue => JSON.stringify(dialogue)).join('\n') + '\n');
  const bare = chat(t, cwd, []);
  const asked = await bare.prepare({ task: 'Проверить возвраты', logs: 'logs.jsonl' });
  assert.equal(asked.status, 'needs_owner_input'); assert.match(asked.message, /Нет правил, по которым судить агента/);
  await mkdir(join(cwd, 'prompts'));
  await writeFile(join(cwd, 'prompts', 'system.md'), `Ты — агент поддержки. ${policy}\n`);
  const found = chat(t, cwd, ['Не сейчас']);
  await found.prepare({ task: 'Проверить возвраты', logs: 'logs.jsonl' });
  assert.match(found.asked[0]!.title, /\nПравила: prompts\/system\.md — 1 документ\.\n/);
});
