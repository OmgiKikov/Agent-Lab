import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, test } from 'node:test';
import { initTheme, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, type Component } from '@earendil-works/pi-tui';
import agentLab from '../extensions/agent-lab.ts';
import { ownerMessages } from '../extensions/conversation.ts';
import { saidWordForWord } from '../extensions/situation-tools.ts';
import { callText } from '../extensions/render/feed.ts';
import type { CardReviewRequest, ReviewVerdict } from '../src/card/review.js';
import type { Card, LibraryV2 } from '../src/card/schema.js';
import { ExperimentLab } from '../src/experiment.js';
import { draftHash } from '../src/lab/record.js';
import { fingerprint, type Experiment } from '../src/contracts.js';
import type { Runtime } from '../src/runtime.js';
import { createDemoRuntime } from '../src/demo.js';
import { ExperimentStore } from '../src/store.js';
import { cardInput, cardRuntime, dialogues, policy } from './helpers/card-prep.js';
import { READY } from './helpers/card-library.js';
import { demoEvaluateRecord, legacyDemoRuntime, legacyDraft } from './helpers/demo-record.js';

/*
 * The conversational path on a draft of situations: the owner's sentence ──► one Agent Lab tool ──► the stored draft.
 * Every test reads the 0600 store after the call; a message on screen alone proves nothing. What the host needs from
 * the owner comes from the owner: their own words in their message, or a native dialog.
 */

/** The agent under test: a module that always asks for the terminal number. */
const chatAgent = { kind: 'module' as const, path: fileURLToPath(new URL('./fixtures/board-chat-agent.mjs', import.meta.url)), exportName: 'createSession' };
/**
 * Holds every reply of the chat agent until released, so a run can be observed while it goes. The agent
 * runs in its own process (a module target), so the hold is a file it watches, named through the environment.
 */
async function holdReplies(): Promise<() => Promise<void>> {
  const directory = await mkdtemp(join(tmpdir(), 'chat-hold-'));
  const file = join(directory, 'hold');
  await writeFile(file, '');
  process.env.AGENT_LAB_TEST_HOLD = file;
  return async () => { delete process.env.AGENT_LAB_TEST_HOLD; await rm(directory, { recursive: true, force: true }); };
}
/** Holds the preparation before its first model step, so a test can watch the conversation go on while situations are being built. */
let buildGate: Promise<void> | undefined;
/** Holds the reviewer, so a test can watch the conversation go on while a changed situation is checked. */
let checkGate: Promise<void> | undefined;
/** The reviewer doubts one claim: whether the customer of «номер по просьбе» knew the number, until the owner vouched for it. */
const DOUBT: ReviewVerdict = { status: 'needs_owner', reason: 'В исходном разговоре клиент назвал номер только после вопроса агента.' };
const doubted = (alias: string, request: CardReviewRequest) => alias === 'fact_f1' && request.payload.card.title.includes('по просьбе') && !request.payload.card.knows[0]?.owner;

/** The deterministic card runtime (test/helpers/card-prep.ts) with gates; `questions` makes the reviewer doubt one fact. */
function runtimeFixture(questions = false): Runtime {
  const base = cardRuntime();
  return { ...base,
    async proposeCard(request, ctx) { await buildGate; ctx.signal.throwIfAborted(); return base.proposeCard!(request, ctx); },
    async reviewCard(request, ctx) {
      await checkGate; ctx.signal.throwIfAborted(); ctx.beforeCall();
      return { verdicts: Object.fromEntries(request.aliases.map(alias => [alias, questions && doubted(alias, request) ? DOUBT : READY])), model: 'fixture/reviewer' };
    },
  };
}

// Each extension session receives its runtime through the public factory.
let runtime = runtimeFixture();
before(() => { initTheme('dark', false); });

interface Sent { message: { customType: string; content: string; display: boolean; details: unknown }; options: { deliverAs?: string; triggerTurn?: boolean } }
function registered(inlineRunMs?: number, inlineCheckMs?: number, inlineBuildMs?: number) {
  const tools = new Map<string, ToolDefinition>();
  const sent: Sent[] = [];
  const active = { names: ['read', 'bash'] };
  let shutdown!: () => Promise<void>;
  agentLab({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand() {}, registerMessageRenderer() {},
    on: (name: string, handler: () => Promise<void>) => { if (name === 'session_shutdown') shutdown = handler; },
    sendMessage: (message: Sent['message'], options: Sent['options']) => { sent.push({ message, options }); }, sendUserMessage() {},
    getActiveTools: () => [...active.names], setActiveTools: (names: string[]) => { active.names = [...names]; },
  } as unknown as ExtensionAPI, { createLab: directory => new ExperimentLab(directory, runtime), ...(inlineRunMs === undefined ? {} : { inlineRunMs }), ...(inlineCheckMs === undefined ? {} : { inlineCheckMs }), ...(inlineBuildMs === undefined ? {} : { inlineBuildMs }) });
  return { tools, sent, shutdown, active };
}

/**
 * A Pi terminal whose session holds exactly what the owner said; `select` picks and editor texts are scripted and
 * recorded. A pick that is not scripted closes the dialog (undefined).
 */
function terminal(cwd: string, said: string[], session: { picks?: (string | undefined)[]; texts?: (string | undefined)[] } = {}) {
  const selects: { title: string; options: string[] }[] = [];
  const editors: { title: string; prefill: string }[] = [];
  const widgets: (string[] | undefined)[] = [];
  /** A widget is Pi's own component (the progress row): drawn once here as the owner would see it, then disposed. */
  const drawWidget = (content: unknown): string[] | undefined => {
    if (typeof content !== 'function') return content as string[] | undefined;
    const component = (content as (tui: unknown, theme: unknown) => Component & { dispose?(): void })({ requestRender() {} }, plainTheme);
    try { return component.render(120).map(line => stripTerminalSequences(line).trim()).filter(Boolean); } finally { component.dispose?.(); }
  };
  const ctx = { cwd, hasUI: true, mode: 'tui',
    sessionManager: { getBranch: () => said.map((content, index) => ({ type: 'message', id: String(index), message: { role: 'user', content } })) },
    ui: { select: async (title: string, options: string[]) => { selects.push({ title, options }); return session.picks?.shift(); },
      editor: async (title: string, prefill: string) => { editors.push({ title, prefill }); return session.texts?.shift(); },
      setStatus() {}, notify() {}, setWidget: (_key: string, content: unknown) => { widgets.push(drawWidget(content)); } },
  } as unknown as ExtensionContext;
  return { ctx, selects, editors, widgets };
}

