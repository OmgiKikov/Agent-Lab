import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, test } from 'node:test';
import { initTheme, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, type Component } from '@earendil-works/pi-tui';
import agentLab from '../extensions/agent-lab.ts';
import { authorize, planLines, changeRows, deriveVariantInput, ownerBasis, ownerMessages, plainIssue, verbatimSpan, resolveVariant, variantDiff } from '../extensions/conversation.ts';
import { callText, forgetFeeds } from '../extensions/render/feed.ts';
import { draftHash, ExperimentLab } from '../src/experiment.js';
import { recordSemanticAssessment, semanticPaths } from '../src/scenario-library.js';
import { createInputSchema, type Experiment, type Runtime } from '../src/contracts.js';
import { createDemoRuntime } from '../src/demo.js';
import { acceptLibrary, compileLibrary, editLibrary, libraryHash, librarySnapshot, verifyAcceptedRun, ownerFactEvidence, resolutionBusinessHash, resolutionHash, resolutionQuestionHash } from '../src/scenario-library.js';
import { libraryV1Schema } from '../src/scenario-contracts.js';
import { ExperimentStore } from '../src/store.js';
import { demoEvaluateRecord, legacyDemoRuntime, legacyDraft } from './helpers/demo-record.js';
import { libraryFixture, coverageProposals as proposals, rawDialogues, requirements, sources } from './helpers/scenario-library.js';

/*
 * The conversational path: the owner's sentence ──► one Agent Lab tool call ──► the stored library.
 * Every test reads the 0600 store after the call; a message on screen alone proves nothing.
 */

/** The agent under test: a module that always asks for the terminal number. */
const chatAgent = { kind: 'module' as const, path: fileURLToPath(new URL('./fixtures/board-chat-agent.mjs', import.meta.url)), exportName: 'createSession' };
const existingAgent = { name: 'Агент', instructions: 'Уточните номер терминала', tools: [] };
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
/** Holds the semantic recheck, so a test can watch the conversation go on while it runs. */
let checkGate: Promise<void> | undefined;
let checkCalls = 0;
/** Holds the preparation before its first model step, so a test can watch the conversation go on while scenarios are being built. */
let buildGate: Promise<void> | undefined;
/** The deterministic runtime of the scenario workflow tests. */
function runtimeFixture(separateGroups = false, twoChecks = false): Runtime {
  return { ...createDemoRuntime(),
    async groundRequirements(_input, ctx) { await buildGate; ctx.signal.throwIfAborted(); return { requirements: requirements.map(r => ({ ...r, sourceId: 'source-1' })), questions: [] }; },
    async scenarioProposals(request, ctx) { ctx.beforeCall(); return proposals(request.batchId).map((p, index) => {
      if (twoChecks && !index) p.variant.evaluationSpec.checkpoints.push({ ...p.variant.evaluationSpec.checkpoints[0]!, id: 'explain_refund', rule: 'Агент объяснил порядок возврата после получения номера' });
      return separateGroups && index ? { ...p, business: { ...p.business, key: 'refund_term', title: 'Срок возврата', goal: 'Узнать срок возврата' } } : p;
    }).filter(p => request.dialogues.some(d => d.id === p.variant.sourceDialogues[0]!.dialogueId)) as never; },
    async assessScenarioProposals(request, ctx) { ctx.beforeCall(); checkCalls++; await checkGate; ctx.signal.throwIfAborted();
      return request.fields.flatMap(f => f.paths.map(path => ({ variantId: f.variantId, path, status: 'ready' as const, reason: 'Детерминированная проверка учебного примера' }))); },
    async selectUserAction() { return { actionId: 'finish' }; },
    // Every expectation of the card passes on the agent's first reply.
    async assess({ scenario, trial }) {
      const reply = trial.events.find(e => e.type === 'assistant')!.seq;
      return (scenario.metrics ?? []).map(metric => ({ metricId: metric.id, result: 'pass' as const, rationale: 'Номер запрошен', evidence: [reply] }));
    },
  } as Runtime;
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
function terminal(cwd: string, said: string[], answers: boolean[] = [], session: { entries?: unknown[]; picks?: (string | undefined)[] } = {}) {
  const confirms: { title: string; body: string }[] = [];
  const selects: { title: string; options: string[] }[] = [];
  const widgets: (string[] | undefined)[] = [];
  const ctx = { cwd, hasUI: true, mode: 'tui',
    sessionManager: { getBranch: () => said.map((content, index) => ({ type: 'message', id: String(index), message: { role: 'user', content } })), getEntries: () => session.entries ?? [] },
    ui: { confirm: async (title: string, body: string) => { confirms.push({ title, body }); return answers.shift() ?? false; },
      select: async (title: string, options: string[]) => { selects.push({ title, options }); return session.picks?.shift(); },
      setStatus() {}, notify() {}, setWidget: (_key: string, lines: string[] | undefined) => { widgets.push(lines); } },
  } as unknown as ExtensionContext;
  return { ctx, confirms, selects, widgets };
}

async function draft(prefix: string, separateGroups = false, twoChecks = false) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  runtime = runtimeFixture(separateGroups, twoChecks);
  const lab = new ExperimentLab(join(cwd, '.agent-lab'), runtime);
  await lab.init();
  const seed = await lab.create(createInputSchema.parse({ task: 'Проверить возвраты', mode: 'demo', materials: sources.map(({ name, content }) => ({ name, content })),
    dialogues: rawDialogues, scenarioCount: 2, target: chatAgent, existingAgent, settings: { maxCalls: 100, repeats: 1, userModes: ['reactive'] } }));
  await lab.waitForIdle();
  await lab.close();
  const read = async () => { const store = new ExperimentStore(join(cwd, '.agent-lab')); return store.get(seed.id); };
  return { cwd, id: seed.id, read, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}
/** Two explicitly disputed instances of the same rule; the first card also has an unrelated policy question. */
async function sharedQuestionDraft(prefix: string, second: 'shared' | 'different' | 'blocked' = 'shared') {
  const fixture = await draft(prefix);
  const lab = new ExperimentLab(join(fixture.cwd, '.agent-lab'), runtime);
  await lab.init();
  try {
    const before = await lab.readLibrary(fixture.id);
    const findings = before.library.variants.flatMap(variant => semanticPaths(variant).map(path => {
      const checkpoint = path.startsWith('evaluationSpec.checkpoints.');
      return { variantId: variant.id, path,
        status: checkpoint ? variant.id === 'variant_2' && second === 'blocked' ? 'blocked' as const : 'needs_review' as const
          : variant.id === 'variant_1' && path === 'behaviorPolicy' ? 'needs_review' as const : 'ready' as const,
        reason: checkpoint ? variant.id === 'variant_2' && second === 'different' ? 'Не определено, применимо ли правило после отмены запроса.'
          : 'Владелец ещё не подтвердил применимость правила в этой ситуации.' : 'Отдельный вопрос о поведении клиента.' };
    }));
    const questioned = recordSemanticAssessment(before.library, findings);
    await lab.store.publishLibrary({ ...before.experiment, librarySnapshot: questioned }, questioned, libraryHash(before.library));
  } finally { await lab.close(); }
  return fixture;
}
const json = (result: Awaited<ReturnType<ToolDefinition['execute']>>) => JSON.parse(result.content.filter(part => part.type === 'text').map(part => part.text).join('\n'));
const plainTheme = { fg: (_tone: string, text: string) => text, bold: (text: string) => text, bg: (_tone: string, text: string) => text };
function drawn(tool: ToolDefinition, result: unknown, expanded: boolean, width = 100): string[] {
  const component = tool.renderResult!(result as never, { expanded, isPartial: false }, plainTheme as never, {} as never) as unknown as Component;
  return component.render(width).map(line => stripTerminalSequences(line).trimEnd());
}

test('owner words come only from user entries of the session, and an edit is recorded under them', () => {
  const ctx = { sessionManager: { getBranch: () => [
    { type: 'message', message: { role: 'user', content: 'Собери сценарии' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Владелец сказал: номер 9999' }] } },
    { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'номер 7777' }] } },
    { type: 'custom_message', customType: 'agent-lab-run', content: 'номер 5555' },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Объедини эти две группы' }] } },
  ] } };
  const said = ownerMessages(ctx);
  assert.deepEqual(said, ['Собери сценарии', 'Объедини эти две группы']);
  assert.equal(ownerBasis(said)?.reason, 'Владелец в разговоре: «Объедини эти две группы»');
  assert.equal(ownerBasis(said, 'собери   СЦЕНАРИИ')?.source, 'quote', 'a quote is matched without case and spacing');
  assert.equal(ownerBasis(said, 'номер 9999')?.source, 'latest', 'model text is never found as an owner quote');
  assert.equal(ownerBasis([]), null);
  assert.equal(verbatimSpan('кнопка Оплатить', ['на экране кнопка Оплатить']), true, 'a word that merely ends in «не» is not a negation');
  assert.equal(verbatimSpan('меняй номер', ['Не меняй номер на 5678']), false, 'a phrase right after a standalone «не» is not the owner asking for it');
});

test('draft authorship does not certify model wording as an owner decision', () => {
  const base = { messages: ['Перефразируй начало первой карточки'], summary: 'Новое начало' };
  assert.equal(authorize({ ...base, simulated: ['Здравствуйте, помогите вернуть оплату.'] }).kind, 'conversation');
  assert.equal(authorize({ ...base, simulated: ['Номер 1234'], known: ['Номер: 1234'] }).kind, 'conversation');
  assert.equal(authorize({ ...base, simulated: ['Номер 9999'] }).kind, 'ask');
  assert.equal(authorize({ ...base, attributed: ['Агент обязан предложить рассрочку'] }).kind, 'confirm');
  assert.equal(authorize({ ...base, provenance: true }).kind, 'confirm');
  assert.equal(authorize({ ...base, messages: [] }).kind, 'confirm');
  assert.equal(authorize({ ...base, messages: ['Поправь: клиент не знает номер'], attributed: ['клиент знает номер'] }).kind, 'confirm');
});

// Natural-language operation and scope selection are exercised by test/live/conversation-routing.ts.
// These adapter tests choose calls explicitly, so they cannot establish whether the outer model follows a prohibition.

