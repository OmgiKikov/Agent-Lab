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
import { callText } from '../extensions/render/feed.ts';
import type { CardReviewRequest, ReviewVerdict } from '../src/card/review.js';
import type { Card, LibraryV2 } from '../src/card/schema.js';
import { draftHash, ExperimentLab } from '../src/experiment.js';
import { fingerprint, type Experiment, type Runtime } from '../src/contracts.js';
import { createDemoRuntime } from '../src/demo.js';
import { ExperimentStore } from '../src/store.js';
import { cardInput, cardRuntime, dialogues, policy } from './helpers/card-prep.js';
import { READY } from './helpers/card-library.js';
import { demoEvaluateRecord, legacyDemoRuntime, legacyDraft } from './helpers/demo-record.js';

/*
 * The conversational path on a draft of cards: the owner's sentence ──► one narrow Agent Lab tool ──► the stored
 * draft. Every test reads the 0600 store after the call; a message on screen alone proves nothing. What the host
 * needs from the owner comes from the owner: their own words in their message, or a native dialog.
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
    async groundRequirements(input, ctx) { await buildGate; ctx.signal.throwIfAborted(); return base.groundRequirements!(input, ctx); },
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
  /** What the extension appended with `pi.appendEntry`, in the shape `ctx.sessionManager.getEntries()` gives it back after a restart. */
  const entries: { type: 'custom'; customType: string; data: unknown }[] = [];
  let shutdown!: () => Promise<void>;
  agentLab({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand() {}, registerMessageRenderer() {},
    on: (name: string, handler: () => Promise<void>) => { if (name === 'session_shutdown') shutdown = handler; },
    sendMessage: (message: Sent['message'], options: Sent['options']) => { sent.push({ message, options }); }, sendUserMessage() {},
    appendEntry: (customType: string, data: unknown) => { entries.push({ type: 'custom', customType, data }); },
  } as unknown as ExtensionAPI, { createLab: directory => new ExperimentLab(directory, runtime), ...(inlineRunMs === undefined ? {} : { inlineRunMs }), ...(inlineCheckMs === undefined ? {} : { inlineCheckMs }), ...(inlineBuildMs === undefined ? {} : { inlineBuildMs }) });
  return { tools, sent, shutdown, entries };
}

/**
 * A Pi terminal whose session holds exactly what the owner said; `confirm` answers and `select` picks are scripted and recorded.
 * `session.entries` are the custom entries of a reopened session; a pick that is not scripted closes the dialog (undefined).
 */