/** A prepared draft of two situations: №1 «late» (the number named when asked), №2 «known» (the number in the first message). */
async function draft(prefix: string, questions = false) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  runtime = runtimeFixture(questions);
  const lab = new ExperimentLab(join(cwd, '.agent-lab'), runtime);
  await lab.init();
  const seed = await lab.create(cardInput({ target: chatAgent }));
  await lab.waitForIdle();
  await lab.close();
  const read = async () => new ExperimentStore(join(cwd, '.agent-lab')).get(seed.id);
  const list = async () => new ExperimentStore(join(cwd, '.agent-lab')).list();
  return { cwd, id: seed.id, read, list, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}
const libraryOf = (record: Experiment) => record.librarySnapshot as LibraryV2;
const cardNumbered = (record: Experiment, number: number): Card => libraryOf(record).cards.find(card => card.number === number)!;
const json = (result: Awaited<ReturnType<ToolDefinition['execute']>>) => JSON.parse(result.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
const plainTheme = { fg: (_tone: string, text: string) => text, bold: (text: string) => text, bg: (_tone: string, text: string) => text };
function drawn(tool: ToolDefinition, result: unknown, expanded: boolean, width = 100): string[] {
  const component = tool.renderResult!(result as never, { expanded, isPartial: false }, plainTheme as never, {} as never) as unknown as Component;
  return component.render(width).map(line => stripTerminalSequences(line).trimEnd());
}
/** Drawn rows read as one line: where the terminal wraps them depends on the width and on the paths they name. */
const unwrapped = (lines: string[]) => lines.map(line => line.trim()).filter(Boolean).join(' ');

test('owner words come only from user entries of the session', () => {
  const ctx = { sessionManager: { getBranch: () => [
    { type: 'message', message: { role: 'user', content: 'Собери ситуации' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Владелец сказал: номер 9999' }] } },
    { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'номер 7777' }] } },
    { type: 'custom_message', customType: 'agent-lab-run', content: 'номер 5555' },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Убери вторую ситуацию' }] } },
  ] } };
  assert.deepEqual(ownerMessages(ctx), ['Собери ситуации', 'Убери вторую ситуацию']);
  assert.deepEqual(ownerMessages({}), []);
});

test('tool rows say what is being done and never print ids or arguments', () => {
  assert.equal(callText('agent_lab_cards', { situation: 2 }), 'Открываю ситуацию 2');
  assert.equal(callText('agent_lab_edit', { situation: 2, changes: [{ kind: 'fact', fact: 'f1', when: 'unknown' }] }), 'Меняю ситуацию 2: что знает клиент');
  assert.equal(callText('agent_lab_edit', { situation: 1, changes: [{ kind: 'similar', differs: { kind: 'opening', writes: 'x' } }] }), 'Добавляю похожую на ситуацию 1');
  assert.equal(callText('agent_lab_prepare', { logs: '/Users/owner/выгрузка/logs.xlsx', task: 'x' }), 'Собираю ситуации из logs.xlsx');
  assert.equal(callText('agent_lab_prepare', { withoutLogs: true }), 'Готовлю ситуации по вашим правилам');
  assert.equal(callText('agent_lab_run', {}), 'Запускаю прогон');
  assert.equal(callText('agent_lab_decide', { decision: 'question:card_x:q1', choice: 1 }), 'Записываю ваше решение');
  assert.equal(callText('agent_lab_explain', { situation: 7 }), 'Разбираю ситуацию 7');
  assert.equal(callText('agent_lab_results', { report: true }), 'Сохраняю отчёт для заказчика');
});