test('natural edit requests persist model-written openings without owner retyping or a native confirmation', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-natural-edit-');
  const { tools, shutdown } = registered();
  try {
    const said = ['Покажи сценарии'];
    const { ctx, confirms } = terminal(fixture.cwd, said);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    const requests = [
      ['Перефразируй начало первой карточки', 'Здравствуйте, помогите, пожалуйста, вернуть оплату.'],
      ['Можешь сделать начало первой карточки естественнее?', 'Подскажите, пожалуйста, как вернуть оплату?'],
      ['Можете сделать начало первой карточки естественнее?', 'Добрый день! Нужна помощь с возвратом оплаты.'],
    ];
    for (const [index, [message, value]] of requests.entries()) {
      said.push(message!);
      const result = json(await tool.execute(`natural-edit-${index}`, { operation: 'edit', variant: '1', verify: 'later', change: { field: 'opening', value } }, undefined, undefined, ctx));
      assert.equal(result.mutated, true, message);
      const card = (await fixture.read()).librarySnapshot!.variants.find(item => item.id === 'variant_1')!;
      assert.equal(card.userState.opening, value);
      assert.equal(card.history.at(-1)!.reason, `Владелец в разговоре: «${message}»`);
    }
    assert.equal(confirms.length, 0);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('cards are found by number, title and id; an unclear reference returns candidates instead of a guess', () => {
  const library = libraryFixture();
  assert.equal((resolveVariant(library, '2') as { item: { id: string } }).item.id, 'variant_2');
  assert.equal((resolveVariant(library, 'возврат 1') as { item: { id: string } }).item.id, 'variant_1');
  assert.equal((resolveVariant(library, 'variant_2') as { item: { id: string } }).item.id, 'variant_2');
  const many = resolveVariant(library, 'Возврат');
  assert.equal(many.kind, 'many'); assert.equal(many.kind === 'many' ? many.items.length : 0, 2);
  assert.equal(resolveVariant(library, 'кредит').kind, 'none');
});

test('a one-sentence variant takes the fact, the opening and the conditions from the parent card', () => {
  const parent = libraryFixture().variants[0]!;
  parent.userState.opening = 'Помогите с возвратом. Номер терминала: 1234';
  assert.equal(deriveVariantInput(parent, 'missing_fact', {}).kind, 'ask', 'an opening that says the value is not cut apart: the model proposes a new one');
  assert.equal(deriveVariantInput(parent, 'missing_fact', { opening: 'Помогите с возвратом, терминал 1234' }).kind, 'ask', 'a proposed opening that still says the value is refused');
  const derived = deriveVariantInput(parent, 'missing_fact', { opening: 'Помогите с возвратом.' });
  assert.deepEqual(derived, { kind: 'ready', input: { factId: 'terminal_number', opening: 'Помогите с возвратом.', ifAsked: 'Агент запросил: Номер терминала', missingDescription: 'Номер терминала' } });
  const quiet = structuredClone(parent); quiet.userState.opening = 'Здравствуйте! Мой терминал не печатает чеки';
  assert.equal((deriveVariantInput(quiet, 'reveal_on_request', {}) as { input: { opening: string } }).input.opening, 'Здравствуйте! Мой терминал не печатает чеки', 'the request itself is kept whole');
  assert.equal(deriveVariantInput(parent, 'changed_intent', {}).kind, 'ask', 'a new intention is a business decision of the owner');
  const twoFacts = structuredClone(parent);
  twoFacts.userState.facts.push({ ...parent.userState.facts[0]!, id: 'contract', statement: 'Номер договора: 5678', value: '5678' });
  assert.equal(deriveVariantInput(twoFacts, 'missing_fact', {}).kind, 'ask', 'two known facts and no hint: the owner is asked which one');
  assert.equal(deriveVariantInput(twoFacts, 'missing_fact', { fact: 'договор' }).kind, 'ready');
});

test('«было → стало» names the changed fields in the owner\'s words and leaves the rest out', () => {
  const before = libraryFixture().variants[0]!;
  const after = structuredClone(before);
  after.userState.opening = 'Здравствуйте, не проходит возврат';
  const text = changeRows(variantDiff(before, after)).map(item => item.text);
  assert.deepEqual(text, ['Первая реплика', 'было: Помогите с возвратом', 'стало: Здравствуйте, не проходит возврат']);
});

test('tool rows say what is being done and never print ids or arguments', () => {
  assert.equal(callText('agent_lab_scenarios', { operation: 'variant', variant: 'Возврат 1', kind: 'missing_fact' }), 'Добавляю вариант к карточке «Возврат 1»');
  assert.equal(callText('agent_lab_scenarios', { operation: 'show', variant: 'variant_missing_fact_0123456789abcdef', source: true }), 'Открываю источник карточки');
  assert.equal(callText('agent_lab_build', { mode: 'validate', dialoguesFile: '/Users/owner/выгрузка/logs.jsonl' }), 'Собираю сценарии из логов · logs.jsonl');
  assert.equal(callText('agent_lab_inspect', { failure: 2 }), 'Открываю провал 2');
});

test('show: the feed names the cards, the expanded view adds openings and expectations, and the session details hold no card text', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-show-');
  const { tools, shutdown } = registered();
  try {
    const { ctx } = terminal(fixture.cwd, ['Покажи, какие ситуации ты нашёл']);
    const tool = tools.get('agent_lab_scenarios')!;
    const result = await tool.execute('show-1', { operation: 'show' }, undefined, undefined, ctx);
    assert.equal(json(result).variants.length, 2, 'with one draft in the project no run id is needed');
    assert.doesNotMatch(JSON.stringify(result.details), /Возврат|1234|терминал/i, 'REV-01: the 0644 session file gets ids and a neutral note only');
    const collapsed = drawn(tool, result, false).join('\n');
    assert.match(collapsed, /Сценарии · ревизия \d+ · 2 варианта/); assert.match(collapsed, /1\. ✓ Возврат 1 — готов · из диалогов/);
    assert.match(collapsed, /принятого набора нет/); assert.doesNotMatch(collapsed, /[a-f0-9]{16}|\{"/, 'no hashes and no JSON in the feed');
    assert.doesNotMatch(collapsed, /Клиент пишет/);
    assert.match(drawn(tool, result, true).join('\n'), /Клиент пишет: «Помогите с возвратом»/);
    for (const line of drawn(tool, result, true, 40)) assert.ok([...line].length <= 40, `a 40-column terminal wraps, never overflows: «${line}»`);
    const source = await tool.execute('show-2', { operation: 'show', variant: 'Возврат 1', source: true }, undefined, undefined, ctx);
    assert.match(drawn(tool, source, false).join('\n'), /Источник: диалог terminal, реплика 0: «Номер терминала: 1234»/);
    assert.match(drawn(tool, source, true).join('\n'), /Исходный диалог terminal[\s\S]*#0 Клиент: Нужна помощь\. Номер терминала: 1234/);
    assert.equal(json(source).detail[0].sourceEvents[0].events[0].content, 'Нужна помощь. Номер терминала: 1234');
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('an edit asked for in plain words is saved under the owner\'s message, rechecked, and drops nothing but acceptance', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-edit-');
  const { tools, shutdown } = registered();
  try {
    const said = ['Покажи сценарии'];
    const { ctx, confirms } = terminal(fixture.cwd, said);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    const before = await fixture.read();
    said.push('В первой карточке пусть клиент начинает так: Здравствуйте, не проходит возврат');
    const result = await tool.execute('edit', { operation: 'edit', variant: '1', change: { field: 'opening', value: 'Здравствуйте, не проходит возврат' } }, undefined, undefined, ctx);
    const after = await fixture.read();
    const card = after.librarySnapshot!.variants.find(item => item.id === 'variant_1')!;
    assert.equal(card.userState.opening, 'Здравствуйте, не проходит возврат');
    assert.equal(card.history.at(-1)!.author, 'assistant'); assert.equal(card.history.at(-1)!.reason, `Владелец в разговоре: «${said[1]}»`);
    assert.equal(confirms.length, 0, 'a draft edit the owner asked for needs no extra confirmation');
    assert.equal(after.librarySnapshot!.revision > before.librarySnapshot!.revision, true);
    assert.equal(json(result).check.status, 'done'); assert.equal(card.quality, 'ready', 'the semantic recheck ran inside the agreed call limit');
    assert.ok(after.usage.calls > before.usage.calls && after.usage.calls <= after.settings.maxCalls);
    const feed = drawn(tool, result, false).join('\n');
    assert.match(feed, /Карточка «Возврат 1» изменена/); assert.match(feed, /было: Помогите с возвратом/); assert.match(feed, /стало: Здравствуйте, не проходит возврат/);
    assert.match(feed, /Смысл перепроверен/);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('a fact value the owner never said is not written; once they say it, the fact carries a verified owner receipt', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-fact-');
  const { tools, shutdown } = registered();
  try {
    const said = ['Поправь номер терминала в первой карточке'];
    const { ctx, confirms } = terminal(fixture.cwd, said, [true]);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    const before = await fixture.read();
    const refused = await tool.execute('guess', { operation: 'edit', variant: 'Возврат 1', change: { field: 'fact', fact: 'номер терминала', value: '9999', statement: 'Номер терминала: 9999' } }, undefined, undefined, ctx);
    assert.equal(json(refused).status, 'needs_owner_input'); assert.equal(json(refused).mutated, false); assert.match(json(refused).message, /9999/);
    assert.equal(libraryHash((await fixture.read()).librarySnapshot!), libraryHash(before.librarySnapshot!), 'nothing was written');
    assert.match(drawn(tool, refused, false).join('\n'), /Значение 9999 вы не называли, а от себя я значения не записываю/, 'the feed speaks to the owner, the instruction goes to the model');
    said.push('Номер терминала там 9999');
    await tool.execute('said', { operation: 'edit', variant: 'Возврат 1', change: { field: 'fact', fact: 'номер терминала', value: '9999', statement: 'Номер терминала: 9999' } }, undefined, undefined, ctx);
    const library = (await fixture.read()).librarySnapshot!;
    const card = library.variants.find(item => item.id === 'variant_1')!;
    const fact = card.userState.facts.find(item => item.id === 'terminal_number')!;
    assert.equal(fact.value, '9999'); assert.equal(fact.origin.kind, 'owner');
    assert.match(fact.origin.kind === 'owner' ? fact.origin.text : '', /Номер терминала там 9999/);
    assert.deepEqual(ownerFactEvidence(library, card).map(item => item.status), ['verified']);
    assert.equal(confirms.length, 1, 'a fact in the owner\'s name is confirmed natively, once, and only after its value is known');
    assert.match(confirms[0]!.body, /«Номер терминала: 9999»[\s\S]*клиент знал это до разговора/);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('an expectation in the model\'s own words waits for the native dialog; a refusal writes nothing', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-expectation-');
  const { tools, shutdown } = registered();
  try {
    const { ctx, confirms } = terminal(fixture.cwd, ['Сделай карточки получше'], [false, true]);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    const change = { field: 'expectation', value: 'Агент обязан предложить рассрочку платежа и скидку' };
    const declined = await tool.execute('declined', { operation: 'edit', variant: '1', change }, undefined, undefined, ctx);
    assert.equal(json(declined).status, 'declined'); assert.match(confirms[0]!.body, /рассрочку платежа/);
    assert.equal((await fixture.read()).librarySnapshot!.variants[0]!.evaluationSpec.successCriteria, 'Уточнён номер терминала');
    await tool.execute('confirmed', { operation: 'edit', variant: '1', change }, undefined, undefined, ctx);
    assert.equal((await fixture.read()).librarySnapshot!.variants.find(item => item.id === 'variant_1')!.evaluationSpec.successCriteria, change.value);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('«добавь случай, где клиент не знает номер» is one call: a synthetic child appears, the parent card stays byte-identical', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-variant-');
  const { tools, shutdown } = registered();
  try {
    const said = ['Добавь к первой карточке случай, где клиент не знает номер терминала'];
    const { ctx, confirms } = terminal(fixture.cwd, said);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    const parentBefore = JSON.stringify((await fixture.read()).librarySnapshot!.variants.find(item => item.id === 'variant_1'));
    const result = await tool.execute('variant', { operation: 'variant', variant: 'Возврат 1', kind: 'missing_fact' }, undefined, undefined, ctx);
    const library = (await fixture.read()).librarySnapshot!;
    const child = library.variants.find(item => item.parentVariantId === 'variant_1')!;
    assert.ok(child, 'the variant is in the stored library'); assert.equal(child.provenance, 'synthetic');
    assert.deepEqual(child.userState.facts, []); assert.deepEqual(child.userState.missing, ['Номер терминала']);
    assert.equal(child.mutationReason, `Владелец в разговоре: «${said[0]}»`);
    assert.ok(!JSON.stringify(child.userState).includes('1234') && !JSON.stringify(child.behaviorPolicy).includes('1234'), 'the removed value is gone from everything the client may say');
    const parentAfter = library.variants.find(item => item.id === 'variant_1')!;
    assert.equal(JSON.stringify({ ...parentAfter, ownerDecision: undefined }), JSON.stringify({ ...JSON.parse(parentBefore), ownerDecision: undefined }), 'the original card is unchanged');
    assert.equal(confirms.length, 0);
    const feed = drawn(tool, result, false).join('\n');
    assert.match(feed, /Добавлен синтетический вариант «Возврат 1 · нет данных»/); assert.match(feed, /было: Номер терминала: 1234/);
    assert.match(feed, /стало: Номер терминала/); assert.match(feed, /Исходная карточка «Возврат 1» не изменена/);
    assert.equal(json(result).parentUnchanged, true);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('Q19: a numeric fact id is a reference, while an invented customer value still needs the owner', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-variant-numeric-id-');
  const { tools, shutdown } = registered();
  try {
    const lab = new ExperimentLab(join(fixture.cwd, '.agent-lab'), runtime);
    await lab.init();
    try {
      const before = await lab.readLibrary(fixture.id);
      const parent = structuredClone(before.library.variants.find(item => item.id === 'variant_1')!);
      const previousId = parent.userState.facts[0]!.id;
      parent.userState.facts[0]!.id = 'fact_123';
      for (const action of parent.behaviorPolicy.actions) action.factIds = action.factIds.map(id => id === previousId ? 'fact_123' : id);
      const edited = await lab.editLibrary(fixture.id, libraryHash(before.library), { kind: 'upsert_variant', variant: parent, reason: 'Regression fixture: rename an internal fact reference' }, 'owner');
      await lab.assessLibrary(fixture.id, libraryHash(edited.library));
      await lab.waitForIdle();
    } finally { await lab.close(); }

    const said = ['Добавь к первой карточке случай, где клиент не знает номер терминала'];
    const { ctx, confirms } = terminal(fixture.cwd, said);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    const added = json(await tool.execute('variant', { operation: 'variant', variant: '1', kind: 'missing_fact' }, undefined, undefined, ctx));
    assert.equal(added.mutated, true, 'fact_123 must not become a question about an unknown customer value');
    const library = (await fixture.read()).librarySnapshot!;
    assert.equal(library.variants.find(item => item.id === 'variant_1')!.userState.facts[0]!.id, 'fact_123');
    const child = library.variants.find(item => item.parentVariantId === 'variant_1')!;
    assert.deepEqual(child.userState.facts, []);
    assert.deepEqual(child.userState.missing, ['Номер терминала']);
    assert.equal(confirms.length, 0);

    said.push('Добавь к первой карточке случай, где клиент сообщает номер по запросу');
    const refused = json(await tool.execute('invented', { operation: 'variant', variant: '1', kind: 'reveal_on_request', reply: 'Номер терминала: 9999' }, undefined, undefined, ctx));
    assert.equal(refused.status, 'needs_owner_input');
    assert.equal(refused.mutated, false);
    assert.match(refused.message, /9999/);
    assert.doesNotMatch(refused.message, /fact_123|\b123\b/);
    assert.equal(libraryHash((await fixture.read()).librarySnapshot!), libraryHash(library), 'the refused proposal must not change the library');
    const raw = await tool.execute('raw', { operation: 'variant', request: { parentId: 'variant_1', operation: 'reveal_on_request', input: { factId: 'fact_123', reply: 'Номер терминала: 9999' } } }, undefined, undefined, ctx).catch(error => error as Error);
    assert.match(raw instanceof Error ? raw.message : '', /не принимается/);
    assert.equal(confirms.length, 0);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('an unclear card reference asks the owner and writes nothing; a stale view is refused with the fresh state', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-reference-');
  const { tools, shutdown } = registered();
  try {
    const said = ['Убери карточку про возврат'];
    const { ctx } = terminal(fixture.cwd, said);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    const unclear = await tool.execute('remove', { operation: 'remove', variant: 'Возврат' }, undefined, undefined, ctx);
    assert.equal(json(unclear).status, 'ambiguous_reference'); assert.deepEqual(json(unclear).options, ['1. Возврат 1', '2. Возврат 2']);
    assert.equal((await fixture.read()).librarySnapshot!.variants.length, 2);
    // The owner answers the question: only now does the instruction name its card.
    said.push('Убери первую');
    // Another writer (the board, another session) edits the draft after the model read it.
    const other = new ExperimentLab(join(fixture.cwd, '.agent-lab'), runtime);
    await other.init();
    const current = await other.readLibrary(fixture.id);
    await other.editLibrary(fixture.id, libraryHash(current.library), { kind: 'edit_variant_text', variantId: 'variant_2', field: 'goal', value: 'Узнать срок', editId: 'board_edit', reason: 'Правка с доски' }, 'owner');
    await other.close();
    const stale = await tool.execute('stale', { operation: 'remove', variant: 'Возврат 1' }, undefined, undefined, ctx);
    assert.equal(json(stale).status, 'stale_library'); assert.equal((await fixture.read()).librarySnapshot!.variants.length, 2, 'the concurrent edit is never overwritten');
    const retried = await tool.execute('retry', { operation: 'remove', variant: 'Возврат 1' }, undefined, undefined, ctx);
    assert.equal(json(retried).mutated, true); assert.equal((await fixture.read()).librarySnapshot!.variants.length, 1);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('«эти две группы про одно и то же» merges the named groups under the owner\'s words', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-merge-', true);
  const { tools, shutdown } = registered();
  try {
    const said = ['Возврат и срок возврата про одно и то же, объедини'];
    const { ctx, confirms } = terminal(fixture.cwd, said);
    const tool = tools.get('agent_lab_scenarios')!;
    const shown = json(await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx));
    assert.equal(shown.groups.length, 2);
    const result = await tool.execute('merge', { operation: 'merge', groups: ['Возврат', 'Срок возврата'] }, undefined, undefined, ctx);
    const library = (await fixture.read()).librarySnapshot!;
    assert.equal(library.businessScenarios.length, 1); assert.equal(library.businessScenarios[0]!.grouping.reason, `Владелец в разговоре: «${said[0]}»`);
    assert.equal(confirms.length, 0); assert.match(drawn(tool, result, false).join('\n'), /Группы объединены: «Возврат» \+ «Срок возврата» → «Возврат»/);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('split applies the explicitly requested group goal and conditions in one change, leaving the sibling content intact', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-split-conditions-');
  const { tools, shutdown } = registered();
  try {
    const goal = 'Узнать порядок возврата';
    const conditions = ['Клиент спрашивает о порядке возврата'];
    const said = [`Выдели первую карточку в группу Общий вопрос о возврате. Цель: ${goal}. Условия: ${conditions[0]}`];
    const { ctx, confirms } = terminal(fixture.cwd, said);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    const before = (await fixture.read()).librarySnapshot!;
    const result = await tool.execute('split', { operation: 'split', variants: ['1'], title: 'Общий вопрос о возврате', goal, conditions, verify: 'later' }, undefined, undefined, ctx);
    const library = (await fixture.read()).librarySnapshot!;
    const moved = library.variants.find(card => card.id === 'variant_1')!;
    const group = library.businessScenarios.find(group => group.id === moved.businessScenarioId)!;
    assert.equal(json(result).mutated, true);
    assert.equal(library.revision, before.revision + 1);
    assert.equal(group.goal, goal); assert.deepEqual(group.conditions, conditions);
    assert.deepEqual(moved.userState, before.variants[0]!.userState, 'group goal is not a client goal edit');
    const sibling = library.variants.find(card => card.id === 'variant_2')!;
    for (const field of ['businessScenarioId', 'userState', 'behaviorPolicy', 'evaluationSpec', 'revision', 'history'] as const) assert.deepEqual(sibling[field], before.variants[1]![field], field);
    const original = library.businessScenarios.find(group => group.id === before.businessScenarios[0]!.id)!;
    assert.equal(original.goal, before.businessScenarios[0]!.goal); assert.deepEqual(original.conditions, before.businessScenarios[0]!.conditions);
    assert.deepEqual(json(result).groups.find((item: { id: string }) => item.id === group.id).conditions, conditions);
    assert.match(drawn(tool, result, false).join('\n'), /Цель группы: Узнать порядок возврата[\s\S]*Условия группы: Клиент спрашивает о порядке возврата/);
    assert.equal(confirms.length, 0, 'the owner already gave the selected card, goal and conditions');
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('split cannot silently add or erase business conditions through convenience parameters or a raw patch', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-split-authorization-');
  const setup = new ExperimentLab(join(fixture.cwd, '.agent-lab'), runtime);
  await setup.init();
  try {
    const current = await setup.readLibrary(fixture.id);
    await setup.editLibrary(fixture.id, libraryHash(current.library), { kind: 'edit_business', businessScenarioId: current.library.businessScenarios[0]!.id,
      conditions: ['При запросе возврата'], reason: 'Fixture needs nonempty conditions to test their removal' }, 'owner');
  } finally { await setup.close(); }
  const { tools, shutdown } = registered();
  try {
    const { ctx, confirms } = terminal(fixture.cwd, ['Выдели первую карточку в отдельную группу'], [false, false, false]);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    const before = (await fixture.read()).librarySnapshot!;
    const source = before.businessScenarios[0]!;
    const conditions = ['Покупатель подключил платную подписку и требует автоматическое продление'];
    for (const params of [
      { variants: ['1'], title: 'Другая группа', conditions },
      { variants: ['1'], title: 'Другая группа', conditions: [] },
    ]) {
      const result = json(await tool.execute('split', { operation: 'split', ...params, verify: 'later' }, undefined, undefined, ctx));
      assert.equal(result.status, 'declined'); assert.equal(result.mutated, false);
      assert.deepEqual((await fixture.read()).librarySnapshot, before);
    }
    const rawPatch = await tool.execute('split-patch', { operation: 'split', verify: 'later', patch: { kind: 'split_business', businessScenarioId: source.id, variantIds: ['variant_1'], reason: 'model reason', newBusiness: {
      key: 'split_test', title: 'Другая группа', goal: source.goal, conditions, requirementIds: source.requirementIds, grouping: { status: 'confirmed', reason: 'model reason' } } } }, undefined, undefined, ctx).catch(error => error as Error);
    assert.match(rawPatch instanceof Error ? rawPatch.message : '', /не принимается/);
    assert.deepEqual((await fixture.read()).librarySnapshot, before);
    assert.equal(confirms.length, 2);
    assert.match(confirms[0]!.body, /Цель группы:[\s\S]*Условия группы: Покупатель подключил платную подписку/);
    assert.match(confirms[1]!.body, /Условия группы: нет/);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('edit_group changes the existing group goal and conditions directly, marks its cards for recheck and leaves other group content unchanged', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-edit-group-', true);
  const { tools, shutdown } = registered();
  try {
    const goal = 'Узнать порядок возврата';
    const conditions = ['Клиент спрашивает о порядке возврата'];
    const { ctx, confirms } = terminal(fixture.cwd, [`Измени первую группу. Цель: ${goal}. Условия: ${conditions[0]}`]);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    const before = (await fixture.read()).librarySnapshot!;
    const calls = checkCalls;
    const result = await tool.execute('edit-group', { operation: 'edit_group', group: '1', goal, conditions, verify: 'later' }, undefined, undefined, ctx);
    const library = (await fixture.read()).librarySnapshot!;
    assert.equal(json(result).mutated, true); assert.equal(library.revision, before.revision + 1);
    assert.equal(library.businessScenarios.length, before.businessScenarios.length, 'editing context does not create or split a group');
    assert.equal(library.businessScenarios[0]!.id, before.businessScenarios[0]!.id);
    assert.equal(library.businessScenarios[0]!.goal, goal); assert.deepEqual(library.businessScenarios[0]!.conditions, conditions);
    assert.deepEqual(library.businessScenarios[1], before.businessScenarios[1]);
    const affected = library.variants[0]!;
    assert.equal(affected.semanticReviewRequired, true); assert.equal(affected.quality, 'needs_review');
    assert.deepEqual(affected.userState, before.variants[0]!.userState); assert.deepEqual(affected.evaluationSpec, before.variants[0]!.evaluationSpec);
    for (const field of ['businessScenarioId', 'userState', 'behaviorPolicy', 'evaluationSpec', 'revision', 'history', 'semanticReviewRequired'] as const) assert.deepEqual(library.variants[1]![field], before.variants[1]![field], field);
    assert.deepEqual(json(result).groupScope.variantIds, ['variant_1']);
    assert.match(drawn(tool, result, false).join('\n'), /Возврат 1[\s\S]*Цель группы:.*→ Узнать порядок возврата[\s\S]*Условия группы:.*→ Клиент спрашивает о порядке возврата/);
    assert.equal(confirms.length, 0); assert.equal(checkCalls, calls);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('edit_group refuses stale scope before any write or owner request', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-edit-group-protected-', true);
  const setup = new ExperimentLab(join(fixture.cwd, '.agent-lab'), runtime); await setup.init();
  try {
    const current = await setup.readLibrary(fixture.id);
    await setup.editLibrary(fixture.id, libraryHash(current.library), { kind: 'edit_business', businessScenarioId: current.library.businessScenarios[0]!.id,
      conditions: ['При запросе возврата'], reason: 'Fixture for protected condition removal' }, 'owner');
  } finally { await setup.close(); }
  const { tools, shutdown } = registered();
  try {
    const said = ['Первую группу не трогай, измени цель второй группы'];
    const { ctx, confirms } = terminal(fixture.cwd, said, [true]);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    const before = (await fixture.read()).librarySnapshot!;
    const lab = new ExperimentLab(join(fixture.cwd, '.agent-lab'), runtime); await lab.init();
    try { await lab.editLibrary(fixture.id, libraryHash(before), { kind: 'edit_business', businessScenarioId: before.businessScenarios[1]!.id, title: 'Новая группа', reason: 'Concurrent fixture' }, 'owner'); }
    finally { await lab.close(); }
    said[0] = 'Измени цель первой группы';
    const current = (await fixture.read()).librarySnapshot!;
    const stale = json(await tool.execute('stale', { operation: 'edit_group', group: '1', goal: before.businessScenarios[0]!.goal, verify: 'later' }, undefined, undefined, ctx));
    assert.equal(stale.status, 'stale_library'); assert.deepEqual((await fixture.read()).librarySnapshot, current); assert.equal(confirms.length, 0);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('edit_group raw patch uses the same native scope authorization for owner-attributed business changes', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-edit-group-patch-', true);
  const { tools, shutdown } = registered();
  try {
    const { ctx, confirms } = terminal(fixture.cwd, ['Измени первую группу'], [true]);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    const before = (await fixture.read()).librarySnapshot!;
    const patch = { kind: 'edit_business', businessScenarioId: before.businessScenarios[0]!.id, conditions: ['Покупатель подключил платную подписку и требует автоматическое продление'], reason: 'model reason' };
    const declined = await tool.execute('no', { operation: 'edit_group', patch, verify: 'later' }, undefined, undefined, ctx).catch(error => error as Error);
    assert.match(declined instanceof Error ? declined.message : '', /не принимается/); assert.deepEqual((await fixture.read()).librarySnapshot, before);
    const accepted = json(await tool.execute('yes', { operation: 'edit_group', group: '1', conditions: patch.conditions, verify: 'later' }, undefined, undefined, ctx));
    assert.equal(accepted.mutated, true); assert.equal(confirms.length, 1);
    assert.match(confirms[0]!.body, /Возврат 1[\s\S]*Условия группы:.*→ Покупатель подключил платную подписку/);
    assert.deepEqual((await fixture.read()).librarySnapshot!.businessScenarios[0]!.conditions, patch.conditions);
    assert.match((await fixture.read()).librarySnapshot!.businessScenarios[0]!.grouping.reason, /Владелец в разговоре/);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('accepting the ready cards is the owner\'s native decision about exactly the listed set, and it never runs the agent', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-accept-');
  const { tools, shutdown } = registered();
  try {
    const { ctx, confirms } = terminal(fixture.cwd, ['Прими готовые сценарии, спорные пока оставь'], [false, true]);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    const cancelled = await tool.execute('accept-no', { operation: 'accept', select: 'ready' }, undefined, undefined, ctx);
    assert.equal(json(cancelled).cancelled, true); assert.equal((await fixture.read()).librarySnapshot!.acceptance, undefined);
    assert.match(confirms[0]!.body, /1\. Возврат 1/); assert.match(confirms[0]!.body, /Агент не запускается/);
    const accepted = await tool.execute('accept-yes', { operation: 'accept', select: 'ready' }, undefined, undefined, ctx);
    const record = await fixture.read();
    assert.deepEqual(record.librarySnapshot!.acceptance!.variantIds.sort(), ['variant_1', 'variant_2']);
    assert.equal(record.trials.length, 0); assert.equal(record.phase, 'review', 'acceptance is not a run');
    const feed = drawn(tool, accepted, false).join('\n');
    assert.match(feed, /Принят набор: ревизия \d+, 2 из 2 карточек\. Агент не запускался/); assert.match(feed, /Попыток: 2/);
    // A later draft edit drops the acceptance, and the run refuses to start the previous set silently.
    const { ctx: editing } = terminal(fixture.cwd, ['Поменяй первую реплику в первой карточке: Добрый день, нужен возврат']);
    await tool.execute('edit', { operation: 'edit', variant: '1', change: { field: 'opening', value: 'Добрый день, нужен возврат' } }, undefined, undefined, editing);
    assert.equal((await fixture.read()).librarySnapshot!.acceptance, undefined);
    const run = await tools.get('agent_lab_run')!.execute('run', {}, undefined, undefined, editing);
    assert.equal(json(run).status, 'needs_owner_input'); assert.match(json(run).message, /Набор ещё не принят/);
    assert.equal((await fixture.read()).trials.length, 0);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('a short run ends in its own row; the confirmation shows the agent, the set, the attempts, the models and the limits', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-run-inline-');
  const { tools, shutdown } = registered();
  try {
    const { ctx, confirms } = terminal(fixture.cwd, ['Прими готовые и запусти'], [true, true]);
    await tools.get('agent_lab_scenarios')!.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    await tools.get('agent_lab_scenarios')!.execute('accept', { operation: 'accept', select: 'ready' }, undefined, undefined, ctx);
    const result = await tools.get('agent_lab_run')!.execute('run', {}, undefined, undefined, ctx);
    const plan = confirms[1]!.body;
    for (const part of [/Агент: /, /Набор: принятая ревизия \d+, 2 варианта \(2 из диалогов\)/, /Попыток: 2/, /Лимиты: использовано \d+ из 100 вызовов/, /Учебный пример: без модели и оплаты/]) assert.match(plan, part);
    assert.equal((result.details as { kind?: string }).kind, 'agent-lab/verdict');
    const record = await fixture.read();
    assert.equal(record.trials.length, 2); assert.equal(record.phase, 'results_review');
    const again = await tools.get('agent_lab_run')!.execute('again', {}, undefined, undefined, ctx).catch(error => error as Error);
    assert.match(again instanceof Error ? again.message : '', /уже выполнен, его результат не меняется/);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('a long run leaves the conversation free: Esc does not stop it, progress is real, edits wait, and the result arrives as a message', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-run-background-');
  const { tools, sent, shutdown } = registered(60_000);
  const release = await holdReplies();
  try {
    const { ctx, widgets } = terminal(fixture.cwd, ['Прими готовые и запусти'], [true, true]);
    const scenarios = tools.get('agent_lab_scenarios')!, run = tools.get('agent_lab_run')!;
    await scenarios.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    await scenarios.execute('accept', { operation: 'accept', select: 'ready' }, undefined, undefined, ctx);
    const escape = new AbortController();
    const started = run.execute('run', {}, escape.signal, undefined, ctx);
    await new Promise(resolve => setTimeout(resolve, 150));
    escape.abort();
    const result = await started;
    assert.equal(json(result).background, true); assert.match(drawn(run, result, false).join('\n'), /Прогон запущен и идёт в фоне/);
    assert.equal((await fixture.read()).phase, 'evaluating', 'interrupting the action does not stop the run');
    const progress = json(await run.execute('progress', { action: 'progress' }, undefined, undefined, ctx));
    assert.deepEqual([progress.running, progress.finishedDialogues, progress.plannedDialogues], [true, 0, 2]);
    assert.match(json(await scenarios.execute('read', { operation: 'show' }, undefined, undefined, ctx)).libraryHash, /^[a-f0-9]{64}$/, 'reading works while the run goes');
    const edit = await scenarios.execute('edit', { operation: 'remove', variant: '1' }, undefined, undefined, ctx).catch(error => error as Error);
    assert.match(edit instanceof Error ? edit.message : '', /Сейчас идёт прогон .* правки и новый запуск — после его завершения или остановки/);
    await release();
    while (!sent.length) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sent[0]!.message.customType, 'agent-lab-run'); assert.deepEqual(sent[0]!.options, { deliverAs: 'followUp', triggerTurn: true });
    assert.equal((sent[0]!.message.details as { kind: string }).kind, 'agent-lab/verdict'); assert.equal(JSON.parse(sent[0]!.message.content).trialCount, 2);
    assert.match(widgets.find(lines => lines)!.join('\n'), /0 из 2 диалогов завершено/);
    while (widgets.at(-1) !== undefined) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await fixture.read()).phase, 'results_review');
  } finally { await release(); await shutdown(); await fixture.cleanup(); }
});

test('stopping is its own request: the owner\'s words stop the run, what is recorded stays, and the answer says what must be rerun', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-run-stop-');
  const { tools, sent, shutdown } = registered(0);
  const release = await holdReplies();
  try {
    const said = ['Прими готовые и запусти'];
    const { ctx, confirms } = terminal(fixture.cwd, said, [true, true, false]);
    const run = tools.get('agent_lab_run')!;
    await tools.get('agent_lab_scenarios')!.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    await tools.get('agent_lab_scenarios')!.execute('accept', { operation: 'accept', select: 'ready' }, undefined, undefined, ctx);
    assert.equal(json(await run.execute('run', {}, undefined, undefined, ctx)).background, true);
    said.push('Останови прогон');
    const pending = run.execute('stop', { action: 'stop' }, undefined, undefined, ctx);
    await release();
    const stopped = await pending;
    assert.equal(json(stopped).stopped, true); assert.equal(confirms.length, 2, 'the owner\'s own request needs no second confirmation');
    assert.match(drawn(run, stopped, false).join('\n'), /остановлен: сохранено \d из 2 диалогов[\s\S]*Продолжить этот прогон с места остановки нельзя/);
    assert.equal(sent.length, 0, 'a stop the owner asked for is answered in its own row, not announced twice');
    assert.ok(['cancelled', 'results_review'].includes((await fixture.read()).phase));
  } finally { await release(); await shutdown(); await fixture.cleanup(); }
});

/** A preparation asked for in the conversation: the same materials and dialogues `draft()` seeds, built through the tool. */
const buildRequest = { task: 'Проверить возвраты', target: chatAgent, existingAgent, materials: sources.map(({ name, content }) => ({ name, content })), dialogues: rawDialogues, scenarioCount: 2,
  settings: { maxCalls: 100, repeats: 1, userModes: ['reactive'] } };
async function preparing(prefix: string) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  runtime = runtimeFixture();
  const stored = async () => { const store = new ExperimentStore(join(cwd, '.agent-lab')); return store.list(); };
  return { cwd, stored, cleanup: () => rm(cwd, { recursive: true, force: true }) };
}

test('a long preparation leaves the conversation free: reads work, changes wait for it by name, and the scenarios arrive as one message', { timeout: 60000 }, async () => {
  const fixture = await preparing('chat-build-background-');
  const { tools, sent, shutdown } = registered(undefined, undefined, 0);
  let release!: () => void;
  buildGate = new Promise<void>(resolve => { release = resolve; });
  try {
    const { ctx, widgets } = terminal(fixture.cwd, ['Собери сценарии по этим логам']);
    const build = tools.get('agent_lab_build')!, run = tools.get('agent_lab_run')!;
    const startedAt = Date.now();
    const result = await build.execute('build', buildRequest, undefined, undefined, ctx);
    assert.ok(Date.now() - startedAt < 5000, 'the row does not wait for the held preparation');
    assert.equal(json(result).background, true); assert.match(json(result).instruction, /do not poll/);
    assert.match(drawn(build, result, false).join('\n'), /Подготовка сценариев идёт в фоне/);
    const [record] = await fixture.stored();
    assert.deepEqual([record!.id, record!.phase, record!.librarySnapshot], [json(result).id, 'preparing', undefined], 'the stored record is still being prepared');
    assert.equal(json(await tools.get('agent_lab_status')!.execute('status', {}, undefined, undefined, ctx)).runningInThisSession, record!.id, 'reading works while the preparation goes');
    const progress = json(await run.execute('progress', { action: 'progress' }, undefined, undefined, ctx));
    assert.deepEqual([progress.running, progress.preparation, progress.ownedByThisSession], [true, true, true]);
    const second = await build.execute('build-2', buildRequest, undefined, undefined, ctx).catch(error => error as Error);
    assert.match(second instanceof Error ? second.message : '', /Сейчас идёт подготовка сценариев .* правки и новый запуск — после её завершения или остановки/);
    assert.equal((await fixture.stored()).length, 1, 'the refused call wrote nothing'); assert.equal(sent.length, 0);
    release();
    while (!sent.length) await new Promise(resolve => setTimeout(resolve, 20));
    while (widgets.at(-1) !== undefined) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sent.length, 1, 'exactly one message reports the preparation');
    assert.equal(sent[0]!.message.customType, 'agent-lab-build'); assert.deepEqual(sent[0]!.options, { deliverAs: 'followUp', triggerTurn: true });
    const finished = (await fixture.stored())[0]!;
    assert.equal(finished.phase, 'review'); assert.equal(finished.librarySnapshot!.variants.length, 2);
    const content = JSON.parse(sent[0]!.message.content);
    assert.deepEqual([content.id, content.libraryHash, content.variants.length], [finished.id, libraryHash(finished.librarySnapshot!), 2], 'the message carries the model JSON of the inline result');
    // The session file is world-readable: the details point at the remembered feed and hold no card text.
    const details = JSON.stringify(sent[0]!.message.details);
    for (const variant of finished.librarySnapshot!.variants) for (const text of [variant.title, variant.userState.opening, variant.evaluationSpec.successCriteria]) assert.ok(!details.includes(text), text);
    const rows = drawn(build, { content: [{ type: 'text', text: '' }], details: sent[0]!.message.details }, false).join('\n');
    assert.match(rows, /Сценарии собраны/); assert.match(rows, /Готовые карточки \(\d+\) можно принять и запустить прямо сейчас|Готовых карточек пока нет/);
    assert.match(widgets.find(lines => lines)!.join('\n'), /Подготовка [a-f0-9]{8}[\s\S]*Остановить подготовку — так и напишите/);
    // The lock went back with the message: the next change is taken, against the state the message showed.
    const { ctx: next } = terminal(fixture.cwd, ['Убери первую карточку']);
    assert.equal(json(await tools.get('agent_lab_scenarios')!.execute('remove', { operation: 'remove', variant: '1' }, undefined, undefined, next)).mutated, true);
  } finally { buildGate = undefined; release(); await shutdown(); await fixture.cleanup(); }
});

test('Esc during a preparation interrupts the action, not the work: the scenarios are still built and reported', { timeout: 60000 }, async () => {
  const fixture = await preparing('chat-build-escape-');
  const { tools, sent, shutdown } = registered(undefined, undefined, 60_000);
  let release!: () => void;
  buildGate = new Promise<void>(resolve => { release = resolve; });
  try {
    const { ctx } = terminal(fixture.cwd, ['Собери сценарии по этим логам']);
    const escape = new AbortController();
    const started = tools.get('agent_lab_build')!.execute('build', buildRequest, escape.signal, undefined, ctx);
    await new Promise(resolve => setTimeout(resolve, 150));
    escape.abort();
    assert.equal(json(await started).background, true);
    assert.equal((await fixture.stored())[0]!.phase, 'preparing', 'interrupting the action does not cancel the preparation');
    release();
    while (!sent.length) await new Promise(resolve => setTimeout(resolve, 20));
    const finished = (await fixture.stored())[0]!;
    assert.deepEqual([finished.phase, finished.error ?? null, finished.librarySnapshot!.variants.length], ['review', null, 2]);
    assert.equal(JSON.parse(sent[0]!.message.content).cancelled, undefined);
  } finally { buildGate = undefined; release(); await shutdown(); await fixture.cleanup(); }
});

test('stopping a preparation is the owner\'s request: the record stays readable, the answer says what was saved, and no message follows', { timeout: 60000 }, async () => {
  const fixture = await preparing('chat-build-stop-');
  const { tools, sent, shutdown } = registered(undefined, undefined, 0);
  let release!: () => void;
  buildGate = new Promise<void>(resolve => { release = resolve; });
  try {
    const said = ['Собери сценарии по этим логам'];
    const { ctx, confirms } = terminal(fixture.cwd, said, [false]);
    const run = tools.get('agent_lab_run')!;
    const built = json(await tools.get('agent_lab_build')!.execute('build', buildRequest, undefined, undefined, ctx));
    assert.equal(built.background, true);
    said.push('Останови подготовку');
    const pending = run.execute('stop', { action: 'stop', id: built.id }, undefined, undefined, ctx);
    release();
    const stopped = await pending;
    assert.equal(json(stopped).stopped, true); assert.equal(confirms.length, 0, 'the owner\'s own request needs no second confirmation');
    assert.match(drawn(run, stopped, false).join('\n'), /Подготовка [a-f0-9]{8} остановлена\.[\s\S]*(Сохранён черновик: карточек \d+|Карточки собрать не успели\. Запись сохранена)/);
    const record = (await fixture.stored())[0]!;
    assert.ok(['cancelled', 'review'].includes(record.phase), record.phase); assert.match(record.error ?? '', /Cancelled by the user/);
    assert.equal(json(stopped).savedVariants, record.librarySnapshot?.variants.length ?? 0, 'the answer counts what the stored record holds');
    assert.equal(sent.length, 0, 'a stop the owner asked for is answered in its own row, not announced twice');
    assert.equal(json(await tools.get('agent_lab_status')!.execute('status', {}, undefined, undefined, ctx)).runningInThisSession, null, 'the lock is released');
  } finally { buildGate = undefined; release(); await shutdown(); await fixture.cleanup(); }
});

test('an assessment the owner asks for does not hold the conversation: it answers at once and its outcome arrives as a message', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-assess-background-');
  const { tools, sent, shutdown } = registered(undefined, 0);
  let release: () => void = () => {};
  try {
    const said = ['Поменяй первую реплику первой карточки на: Здравствуйте, не проходит возврат'];
    const { ctx } = terminal(fixture.cwd, said);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    const edit = json(await tool.execute('edit', { operation: 'edit', variant: '1', verify: 'later', change: { field: 'opening', value: 'Здравствуйте, не проходит возврат' } }, undefined, undefined, ctx));
    assert.equal(edit.check.status, 'skipped', 'the edit leaves a semantic check owed');
    said.push('Проверь смысл карточек');
    checkGate = new Promise<void>(resolve => { release = resolve; });
    const callsBefore = (await fixture.read()).usage.calls;
    const startedAt = Date.now();
    const result = await tool.execute('assess', { operation: 'assess' }, undefined, undefined, ctx);
    assert.ok(Date.now() - startedAt < 5000, 'the row does not wait for the held assessment');
    assert.equal(json(result).check.status, 'running'); assert.match(drawn(tool, result, false).join('\n'), /Смысловая проверка идёт в фоне/);
    assert.equal(sent.length, 0);
    assert.equal(json(await tool.execute('read', { operation: 'show' }, undefined, undefined, ctx)).variants.length, 2, 'reading works while the assessment runs');
    release();
    while (!sent.length) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sent[0]!.message.customType, 'agent-lab-check'); assert.deepEqual(sent[0]!.options, { deliverAs: 'followUp', triggerTurn: true }, 'the owner is waiting for this answer');
    const after = await fixture.read();
    assert.ok(after.usage.calls > callsBefore, 'the assessment really ran'); assert.equal(after.phase, 'review');
    assert.deepEqual(after.librarySnapshot!.variants.map(item => item.quality), ['ready', 'ready']);
    const content = JSON.parse(sent[0]!.message.content);
    assert.deepEqual([content.check.status, content.libraryHash], ['done', libraryHash(after.librarySnapshot!)]);
    // Nothing owed any more: the same request answers in its own row, as before.
    const again = await tool.execute('assess-2', { operation: 'assess' }, undefined, undefined, ctx);
    assert.equal(json(again).mutated, false); assert.match(drawn(tool, again, false).join('\n'), /Смысловая проверка не нужна/);
  } finally { checkGate = undefined; release(); await shutdown(); await fixture.cleanup(); }
});

test('results: a failure opens by its number with the dialogue, an unknown one asks, and a repeat is compared with its source run', { timeout: 60000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'chat-results-cwd-'));
  // A finished run of old-format cards (free user simulator, no controller) on an external agent: it can still be repeated.
  const seed = new ExperimentLab(join(cwd, '.agent-lab'), legacyDemoRuntime());
  let source: Experiment;
  try {
    await seed.init();
    const draft = await legacyDraft(seed, { count: 2 });
    await seed.start(draft.id, { approved: true, expectedHash: draftHash(draft) }); await seed.waitForIdle();
    source = await seed.get(draft.id);
  } finally { await seed.close(); }
  assert.equal(source.phase, 'results_review', source.error ?? '');
  runtime = legacyDemoRuntime();
  const { tools, shutdown } = registered();
  try {
    const { ctx } = terminal(cwd, ['Покажи первый провал'], [true]);
    const inspect = tools.get('agent_lab_inspect')!;
    const status = await tools.get('agent_lab_status')!.execute('status', {}, undefined, undefined, ctx);
    assert.equal(json(status).runs[0].id, source.id); assert.match(drawn(tools.get('agent_lab_status')!, status, false).join('\n'), /есть результат/);
    const failure = await inspect.execute('failure', { failure: 1 }, undefined, undefined, ctx);
    const payload = json(failure);
    assert.deepEqual(Object.keys(payload.failure), ['number', 'of', 'title', 'kind', 'lines']);
    assert.equal(payload.failure.number, 1); assert.equal(payload.trial.id, source.trials.find(trial => trial.id === payload.trial.id)!.id);
    // One failure on one screen: what was expected, what the agent said, the owner's rule, then the conversation itself.
    const rows = drawn(inspect, failure, false);
    assert.equal(rows[0], `✗ 1  ${payload.failure.title} · ошибка 1 из ${payload.failure.of}`);
    for (const label of ['Ожидалось', 'Агент ответил', 'Правило']) assert.ok(rows.some(line => line.startsWith(`    ${label.padEnd(16)}`)), `${label}\n${rows.join('\n')}`);
    const collapsed = rows.join('\n');
    assert.match(collapsed, /^ {4}Разговор$/m); assert.match(collapsed, /^ {6}Клиент {3}\S/m); assert.match(collapsed, /^ {6}Агент {4}\S/m);
    assert.ok(rows.includes('Судья решил: не справился. Вы согласны?'), 'an unmarked failure asks the owner');
    assert.doesNotMatch(collapsed, /Решение судьи/); assert.match(drawn(inspect, failure, true).join('\n'), /Решение судьи/);
    assert.equal(json(await inspect.execute('missing', { failure: 99 }, undefined, undefined, ctx)).status, 'unknown_reference');
    const title = source.scenarios[0]!.title;
    const repeated = json(await tools.get('agent_lab_repeat')!.execute('repeat', { scenarios: [title] }, undefined, undefined, ctx));
    assert.equal(repeated.scenarioCount, 1); assert.equal(repeated.parentRunId, source.id);
    assert.equal(json(await tools.get('agent_lab_run')!.execute('rerun', {}, undefined, undefined, ctx)).trialCount, 1, 'the repeat is the run the conversation now works on');
    const comparison = await inspect.execute('compare', { compare: true }, undefined, undefined, ctx);
    assert.equal(json(comparison).comparisonSource.beforeId, source.id);
    assert.match(drawn(inspect, comparison, false).join('\n'), new RegExp(`Сравнение с прогоном ${source.id.slice(0, 8)}`));
    assert.equal((await new ExperimentStore(join(cwd, '.agent-lab')).get(source.id)).trials.length, source.trials.length, 'the source run is untouched');
  } finally { await shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

test('checker remarks reach the owner in plain words: titles instead of ids, the part of the card they are about', () => {
  const library = libraryFixture();
  const card = library.variants[0]!;
  assert.equal(plainIssue(library, card, { path: 'variants.variant_1.duplicates', message: 'Среди кандидатов variant_2 семантически эквивалентен.' }),
    'Похоже на дубль: Среди кандидатов «Возврат 2» семантически эквивалентен.');
  assert.equal(plainIssue(library, card, { path: 'variants.variant_1.evaluationSpec.checkpoints.ask_terminal', message: 'Неприменим: checkpoint предполагает номер; ownerFactEvidence отсутствует.' }),
    'Проверка «Агент уточнил номер терминала»: Неприменим: проверка предполагает номер; подтверждение владельца отсутствует.');
  assert.equal(plainIssue(library, card, { path: 'variants.variant_1.userState', message: 'initialState содержит missingDescription и checkpointHash' }),
    'initialState содержит missingDescription и checkpointHash', 'identifiers that merely contain a glossary word stay intact');
  assert.equal(plainIssue(library, card, { path: 'variants.variant_1.userState.facts.terminal_number', message: 'Классификация initial требует подтверждения.' }),
    'Факт «Номер терминала: 1234»: Классификация знал заранее требует подтверждения.');
});

test('an edit asked for after a run goes into a fresh draft of the same set; the finished run never changes', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-after-run-');
  const { tools, shutdown } = registered();
  try {
    const said = ['Прими готовые и запусти'];
    const { ctx } = terminal(fixture.cwd, said, [true, true]);
    const scenarios = tools.get('agent_lab_scenarios')!;
    await scenarios.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    await scenarios.execute('accept', { operation: 'accept', select: 'ready' }, undefined, undefined, ctx);
    await tools.get('agent_lab_run')!.execute('run', {}, undefined, undefined, ctx);
    const finished = JSON.stringify(await fixture.read());
    said.push('Убери вторую карточку, она лишняя');
    const result = await scenarios.execute('remove', { operation: 'remove', variant: '2' }, undefined, undefined, ctx);
    const payload = json(result);
    assert.equal(payload.mutated, true); assert.equal(payload.unchangedRunId, fixture.id); assert.notEqual(payload.draftRunId, fixture.id);
    assert.equal(JSON.stringify(await fixture.read()), finished, 'the run that has dialogues is byte-identical');
    const store = new ExperimentStore(join(fixture.cwd, '.agent-lab'));
    const fresh = await store.get(payload.draftRunId);
    assert.equal(fresh.phase, 'review'); assert.equal(fresh.parentRunId, fixture.id); assert.equal(fresh.trials.length, 0);
    assert.deepEqual(fresh.librarySnapshot!.variants.map(item => item.id), ['variant_1']); assert.equal(fresh.librarySnapshot!.acceptance, undefined);
    assert.match(drawn(scenarios, result, false).join('\n'), /уже выполнен и не меняется: правка сделана в черновике того же набора/);
    // The conversation now works on the draft, and a second edit does not multiply drafts.
    said.push('И пусть в первой карточке клиент пишет: Добрый день, нужен возврат');
    const again = json(await scenarios.execute('edit', { operation: 'edit', id: fixture.id, variant: '1', change: { field: 'opening', value: 'Добрый день, нужен возврат' } }, undefined, undefined, ctx));
    assert.equal(again.draftRunId, payload.draftRunId, 'the same draft is reused');
    assert.equal((await store.list()).length, 2);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('an inapplicable check is taken out in plain words, and the last check of a card cannot be removed', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-rule-', false, true);
  const { tools, shutdown } = registered();
  try {
    const said = ['Убери из первой карточки проверку про объяснение порядка возврата, она сюда не подходит'];
    const { ctx, confirms } = terminal(fixture.cwd, said);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    const result = await tool.execute('remove-rule', { operation: 'edit', variant: '1', change: { field: 'rule', rule: 'объяснил порядок возврата', remove: true } }, undefined, undefined, ctx);
    const card = (await fixture.read()).librarySnapshot!.variants.find(item => item.id === 'variant_1')!;
    assert.deepEqual(card.evaluationSpec.checkpoints.map(item => item.id), ['ask_terminal']); assert.equal(card.history.at(-1)!.reason, `Владелец в разговоре: «${said[0]}»`);
    assert.equal(confirms.length, 0);
    assert.match(drawn(tool, result, false).join('\n'), /Правила проверки[\s\S]*было: Агент объяснил порядок возврата после получения номера/);
    const last = await tool.execute('remove-last', { operation: 'edit', variant: '1', change: { field: 'rule', remove: true } }, undefined, undefined, ctx);
    assert.equal(json(last).status, 'needs_owner_input'); assert.match(json(last).message, /нечем измерять/);
    assert.equal((await fixture.read()).librarySnapshot!.variants.find(item => item.id === 'variant_1')!.evaluationSpec.checkpoints.length, 1);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('status and stop address a semantic assessment across the same session; the saved draft can be checked again', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-assessment-stop-');
  const { tools, sent, shutdown } = registered(undefined, 0);
  let release: () => void = () => {};
  try {
    const said = ['Поменяй первую реплику первой карточки на: Здравствуйте, не проходит возврат'];
    const { ctx, confirms } = terminal(fixture.cwd, said);
    const scenarios = tools.get('agent_lab_scenarios')!, run = tools.get('agent_lab_run')!, status = tools.get('agent_lab_status')!;
    await scenarios.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    await scenarios.execute('edit', { operation: 'edit', variant: '1', verify: 'later', change: { field: 'opening', value: 'Здравствуйте, не проходит возврат' } }, undefined, undefined, ctx);
    const before = await fixture.read();
    checkGate = new Promise<void>(resolve => { release = resolve; });
    said.push('Проверь смысл карточек');
    const callsAtStart = checkCalls;
    assert.equal(json(await scenarios.execute('assess', { operation: 'assess' }, undefined, undefined, ctx)).check.status, 'running');
    const deadline = Date.now() + 5000;
    while (checkCalls === callsAtStart && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(checkCalls > callsAtStart, 'the assessment reached the held model call');
    const current = json(await status.execute('status', {}, undefined, undefined, ctx));
    assert.equal(current.runningInThisSession, fixture.id);
    assert.equal(current.activeOperation.kind, 'assessment');
    const progress = json(await run.execute('progress', { action: 'progress' }, undefined, undefined, ctx));
    assert.deepEqual([progress.assessment, progress.preparation, progress.ownedByThisSession], [true, false, true]);
    assert.equal(progress.operationId, current.activeOperation.id);
    assert.ok(progress.usage.calls > before.usage.calls, 'status reads in-flight usage from the same live executor');
    said.push('Останови смысловую проверку');
    const pending = run.execute('stop', { action: 'stop', id: fixture.id }, undefined, undefined, ctx);
    release();
    const stopped = json(await pending);
    assert.equal(stopped.stopped, true); assert.equal(stopped.operationKind, 'assessment');
    assert.equal(stopped.operationId, progress.operationId);
    assert.equal(confirms.length, 0, 'an explicit stop request does not need a second approval');
    assert.equal(sent.length, 0, 'the stop row is the single completion answer');
    const saved = await fixture.read();
    assert.equal(saved.phase, 'review');
    assert.equal(saved.librarySnapshot!.variants[0]!.userState.opening, 'Здравствуйте, не проходит возврат');
    assert.equal(json(await status.execute('stopped-status', {}, undefined, undefined, ctx)).activeOperation, null);
    checkGate = undefined;
    said.push('Продолжи смысловую проверку');
    await scenarios.execute('resume-check', { operation: 'assess' }, undefined, undefined, ctx);
    while (!(await fixture.read()).librarySnapshot!.variants.every(v => v.quality === 'ready')) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok((await fixture.read()).usage.calls >= stopped.usage.calls, 'resuming does not reset the cumulative budget');
  } finally { checkGate = undefined; release(); await shutdown(); await fixture.cleanup(); }
});

test('a slow recheck does not hold the conversation: the edit answers at once, a new edit restarts the check, the outcome arrives as a message', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-background-check-');
  const { tools, sent, shutdown } = registered(undefined, 0);
  let release!: () => void;
  checkGate = new Promise<void>(resolve => { release = resolve; });
  try {
    const said = ['Поменяй первую реплику первой карточки на: Здравствуйте, не проходит возврат'];
    const { ctx, widgets } = terminal(fixture.cwd, said);
    const tool = tools.get('agent_lab_scenarios')!;
    const shown = json(await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx));
    const first = await tool.execute('edit-1', { operation: 'edit', variant: '1', change: { field: 'opening', value: 'Здравствуйте, не проходит возврат' } }, undefined, undefined, ctx);
    assert.equal(json(first).check.status, 'running'); assert.match(drawn(tool, first, false).join('\n'), /Смысл перепроверяю в фоне/);
    assert.equal((await fixture.read()).librarySnapshot!.variants[0]!.userState.opening, 'Здравствуйте, не проходит возврат', 'the edit itself is already saved');
    assert.equal(json(await tool.execute('read', { operation: 'show' }, undefined, undefined, ctx)).variants.length, 2, 'reading works while the check runs');
    // The owner goes on: the running check is cancelled, the new edit lands, the check restarts. The hash the model holds is from before the check.
    said.push('А во второй пусть спрашивает: Когда вернут деньги?');
    const callsBefore = checkCalls;
    const second = await tool.execute('edit-2', { operation: 'edit', variant: '2', expectedLibraryHash: json(first).libraryHash, change: { field: 'opening', value: 'Когда вернут деньги?' } }, undefined, undefined, ctx);
    assert.equal(json(second).mutated, true, 'this session\'s own recheck bookkeeping is not a stale state');
    assert.equal(sent.length, 0, 'a cancelled check reports nothing');
    release();
    while (!sent.length) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(checkCalls > callsBefore, 'the check restarted after the second edit');
    assert.equal(sent[0]!.message.customType, 'agent-lab-check'); assert.deepEqual(sent[0]!.options, { deliverAs: 'followUp', triggerTurn: false }, 'a card that came out ready needs no turn of the model');
    const library = (await fixture.read()).librarySnapshot!;
    assert.deepEqual(library.variants.map(item => [item.userState.opening, item.quality]), [['Здравствуйте, не проходит возврат', 'ready'], ['Когда вернут деньги?', 'ready']]);
    assert.equal(JSON.parse(sent[0]!.message.content).libraryHash, libraryHash(library)); assert.notEqual(shown.libraryHash, libraryHash(library));
    assert.match(widgets.find(lines => lines)!.join('\n'), /Перепроверяю смысл изменённых карточек/);
    while (widgets.at(-1) !== undefined) await new Promise(resolve => setTimeout(resolve, 20));
    // Acceptance waits for nothing now and sees checked cards.
    const { ctx: accepting } = terminal(fixture.cwd, ['Прими готовые'], [true]);
    assert.equal(json(await tool.execute('accept', { operation: 'accept', select: 'ready' }, undefined, undefined, accepting)).accepted, true);
  } finally { checkGate = undefined; release(); await shutdown(); await fixture.cleanup(); }
});

test('an edit aimed at an older run of a library that has moved on shows the newest revision instead of failing, and then lands in its draft', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-newer-revision-');
  const { tools, shutdown } = registered();
  try {
    const said = ['Прими готовые и запусти'];
    const { ctx } = terminal(fixture.cwd, said, [true, true]);
    const scenarios = tools.get('agent_lab_scenarios')!;
    await scenarios.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    await scenarios.execute('accept', { operation: 'accept', select: 'ready' }, undefined, undefined, ctx);
    await tools.get('agent_lab_run')!.execute('run', {}, undefined, undefined, ctx);
    // The library moves on in a draft of its own…
    said.push('Убери вторую карточку');
    const moved = json(await scenarios.execute('remove', { operation: 'remove', id: fixture.id, variant: '2' }, undefined, undefined, ctx));
    // …and the owner comes back to the first run, which still shows both cards.
    said.push('Вернись к первому прогону и поменяй первую реплику первой карточки: Добрый день, нужен возврат');
    await scenarios.execute('old-show', { operation: 'show', id: fixture.id }, undefined, undefined, ctx);
    const change = { operation: 'edit', id: fixture.id, variant: '1', change: { field: 'opening', value: 'Добрый день, нужен возврат' } };
    const first = await scenarios.execute('old-edit', change, undefined, undefined, ctx);
    assert.equal(json(first).status, 'stale_library'); assert.equal(json(first).variants.length, 1, 'the answer is the newest revision, where the second card is already gone');
    assert.match(drawn(scenarios, first, false).join('\n'), /есть ревизия новее, чем в прогоне .*: правки идут в неё/);
    const second = json(await scenarios.execute('old-edit-again', change, undefined, undefined, ctx));
    assert.equal(second.mutated, true); assert.equal(second.draftRunId, moved.draftRunId, 'the library has one line of revisions and one draft');
    const store = new ExperimentStore(join(fixture.cwd, '.agent-lab'));
    assert.equal((await store.get(moved.draftRunId)).librarySnapshot!.variants[0]!.userState.opening, 'Добрый день, нужен возврат');
    assert.equal((await store.list()).length, 2);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('review 92e30d3: a learned fact never becomes prior knowledge without the owner\'s native decision', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-review-authority-');
  const { tools, shutdown } = registered();
  try {
    const { ctx, confirms } = terminal(fixture.cwd, ['Покажи сценарии'], [false, false]);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    // «Срок: три дня» is what the old agent said; the model tries to turn it into what the client knew beforehand.
    const promoted = json(await tool.execute('promote', { operation: 'edit', variant: '2', change: { field: 'fact', fact: 'Срок', availability: 'initial' } }, undefined, undefined, ctx));
    assert.equal(promoted.status, 'declined'); assert.match(confirms[0]!.body, /«Срок: три дня»[\s\S]*клиент знал это до разговора/);
    assert.equal((await fixture.read()).librarySnapshot!.variants[1]!.userState.facts[0]!.availability, 'learned_in_source');
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('review 92e30d3: stopping needs a real request and the run that is actually going; acceptance shows definitions; the plan names the models that will run', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-review-stop-');
  const { tools, shutdown } = registered(0);
  const release = await holdReplies();
  try {
    const said = ['Прими готовые и запусти'];
    const { ctx, confirms } = terminal(fixture.cwd, said, [true, true, false]);
    const run = tools.get('agent_lab_run')!, scenarios = tools.get('agent_lab_scenarios')!;
    await scenarios.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    await scenarios.execute('accept', { operation: 'accept', select: 'ready' }, undefined, undefined, ctx);
    assert.match(confirms[0]!.body, /1\. Возврат 1\n   Клиент пишет: «Помогите с возвратом»\n   Ожидается: Уточнён номер терминала/, 'the owner accepts test definitions, not a list of titles');
    // The plan names the models that will really answer: a role override wins over the common model, as in the runtime.
    const planned = await fixture.read();
    planned.mode = 'live'; planned.settings.provider = 'common'; planned.settings.model = 'model-a';
    planned.settings.roles = { simulator: { provider: 'other', model: 'model-b' } }; planned.settings.judge = { provider: 'judge', model: 'model-c' } as never;
    assert.ok(planLines(planned).includes('Модели: клиента играет other/model-b; судья — judge/model-c'), planLines(planned).join(' | '));
    assert.equal(json(await run.execute('run', {}, undefined, undefined, ctx)).background, true);
    said.push('Останови прогон');
    const other = json(await run.execute('stop-other', { action: 'stop', id: 'no-such-run-0000' }, undefined, undefined, ctx));
    assert.equal(other.status, 'unknown_reference'); assert.equal((await fixture.read()).phase, 'evaluating', 'a run the owner did not name is never stopped in its place');
    const pending = run.execute('stop', { action: 'stop', id: fixture.id }, undefined, undefined, ctx);
    await release();
    assert.equal(json(await pending).stopped, true);
  } finally { await release(); await shutdown(); await fixture.cleanup(); }
});

test('review 92e30d3: «второй прогон» is the second row that was shown, and an old row is rebuilt from its stored revision when the cache is gone', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-review-history-');
  const { tools, shutdown } = registered();
  try {
    const said = ['Поменяй первую реплику первой карточки: Добрый день, нужен возврат'];
    const { ctx } = terminal(fixture.cwd, said, [true, true]);
    const scenarios = tools.get('agent_lab_scenarios')!;
    await scenarios.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    const edit = await scenarios.execute('edit', { operation: 'edit', variant: '1', change: { field: 'opening', value: 'Добрый день, нужен возврат' } }, undefined, undefined, ctx);
    assert.doesNotMatch(JSON.stringify(edit.details), /Добрый день|Возврат 1/, 'the session file still holds ids and hashes only');
    said.push('А теперь так: Здравствуйте, не проходит возврат');
    said.push('Поменяй там ещё раз первую реплику: Здравствуйте, не проходит возврат');
    await scenarios.execute('edit-2', { operation: 'edit', variant: '1', change: { field: 'opening', value: 'Здравствуйте, не проходит возврат' } }, undefined, undefined, ctx);
    forgetFeeds();
    let redrawn!: () => void;
    const ready = new Promise<void>(resolve => { redrawn = resolve; });
    const waiting = (scenarios.renderResult!(edit as never, { expanded: false, isPartial: false }, plainTheme as never, { invalidate: redrawn } as never) as unknown as Component).render(100).join('\n');
    assert.match(waiting, /восстанавливаю из сохранённой ревизии/);
    await ready;
    const restored = drawn(scenarios, edit, false).join('\n');
    assert.match(restored, /было: Помогите с возвратом/); assert.match(restored, /стало: Добрый день, нужен возврат/, 'the historical «было → стало» of that edit, not today\'s state');
    // Two runs: the list shows the newest first, and the number means the row of that list.
    await scenarios.execute('accept', { operation: 'accept', select: 'ready' }, undefined, undefined, ctx);
    await tools.get('agent_lab_run')!.execute('run', {}, undefined, undefined, ctx);
    await tools.get('agent_lab_repeat')!.execute('repeat', {}, undefined, undefined, ctx);
    const status = json(await tools.get('agent_lab_status')!.execute('status', {}, undefined, undefined, ctx));
    const second = json(await tools.get('agent_lab_run')!.execute('progress', { action: 'progress', id: '2' }, undefined, undefined, ctx));
    assert.equal(second.id, status.runs[1].id, 'number 2 is the second row of the shown list');
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('the owner settles a checker\'s question in their own name: the card becomes ready, a blocking remark cannot be waived, an edit reopens the question', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-resolve-');
  const { tools, shutdown } = registered();
  try {
    // The checker doubts one rule of the first card and blocks the second card.
    const lab = new ExperimentLab(join(fixture.cwd, '.agent-lab'), runtime);
    await lab.init();
    const before = await lab.readLibrary(fixture.id);
    const findings = before.library.variants.flatMap(variant => semanticPaths(variant).map(path => ({ variantId: variant.id, path,
      status: variant.id === 'variant_1' && path.includes('checkpoints') ? 'needs_review' as const : variant.id === 'variant_2' && path === 'behaviorPolicy' ? 'blocked' as const : 'ready' as const,
      reason: variant.id === 'variant_1' ? 'Ожидание расширяет исходное правило: источник этого не подтверждает.' : 'Поведение противоречит фактам.' })));
    const doubted = recordSemanticAssessment(before.library, findings);
    await lab.store.publishLibrary({ ...before.experiment, librarySnapshot: doubted }, doubted, libraryHash(before.library));
    await lab.close();
    const said = ['Да, это моё правило, так и должно быть'];
    const { ctx, confirms } = terminal(fixture.cwd, said, [false, true]);
    const tool = tools.get('agent_lab_scenarios')!;
    const shown = json(await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx));
    assert.deepEqual(shown.variants.map((item: { quality: string }) => item.quality), ['needs_review', 'blocked']);
    assert.equal(json(await tool.execute('no', { operation: 'resolve', variant: '1', verify: 'later' }, undefined, undefined, ctx)).status, 'declined', 'only the owner\'s native «да» settles it');
    assert.match(confirms[0]!.body, /Проверка «Агент уточнил номер терминала»: Ожидание расширяет исходное правило/);
    // The hand-made assessment has no work receipts, so the recheck is held back: the card must become ready by the owner's decision alone.
    const settled = await tool.execute('yes', { operation: 'resolve', variant: '1', verify: 'later' }, undefined, undefined, ctx);
    const library = (await fixture.read()).librarySnapshot!;
    assert.equal(library.variants[0]!.quality, 'ready'); assert.equal(library.ownerResolutions!.length, 1);
    assert.equal(library.ownerResolutions![0]!.reason, `Владелец в разговоре: «${said[0]}»`);
    assert.match(drawn(tool, settled, false).join('\n'), /Вопрос по карточке «Возврат 1» закрыт вашим решением/);
    assert.equal(json(await tool.execute('blocked', { operation: 'resolve', variant: '2', verify: 'later' }, undefined, undefined, ctx)).status, 'needs_owner_input', 'a blocking remark is fixed in the card, never waived');
    // Review 86bdf60 #2: the rule is rewritten, the checker repeats the very same sentence — it is a new question, the old decision does not carry over.
    said.push('Поменяй правило первой карточки: агент уточнил номер терминала и срок возврата');
    await tool.execute('rewrite', { operation: 'edit', variant: '1', verify: 'later', change: { field: 'rule', value: 'Агент уточнил номер терминала и срок возврата' } }, undefined, undefined, ctx);
    const again = new ExperimentLab(join(fixture.cwd, '.agent-lab'), runtime);
    await again.init();
    const edited = await again.readLibrary(fixture.id);
    const repeated = recordSemanticAssessment(edited.library, findings);
    await again.store.publishLibrary({ ...edited.experiment, librarySnapshot: repeated }, repeated, libraryHash(edited.library));
    await again.close();
    const reopened = (await fixture.read()).librarySnapshot!;
    assert.equal(reopened.ownerResolutions!.length, 1, 'the old decision is kept as history');
    assert.equal(reopened.variants[0]!.quality, 'needs_review', 'but it does not settle the question about the rewritten rule');
    assert.equal((await fixture.read()).librarySnapshot!.variants[1]!.quality, 'blocked');
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('grouped resolve previews an explicit shared rule scope, then publishes one revision without settling unrelated questions', { timeout: 60000 }, async () => {
  const fixture = await sharedQuestionDraft('chat-grouped-resolve-');
  const { tools, shutdown } = registered();
  const edit = ExperimentLab.prototype.editLibrary;
  let publications = 0;
  ExperimentLab.prototype.editLibrary = function(id, hash, patch) { if (patch.kind === 'resolve_findings') publications++; return edit.call(this, id, hash, patch); };
  try {
    const said = ['Для первой и второй карточки подтверждаю применимость правила про номер терминала.'];
    const { ctx, confirms } = terminal(fixture.cwd, said, [false, true]);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    const before = await fixture.read(), beforeLibrary = before.librarySnapshot!;
    const declined = json(await tool.execute('decline', { operation: 'resolve', variants: ['1', '2'], verify: 'later' }, undefined, undefined, ctx));
    assert.equal(declined.status, 'declined');
    assert.deepEqual((await fixture.read()).librarySnapshot, beforeLibrary);
    assert.equal(publications, 0);
    assert.match(confirms[0]!.body, /Одно решение для 2 карточек · ревизия/);
    assert.match(confirms[0]!.body, /1\. Возврат 1[\s\S]*2\. Возврат 2[\s\S]*Правило:[\s\S]*Когда применимо:[\s\S]*Основание:[\s\S]*Источник:/);

    const result = await tool.execute('agree', { operation: 'resolve', variants: ['1', '2'], verify: 'later' }, undefined, undefined, ctx);
    const after = await fixture.read(), library = after.librarySnapshot!;
    assert.equal(json(result).mutated, true);
    assert.equal(publications, 1, 'all receipts go through one ExperimentLab edit and one store publication');
    assert.equal(confirms.length, 2, 'one native scope decision per attempt, not per card');
    assert.equal(library.revision, beforeLibrary.revision + 1);
    assert.deepEqual(json(result).decisionScope.variantIds, ['variant_1', 'variant_2']);
    assert.equal(json(result).decisionScope.libraryHash, libraryHash(beforeLibrary));
    assert.equal(library.ownerResolutions!.length, 2);
    assert.equal(new Set(library.ownerResolutions!.map(item => item.editId)).size, 1);
    assert.ok(library.ownerResolutions!.every(item => item.reason === `Владелец в разговоре: «${said[0]}»`));
    assert.deepEqual(library.variants.map(item => item.quality), ['needs_review', 'ready'], 'the unrelated policy question remains open');
    assert.equal(after.usage.calls, before.usage.calls);
    assert.deepEqual(await new ExperimentStore(join(fixture.cwd, '.agent-lab')).readLibrary(beforeLibrary.id, libraryHash(beforeLibrary)), beforeLibrary);
    const shown = await tool.execute('card', { operation: 'show', variant: '2' }, undefined, undefined, ctx);
    assert.match(drawn(tool, shown, true).join('\n'), /Решения владельца[\s\S]*общее решение для 2 карточек/);
    said.push('Добавь к первой карточке случай, где клиент не знает номер терминала');
    await tool.execute('child', { operation: 'variant', variant: '1', kind: 'missing_fact', verify: 'later' }, undefined, undefined, ctx);
    const extended = (await fixture.read()).librarySnapshot!;
    const child = extended.variants.find(item => item.parentVariantId === 'variant_1')!;
    assert.ok(child);
    assert.equal(extended.ownerResolutions!.some(item => item.variantId === child.id), false, 'new descendants do not inherit the owner decision');
  } finally { ExperimentLab.prototype.editLibrary = edit; await shutdown(); await fixture.cleanup(); }
});

test('grouped resolve refuses partial scope matches and blocked members without confirmations or writes', { timeout: 60000 }, async () => {
  for (const second of ['different', 'blocked'] as const) {
    const fixture = await sharedQuestionDraft(`chat-grouped-${second}-`, second);
    const { tools, shutdown } = registered();
    try {
      const { ctx, confirms } = terminal(fixture.cwd, ['Подтверждаю правило для первой и второй карточки'], [true]);
      const tool = tools.get('agent_lab_scenarios')!;
      await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
      const before = (await fixture.read()).librarySnapshot!;
      const result = json(await tool.execute('resolve', { operation: 'resolve', variants: ['1', '2'], verify: 'later' }, undefined, undefined, ctx));
      assert.equal(result.status, 'needs_owner_input');
      assert.equal(result.mutated, false);
      assert.equal(confirms.length, 0);
      assert.deepEqual((await fixture.read()).librarySnapshot, before);
    } finally { await shutdown(); await fixture.cleanup(); }
  }
});

test('grouped resolve records only a native decision on the preview and refuses stale scope', { timeout: 60000 }, async () => {
  const fixture = await sharedQuestionDraft('chat-grouped-protected-');
  const { tools, shutdown } = registered();
  try {
    const said = ['Закрой общий вопрос в первой и второй карточках', 'Первую не трогай, решение относится только ко второй'];
    const { ctx, confirms } = terminal(fixture.cwd, said, [false]);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    const before = (await fixture.read()).librarySnapshot!;
    const protectedResult = json(await tool.execute('wrong', { operation: 'resolve', variants: ['1', '2'], ownerQuote: said[0], verify: 'later' }, undefined, undefined, ctx));
    assert.equal(protectedResult.status, 'declined');
    assert.match(confirms[0]!.body, /Возврат 1[\s\S]*Возврат 2/);
    assert.equal(confirms.length, 1);
    assert.deepEqual((await fixture.read()).librarySnapshot, before);
    said.push('Теперь решение относится к первой и второй карточкам');
    const lab = new ExperimentLab(join(fixture.cwd, '.agent-lab'), runtime);
    await lab.init();
    try { await lab.editLibrary(fixture.id, libraryHash(before), { kind: 'edit_variant_text', variantId: 'variant_2', field: 'opening', value: 'Добрый день, когда будет возврат?', editId: 'concurrent_edit', reason: 'Concurrent revision fixture' }, 'owner'); }
    finally { await lab.close(); }
    const changed = (await fixture.read()).librarySnapshot!;
    const stale = json(await tool.execute('stale', { operation: 'resolve', variants: ['1', '2'], verify: 'later' }, undefined, undefined, ctx));
    assert.equal(stale.status, 'stale_library');
    assert.equal(confirms.length, 1);
    assert.deepEqual((await fixture.read()).librarySnapshot, changed);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('a resolve with no new owner sentence still stops for the diff', () => {
  assert.equal(authorize({ messages: ['Закрой вопрос по первой карточке'], provenance: true, summary: 'Закрыть вопрос' }).kind, 'confirm');
});

test('grouped resolve cannot turn user message fragments into a native owner receipt', { timeout: 60000 }, async () => {
  const fixture = await sharedQuestionDraft('chat-grouped-protection-forms-');
  const { tools, shutdown } = registered();
  try {
    const tool = tools.get('agent_lab_scenarios')!;
    const before = (await fixture.read()).librarySnapshot!;
    for (const protection of ['Карточку «Возврат 1» не трогай, закрой вопрос во второй',
      'В первой карточке вопрос не закрывай, закрой только во второй',
      'Первую не трогай, можно закрыть вопрос во второй?',
      'Не подтверждай правило в карточке "Возврат 1", решение касается второй']) {
      const said = ['Закрой общий вопрос в первой и второй карточках', protection];
      const { ctx, confirms } = terminal(fixture.cwd, said, [false]);
      await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
      const result = json(await tool.execute('protected', { operation: 'resolve', variants: ['1', '2'], ownerQuote: said[0], verify: 'later' }, undefined, undefined, ctx));
      assert.equal(result.status, 'declined', protection);
      assert.match(confirms[0]!.body, /Возврат 1[\s\S]*Возврат 2/);
      assert.equal(confirms.length, 1, protection);
      assert.deepEqual((await fixture.read()).librarySnapshot, before);
    }
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('legacy accepted owner decisions keep their snapshot and run identity; draft group changes reopen their question', { timeout: 60000 }, async () => {
  const fixture = await sharedQuestionDraft('chat-legacy-resolution-');
  const lab = new ExperimentLab(join(fixture.cwd, '.agent-lab'), runtime);
  await lab.init();
  try {
    const before = await lab.readLibrary(fixture.id);
    const settled = await lab.editLibrary(fixture.id, libraryHash(before.library), { kind: 'resolve_finding', variantId: 'variant_2',
      path: 'evaluationSpec.checkpoints.ask_terminal', editId: 'legacy_owner', reason: 'Historical owner resolution' }, 'owner');
    assert.equal(settled.library.ownerResolutions![0]!.businessHash, undefined, 'legacy receipt has its original shape');
    const accepted = await lab.acceptLibrary(fixture.id, libraryHash(settled.library), ['variant_2']);
    const encoded = JSON.stringify(accepted.library);
    const restored = libraryV1Schema.parse(JSON.parse(encoded));
    assert.equal(libraryHash(restored), libraryHash(accepted.library));
    assert.deepEqual(librarySnapshot(restored), librarySnapshot(accepted.library));
    assert.deepEqual(compileLibrary(restored), compileLibrary(accepted.library));
    verifyAcceptedRun(JSON.parse(JSON.stringify(accepted.experiment)));
    const original = restored.businessScenarios[0]!;
    const split = editLibrary(restored, libraryHash(restored), { kind: 'split_business', businessScenarioId: original.id, variantIds: ['variant_1'], reason: 'New draft context',
      newBusiness: { key: 'other_context', title: 'Иные условия', goal: original.goal, conditions: ['Клиент отменил запрос'], requirementIds: original.requirementIds, grouping: { status: 'confirmed', reason: 'Owner requested context' } } });
    const newGroup = split.businessScenarios.find(group => group.id !== original.id)!;
    const merged = editLibrary(split, libraryHash(split), { kind: 'merge_business', targetId: original.id, sourceIds: [newGroup.id], reason: 'Owner changes context of the original group' });
    const checked = recordSemanticAssessment(merged, restored.semanticAssessment!.findings);
    assert.equal(checked.variants.find(card => card.id === 'variant_2')!.quality, 'needs_review', 'same card, rule and checker words with different group conditions need a new decision');
    assert.equal(JSON.stringify(accepted.library), encoded, 'accepted historical snapshot was not upgraded in place');
    verifyAcceptedRun(accepted.experiment);
  } finally { await lab.close(); await fixture.cleanup(); }
});

test('owner resolution hashes bind business conditions as well as the rule, so changed context reopens the question', () => {
  const library = libraryFixture();
  const card = library.variants[0]!;
  const path = `evaluationSpec.checkpoints.${card.evaluationSpec.checkpoints[0]!.id}`;
  const reason = 'Не определена применимость';
  const hash = resolutionBusinessHash(library, card);
  const shared = resolutionQuestionHash(library, card, path, reason);
  library.businessScenarios.find(group => group.id === card.businessScenarioId)!.conditions.push('Клиент отменил запрос');
  assert.notEqual(resolutionBusinessHash(library, card), hash);
  assert.notEqual(resolutionQuestionHash(library, card, path, reason), shared);
});

test('grouped resolution API validates all member hashes and rule scopes atomically, with no raw-patch native bypass', { timeout: 60000 }, async () => {
  const fixture = await sharedQuestionDraft('chat-grouped-api-');
  const { tools, shutdown } = registered();
  try {
    const lab = new ExperimentLab(join(fixture.cwd, '.agent-lab'), runtime);
    await lab.init();
    let patch!: Extract<Parameters<ExperimentLab['editLibrary']>[2], { kind: 'resolve_findings' }>;
    try {
      const before = await lab.readLibrary(fixture.id);
      const path = 'evaluationSpec.checkpoints.ask_terminal';
      patch = { kind: 'resolve_findings', editId: 'owner_group', reason: 'Owner scope fixture', findings: before.library.variants.map(card => {
        const finding = before.library.semanticAssessment!.findings.find(item => item.variantId === card.id && item.path === path)!;
        return { variantId: card.id, path, findingHash: resolutionHash(before.library, card, path, finding.reason) };
      }) };
      await assert.rejects(lab.editLibrary(fixture.id, libraryHash(before.library), { ...patch, findings: [patch.findings[0]!, { ...patch.findings[1]!, findingHash: '0'.repeat(64) }] }, 'owner'), /устарели/);
      assert.deepEqual((await lab.readLibrary(fixture.id)).library, before.library, 'valid first member was not published before invalid second member');
      const mixedPath = 'behaviorPolicy';
      const mixedFinding = before.library.semanticAssessment!.findings.find(item => item.variantId === 'variant_1' && item.path === mixedPath)!;
      const mixed = { variantId: 'variant_1', path: mixedPath, findingHash: resolutionHash(before.library, before.library.variants[0]!, mixedPath, mixedFinding.reason) };
      await assert.rejects(lab.editLibrary(fixture.id, libraryHash(before.library), { ...patch, findings: [mixed, patch.findings[1]!] }, 'owner'), /общего вопроса/);
      assert.deepEqual((await lab.readLibrary(fixture.id)).library, before.library);
    } finally { await lab.close(); }
    const { ctx, confirms } = terminal(fixture.cwd, ['Закрой общий вопрос'], [true]);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    await assert.rejects(tool.execute('bypass', { operation: 'edit', patch, verify: 'later' }, undefined, undefined, ctx), /не принимается/);
    assert.equal(confirms.length, 0);
    assert.equal((await fixture.read()).librarySnapshot!.ownerResolutions, undefined);
  } finally { await shutdown(); await fixture.cleanup(); }
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
    const picks: (string | undefined)[] = [undefined, 'Согласен с судьёй'];
    const asked: string[] = [];
    const { ctx } = terminal(cwd, ['Покажи первый провал. Да, согласен с судьёй']);
    (ctx.ui as unknown as { select: (title: string, options: string[]) => Promise<string | undefined> }).select = async title => { asked.push(title); return picks.shift(); };
    const agree = tools.get('agent_lab_agree')!;
    const skipped = json(await agree.execute('skip', { failure: 1 }, undefined, undefined, ctx));
    assert.equal(skipped.cancelled, true); assert.equal((await new ExperimentStore(join(cwd, '.agent-lab')).get(demo.record.id)).humanReviews?.length ?? 0, 0, 'no answer in the dialog, no mark');
    const marked = await agree.execute('mark', { failure: 1 }, undefined, undefined, ctx);
    assert.match(asked[1]!, /судья решил: не справился\. Ваше мнение\?/);
    const reviews = (await new ExperimentStore(join(cwd, '.agent-lab')).get(demo.record.id)).humanReviews ?? [];
    assert.ok(reviews.length >= 1); assert.ok(reviews.every(item => item.source === 'quick' && item.verdict === 'fail' && item.judgeVerdict === 'fail'));
    assert.match(drawn(agree, marked, false).join('\n'), /Отмечено вашим решением: согласен с судьёй/);
  } finally { await shutdown(); await rm(cwd, { recursive: true, force: true }); await rm(demo.directory, { recursive: true, force: true }); }
});

test('review 86bdf60: the owner\'s waiver has one door — a ready-made patch or request never gets rights the conversational form lacks', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-review-bypass-');
  const { tools, shutdown } = registered();
  try {
    const lab = new ExperimentLab(join(fixture.cwd, '.agent-lab'), runtime);
    await lab.init();
    const before = await lab.readLibrary(fixture.id);
    const doubted = recordSemanticAssessment(before.library, before.library.variants.flatMap(variant => semanticPaths(variant).map(path => ({ variantId: variant.id, path,
      status: variant.id === 'variant_1' && path.includes('checkpoints') ? 'needs_review' as const : 'ready' as const, reason: 'Источник этого не подтверждает.' }))));
    await lab.store.publishLibrary({ ...before.experiment, librarySnapshot: doubted }, doubted, libraryHash(before.library));
    await lab.close();
    const { ctx, confirms } = terminal(fixture.cwd, ['Исправь первую реплику'], [false]);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    const bypass = await tool.execute('bypass', { operation: 'edit', verify: 'later', patch: { kind: 'resolve_finding', variantId: 'variant_1', path: 'evaluationSpec.checkpoints.ask_terminal', editId: 'model_1', reason: 'x' } }, undefined, undefined, ctx).catch(error => error as Error);
    assert.match(bypass instanceof Error ? bypass.message : '', /не принимается/);
    assert.equal((await fixture.read()).librarySnapshot!.ownerResolutions, undefined, 'nothing was recorded in the owner\'s name');
    const legacy = await tool.execute('legacy', { operation: 'variant', verify: 'later', request: { parentId: 'variant_1', operation: 'ambiguous_opening', reason: 'model', input: { opening: 'Помогите' } } }, undefined, undefined, ctx).catch(error => error as Error);
    assert.match(legacy instanceof Error ? legacy.message : '', /не принимается/);
    assert.equal(confirms.length, 0, 'a raw request never reaches the native dialog');
    assert.equal((await fixture.read()).librarySnapshot!.variants.length, 2);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('shown lists survive a restart of Pi: «второй прогон» and «первый провал» still mean the rows the owner saw', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-shown-restart-');
  const first = registered();
  try {
    const { ctx } = terminal(fixture.cwd, ['Прими готовые и запусти'], [true, true]);
    await first.tools.get('agent_lab_scenarios')!.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    await first.tools.get('agent_lab_scenarios')!.execute('accept', { operation: 'accept', select: 'ready' }, undefined, undefined, ctx);
    await first.tools.get('agent_lab_run')!.execute('run', {}, undefined, undefined, ctx);
    await first.tools.get('agent_lab_repeat')!.execute('repeat', {}, undefined, undefined, ctx);
    const status = json(await first.tools.get('agent_lab_status')!.execute('status', {}, undefined, undefined, ctx));
    await first.tools.get('agent_lab_status')!.execute('status-again', {}, undefined, undefined, ctx);
    const lists = first.entries.filter(entry => entry.customType === 'agent-lab-shown' && (entry.data as { kind: string }).kind === 'runs');
    assert.equal(lists.length, 1, 'the same list shown twice is written once');
    assert.deepEqual((lists[0]!.data as { ids: string[] }).ids, status.runs.map((run: { id: string }) => run.id));
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
    const forgetful = registered();
    const blank = terminal(fixture.cwd, ['Как там второй прогон?']);
    assert.equal(json(await forgetful.tools.get('agent_lab_run')!.execute('progress', { action: 'progress', id: '2' }, undefined, undefined, blank.ctx)).id, status.runs[0].id, 'without the session entries the number means a fresh query: the test bites');
    await forgetful.shutdown();
  } finally { await first.shutdown(); await fixture.cleanup(); }
  // Failures: the list the owner saw (here: today's list reversed) decides what «первый провал» opens after a restart.
  const demo = await demoEvaluateRecord('chat-shown-failures-');
  await demo.lab.close();
  const cwd = await mkdtemp(join(tmpdir(), 'chat-shown-failures-cwd-'));
  const saved = new ExperimentStore(join(cwd, '.agent-lab'));
  await saved.init();
  try { await saved.save(demo.record); } finally { await saved.close(); }
  runtime = createDemoRuntime();
  const showing = registered(), later = registered();
  try {
    const opened = json(await showing.tools.get('agent_lab_inspect')!.execute('failure', { failure: 1 }, undefined, undefined, terminal(cwd, ['Покажи первый провал']).ctx));
    const entry = showing.entries.find(item => item.customType === 'agent-lab-shown' && (item.data as { kind: string }).kind === 'failures')!;
    const ids = (entry.data as { key: string; ids: string[] }).ids;
    assert.equal(ids.length, opened.failure.of); assert.ok(ids.length >= 2, 'the demo run has several failures');
    const reversed = { ...entry, data: { ...entry.data as object, ids: [...ids].reverse() } };
    const again = json(await later.tools.get('agent_lab_inspect')!.execute('failure', { failure: 1 }, undefined, undefined, terminal(cwd, ['Покажи первый провал'], [], { entries: [entry, reversed] }).ctx));
    assert.equal(again.trial.scenarioId, ids.at(-1), 'the latest entry wins, and number 1 is its first row');
    assert.notEqual(again.trial.scenarioId, opened.trial.scenarioId);
  } finally { await showing.shutdown(); await later.shutdown(); await rm(cwd, { recursive: true, force: true }); await rm(demo.directory, { recursive: true, force: true }); }
});

/** Replaces the two cards of a draft with `count` ready cards cloned from the first one; openings differ so a page can be told from another. */
async function growLibrary(fixture: Awaited<ReturnType<typeof draft>>, count: number): Promise<void> {
  const lab = new ExperimentLab(join(fixture.cwd, '.agent-lab'), runtime);
  await lab.init();
  try {
    const before = await lab.readLibrary(fixture.id);
    const seed = before.library.variants[0]!;
    const grown = { ...before.library, variants: Array.from({ length: count }, (_, index) => ({ ...structuredClone(seed), id: `card_${index + 1}`, title: `Карточка ${index + 1}`,
      userState: { ...structuredClone(seed.userState), opening: `Помогите с возвратом, случай ${index + 1}` } })) };
    const ready = recordSemanticAssessment(grown, grown.variants.flatMap(variant => semanticPaths(variant).map(path => ({ variantId: variant.id, path, status: 'ready' as const, reason: 'Проверено' }))));
    await lab.store.publishLibrary({ ...before.experiment, librarySnapshot: ready }, ready, libraryHash(before.library));
  } finally { await lab.close(); }
}

test('more than eight cards are accepted page by page inside the native dialog: every definition can be opened and nothing is claimed as shown', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-accept-pages-');
  const { tools, shutdown } = registered();
  try {
    await growLibrary(fixture, 10);
    const { ctx, confirms, selects } = terminal(fixture.cwd, ['Прими готовые'], [], { picks: ['Показать следующие определения', 'Не принимать', 'Показать следующие определения', 'Принять все 10 карточек'] });
    const tool = tools.get('agent_lab_scenarios')!;
    const shown = json(await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx));
    assert.deepEqual(shown.variants.map((item: { quality: string }) => item.quality), Array.from({ length: 10 }, () => 'ready'));
    const refused = json(await tool.execute('accept-no', { operation: 'accept', select: 'ready' }, undefined, undefined, ctx));
    assert.equal(refused.cancelled, true); assert.equal((await fixture.read()).librarySnapshot!.acceptance, undefined, '«Не принимать» writes nothing');
    assert.match(selects[0]!.title, /Принять 10 карточек как набор для проверки\?\nОпределения карточек 1–8 из 10 · ещё не открыто: 2/);
    assert.match(selects[0]!.title, /8\. Карточка 8\n   Клиент пишет: «Помогите с возвратом, случай 8»\n   Ожидается: Уточнён номер терминала/);
    assert.doesNotMatch(selects[0]!.title, /случай 9|Карточка 9/, 'the first page holds the first eight definitions only');
    assert.deepEqual(selects[0]!.options, ['Принять все 10 карточек', 'Показать следующие определения', 'Не принимать'], 'accepting is possible on every page');
    assert.match(selects[1]!.title, /Определения карточек 9–10 из 10 · открыты все[\s\S]*случай 9[\s\S]*случай 10[\s\S]*Агент не запускается/);
    assert.deepEqual(selects[1]!.options, ['Принять все 10 карточек', 'Показать определения с начала', 'Не принимать']);
    const accepted = json(await tool.execute('accept-yes', { operation: 'accept', select: 'ready' }, undefined, undefined, ctx));
    assert.equal(accepted.accepted, true);
    const record = await fixture.read();
    assert.equal(record.librarySnapshot!.acceptance!.variantIds.length, 10); assert.equal(record.trials.length, 0);
    assert.equal(confirms.length, 0, 'a large set is confirmed in the paged dialog, not in a body that cannot hold it');
    for (const item of selects) assert.doesNotMatch(item.title, /показаны в ленте|…и ещё/, 'no claim about what was shown elsewhere');
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('a draft tool edits only its explicit reference and records assistant authorship', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-object-'); const { tools, shutdown } = registered();
  try {
    const { ctx, confirms } = terminal(fixture.cwd, ['Во второй карточке сделай начало естественнее']);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    const before = (await fixture.read()).librarySnapshot!;
    const value = 'Добрый день, когда вернут деньги?';
    const result = json(await tool.execute('edit', { operation: 'edit', variant: '2', verify: 'later', change: { field: 'opening', value } }, undefined, undefined, ctx));
    assert.equal(result.mutated, true); assert.equal(confirms.length, 0);
    const after = (await fixture.read()).librarySnapshot!;
    const definition = ({ quality: _q, issues: _i, ownerDecision: _d, ...value }: (typeof after.variants)[number]) => value;
    assert.deepEqual(definition(after.variants[0]!), definition(before.variants[0]!));
    assert.equal(after.variants[1]!.userState.opening, value);
    assert.equal(after.variants[1]!.history.at(-1)!.author, 'assistant');
    assert.equal(after.acceptance, undefined);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('dedicated behavior tool updates the same draft with a visible diff and shared deferred recheck', async () => {
  const f = await draft('lab-behavior-tool-');
  const session = registered();
  try {
    const { ctx, confirms } = terminal(f.cwd, ['Поправь поведение первой карточки: заканчивать после ответа на вопрос.']);
    const view = session.tools.get('agent_lab_scenarios')!;
    const shown = json(await view.execute('read', { id: f.id, variant: '1', source: true }, new AbortController().signal, undefined, ctx));
    const policy = shown.detail[0].behaviorPolicy;
    policy.transitions[0].when = 'Получен ответ на вопрос клиента';
    const result = json(await session.tools.get('agent_lab_edit_behavior')!.execute('repair', { id: f.id, variant: '1', behaviorPolicy: policy, verify: 'later' }, new AbortController().signal, undefined, ctx));
    assert.equal(result.mutated, true);
    assert.equal(result.check.status, 'skipped');
    assert.ok(result.diff.some((item: { path: string }) => item.path === 'behaviorPolicy'));
    const saved = await f.read();
    assert.equal(saved.librarySnapshot!.variants[0]!.behaviorPolicy.transitions[0]!.when, 'Получен ответ на вопрос клиента');
    assert.equal(saved.librarySnapshot!.variants[0]!.history.at(-1)!.author, 'assistant');
    assert.equal(confirms.length, 0);
  } finally { await session.shutdown(); await f.cleanup(); }
});

test('board handoff identifies an unaccepted selected card and routes correction to library tools', async () => {
  const { boardDiscussionContext } = await import('../extensions/lab-ui.ts');
  const f = await draft('lab-board-selection-');
  try {
    const record = await f.read();
    assert.equal(record.scenarios.length, 0, 'runnable scenarios do not exist before acceptance');
    const context = boardDiscussionContext(record, 'cards', 1);
    assert.equal(context.variantId, record.librarySnapshot!.variants[1]!.id);
    assert.equal(context.expectedLibraryHash, libraryHash(record.librarySnapshot!));
    assert.match(context.task, /agent_lab_scenarios/);
    assert.match(context.task, /agent_lab_resume_preparation/);
    assert.doesNotMatch(context.task, /prepare a new draft/);
  } finally { await f.cleanup(); }
});