function terminal(cwd: string, said: string[], answers: boolean[] = [], session: { entries?: unknown[]; picks?: (string | undefined)[]; texts?: (string | undefined)[] } = {}) {
  const confirms: { title: string; body: string }[] = [];
  const selects: { title: string; options: string[] }[] = [];
  const widgets: (string[] | undefined)[] = [];
  /** A widget is Pi's own component (the progress row): drawn once here as the owner would see it, then disposed. */
  const drawWidget = (content: unknown): string[] | undefined => {
    if (typeof content !== 'function') return content as string[] | undefined;
    const component = (content as (tui: unknown, theme: unknown) => Component & { dispose?(): void })({ requestRender() {} }, plainTheme);
    try { return component.render(120).map(line => stripTerminalSequences(line).trim()).filter(Boolean); } finally { component.dispose?.(); }
  };
  const ctx = { cwd, hasUI: true, mode: 'tui',
    sessionManager: { getBranch: () => said.map((content, index) => ({ type: 'message', id: String(index), message: { role: 'user', content } })), getEntries: () => session.entries ?? [] },
    ui: { confirm: async (title: string, body: string) => { confirms.push({ title, body }); return answers.shift() ?? false; },
      select: async (title: string, options: string[]) => { selects.push({ title, options }); return session.picks?.shift(); },
      editor: async () => session.texts?.shift(),
      setStatus() {}, notify() {}, setWidget: (_key: string, content: unknown) => { widgets.push(drawWidget(content)); } },
  } as unknown as ExtensionContext;
  return { ctx, confirms, selects, widgets };
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
  return { cwd, id: seed.id, read, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}
const libraryOf = (record: Experiment) => record.librarySnapshot as LibraryV2;
const cardNumbered = (record: Experiment, number: number): Card => libraryOf(record).cards.find(card => card.number === number)!;
const json = (result: Awaited<ReturnType<ToolDefinition['execute']>>) => JSON.parse(result.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
const plainTheme = { fg: (_tone: string, text: string) => text, bold: (text: string) => text, bg: (_tone: string, text: string) => text };
function drawn(tool: ToolDefinition, result: unknown, expanded: boolean, width = 100): string[] {
  const component = tool.renderResult!(result as never, { expanded, isPartial: false }, plainTheme as never, {} as never) as unknown as Component;
  return component.render(width).map(line => stripTerminalSequences(line).trimEnd());
}

test('the situation tools have small closed schemas: every value is typed, and none takes an approval, a hash or a raw command', () => {
  const { tools } = registered();
  const cardTools = [...tools.values()].filter(tool => tool.name === 'agent_lab_cards' || tool.name.startsWith('agent_lab_card_'));
  assert.deepEqual(cardTools.map(tool => tool.name), ['agent_lab_cards', 'agent_lab_card_answer', 'agent_lab_card_check', 'agent_lab_card_convert', 'agent_lab_card_fact',
    'agent_lab_card_expectation', 'agent_lab_card_client', 'agent_lab_card_similar', 'agent_lab_card_remove']);
  /** Type.Any, Type.Unknown or an open object would take a value the host cannot check. */
  const walk = (schema: unknown, path: string): void => {
    assert.ok(schema && typeof schema === 'object', path);
    const node = schema as { type?: string; anyOf?: unknown[]; const?: unknown; enum?: unknown[]; properties?: Record<string, unknown>; items?: unknown; additionalProperties?: unknown };
    assert.ok(node.type !== undefined || node.anyOf !== undefined || node.const !== undefined || node.enum !== undefined, `${path} takes anything`);
    if (node.type === 'object') assert.equal(node.additionalProperties, false, `${path} is an open object`);
    for (const [key, child] of Object.entries(node.properties ?? {})) walk(child, `${path}.${key}`);
    for (const [index, child] of (node.anyOf ?? []).entries()) walk(child, `${path}|${index}`);
    if (node.items !== undefined) walk(node.items, `${path}[]`);
  };
  for (const tool of cardTools) {
    walk(tool.parameters, tool.name);
    const text = JSON.stringify(tool.parameters);
    assert.ok(text.length < 2500, `${tool.name}: ${text.length} bytes of schema`);
    for (const forbidden of ['approved', 'expectedHash', 'expectedLibraryHash', 'patch', 'command', 'grant', 'authority', 'ownerWords', 'via', 'receipt'])
      assert.ok(!text.includes(`"${forbidden}"`), `${tool.name} offers ${forbidden}`);
  }
});

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
  assert.equal(callText('agent_lab_cards', { card: 2 }), 'Открываю ситуацию 2');
  assert.equal(callText('agent_lab_card_fact', { card: 2, fact: 'f1', disclosure: 'unknown' }), 'Меняю ситуацию 2: что знает клиент');
  assert.equal(callText('agent_lab_card_similar', { card: 1, change: { kind: 'opening', writes: 'x' } }), 'Добавляю похожую на ситуацию 1');
  assert.equal(callText('agent_lab_build', { mode: 'validate', dialoguesFile: '/Users/owner/выгрузка/logs.jsonl' }), 'Собираю ситуации из logs.jsonl');
  assert.equal(callText('agent_lab_run', {}), 'Запускаю прогон');
  assert.equal(callText('agent_lab_inspect', { failure: 2 }), 'Открываю ошибку 2');
});