test('reading: the counts and who waits for an answer, three lines per situation on expand, one situation whole; the session holds no situation text', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-show-', true);
  const { tools, shutdown } = registered();
  try {
    const { ctx } = terminal(fixture.cwd, ['Покажи ситуации']);
    const cards = tools.get('agent_lab_cards')!;
    const list = await cards.execute('list', {}, undefined, undefined, ctx);
    const payload = json(list);
    assert.deepEqual([payload.run, payload.readOnly, payload.counts], [fixture.id, false, '2 ситуации: 1 готова · 1 ждёт вашего ответа']);
    assert.deepEqual(payload.situations.map((item: { number: number; status: string }) => [item.number, item.status]), [[1, 'needs_owner'], [2, 'ready']]);
    assert.deepEqual(Object.keys(payload.situations[0]), ['number', 'title', 'status', 'question', 'decision'], 'a list stays small: the whole brief is read by number');
    assert.match(payload.situations[0].decision, /^question:card_[0-9a-f]+:/, 'the question names the decision that answers it');
    assert.deepEqual(payload.situations[0].question.answers.map((answer: { number: number; label: string }) => `${answer.number} ${answer.label}`), ['1 Да', '2 Не знал', '3 Убрать']);
    // Claude-Code-like: the answer hangs under the action, one to three lines, the list behind ctrl+o.
    assert.deepEqual(drawn(cards, list, false).slice(0, 2), ['  └ 2 ситуации: 1 готова · 1 ждёт вашего ответа', '    Ждут ответа: 1 Возврат оплаты — номер по просьбе']);
    const expanded = drawn(cards, list, true).join('\n');
    assert.match(expanded, /^ +1 {2}Возврат оплаты — номер по просьбе +\? нужен ваш ответ$/m);
    assert.match(expanded, /Клиент: «Номер терминала: 1234\. Помогите с возвратом\.»/);
    const one = await cards.execute('one', { situation: 1, details: true }, undefined, undefined, ctx);
    assert.deepEqual(json(one).situation.knows, [{ id: 'f1', what: 'Номер терминала: 5678', when: 'если спросят' }], 'one situation gives the model the ids a change names');
    assert.match(drawn(cards, one, false).join('\n'), /Вопрос: Клиент знал «Номер терминала» до разговора\?/);
    const whole = drawn(cards, one, true).join('\n');
    assert.match(whole, /Хочет {4}Получить инструкцию по возврату оплаты/); assert.match(whole, /Как это проверяется/);
    for (const result of [list, one]) assert.doesNotMatch(JSON.stringify(result.details), /Возврат|терминал|5678/i, 'REV-01: the session file gets ids only');
    const unknown = json(await cards.execute('none', { situation: 9 }, undefined, undefined, ctx));
    assert.equal(unknown.status, 'unknown_reference');
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('what the customer knows is the owner\'s decision: the native dialog shows «было → стало», and only «Записать» writes it', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-fact-');
  const { tools, shutdown } = registered();
  try {
    const { ctx, selects } = terminal(fixture.cwd, ['Клиент в первой ситуации не знает номер терминала'], { picks: ['Не записывать', 'Записать'] });
    const edit = tools.get('agent_lab_edit')!;
    const change = { kind: 'fact', fact: 'f1', when: 'unknown' };
    const declined = json(await edit.execute('no', { situation: 1, changes: [change] }, undefined, undefined, ctx));
    assert.equal(declined.declined, true);
    assert.match(selects[0]!.title, /1 {2}Знает: было «Номер терминала: 5678 — если спросят», стало «Номер терминала — не знает»/);
    assert.deepEqual(selects[0]!.options, ['Записать', 'Не записывать']);
    assert.equal(cardNumbered(await fixture.read(), 1).client.knows[0]!.disclosure, 'on_request', 'a declined change writes nothing');
    const written = await edit.execute('yes', { situation: 1, changes: [change] }, undefined, undefined, ctx);
    const record = await fixture.read();
    const card = cardNumbered(record, 1);
    assert.deepEqual([card.client.knows[0]!.disclosure, card.client.knows[0]!.source.kind, card.revision], ['unknown', 'owner', 2]);
    const receipt = libraryOf(record).receipts.at(-1)!;
    assert.deepEqual([receipt.via, receipt.command.kind, receipt.ownerWords], ['pi-confirm', 'set_fact_disclosure', undefined]);
    const rows = drawn(edit, written, false).join('\n');
    assert.match(rows, /^ {2}└ Ситуация 1 готова · версия 2$/m, 'the changed situation was checked again in the same row, and names its new version');
    assert.match(rows, /Знает: было «Номер терминала: 5678 — если спросят», стало «Номер терминала — не знает»/);
    assert.doesNotMatch(JSON.stringify(written.details), /терминал|5678/i);
    const missing = json(await edit.execute('missing', { situation: 1, changes: [{ kind: 'fact', fact: 'f7', when: 'unknown' }] }, undefined, undefined, ctx));
    assert.equal(missing.status, 'unknown_reference'); assert.deepEqual(missing.options, ['f1 Номер терминала']);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('the customer\'s words the owner wrote still wait for «Записать»: the dialog marks them as the owner\'s, and only then they are recorded as theirs', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-words-');
  const { tools, shutdown } = registered();
  try {
    const writes = 'Добрый день! Номер терминала: 1234, хочу вернуть деньги';
    const { ctx, selects } = terminal(fixture.cwd, [`Пусть во второй ситуации клиент пишет: «${writes}»`], { picks: ['Записать', 'Не записывать'] });
    const edit = tools.get('agent_lab_edit')!;
    const own = json(await edit.execute('own', { situation: 2, changes: [{ kind: 'client', writes }] }, undefined, undefined, ctx));
    assert.equal(own.applied, true); assert.equal(selects.length, 1, 'the owner\'s own words are confirmed like any change');
    assert.ok(selects[0]!.title.includes(`стало ««${writes}»»`), selects[0]!.title);
    assert.match(selects[0]!.title, /\n\nФормулировка — ваши слова из разговора\.\n\nЗаписать это от вашего имени\?$/);
    const record = await fixture.read();
    assert.deepEqual([cardNumbered(record, 2).client.writes, cardNumbered(record, 2).client.writesSource.kind], [writes, 'owner']);
    assert.deepEqual([libraryOf(record).receipts.at(-1)!.ownerWords, libraryOf(record).receipts.at(-1)!.via], [writes, 'pi-confirm']);
    const proposed = json(await edit.execute('model', { situation: 2, changes: [{ kind: 'client', leaves: 'получил номер заявки на возврат' }] }, undefined, undefined, ctx));
    assert.equal(proposed.declined, true);
    assert.match(selects[1]!.title, /Уходит: было «получил инструкцию по возврату или понял, что агент не поможет», стало «получил номер заявки на возврат»/);
    assert.doesNotMatch(selects[1]!.title, /ваши слова/, 'words the model chose are never called the owner\'s');
    assert.equal(cardNumbered(await fixture.read(), 2).client.leaves, 'получил инструкцию по возврату или понял, что агент не поможет');
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('a fragment of the owner\'s sentence never passes as their decision: the duty it would turn inside out waits for «Записать»; a letter inside a word is not their words; without a terminal nothing is written', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-fragment-');
  const { tools, shutdown } = registered();
  try {
    const said = 'Агент не должен обещать возврат денег, если клиент не назвал номер терминала';
    const { ctx, selects } = terminal(fixture.cwd, [said], { picks: ['Не записывать', 'Записать'] });
    const edit = tools.get('agent_lab_edit')!;
    const receipts = libraryOf(await fixture.read()).receipts.length;
    // «обещать возврат денег» stands in the owner's sentence word for word — and would make the agent do what the owner forbade.
    const flipped = json(await edit.execute('flip', { situation: 1, changes: [{ kind: 'duty', duty: 'e2', text: 'обещать возврат денег' }] }, undefined, undefined, ctx));
    assert.equal(flipped.declined, true);
    assert.equal(selects.length, 1, 'the owner is asked, words of theirs or not');
    assert.match(selects[0]!.title, /Агент должен: было «объяснить, как оформить возврат», стало «обещать возврат денег»/);
    assert.equal(libraryOf(await fixture.read()).receipts.length, receipts, 'declined: nothing written');
    assert.equal(cardNumbered(await fixture.read(), 1).agentMust[1]!.text, 'объяснить, как оформить возврат');
    // «а» stands only inside «Агент»: confirmed, the change is recorded as a confirmation, never as the owner's words.
    const stray = json(await edit.execute('stray', { situation: 1, changes: [{ kind: 'client', leaves: 'а' }] }, undefined, undefined, ctx));
    assert.equal(stray.applied, true); assert.equal(selects.length, 2);
    assert.doesNotMatch(selects[1]!.title, /ваши слова/);
    assert.equal(libraryOf(await fixture.read()).receipts.at(-1)!.ownerWords, undefined);
    // Without a terminal even the owner's own words are refused, in their words, and the model is handed no command line.
    const headless = { ...ctx, hasUI: false, mode: 'print' } as ExtensionContext;
    const written = libraryOf(await fixture.read()).receipts.length;
    const refused = await edit.execute('headless', { situation: 1, changes: [{ kind: 'duty', duty: 'e2', text: 'обещать возврат денег' }] }, undefined, undefined, headless).catch(error => error as Error);
    assert.ok(refused instanceof Error); assert.match(refused.message, /интерактивном терминале Pi/); assert.doesNotMatch(refused.message, /--yes|agent-lab cards/);
    assert.equal(libraryOf(await fixture.read()).receipts.length, written, 'headless: nothing written');
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('a duty\'s condition is a decision the dialog shows, even when its words stay or come from the owner', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-condition-');
  const { tools, shutdown } = registered();
  try {
    const said = 'Пусть агент всегда должен объяснить, как оформить заявление на возврат';
    const { ctx, selects } = terminal(fixture.cwd, [said], { picks: ['Не записывать', 'Записать'] });
    const edit = tools.get('agent_lab_edit')!;
    const condition = /Агент должен: объяснить, как оформить (заявление на )?возврат — когда: было «клиент назвал номер терминала», стало «всегда»/;
    // The condition alone: its line is in the dialog — before, the dialog showed nothing while the judge's duty changed.
    const dropped = json(await edit.execute('drop', { situation: 1, changes: [{ kind: 'duty', duty: 'e2', appliesWhen: null }] }, undefined, undefined, ctx));
    assert.equal(dropped.declined, true); assert.match(selects[0]!.title, condition);
    // The owner's words with the condition dropped: still one dialog with both lines; the words are kept as theirs, the grant is a confirmation.
    const both = json(await edit.execute('both', { situation: 1, changes: [{ kind: 'duty', duty: 'e2', text: 'объяснить, как оформить заявление на возврат', appliesWhen: null }] }, undefined, undefined, ctx));
    assert.equal(both.applied, true); assert.equal(selects.length, 2, 'new words never carry a dropped condition past the owner');
    assert.match(selects[1]!.title, /Агент должен: было «объяснить, как оформить возврат», стало «объяснить, как оформить заявление на возврат»/);
    assert.match(selects[1]!.title, condition);
    const record = await fixture.read();
    const duty = cardNumbered(record, 1).agentMust[1]!;
    assert.deepEqual([duty.text, duty.appliesWhen], ['объяснить, как оформить заявление на возврат', undefined]);
    assert.equal(libraryOf(record).receipts.at(-1)!.ownerWords, 'объяснить, как оформить заявление на возврат');
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('words stand in the owner\'s message only as whole words, after the one normalisation', () => {
  const said = 'Агент не должен обещать возврат денег, если клиент не назвал  НОМЕР терминала';
  assert.equal(saidWordForWord(said, 'обещать возврат денег'), true);
  assert.equal(saidWordForWord(said, 'номер терминала'), true, 'case and spacing do not matter');
  assert.equal(saidWordForWord(said, 'Агент не'), true);
  assert.equal(saidWordForWord(said, 'а'), false, 'a letter inside a word is not a word');
  assert.equal(saidWordForWord(said, 'ещать возв'), false, 'pieces of words are not words');
  assert.equal(saidWordForWord('Номер5678', '5678'), false);
  assert.equal(saidWordForWord('Номер: 5678.', '5678'), true, 'punctuation ends a word');
  assert.equal(saidWordForWord(said, '   '), false);
});

test('a situation\'s question is a decision: the owner answers in a native dialog of the question itself, and the answer is kept with its basis', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-answer-', true);
  const { tools, shutdown } = registered();
  try {
    const { ctx, selects } = terminal(fixture.cwd, ['Да, клиент знал номер заранее'], { picks: ['1  Да'] });
    const decide = tools.get('agent_lab_decide')!;
    const listed = json(await decide.execute('list', {}, undefined, undefined, ctx));
    assert.equal(listed.decisions.length, 1);
    const [decision] = listed.decisions;
    assert.deepEqual(decision.answers.map((answer: { number: number; label: string }) => `${answer.number} ${answer.label}`), ['1 Да', '2 Не знал', '3 Убрать']);
    const result = json(await decide.execute('answer', { decision: decision.key, choice: 1 }, undefined, undefined, ctx));
    assert.match(selects[0]!.title, /^Ситуация 1 · Возврат оплаты — номер по просьбе\n\nКлиент знал «Номер терминала» до разговора\?[^\n]*\n\nВ разговоре вы ответили: «Да»$/);
    assert.deepEqual(selects[0]!.options, ['1  Да', '2  Не знал', '3  Убрать', 'Не сейчас']);
    assert.equal(result.decided, true); assert.deepEqual(result.left, [], 'a resolved decision leaves the queue');
    const receipt = libraryOf(await fixture.read()).receipts.at(-1)!;
    assert.deepEqual([receipt.command.kind, receipt.via], ['settle_claim', 'pi-confirm']); assert.match(receipt.basisHash ?? '', /^[a-f0-9]{64}$/);
    assert.equal(json(await tools.get('agent_lab_cards')!.execute('one', { situation: 1 }, undefined, undefined, ctx)).situation.status, 'ready');
    assert.equal(json(await decide.execute('again', { decision: decision.key }, undefined, undefined, ctx)).status, 'unknown_reference', 'the answered decision is gone');
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('«добавь случай, где клиент не знает номер» is one call: a new situation, the original byte for byte the same', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-similar-');
  const { tools, shutdown } = registered();
  try {
    const parent = cardNumbered(await fixture.read(), 2);
    const { ctx, selects } = terminal(fixture.cwd, ['Добавь случай, где клиент не знает номер терминала'], { picks: ['Записать'] });
    const result = json(await tools.get('agent_lab_edit')!.execute('similar', { situation: 2,
      changes: [{ kind: 'similar', differs: { kind: 'when', fact: 'f1', when: 'unknown', writes: 'Помогите с возвратом, номер терминала не помню.' } }] }, undefined, undefined, ctx));
    assert.match(selects[0]!.title, /Похожая на ситуацию 2/);
    const record = await fixture.read();
    const added = cardNumbered(record, 3);
    assert.deepEqual([added.origin.kind, added.client.knows[0]!.disclosure, added.client.writes], ['similar', 'unknown', 'Помогите с возвратом, номер терминала не помню.']);
    assert.equal(fingerprint(cardNumbered(record, 2)), fingerprint(parent));
    assert.deepEqual([result.situation.number, result.situation.source], [3, 'похожая на №2']);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('removing a situation is confirmed natively; an unknown situation asks the owner with what there is, and nothing is written', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-remove-');
  const { tools, shutdown } = registered();
  try {
    const { ctx, selects } = terminal(fixture.cwd, ['Убери вторую ситуацию'], { picks: ['Записать'] });
    const edit = tools.get('agent_lab_edit')!;
    const unknown = json(await edit.execute('unknown', { situation: 9, changes: [{ kind: 'remove' }] }, undefined, undefined, ctx));
    assert.equal(unknown.status, 'unknown_reference'); assert.deepEqual(unknown.options, ['№1 Возврат оплаты — номер по просьбе', '№2 Возврат оплаты — номер назван сразу']);
    assert.equal(selects.length, 0);
    const removed = await edit.execute('remove', { situation: 2, changes: [{ kind: 'remove' }] }, undefined, undefined, ctx);
    assert.match(selects[0]!.title, /Убрать ситуацию 2 «Возврат оплаты — номер назван сразу» из черновика\?/);
    assert.deepEqual(libraryOf(await fixture.read()).cards.map(card => card.number), [1]);
    assert.match(drawn(edit, removed, false).join('\n'), /Ситуация 2 убрана из черновика/);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('situations recorded before the card format are read the same way and cannot be changed', { timeout: 60000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'chat-legacy-'));
  const seed = new ExperimentLab(join(cwd, '.agent-lab'), legacyDemoRuntime());
  try {
    await seed.init();
    try { await legacyDraft(seed, { count: 2 }); } finally { await seed.close(); }
    runtime = legacyDemoRuntime();
    const { tools, shutdown } = registered();
    try {
      const { ctx } = terminal(cwd, ['Покажи ситуации']);
      const shown = json(await tools.get('agent_lab_cards')!.execute('show', {}, undefined, undefined, ctx));
      assert.equal(shown.readOnly, true); assert.equal(shown.situations.length, 2);
      assert.equal(shown.situations[0].status, 'ready');
      const refused = json(await tools.get('agent_lab_edit')!.execute('remove', { situation: 1, changes: [{ kind: 'remove' }] }, undefined, undefined, ctx));
      assert.match(refused.refused, /записаны до наборов ситуаций: их можно посмотреть и повторить, но не изменить/);
    } finally { await shutdown(); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('one dialog runs the ready situations: «Принять 1 ситуацию и запустить?» with its plan; «Не сейчас» writes nothing; a finished run is run again as a repeat', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-run-', true);
  const { tools, shutdown } = registered();
  try {
    const { ctx, selects } = terminal(fixture.cwd, ['Запусти готовые'], { picks: ['Не сейчас', 'Запустить', 'Не сейчас'] });
    const run = tools.get('agent_lab_run')!;
    const declined = json(await run.execute('no', {}, undefined, undefined, ctx));
    assert.equal(declined.cancelled, true);
    const plan = selects[0]!.title;
    for (const part of [/^Принять 1 ситуацию и запустить\?/, /1 ситуация · 1 разговор: клиента играет Lab, ответы агента оценивает судья\./, /Судья: по 2 голоса на каждое ожидание — до 4 вызовов на попытку, всего до 4\./,
      /Не войдут: 1 ждёт вашего ответа/, /Вместе с запуском Lab утвердит эти ситуации — повтор пойдёт по ним же\./]) assert.match(plan, part);
    assert.match(plan, /до 4\.\nСверка с продом: до 4 вызовов судьи; агент и симулятор не участвуют\.\n/, 'situations from logs: the comparison with production and its ceiling stand next to the judge\'s');
    assert.deepEqual(selects[0]!.options, ['Запустить', 'Не сейчас']);
    assert.equal(libraryOf(await fixture.read()).acceptance, undefined, 'declining accepts nothing');
    const result = await run.execute('yes', {}, undefined, undefined, ctx);
    assert.equal((result.details as { kind?: string }).kind, 'agent-lab/verdict');
    assert.equal(json(result).run, fixture.id);
    const record = await fixture.read();
    assert.deepEqual(libraryOf(record).acceptance!.cardIds, [cardNumbered(record, 2).id], 'the situation that waits for the owner stays out');
    assert.deepEqual([record.trials.length, record.phase], [1, 'results_review']);
    // «Запусти ещё раз»: the finished run never runs again in place; its accepted set goes into a repeat, which just
    // starts — and a repeat the owner declines in its dialog is never written.
    const again = json(await run.execute('again', {}, undefined, undefined, ctx));
    assert.deepEqual([again.cancelled, again.run], [true, fixture.id], 'the answer names the run that exists');
    assert.match(selects[2]!.title, /^Запустить прогон\?\n/);
    assert.equal(fingerprint(await fixture.read()), fingerprint(record), 'the finished run is untouched');
    assert.deepEqual((await fixture.list()).map(item => item.id), [fixture.id], '«Не сейчас» leaves no draft behind');
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('a change asked for after a run goes into a fresh draft of the same set; the finished run never changes', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-after-run-');
  const { tools, shutdown } = registered();
  try {
    const { ctx } = terminal(fixture.cwd, ['Запусти, а потом клиент во второй ситуации пусть не знает номер'], { picks: ['Запустить', 'Записать'] });
    await tools.get('agent_lab_run')!.execute('run', {}, undefined, undefined, ctx);
    const finished = await fixture.read();
    assert.equal(finished.phase, 'results_review');
    const changed = json(await tools.get('agent_lab_edit')!.execute('fact', { run: fixture.id, situation: 1, changes: [{ kind: 'fact', fact: 'f1', when: 'unknown' }] }, undefined, undefined, ctx));
    assert.equal(changed.unchangedRun, fixture.id); assert.notEqual(changed.run, fixture.id); assert.match(changed.instruction, /fresh draft/);
    assert.equal(fingerprint(await fixture.read()), fingerprint(finished), 'the run that happened is untouched');
    const draftRecord = await new ExperimentStore(join(fixture.cwd, '.agent-lab')).get(changed.run);
    assert.deepEqual([draftRecord.phase, draftRecord.parentRunId, cardNumbered(draftRecord, 1).client.knows[0]!.disclosure], ['review', fixture.id, 'unknown']);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('a long run leaves the conversation free: Esc does not stop it, progress is real, changes wait, and the result arrives as a message', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-run-background-');
  const { tools, sent, shutdown } = registered(60_000);
  const release = await holdReplies();
  try {
    const { ctx, widgets } = terminal(fixture.cwd, ['Запусти готовые'], { picks: ['Запустить'] });
    const run = tools.get('agent_lab_run')!;
    const escape = new AbortController();
    const started = run.execute('run', {}, escape.signal, undefined, ctx);
    // Esc while the run goes (its replies are held).
    while ((await fixture.read()).phase !== 'evaluating') await new Promise(resolve => setTimeout(resolve, 20));
    escape.abort();
    const result = await started;
    // The row wraps at the terminal width and names the agent by its path, so where it breaks depends on the checkout: read it as one line.
    assert.equal(json(result).background, true); assert.match(unwrapped(drawn(run, result, false)), /Прогон идёт: 2 разговора .* Результат придёт сюда сообщением\./);
    assert.equal((await fixture.read()).phase, 'evaluating', 'interrupting the action does not stop the run');
    const progress = json(await run.execute('progress', { action: 'progress' }, undefined, undefined, ctx));
    assert.deepEqual([progress.running, progress.working, progress.finished, progress.planned], [true, 'run', 0, 2]);
    assert.equal(json(await tools.get('agent_lab_cards')!.execute('read', {}, undefined, undefined, ctx)).situations.length, 2, 'reading works while the run goes');
    const change = await tools.get('agent_lab_edit')!.execute('remove', { situation: 1, changes: [{ kind: 'remove' }] }, undefined, undefined, ctx).catch(error => error as Error);
    assert.match(change instanceof Error ? change.message : '', /^Сейчас идёт прогон\. .* правки и новый запуск — после его завершения или остановки/);
    await release();
    while (!sent.length) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sent[0]!.message.customType, 'agent-lab-run'); assert.deepEqual(sent[0]!.options, { deliverAs: 'followUp', triggerTurn: true });
    assert.equal((sent[0]!.message.details as { kind: string }).kind, 'agent-lab/verdict');
    const content = JSON.parse(sent[0]!.message.content);
    assert.equal(content.run, fixture.id); assert.ok(content.lines.length > 0);
    // One progress row above the input: Pi's spinner and the count from the stored record; once the run is handed over, how to stop it.
    assert.match(widgets.find(lines => lines)!.join('\n'), /^⠋ Прогон: 0 из 2 разговоров/);
    assert.ok(widgets.some(lines => lines?.length === 1 && lines[0]!.includes('Прогон: 0 из 2 разговоров') && lines[0]!.endsWith('остановить — напишите «стоп»')), JSON.stringify(widgets));
    while (widgets.at(-1) !== undefined) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await fixture.read()).phase, 'results_review');
  } finally { await release(); await shutdown(); await fixture.cleanup(); }
});

test('stopping is its own request: only the run that is going is stopped, what is recorded stays, and the answer says what must be rerun', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-run-stop-');
  const { tools, sent, shutdown } = registered(0);
  const release = await holdReplies();
  try {
    const said = ['Запусти готовые'];
    const { ctx, selects } = terminal(fixture.cwd, said, { picks: ['Запустить'] });
    const run = tools.get('agent_lab_run')!;
    assert.equal(json(await run.execute('run', {}, undefined, undefined, ctx)).background, true);
    said.push('Останови прогон');
    const other = json(await run.execute('stop-other', { action: 'stop', run: 'no-such-run-0000' }, undefined, undefined, ctx));
    assert.equal(other.status, 'unknown_reference'); assert.equal((await fixture.read()).phase, 'evaluating', 'a run the owner did not name is never stopped in its place');
    const pending = run.execute('stop', { action: 'stop', run: fixture.id }, undefined, undefined, ctx);
    await release();
    const stopped = await pending;
    assert.equal(json(stopped).stopped, true); assert.equal(selects.length, 1, 'the owner\'s own request needs no second confirmation');
    assert.match(unwrapped(drawn(run, stopped, false)), /Прогон остановлен: сохранено \d из 2 разговоров.* С места остановки не продолжить/);
    assert.equal(sent.length, 0, 'a stop the owner asked for is answered in its own row, not announced twice');
    assert.ok(['cancelled', 'results_review'].includes((await fixture.read()).phase));
  } finally { await release(); await shutdown(); await fixture.cleanup(); }
});

/** A folder with the owner's logs, prepared through the chat: the same rule and dialogues `draft()` seeds. */
async function preparing(prefix: string) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(cwd, 'logs.jsonl'), dialogues.map(dialogue => JSON.stringify(dialogue)).join('\n') + '\n');
  runtime = runtimeFixture(true);
  const stored = async () => new ExperimentStore(join(cwd, '.agent-lab')).list();
  return { cwd, stored, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}
const prepareRequest = { task: 'Проверить возвраты', logs: 'logs.jsonl', rules: policy };

test('a long preparation leaves the conversation free: a second one is refused before any question, and the situations arrive as one message', { timeout: 60000 }, async () => {
  const fixture = await preparing('chat-build-background-');
  const { tools, sent, shutdown } = registered(undefined, undefined, 0);
  let release!: () => void;
  buildGate = new Promise<void>(resolve => { release = resolve; });
  try {
    const { ctx, widgets, selects } = terminal(fixture.cwd, ['Собери ситуации по этим логам', 'Убери вторую ситуацию'], { picks: ['Собрать ситуации', 'Записать'] });
    const prepare = tools.get('agent_lab_prepare')!, run = tools.get('agent_lab_run')!;
    const result = await prepare.execute('prepare', prepareRequest, undefined, undefined, ctx);
    assert.equal(json(result).background, true); assert.match(json(result).instruction, /do not poll/);
    assert.match(selects[0]!.title, /^Собрать 2 ситуации из logs\.jsonl\?/, 'one consent before anything is spent');
    const [record] = await fixture.stored();
    assert.deepEqual([record!.phase, record!.librarySnapshot], ['preparing', undefined], 'the stored record is still being prepared');
    const progress = json(await run.execute('progress', { action: 'progress' }, undefined, undefined, ctx));
    assert.deepEqual([progress.running, progress.working, progress.inThisSession], [true, 'preparation', true]);
    const second = await prepare.execute('prepare-2', prepareRequest, undefined, undefined, ctx).catch(error => error as Error);
    assert.match(second instanceof Error ? second.message : '', /^Сейчас идёт подготовка ситуаций\. .* правки и новый запуск — после её завершения или остановки/);
    assert.equal(selects.length, 1, 'work that cannot start never asks the owner');
    release();
    while (!sent.length) await new Promise(resolve => setTimeout(resolve, 20));
    while (widgets.at(-1) !== undefined) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sent.length, 1, 'exactly one message reports the preparation');
    assert.equal(sent[0]!.message.customType, 'agent-lab-build'); assert.deepEqual(sent[0]!.options, { deliverAs: 'followUp', triggerTurn: true });
    const finished = (await fixture.stored())[0]!;
    assert.deepEqual([finished.phase, libraryOf(finished).cards.length, finished.target.kind], ['review', 2, 'unconnected']);
    const content = JSON.parse(sent[0]!.message.content);
    assert.deepEqual([content.run, content.counts, content.situations.length, content.agentConnected], [finished.id, '2 ситуации: 1 готова · 1 ждёт вашего ответа', 2, false]);
    assert.doesNotMatch(JSON.stringify(sent[0]!.message.details), /Возврат|терминал/i, 'the session file gets ids only');
    const rows = drawn(prepare, { content: [{ type: 'text', text: '' }], details: sent[0]!.message.details }, false).join('\n');
    assert.match(rows, /└ 2 ситуации: 1 готова · 1 ждёт вашего ответа/); assert.match(rows, /Готовые можно запускать — перед запуском Lab спросит, как подключить агента\./);
    // The lock went back with the message: the next change is taken.
    assert.equal(json(await tools.get('agent_lab_edit')!.execute('remove', { situation: 2, changes: [{ kind: 'remove' }] }, undefined, undefined, ctx)).applied, true);
  } finally { buildGate = undefined; release(); await shutdown(); await fixture.cleanup(); }
});

test('Esc during a preparation interrupts the action, not the work; stopping it is the owner\'s request and says what was saved', { timeout: 60000 }, async () => {
  const fixture = await preparing('chat-build-escape-');
  const { tools, sent, shutdown } = registered(undefined, undefined, 60_000);
  let release!: () => void;
  buildGate = new Promise<void>(resolve => { release = resolve; });
  try {
    const { ctx } = terminal(fixture.cwd, ['Собери ситуации по этим логам'], { picks: ['Собрать ситуации'] });
    const escape = new AbortController();
    const started = tools.get('agent_lab_prepare')!.execute('prepare', prepareRequest, escape.signal, undefined, ctx);
    // Esc while the preparation goes (it is held before its first model step).
    while (!(await fixture.stored()).length) await new Promise(resolve => setTimeout(resolve, 20));
    escape.abort();
    const built = json(await started);
    assert.equal(built.background, true);
    assert.equal((await fixture.stored())[0]!.phase, 'preparing', 'interrupting the action does not cancel the preparation');
    const pending = tools.get('agent_lab_run')!.execute('stop', { action: 'stop', run: built.run }, undefined, undefined, ctx);
    release();
    const stopped = json(await pending);
    assert.equal(stopped.stopped, true); assert.match(stopped.message, /^Подготовка (остановлена|успела завершиться до остановки)\./);
    const record = (await fixture.stored())[0]!;
    assert.equal(stopped.savedSituations, libraryOf(record)?.cards.length ?? 0, 'the answer counts what the stored record holds');
    assert.equal(sent.length, 0, 'a stop the owner asked for is answered in its own row, not announced twice');
  } finally { buildGate = undefined; release(); await shutdown(); await fixture.cleanup(); }
});

test('a slow check of a changed situation does not hold the conversation: the change answers at once, its outcome arrives as a message', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-check-background-');
  const { tools, sent, shutdown } = registered(undefined, 0);
  let release: () => void = () => {};
  try {
    const { ctx } = terminal(fixture.cwd, ['Во второй ситуации клиент пусть не знает номер терминала'], { picks: ['Записать'] });
    checkGate = new Promise<void>(resolve => { release = resolve; });
    const edit = tools.get('agent_lab_edit')!;
    const changed = await edit.execute('fact', { situation: 1, changes: [{ kind: 'fact', fact: 'f1', when: 'unknown' }] }, undefined, undefined, ctx);
    assert.equal(json(changed).check.status, 'running');
    assert.match(unwrapped(drawn(edit, changed, false)), /Ситуация 1 проверяется.* Проверяю изменённую ситуацию в фоне/);
    assert.equal(sent.length, 0);
    assert.equal(json(await tools.get('agent_lab_cards')!.execute('read', { situation: 1 }, undefined, undefined, ctx)).situation.status, 'checking', 'reading works while the check runs');
    release();
    while (!sent.length) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sent[0]!.message.customType, 'agent-lab-check');
    assert.deepEqual(sent[0]!.options, { deliverAs: 'followUp', triggerTurn: false }, 'a situation that became ready needs no turn');
    assert.equal(JSON.parse(sent[0]!.message.content).situation.status, 'ready');
    const nothing = json(await tools.get('agent_lab_decide')!.execute('list', {}, undefined, undefined, ctx));
    assert.deepEqual(nothing.decisions, [], 'nothing waits for the owner: no check, no question');
  } finally { checkGate = undefined; release(); await shutdown(); await fixture.cleanup(); }
});

test('results of a run recorded before the card format: a failure opens by its situation number, a repeat of one situation runs again and is compared with its source', { timeout: 60000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'chat-results-cwd-'));
  // A finished run of old-format cards (free user simulator, no controller) on an external agent: it can still be repeated.
  const seed = new ExperimentLab(join(cwd, '.agent-lab'), legacyDemoRuntime());
  let source: Experiment;
  try {
    await seed.init();
    const legacy = await legacyDraft(seed, { count: 2 });
    await seed.start(legacy.id, { approved: true, expectedHash: draftHash(legacy) }); await seed.waitForIdle();
    source = await seed.get(legacy.id);
  } finally { await seed.close(); }
  assert.equal(source.phase, 'results_review', source.error ?? '');
  runtime = legacyDemoRuntime();
  const { tools, shutdown } = registered();
  try {
    const { ctx, selects } = terminal(cwd, ['Покажи первый провал'], { picks: ['Запустить'] });
    const status = await tools.get('agent_lab_status')!.execute('status', {}, undefined, undefined, ctx);
    assert.equal(json(status).runs[0].id, source.id); assert.match(drawn(tools.get('agent_lab_status')!, status, false).join('\n'), /1 прогон: последний — .*точность \d+%/);
    const results = json(await tools.get('agent_lab_results')!.execute('results', {}, undefined, undefined, ctx));
    assert.ok(results.failures.length > 0, 'the old run has a failure');
    const explain = tools.get('agent_lab_explain')!;
    const failure = await explain.execute('failure', { situation: results.failures[0].situation }, undefined, undefined, ctx);
    const payload = json(failure);
    assert.deepEqual([payload.situation, payload.title], [results.failures[0].situation, results.failures[0].title]);
    const rows = drawn(explain, failure, false);
    assert.equal(rows[0], `  └ ✗ 1  ${results.failures[0].title}`);
    // Expected, the agent's words and the rule: the three lines the owner reads first; the conversation behind ctrl+o.
    assert.match(rows.join(' '), /Ожидалось: .* · Агент: /); assert.match(rows.join(' '), /Правило: «|нет правила из ваших материалов/);
    assert.match(drawn(explain, failure, true).join('\n'), /Разговор\n {6}Клиент {3}/);
    assert.ok(payload.conversation.length > 0 && payload.conversation.every((turn: { who: string }) => turn.who === 'клиент' || turn.who === 'агент'));
    assert.equal(json(await explain.execute('missing', { situation: 99 }, undefined, undefined, ctx)).status, 'unknown_reference');
    const repeated = await tools.get('agent_lab_run')!.execute('rerun', { situations: [1] }, undefined, undefined, ctx);
    assert.match(selects[0]!.title, /^Подтвердить ожидания и запустить\?/, 'an older record confirms its expectations with the run, in the same dialog');
    const repeat = (await new ExperimentStore(join(cwd, '.agent-lab')).list()).find(record => record.id !== source.id)!;
    assert.deepEqual([json(repeated).run, repeat.parentRunId, repeat.trials.length], [repeat.id, source.id, 1]);
    const comparison = json(await tools.get('agent_lab_results')!.execute('compare', { compare: true }, undefined, undefined, ctx));
    assert.equal(comparison.before, source.id);
    assert.equal((await new ExperimentStore(join(cwd, '.agent-lab')).get(source.id)).trials.length, source.trials.length, 'the source run is untouched');
  } finally { await shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

test('the owner marks the judge\'s decision from the conversation: the answer comes only from the native dialog and is saved as a quick review', { timeout: 60000 }, async () => {
  const demo = await demoEvaluateRecord('chat-agree-');
  await demo.lab.close();
  const cwd = await mkdtemp(join(tmpdir(), 'chat-agree-cwd-'));
  const store = new ExperimentStore(join(cwd, '.agent-lab'));
  await store.init();
  try { await store.save(demo.record); } finally { await store.close(); }
  runtime = createDemoRuntime();
  const { tools, shutdown } = registered();
  try {
    const { ctx, selects } = terminal(cwd, ['Покажи первый провал. Да, согласен с судьёй'], { picks: [undefined, 'Да, судья прав'] });
    const [first] = json(await tools.get('agent_lab_results')!.execute('results', {}, undefined, undefined, ctx)).failures;
    const agree = tools.get('agent_lab_agree')!;
    const skipped = json(await agree.execute('skip', { situation: first.situation }, undefined, undefined, ctx));
    assert.equal(skipped.marked, false); assert.equal((await new ExperimentStore(join(cwd, '.agent-lab')).get(demo.record.id)).humanReviews?.length ?? 0, 0, 'no answer in the dialog, no mark');
    const marked = await agree.execute('mark', { situation: first.situation }, undefined, undefined, ctx);
    assert.match(selects[1]!.title, /судья решил: не справился\. Судья прав\?/);
    assert.deepEqual(selects[1]!.options, ['Да, судья прав', 'Нет, судья ошибся', 'Не знаю']);
    const reviews = (await new ExperimentStore(join(cwd, '.agent-lab')).get(demo.record.id)).humanReviews ?? [];
    assert.ok(reviews.length >= 1); assert.ok(reviews.every(item => item.source === 'quick' && item.verdict === 'fail' && item.judgeVerdict === 'fail'));
    assert.match(drawn(agree, marked, false).join('\n'), /Отмечено: согласен с судьёй/);
  } finally { await shutdown(); await rm(cwd, { recursive: true, force: true }); await rm(demo.directory, { recursive: true, force: true }); }
});

test('a run is named by its exact id or means what the project works on now; nothing is remembered between calls', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-reference-');
  const { tools, shutdown } = registered();
  try {
    const { ctx } = terminal(fixture.cwd, ['Покажи ситуации']);
    const cards = tools.get('agent_lab_cards')!;
    assert.equal(json(await cards.execute('newest', {}, undefined, undefined, ctx)).run, fixture.id, 'no id: the newest record with situations');
    assert.equal(json(await cards.execute('named', { run: fixture.id }, undefined, undefined, ctx)).run, fixture.id);
    // A prefix, a title fragment or a number is not a reference: the model is told what exists and asks the owner.
    for (const wrong of [fixture.id.slice(0, 8), 'возвраты', '1']) {
      const asked = json(await cards.execute('wrong', { run: wrong }, undefined, undefined, ctx));
      assert.equal(asked.status, 'unknown_reference', wrong); assert.match(asked.message, new RegExp(fixture.id));
    }
    const results = json(await tools.get('agent_lab_results')!.execute('none', {}, undefined, undefined, ctx));
    assert.equal(results.status, 'unknown_reference', 'no run has a result yet'); assert.match(results.message, /Результатов ещё нет/);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('an empty project: the status says what Lab found in the folder, and asks for the agent and the logs only when it found neither', { timeout: 60000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-status-found-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const { tools, shutdown } = registered();
  t.after(shutdown);
  const status = tools.get('agent_lab_status')!;
  const read = async () => {
    const result = await status.execute('status', {}, undefined, undefined, terminal(cwd, []).ctx);
    return { output: json(result), shown: drawn(status, result, false).join('\n') };
  };
  const bare = await read();
  assert.match(bare.shown, /Прогонов пока нет\. Скажите, какого агента проверить и где лежат логи\.\n.*В папке: как запускать агента, не видно · логов нет/);
  await writeFile(join(cwd, 'agent.mjs'), 'export async function createSession() {\n  return { async respond() { return { reply: \'Уточните номер терминала.\' }; } };\n}\n');
  await writeFile(join(cwd, 'support.jsonl'), dialogues.map(dialogue => JSON.stringify(dialogue)).join('\n') + '\n');
  const found = await read();
  assert.doesNotMatch(found.shown, /Скажите, какого агента/, 'what Lab found is not asked for again');
  assert.match(found.shown, /Прогонов пока нет\.\n.*В папке: агент — модуль agent\.mjs · логи — support\.jsonl \(2 разговора\)/);
  assert.deepEqual([found.output.found.agents[0].start, found.output.found.logs[0]], ['модуль agent.mjs', { file: 'support.jsonl', conversations: 2 }]);
  assert.deepEqual(found.output.runs, [], 'looking at the folder writes nothing');
});

test('changes of one situation that fit only together go in one call: one dialog with the whole before → after, one receipt', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-series-');
  const { tools, shutdown } = registered();
  try {
    const { ctx, selects } = terminal(fixture.cwd, ['Пусть в первой ситуации клиент сразу называет номер терминала'], { picks: ['Записать'] });
    const edit = tools.get('agent_lab_edit')!;
    const writes = 'Помогите с возвратом, номер терминала 5678.';
    const alone = json(await edit.execute('alone', { situation: 1, changes: [{ kind: 'fact', fact: 'f1', when: 'initial' }] }, undefined, undefined, ctx));
    assert.match(alone.refused, /Передайте вместе с первой репликой/, 'the refusal names what to pass with it');
    assert.equal(selects.length, 0, 'a refused change asks nothing');
    const receipts = libraryOf(await fixture.read()).receipts.length;
    const together = json(await edit.execute('together', { situation: 1, changes: [{ kind: 'client', writes }, { kind: 'fact', fact: 'f1', when: 'initial' }] }, undefined, undefined, ctx));
    assert.equal(together.applied, true);
    assert.equal(selects.length, 1, 'one native dialog for the whole series');
    assert.match(selects[0]!.title, /Пишет: было .*5678/); assert.match(selects[0]!.title, /Знает: .*сразу/);
    const record = await fixture.read();
    assert.equal(libraryOf(record).receipts.length, receipts + 1);
    assert.equal(libraryOf(record).receipts.at(-1)!.command.kind, 'edit_card');
    assert.deepEqual([cardNumbered(record, 1).client.writes, cardNumbered(record, 1).client.knows[0]!.disclosure], [writes, 'initial']);
    const mixed = json(await edit.execute('mixed', { situation: 1, changes: [{ kind: 'client', leaves: 'получил ответ' }, { kind: 'remove' }] }, undefined, undefined, ctx));
    assert.match(mixed.refused, /Вместе передаются только правки одной ситуации/);
  } finally { await shutdown(); await fixture.cleanup(); }
});