test('reading: the counts and who waits for an answer, three lines per situation on expand, one situation whole; the session holds no situation text', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-show-', true);
  const { tools, shutdown } = registered();
  try {
    const { ctx } = terminal(fixture.cwd, ['Покажи ситуации']);
    const cards = tools.get('agent_lab_cards')!;
    const list = await cards.execute('list', {}, undefined, undefined, ctx);
    const payload = json(list);
    assert.deepEqual([payload.readOnly, payload.counts], [false, '2 ситуации: 1 готова · 1 ждёт вашего ответа']);
    assert.deepEqual(payload.situations.map((item: { number: number; status: string }) => [item.number, item.status]), [[1, 'needs_owner'], [2, 'ready']]);
    assert.deepEqual(Object.keys(payload.situations[0]), ['number', 'title', 'status', 'question'], 'a list stays small: the whole brief is read by number');
    assert.deepEqual(payload.situations[0].question.answers.map((answer: { number: number; label: string }) => `${answer.number} ${answer.label}`), ['1 Да', '2 Не знал', '3 Убрать']);
    // Claude-Code-like: the answer hangs under the action, one to three lines, the list behind ctrl+o.
    assert.deepEqual(drawn(cards, list, false).slice(0, 2), ['  └ 2 ситуации: 1 готова · 1 ждёт вашего ответа', '    Ждут ответа: 1 Возврат оплаты — номер по просьбе']);
    const expanded = drawn(cards, list, true).join('\n');
    assert.match(expanded, /^ +1 {2}Возврат оплаты — номер по просьбе +\? нужен ваш ответ$/m);
    assert.match(expanded, /Клиент: «Номер терминала: 1234\. Помогите с возвратом\.»/);
    const one = await cards.execute('one', { card: 1, details: true }, undefined, undefined, ctx);
    assert.deepEqual(json(one).situation.knows, [{ id: 'f1', what: 'Номер терминала: 5678', when: 'если спросят' }], 'one situation gives the model the ids a command names');
    assert.match(drawn(cards, one, false).join('\n'), /Вопрос: Клиент знал «Номер терминала» до разговора\?/);
    const whole = drawn(cards, one, true).join('\n');
    assert.match(whole, /Хочет {4}Получить инструкцию по возврату оплаты/); assert.match(whole, /Как это проверяется/);
    for (const result of [list, one]) assert.doesNotMatch(JSON.stringify(result.details), /Возврат|терминал|5678/i, 'REV-01: the session file gets ids only');
    const unknown = json(await cards.execute('none', { card: 9 }, undefined, undefined, ctx));
    assert.equal(unknown.status, 'unknown_reference');
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('what the customer knows is the owner\'s decision: the native dialog shows «было → стало», and only «Записать» writes it', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-fact-');
  const { tools, shutdown } = registered();
  try {
    const { ctx, selects } = terminal(fixture.cwd, ['Клиент в первой ситуации не знает номер терминала'], [], { picks: ['Не записывать', 'Записать'] });
    const fact = tools.get('agent_lab_card_fact')!;
    const declined = json(await fact.execute('no', { card: 1, fact: 'f1', disclosure: 'unknown' }, undefined, undefined, ctx));
    assert.equal(declined.declined, true);
    assert.match(selects[0]!.title, /1 {2}Знает: было «Номер терминала: 5678 — если спросят», стало «Номер терминала — не знает»/);
    assert.deepEqual(selects[0]!.options, ['Записать', 'Не записывать']);
    assert.equal(cardNumbered(await fixture.read(), 1).client.knows[0]!.disclosure, 'on_request', 'a declined change writes nothing');
    const written = await fact.execute('yes', { card: 1, fact: 'f1', disclosure: 'unknown' }, undefined, undefined, ctx);
    const record = await fixture.read();
    const card = cardNumbered(record, 1);
    assert.deepEqual([card.client.knows[0]!.disclosure, card.client.knows[0]!.source.kind, card.revision], ['unknown', 'owner', 2]);
    const receipt = libraryOf(record).receipts.at(-1)!;
    assert.deepEqual([receipt.via, receipt.command.kind, receipt.ownerWords], ['pi-confirm', 'set_fact_disclosure', undefined]);
    const rows = drawn(fact, written, false).join('\n');
    assert.match(rows, /^ {2}└ Ситуация 1 готова · версия 2$/m, 'the changed situation was checked again in the same row, and names its new version');
    assert.match(rows, /Знает: было «Номер терминала: 5678 — если спросят», стало «Номер терминала — не знает»/);
    assert.doesNotMatch(JSON.stringify(written.details), /терминал|5678/i);
    const missing = json(await fact.execute('missing', { card: 1, fact: 'f7', disclosure: 'unknown' }, undefined, undefined, ctx));
    assert.equal(missing.status, 'unknown_reference'); assert.deepEqual(missing.options, ['f1 Номер терминала']);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('the customer\'s words the owner wrote are recorded as they are, with no dialog; words the model chose wait for the owner', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-words-');
  const { tools, shutdown } = registered();
  try {
    const writes = 'Добрый день! Номер терминала: 1234, хочу вернуть деньги';
    const { ctx, selects } = terminal(fixture.cwd, [`Пусть во второй ситуации клиент пишет: «${writes}»`], [], { picks: ['Не записывать'] });
    const client = tools.get('agent_lab_card_client')!;
    const own = json(await client.execute('own', { card: 2, writes }, undefined, undefined, ctx));
    assert.equal(own.applied, true); assert.equal(selects.length, 0, 'the owner\'s own words need no dialog');
    const record = await fixture.read();
    assert.deepEqual([cardNumbered(record, 2).client.writes, cardNumbered(record, 2).client.writesSource.kind], [writes, 'owner']);
    assert.deepEqual([libraryOf(record).receipts.at(-1)!.ownerWords, libraryOf(record).receipts.at(-1)!.via], [writes, 'pi-confirm']);
    const proposed = json(await client.execute('model', { card: 2, leaves: 'получил номер заявки на возврат' }, undefined, undefined, ctx));
    assert.equal(proposed.declined, true);
    assert.match(selects[0]!.title, /Уходит: было «получил инструкцию по возврату или понял, что агент не поможет», стало «получил номер заявки на возврат»/);
    assert.equal(cardNumbered(await fixture.read(), 2).client.leaves, 'получил инструкцию по возврату или понял, что агент не поможет');
    const mixed = json(await client.execute('mixed', { card: 2, wants: 'x', turn: null }, undefined, undefined, ctx));
    assert.match(mixed.refused, /по одному/);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('a situation\'s question is answered in a native dialog of the question itself, and the answer is kept with its basis', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-answer-', true);
  const { tools, shutdown } = registered();
  try {
    const { ctx, selects } = terminal(fixture.cwd, ['Да, клиент знал номер заранее'], [], { picks: ['1  Да'] });
    const answer = tools.get('agent_lab_card_answer')!;
    const result = json(await answer.execute('answer', { card: 1, choice: 1 }, undefined, undefined, ctx));
    assert.match(selects[0]!.title, /^Ситуация 1 «Возврат оплаты — номер по просьбе»\n\nКлиент знал «Номер терминала» до разговора\?[^\n]*\n\nВ разговоре вы ответили: «Да»$/);
    assert.deepEqual(selects[0]!.options, ['1  Да', '2  Не знал', '3  Убрать', 'Не сейчас']);
    assert.equal(result.situation.status, 'ready');
    const receipt = libraryOf(await fixture.read()).receipts.at(-1)!;
    assert.equal(receipt.command.kind, 'settle_claim'); assert.match(receipt.basisHash ?? '', /^[a-f0-9]{64}$/);
    assert.match(json(await answer.execute('again', { card: 1 }, undefined, undefined, ctx)).refused, /нет открытого вопроса/);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('«добавь случай, где клиент не знает номер» is one call: a new situation, the original byte for byte the same', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-similar-');
  const { tools, shutdown } = registered();
  try {
    const parent = cardNumbered(await fixture.read(), 2);
    const { ctx, selects } = terminal(fixture.cwd, ['Добавь случай, где клиент не знает номер терминала'], [], { picks: ['Записать'] });
    const result = json(await tools.get('agent_lab_card_similar')!.execute('similar', { card: 2,
      change: { kind: 'disclosure', fact: 'f1', disclosure: 'unknown', writes: 'Помогите с возвратом, номер терминала не помню.' } }, undefined, undefined, ctx));
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
    const { ctx, selects } = terminal(fixture.cwd, ['Убери вторую ситуацию'], [], { picks: ['Записать'] });
    const remove = tools.get('agent_lab_card_remove')!;
    const unknown = json(await remove.execute('unknown', { card: 9 }, undefined, undefined, ctx));
    assert.equal(unknown.status, 'unknown_reference'); assert.deepEqual(unknown.options, ['№1 Возврат оплаты — номер по просьбе', '№2 Возврат оплаты — номер назван сразу']);
    assert.equal(selects.length, 0);
    const removed = await remove.execute('remove', { card: 2 }, undefined, undefined, ctx);
    assert.match(selects[0]!.title, /Убрать ситуацию 2 «Возврат оплаты — номер назван сразу» из черновика\?/);
    assert.deepEqual(libraryOf(await fixture.read()).cards.map(card => card.number), [1]);
    assert.match(drawn(remove, removed, false).join('\n'), /Ситуация 2 убрана из черновика/);
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
      const refused = json(await tools.get('agent_lab_card_remove')!.execute('remove', { card: 1 }, undefined, undefined, ctx));
      assert.match(refused.refused, /записаны до наборов ситуаций: их можно посмотреть и повторить, но не изменить/);
    } finally { await shutdown(); }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('one dialog runs the ready situations: «Принять 1 ситуацию и запустить?» with its plan; «Не сейчас» writes nothing', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-run-', true);
  const { tools, shutdown } = registered();
  try {
    const { ctx, selects } = terminal(fixture.cwd, ['Запусти готовые'], [], { picks: ['Не сейчас', 'Запустить'] });
    const run = tools.get('agent_lab_run')!;
    const declined = json(await run.execute('no', {}, undefined, undefined, ctx));
    assert.equal(declined.cancelled, true);
    const plan = selects[0]!.title;
    for (const part of [/^Принять 1 ситуацию и запустить\?/, /1 ситуация · 1 разговор: клиента играет Lab, ответы агента оценивает судья\./, /Судья: по 2 голоса на каждое ожидание — до 4 вызовов на попытку, всего до 4\./,
      /Не войдут: 1 ждёт вашего ответа/, /Вместе с запуском Lab утвердит эти ситуации — повтор пойдёт по ним же\./]) assert.match(plan, part);
    assert.deepEqual(selects[0]!.options, ['Запустить', 'Не сейчас']);
    assert.equal(libraryOf(await fixture.read()).acceptance, undefined, 'declining accepts nothing');
    const result = await run.execute('yes', {}, undefined, undefined, ctx);
    assert.equal((result.details as { kind?: string }).kind, 'agent-lab/verdict');
    const record = await fixture.read();
    assert.deepEqual(libraryOf(record).acceptance!.cardIds, [cardNumbered(record, 2).id], 'the situation that waits for the owner stays out');
    assert.deepEqual([record.trials.length, record.phase], [1, 'results_review']);
    const again = await run.execute('again', {}, undefined, undefined, ctx).catch(error => error as Error);
    assert.match(again instanceof Error ? again.message : '', /уже выполнен, его результат не меняется/);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('a change asked for after a run goes into a fresh draft of the same set; the finished run never changes', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-after-run-');
  const { tools, shutdown } = registered();
  try {
    const { ctx } = terminal(fixture.cwd, ['Запусти, а потом клиент во второй ситуации пусть не знает номер'], [], { picks: ['Запустить', 'Записать'] });
    await tools.get('agent_lab_run')!.execute('run', {}, undefined, undefined, ctx);
    const finished = await fixture.read();
    assert.equal(finished.phase, 'results_review');
    const changed = json(await tools.get('agent_lab_card_fact')!.execute('fact', { id: fixture.id, card: 1, fact: 'f1', disclosure: 'unknown' }, undefined, undefined, ctx));
    assert.equal(changed.unchangedRunId, fixture.id); assert.notEqual(changed.runId, fixture.id); assert.match(changed.instruction, /fresh draft/);
    assert.equal(fingerprint(await fixture.read()), fingerprint(finished), 'the run that happened is untouched');
    const draftRecord = await new ExperimentStore(join(fixture.cwd, '.agent-lab')).get(changed.runId);
    assert.deepEqual([draftRecord.phase, draftRecord.parentRunId, cardNumbered(draftRecord, 1).client.knows[0]!.disclosure], ['review', fixture.id, 'unknown']);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('a long run leaves the conversation free: Esc does not stop it, progress is real, changes wait, and the result arrives as a message', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-run-background-');
  const { tools, sent, shutdown } = registered(60_000);
  const release = await holdReplies();
  try {
    const { ctx, widgets } = terminal(fixture.cwd, ['Запусти готовые'], [], { picks: ['Запустить'] });
    const run = tools.get('agent_lab_run')!;
    const escape = new AbortController();
    const started = run.execute('run', {}, escape.signal, undefined, ctx);
    // Esc while the run goes (its replies are held).
    while ((await fixture.read()).phase !== 'evaluating') await new Promise(resolve => setTimeout(resolve, 20));
    escape.abort();
    const result = await started;
    assert.equal(json(result).background, true); assert.match(drawn(run, result, false).join('\n'), /Прогон идёт: 2 разговора[\s\S]*Результат придёт сюда сообщением/);
    assert.equal((await fixture.read()).phase, 'evaluating', 'interrupting the action does not stop the run');
    const progress = json(await run.execute('progress', { action: 'progress' }, undefined, undefined, ctx));
    assert.deepEqual([progress.running, progress.finishedDialogues, progress.plannedDialogues], [true, 0, 2]);
    assert.equal(json(await tools.get('agent_lab_cards')!.execute('read', {}, undefined, undefined, ctx)).situations.length, 2, 'reading works while the run goes');
    const change = await tools.get('agent_lab_card_remove')!.execute('remove', { card: 1 }, undefined, undefined, ctx).catch(error => error as Error);
    assert.match(change instanceof Error ? change.message : '', /^Сейчас идёт прогон\. .* правки и новый запуск — после его завершения или остановки/);
    await release();
    while (!sent.length) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sent[0]!.message.customType, 'agent-lab-run'); assert.deepEqual(sent[0]!.options, { deliverAs: 'followUp', triggerTurn: true });
    assert.equal((sent[0]!.message.details as { kind: string }).kind, 'agent-lab/verdict'); assert.equal(JSON.parse(sent[0]!.message.content).trialCount, 2);
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
    const { ctx, selects } = terminal(fixture.cwd, said, [], { picks: ['Запустить'] });
    const run = tools.get('agent_lab_run')!;
    assert.equal(json(await run.execute('run', {}, undefined, undefined, ctx)).background, true);
    said.push('Останови прогон');
    const other = json(await run.execute('stop-other', { action: 'stop', id: 'no-such-run-0000' }, undefined, undefined, ctx));
    assert.equal(other.status, 'unknown_reference'); assert.equal((await fixture.read()).phase, 'evaluating', 'a run the owner did not name is never stopped in its place');
    const pending = run.execute('stop', { action: 'stop', id: fixture.id }, undefined, undefined, ctx);
    await release();
    const stopped = await pending;
    assert.equal(json(stopped).stopped, true); assert.equal(selects.length, 1, 'the owner\'s own request needs no second confirmation');
    assert.match(drawn(run, stopped, false).join('\n'), /Прогон остановлен: сохранено \d из 2 разговоров[\s\S]*С места остановки не продолжить/);
    assert.equal(sent.length, 0, 'a stop the owner asked for is answered in its own row, not announced twice');
    assert.ok(['cancelled', 'results_review'].includes((await fixture.read()).phase));
  } finally { await release(); await shutdown(); await fixture.cleanup(); }
});

/** A preparation asked for in the conversation: the same rule and dialogues `draft()` seeds, built through the tool. */
const buildRequest = { task: 'Проверить возвраты', target: chatAgent, materials: [{ name: 'Правила возвратов', content: policy }], dialogues, scenarioCount: 1,
  settings: { maxCalls: 60, repeats: 1, maxTurns: 3, userModes: ['reactive'] } };
async function preparing(prefix: string) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  runtime = runtimeFixture(true);
  const stored = async () => new ExperimentStore(join(cwd, '.agent-lab')).list();
  return { cwd, stored, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

test('a long preparation leaves the conversation free: changes wait for it by name, and the situations arrive as one message', { timeout: 60000 }, async () => {
  const fixture = await preparing('chat-build-background-');
  const { tools, sent, shutdown } = registered(undefined, undefined, 0);
  let release!: () => void;
  buildGate = new Promise<void>(resolve => { release = resolve; });
  try {
    const { ctx, widgets } = terminal(fixture.cwd, ['Собери ситуации по этим логам']);
    const build = tools.get('agent_lab_build')!, run = tools.get('agent_lab_run')!;
    const result = await build.execute('build', buildRequest, undefined, undefined, ctx);
    assert.equal(json(result).background, true); assert.match(json(result).instruction, /do not poll/);
    const [record] = await fixture.stored();
    assert.deepEqual([record!.phase, record!.librarySnapshot], ['preparing', undefined], 'the stored record is still being prepared');
    const progress = json(await run.execute('progress', { action: 'progress' }, undefined, undefined, ctx));
    assert.deepEqual([progress.running, progress.preparation, progress.ownedByThisSession], [true, true, true]);
    const second = await build.execute('build-2', buildRequest, undefined, undefined, ctx).catch(error => error as Error);
    assert.match(second instanceof Error ? second.message : '', /^Сейчас идёт подготовка ситуаций\. .* правки и новый запуск — после её завершения или остановки/);
    release();
    while (!sent.length) await new Promise(resolve => setTimeout(resolve, 20));
    while (widgets.at(-1) !== undefined) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sent.length, 1, 'exactly one message reports the preparation');
    assert.equal(sent[0]!.message.customType, 'agent-lab-build'); assert.deepEqual(sent[0]!.options, { deliverAs: 'followUp', triggerTurn: true });
    const finished = (await fixture.stored())[0]!;
    assert.deepEqual([finished.phase, libraryOf(finished).cards.length], ['review', 2]);
    const content = JSON.parse(sent[0]!.message.content);
    assert.deepEqual([content.id, content.counts, content.situations.length], [finished.id, '2 ситуации: 1 готова · 1 ждёт вашего ответа', 2]);
    assert.doesNotMatch(JSON.stringify(sent[0]!.message.details), /Возврат|терминал/i, 'the session file gets ids only');
    const rows = drawn(build, { content: [{ type: 'text', text: '' }], details: sent[0]!.message.details }, false).join('\n');
    assert.match(rows, /└ 2 ситуации: 1 готова · 1 ждёт вашего ответа/); assert.match(rows, /Готовые можно запустить сразу — скажите «запусти»; вопросы подождут\./);
    // The lock went back with the message: the next change is taken.
    const { ctx: next } = terminal(fixture.cwd, ['Убери вторую ситуацию'], [], { picks: ['Записать'] });
    assert.equal(json(await tools.get('agent_lab_card_remove')!.execute('remove', { card: 2 }, undefined, undefined, next)).applied, true);
  } finally { buildGate = undefined; release(); await shutdown(); await fixture.cleanup(); }
});

test('Esc during a preparation interrupts the action, not the work; stopping it is the owner\'s request and says what was saved', { timeout: 60000 }, async () => {
  const fixture = await preparing('chat-build-escape-');
  const { tools, sent, shutdown } = registered(undefined, undefined, 60_000);
  let release!: () => void;
  buildGate = new Promise<void>(resolve => { release = resolve; });
  try {
    const { ctx } = terminal(fixture.cwd, ['Собери ситуации по этим логам']);
    const escape = new AbortController();
    const started = tools.get('agent_lab_build')!.execute('build', buildRequest, escape.signal, undefined, ctx);
    // Esc while the preparation goes (it is held before its first model step).
    while (!(await fixture.stored()).length) await new Promise(resolve => setTimeout(resolve, 20));
    escape.abort();
    const built = json(await started);
    assert.equal(built.background, true);
    assert.equal((await fixture.stored())[0]!.phase, 'preparing', 'interrupting the action does not cancel the preparation');
    const pending = tools.get('agent_lab_run')!.execute('stop', { action: 'stop', id: built.id }, undefined, undefined, ctx);
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
    const { ctx } = terminal(fixture.cwd, ['Во второй ситуации клиент пусть не знает номер терминала'], [], { picks: ['Записать'] });
    checkGate = new Promise<void>(resolve => { release = resolve; });
    const changed = await tools.get('agent_lab_card_fact')!.execute('fact', { card: 1, fact: 'f1', disclosure: 'unknown' }, undefined, undefined, ctx);
    assert.equal(json(changed).check.status, 'running');
    assert.match(drawn(tools.get('agent_lab_card_fact')!, changed, false).join('\n'), /Ситуация 1 проверяется[\s\S]*Проверяю изменённую ситуацию в фоне/);
    assert.equal(sent.length, 0);
    assert.equal(json(await tools.get('agent_lab_cards')!.execute('read', { card: 1 }, undefined, undefined, ctx)).situation.status, 'checking', 'reading works while the check runs');
    release();
    while (!sent.length) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sent[0]!.message.customType, 'agent-lab-check');
    assert.deepEqual(sent[0]!.options, { deliverAs: 'followUp', triggerTurn: false }, 'a situation that became ready needs no turn');
    assert.equal(JSON.parse(sent[0]!.message.content).situation.status, 'ready');
    const nothing = json(await tools.get('agent_lab_card_check')!.execute('check', {}, undefined, undefined, ctx));
    assert.equal(nothing.check.status, 'none');
  } finally { checkGate = undefined; release(); await shutdown(); await fixture.cleanup(); }
});

test('results of a run recorded before the card format: a failure opens by its number, a repeat runs again and is compared with its source', { timeout: 60000 }, async () => {
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
    const { ctx, selects } = terminal(cwd, ['Покажи первый провал'], [], { picks: ['Запустить'] });
    const inspect = tools.get('agent_lab_inspect')!;
    const status = await tools.get('agent_lab_status')!.execute('status', {}, undefined, undefined, ctx);
    assert.equal(json(status).runs[0].id, source.id); assert.match(drawn(tools.get('agent_lab_status')!, status, false).join('\n'), /1 прогон: последний — .*точность \d+%/);
    const failure = await inspect.execute('failure', { failure: 1 }, undefined, undefined, ctx);
    const payload = json(failure);
    assert.deepEqual(Object.keys(payload.failure), ['number', 'of', 'title', 'kind', 'lines']);
    const rows = drawn(inspect, failure, false);
    assert.equal(rows[0], `  └ ✗ 1  ${payload.failure.title}`);
    // Expected, the agent's words and the rule: the three lines the owner reads first; the conversation behind ctrl+o.
    assert.match(rows.join(' '), /Ожидалось: .* · Агент: /); assert.match(rows.join(' '), /Правило: «|нет правила из ваших материалов/);
    assert.match(drawn(inspect, failure, true).join('\n'), /Разговор\n {6}Клиент {3}/);
    assert.equal(json(await inspect.execute('missing', { failure: 99 }, undefined, undefined, ctx)).status, 'unknown_reference');
    const repeated = json(await tools.get('agent_lab_repeat')!.execute('repeat', { scenarios: [source.scenarios[0]!.title] }, undefined, undefined, ctx));
    assert.deepEqual([repeated.scenarioCount, repeated.parentRunId], [1, source.id]);
    assert.equal(json(await tools.get('agent_lab_run')!.execute('rerun', {}, undefined, undefined, ctx)).trialCount, 1, 'the repeat is the run the conversation now works on');
    assert.match(selects[0]!.title, /^Подтвердить ожидания и запустить\?/, 'an older draft confirms its expectations with the run, in the same dialog');
    const comparison = await inspect.execute('compare', { compare: true }, undefined, undefined, ctx);
    assert.equal(json(comparison).comparisonSource.beforeId, source.id);
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
    const { ctx, selects } = terminal(cwd, ['Покажи первый провал. Да, согласен с судьёй'], [], { picks: [undefined, 'Да, судья прав'] });
    const agree = tools.get('agent_lab_agree')!;
    const skipped = json(await agree.execute('skip', { failure: 1 }, undefined, undefined, ctx));
    assert.equal(skipped.cancelled, true); assert.equal((await new ExperimentStore(join(cwd, '.agent-lab')).get(demo.record.id)).humanReviews?.length ?? 0, 0, 'no answer in the dialog, no mark');
    const marked = await agree.execute('mark', { failure: 1 }, undefined, undefined, ctx);
    assert.match(selects[1]!.title, /судья решил: не справился\. Судья прав\?/);
    assert.deepEqual(selects[1]!.options, ['Да, судья прав', 'Нет, судья ошибся', 'Не знаю']);
    const reviews = (await new ExperimentStore(join(cwd, '.agent-lab')).get(demo.record.id)).humanReviews ?? [];
    assert.ok(reviews.length >= 1); assert.ok(reviews.every(item => item.source === 'quick' && item.verdict === 'fail' && item.judgeVerdict === 'fail'));
    assert.match(drawn(agree, marked, false).join('\n'), /Отмечено: согласен с судьёй/);
  } finally { await shutdown(); await rm(cwd, { recursive: true, force: true }); await rm(demo.directory, { recursive: true, force: true }); }
});

test('shown lists survive a restart of Pi: «второй прогон» still means the row the owner saw', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-shown-restart-');
  const first = registered();
  try {
    const { ctx } = terminal(fixture.cwd, ['Запусти готовые'], [], { picks: ['Запустить'] });
    await first.tools.get('agent_lab_run')!.execute('run', {}, undefined, undefined, ctx);
    await first.tools.get('agent_lab_repeat')!.execute('repeat', {}, undefined, undefined, ctx);
    const status = json(await first.tools.get('agent_lab_status')!.execute('status', {}, undefined, undefined, ctx));
    await first.tools.get('agent_lab_status')!.execute('status-again', {}, undefined, undefined, ctx);
    const lists = first.entries.filter(entry => entry.customType === 'agent-lab-shown' && (entry.data as { kind: string }).kind === 'runs');
    assert.equal(lists.length, 1, 'the same list shown twice is written once');
    assert.doesNotMatch(JSON.stringify(first.entries), /Проверить возвраты|Возврат|терминал/i, 'REV-01: the session gets ids only');
    await first.shutdown();
    // The second row of the shown list is touched, so a fresh newest-first query now puts it first.
    const store = new ExperimentStore(join(fixture.cwd, '.agent-lab'));
    await store.init();
    try { await store.save({ ...await store.get(status.runs[1].id), updatedAt: new Date(Date.now() + 60_000).toISOString() }); } finally { await store.close(); }
    const reopened = registered();
    const restored = terminal(fixture.cwd, ['Как там второй прогон?'], [], { entries: first.entries });
    assert.equal(json(await reopened.tools.get('agent_lab_run')!.execute('progress', { action: 'progress', id: '2' }, undefined, undefined, restored.ctx)).id, status.runs[1].id, 'number 2 is the row that was shown before the restart');
    await reopened.shutdown();
  } finally { await first.shutdown(); await fixture.cleanup(); }
});
