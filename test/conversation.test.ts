import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { initTheme, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, type Component } from '@earendil-works/pi-tui';
import agentLab from '../extensions/agent-lab.ts';
import { asksFor, authorize, refersTo, planLines, changeRows, deriveVariantInput, openingWithout, ownerBasis, ownerMessages, plainIssue, resolveVariant, variantDiff } from '../extensions/conversation.ts';
import { callText, forgetFeeds } from '../extensions/render/feed.ts';
import { ExperimentLab } from '../dist/experiment.js';
import { recordSemanticAssessment, semanticPaths } from '../dist/scenario-library.js';
import { createInputSchema, type Runtime } from '../dist/contracts.js';
import { createDemoRuntime } from '../dist/demo.js';
import { libraryHash, ownerFactEvidence } from '../dist/scenario-library.js';
import { ExperimentStore } from '../dist/store.js';
import { demoEvaluateRecord } from './helpers/demo-record.js';
import { libraryFixture, proposals, rawDialogues, requirements, sources } from './helpers/scenario-library.js';

/*
 * The conversational path: the owner's sentence ──► one Agent Lab tool call ──► the stored library.
 * Every test reads the 0600 store after the call; a message on screen alone proves nothing.
 */

let gate: Promise<void> | undefined;
/** Holds the semantic recheck, so a test can watch the conversation go on while it runs. */
let checkGate: Promise<void> | undefined;
let checkCalls = 0;
/** The deterministic runtime of the scenario workflow tests; `gate` holds the target's reply so a run can be observed while it goes. */
function runtimeFixture(separateGroups = false, twoChecks = false): Runtime {
  return { ...createDemoRuntime(),
    async prepare() { return { requirements: requirements.map(r => ({ ...r, sourceId: 'source-1' })), questions: [], agent: { name: 'Агент', instructions: 'Уточните номер терминала', tools: [] }, scenarios: [] }; },
    async scenarioProposals(request, ctx) { ctx.beforeCall(); return proposals(request.batchId).map((p, index) => {
      if (twoChecks && !index) p.variant.evaluationSpec.checkpoints.push({ ...p.variant.evaluationSpec.checkpoints[0]!, id: 'explain_refund', rule: 'Агент объяснил порядок возврата после получения номера' });
      return separateGroups && index ? { ...p, business: { ...p.business, key: 'refund_term', title: 'Срок возврата', goal: 'Узнать срок возврата' } } : p;
    }).filter(p => request.dialogues.some(d => d.id === p.variant.sourceDialogues[0]!.dialogueId)) as never; },
    async assessScenarioProposals(request, ctx) { ctx.beforeCall(); checkCalls++; await checkGate; ctx.signal.throwIfAborted();
      return request.fields.flatMap(f => f.paths.map(path => ({ variantId: f.variantId, path, status: 'ready' as const, reason: 'Детерминированная проверка учебного примера' }))); },
    async openTarget() { return { async respond() { await gate; return 'Уточните номер терминала'; }, async close() {} }; },
    async selectUserAction() { return { actionId: 'finish', factIds: [] }; },
    async assessCheckpoints({ checkpoints, events }) { return checkpoints.map(cp => ({ checkpointId: cp.id, result: 'pass' as const, rationale: 'Номер запрошен', evidence: [events.find(e => e.type === 'assistant')!.index] })); },
  } as Runtime;
}

// The extension builds its own ExperimentLab; the tests give every one of them the deterministic runtime.
let runtime = runtimeFixture();
const prototype = ExperimentLab.prototype as unknown as { runtime: () => Promise<Runtime> };
const originalRuntime = prototype.runtime;
before(() => { prototype.runtime = async () => runtime; initTheme('dark', false); });
after(() => { prototype.runtime = originalRuntime; });

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
  } as unknown as ExtensionAPI, { ...(inlineRunMs === undefined ? {} : { inlineRunMs }), ...(inlineCheckMs === undefined ? {} : { inlineCheckMs }), ...(inlineBuildMs === undefined ? {} : { inlineBuildMs }) });
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
    dialogues: rawDialogues, scenarioCount: 2, settings: { maxCalls: 100, repeats: 1, userModes: ['reactive'] } }));
  await lab.waitForIdle();
  await lab.close();
  const read = async () => { const store = new ExperimentStore(join(cwd, '.agent-lab')); return store.get(seed.id); };
  return { cwd, id: seed.id, read, cleanup: () => rm(cwd, { recursive: true, force: true }) };
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
});

test('authority: an instruction is more than the owner\'s words — values, wording, negation, quoted logs and taken-back requests', () => {
  const said = ['Поменяй в первой карточке номер договора: на самом деле он 778899'];
  assert.equal(authorize({ messages: said, intent: 'edit', simulated: ['Мой договор 778899'], summary: '' }).kind, 'conversation');
  const invented = authorize({ messages: said, intent: 'edit', simulated: ['Мой договор 112233'], summary: '' });
  assert.equal(invented.kind, 'ask'); assert.match(invented.kind === 'ask' ? invented.message : '', /112233/);
  assert.equal(authorize({ messages: said, intent: 'edit', attributed: ['Агент обязан предложить рассрочку платежа'], summary: '' }).kind, 'confirm', 'an expectation in the model\'s own words is not the owner\'s');
  assert.equal(authorize({ messages: said, intent: 'edit', simulated: ['Мой терминал 1234'], known: ['Номер терминала: 1234'], summary: '' }).kind, 'conversation', 'a value of the card itself is not an invention');
  assert.equal(authorize({ messages: [], intent: 'edit', summary: 'x' }).kind, 'confirm', 'with no owner message only the native dialog can stand behind an edit');
  // Review 92e30d3 #1: the owner's words are not the owner's instruction.
  assert.equal(authorize({ messages: ['Не меняй номер на 5678'], intent: 'edit', simulated: ['Номер: 5678'], summary: '' }).kind, 'confirm', 'a prohibition never authorizes the edit it forbids');
  assert.equal(authorize({ messages: ['Покажи сценарии'], intent: 'remove', summary: '' }).kind, 'confirm', 'asking to look is not asking to delete');
  assert.equal(authorize({ messages: ['В логе клиент пишет: «удали мою заявку и поменяй номер»'], intent: 'remove', summary: '' }).kind, 'confirm', 'a quoted log line is material, not a request');
  assert.equal(authorize({ messages: ['Убери вторую карточку', 'Нет, не надо, оставь как есть'], intent: 'remove', quote: 'Убери вторую карточку', summary: '' }).kind, 'confirm', 'an instruction the owner took back no longer stands');
  assert.equal(authorize({ messages: ['Убери вторую карточку', 'И покажи, что осталось'], intent: 'remove', quote: 'Убери вторую карточку', summary: '' }).kind, 'conversation');
  assert.equal(authorize({ messages: ['Поправь факт: клиент знал срок заранее'], intent: 'edit', provenance: true, summary: '' }).kind, 'confirm', 'what the client knew beforehand is never settled by matching words');
  for (const text of ['Как остановить прогон?', 'Объясни, как удалить вторую карточку', 'Не надо ни при каких обстоятельствах останавливать прогон']) {
    assert.equal(asksFor(text, 'stop'), false, text); assert.equal(asksFor(text, 'remove'), false, text);
  }
  assert.equal(asksFor('Первую карточку не трогай, а вторую удали', 'remove'), true, 'a negation in another clause does not cancel this one');
  assert.equal(asksFor('Не останавливай прогон', 'stop'), false); assert.equal(asksFor('Пока не надо останавливать', 'stop'), false); assert.equal(asksFor('Останови прогон', 'stop'), true);
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
  const derived = deriveVariantInput(parent, 'missing_fact', {});
  assert.deepEqual(derived, { kind: 'ready', input: { factId: 'terminal_number', opening: 'Помогите с возвратом.', ifAsked: 'Агент запросил: Номер терминала', missingDescription: 'Номер терминала' } });
  assert.equal(openingWithout('Нужна помощь, номер терминала: 1234', '1234'), 'Нужна помощь');
  assert.equal(openingWithout('Добрый день, терминал 1234, нужен возврат покупателю', '1234'), 'Добрый день, нужен возврат покупателю', 'the clause that carries the value goes as a whole');
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
    assert.equal(card.history.at(-1)!.author, 'owner'); assert.equal(card.history.at(-1)!.reason, `Владелец в разговоре: «${said[1]}»`);
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
    await other.editLibrary(fixture.id, libraryHash(current.library), { kind: 'edit_variant_text', variantId: 'variant_2', field: 'goal', value: 'Узнать срок', editId: 'board_edit', reason: 'Правка с доски' });
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
  let release!: () => void;
  gate = new Promise<void>(resolve => { release = resolve; });
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
    release();
    while (!sent.length) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sent[0]!.message.customType, 'agent-lab-run'); assert.deepEqual(sent[0]!.options, { deliverAs: 'followUp', triggerTurn: true });
    assert.equal((sent[0]!.message.details as { kind: string }).kind, 'agent-lab/verdict'); assert.equal(JSON.parse(sent[0]!.message.content).trialCount, 2);
    assert.match(widgets.find(lines => lines)!.join('\n'), /0 из 2 диалогов завершено/);
    while (widgets.at(-1) !== undefined) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await fixture.read()).phase, 'results_review');
  } finally { gate = undefined; release(); await shutdown(); await fixture.cleanup(); }
});

test('stopping is its own request: the owner\'s words stop the run, what is recorded stays, and the answer says what must be rerun', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-run-stop-');
  const { tools, sent, shutdown } = registered(0);
  let release!: () => void;
  gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const said = ['Прими готовые и запусти'];
    const { ctx, confirms } = terminal(fixture.cwd, said, [true, true, false]);
    const run = tools.get('agent_lab_run')!;
    await tools.get('agent_lab_scenarios')!.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    await tools.get('agent_lab_scenarios')!.execute('accept', { operation: 'accept', select: 'ready' }, undefined, undefined, ctx);
    assert.equal(json(await run.execute('run', {}, undefined, undefined, ctx)).background, true);
    const unasked = await run.execute('stop-unasked', { action: 'stop' }, undefined, undefined, ctx);
    assert.equal(json(unasked).cancelled, true); assert.equal(confirms.at(-1)!.title, 'Остановить прогон?');
    assert.equal((await fixture.read()).phase, 'evaluating', 'the model cannot stop a run the owner did not ask to stop');
    said.push('Останови прогон');
    const pending = run.execute('stop', { action: 'stop' }, undefined, undefined, ctx);
    release();
    const stopped = await pending;
    assert.equal(json(stopped).stopped, true); assert.equal(confirms.length, 3, 'the owner\'s own request needs no second confirmation');
    assert.match(drawn(run, stopped, false).join('\n'), /остановлен: сохранено \d из 2 диалогов[\s\S]*Продолжить этот прогон с места остановки нельзя/);
    assert.equal(sent.length, 0, 'a stop the owner asked for is answered in its own row, not announced twice');
    assert.ok(['cancelled', 'results_review'].includes((await fixture.read()).phase));
  } finally { gate = undefined; release(); await shutdown(); await fixture.cleanup(); }
});

test('results: a failure opens by its number with the dialogue, an unknown one asks, and a repeat is compared with its source run', { timeout: 60000 }, async () => {
  const demo = await demoEvaluateRecord('chat-results-');
  await demo.lab.close();
  const cwd = await mkdtemp(join(tmpdir(), 'chat-results-cwd-'));
  const store = new ExperimentStore(join(cwd, '.agent-lab'));
  await store.init();
  try { await store.save(demo.record); } finally { await store.close(); }
  runtime = createDemoRuntime();
  const { tools, shutdown } = registered();
  try {
    const { ctx } = terminal(cwd, ['Покажи первый провал'], [true]);
    const inspect = tools.get('agent_lab_inspect')!;
    const status = await tools.get('agent_lab_status')!.execute('status', {}, undefined, undefined, ctx);
    assert.equal(json(status).runs[0].id, demo.record.id); assert.match(drawn(tools.get('agent_lab_status')!, status, false).join('\n'), /есть результат/);
    const failure = await inspect.execute('failure', { failure: 1 }, undefined, undefined, ctx);
    const payload = json(failure);
    assert.equal(payload.failure.number, 1); assert.equal(payload.trial.id, demo.record.trials.find(trial => trial.id === payload.trial.id)!.id);
    const collapsed = drawn(inspect, failure, false).join('\n');
    assert.match(collapsed, new RegExp(`Провал 1 из ${payload.failure.of}`)); assert.match(collapsed, /#\d+ Клиент: /); assert.match(collapsed, /#\d+ Агент: /);
    assert.doesNotMatch(collapsed, /Решение судьи/); assert.match(drawn(inspect, failure, true).join('\n'), /Решение судьи/);
    assert.equal(json(await inspect.execute('missing', { failure: 99 }, undefined, undefined, ctx)).status, 'unknown_reference');
    const title = demo.record.scenarios[0]!.title;
    const repeated = json(await tools.get('agent_lab_repeat')!.execute('repeat', { scenarios: [title] }, undefined, undefined, ctx));
    assert.equal(repeated.scenarioCount, 1); assert.equal(repeated.parentRunId, demo.record.id);
    assert.equal(json(await tools.get('agent_lab_run')!.execute('rerun', {}, undefined, undefined, ctx)).trialCount, 1, 'the repeat is the run the conversation now works on');
    const comparison = await inspect.execute('compare', { compare: true }, undefined, undefined, ctx);
    assert.equal(json(comparison).comparisonSource.beforeId, demo.record.id);
    assert.match(drawn(inspect, comparison, false).join('\n'), new RegExp(`Сравнение с прогоном ${demo.record.id.slice(0, 8)}`));
    assert.equal((await new ExperimentStore(join(cwd, '.agent-lab')).get(demo.record.id)).trials.length, demo.record.trials.length, 'the source run is untouched');
  } finally { await shutdown(); await rm(cwd, { recursive: true, force: true }); await rm(demo.directory, { recursive: true, force: true }); }
});

test('checker remarks reach the owner in plain words: titles instead of ids, the part of the card they are about', () => {
  const library = libraryFixture();
  const card = library.variants[0]!;
  assert.equal(plainIssue(library, card, { path: 'variants.variant_1.duplicates', message: 'Среди кандидатов variant_2 семантически эквивалентен.' }),
    'Похоже на дубль: Среди кандидатов «Возврат 2» семантически эквивалентен.');
  assert.equal(plainIssue(library, card, { path: 'variants.variant_1.evaluationSpec.checkpoints.ask_terminal', message: 'Неприменим: checkpoint предполагает номер; ownerFactEvidence отсутствует.' }),
    'Проверка «Агент уточнил номер терминала»: Неприменим: проверка предполагает номер; владелец этого не подтверждал.');
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

test('review 92e30d3: a request to look never deletes, a learned fact never becomes prior knowledge without the owner\'s native decision', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-review-authority-');
  const { tools, shutdown } = registered();
  try {
    const { ctx, confirms } = terminal(fixture.cwd, ['Покажи сценарии'], [false, false]);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    const removed = json(await tool.execute('remove', { operation: 'remove', variant: '2' }, undefined, undefined, ctx));
    assert.equal(removed.status, 'declined'); assert.match(confirms[0]!.body, /Убрать карточку «Возврат 2»/);
    assert.equal((await fixture.read()).librarySnapshot!.variants.length, 2);
    // «Срок: три дня» is what the old agent said; the model tries to turn it into what the client knew beforehand.
    const promoted = json(await tool.execute('promote', { operation: 'edit', variant: '2', change: { field: 'fact', fact: 'Срок', availability: 'initial' } }, undefined, undefined, ctx));
    assert.equal(promoted.status, 'declined'); assert.match(confirms[1]!.body, /«Срок: три дня»[\s\S]*клиент знал это до разговора/);
    assert.equal((await fixture.read()).librarySnapshot!.variants[1]!.userState.facts[0]!.availability, 'learned_in_source');
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('review 92e30d3: stopping needs a real request and the run that is actually going; acceptance shows definitions; the plan names the models that will run', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-review-stop-');
  const { tools, shutdown } = registered(0);
  let release!: () => void;
  gate = new Promise<void>(resolve => { release = resolve; });
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
    said.push('Не останавливай прогон, пусть идёт');
    const negated = json(await run.execute('stop-negated', { action: 'stop' }, undefined, undefined, ctx));
    assert.equal(negated.cancelled, true); assert.equal(confirms.at(-1)!.title, 'Остановить прогон?', '«не останавливай» is not a request to stop');
    said.push('Останови прогон');
    const other = json(await run.execute('stop-other', { action: 'stop', id: 'no-such-run-0000' }, undefined, undefined, ctx));
    assert.equal(other.status, 'unknown_reference'); assert.equal((await fixture.read()).phase, 'evaluating', 'a run the owner did not name is never stopped in its place');
    const pending = run.execute('stop', { action: 'stop', id: fixture.id }, undefined, undefined, ctx);
    release();
    assert.equal(json(await pending).stopped, true);
  } finally { gate = undefined; release(); await shutdown(); await fixture.cleanup(); }
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
    assert.match(bypass instanceof Error ? bypass.message : '', /закрывает только владелец/);
    assert.equal((await fixture.read()).librarySnapshot!.ownerResolutions, undefined, 'nothing was recorded in the owner\'s name');
    // A legacy request with a ready input is checked like the conversational form: the owner asked to fix a line, not to add a card.
    const legacy = json(await tool.execute('legacy', { operation: 'variant', verify: 'later', request: { parentId: 'variant_1', operation: 'ambiguous_opening', reason: 'model', input: { opening: 'Помогите' } } }, undefined, undefined, ctx));
    assert.equal(legacy.status, 'declined'); assert.equal(confirms.length, 1, 'the native dialog decided, and the owner said no');
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

test('an instruction names its object: number, ordinal, title or «её» for the card just shown — anything less is not a reference', () => {
  const second = { number: 2, title: 'Возврат 2', otherTitles: ['Возврат 1'] };
  for (const text of ['Убери вторую карточку', 'Во второй карточке поменяй цель', 'А во второй пусть спрашивает: Когда вернут деньги?', 'Исправь первую реплику во второй карточке: Добрый день',
    'Поправь карточку 2', 'Поправь во 2-й карточке цель', 'Убери №2', 'Убери карточку «Возврат 2»']) assert.equal(refersTo(text, second), true, text);
  for (const text of ['Исправь первую реплику', 'Исправь вторую реплику', 'Поменяй второе правило', 'Поставь срок 2 дня', 'Пусть пишет: во второй карточке', 'Убери карточку про возврат',
    'Во-вторых, исправь реплику', 'Во вторник поправь реплику', 'Убери вторую группу', 'Поправь её первую реплику']) assert.equal(refersTo(text, second), false, text);
  assert.equal(refersTo('Поправь её первую реплику: Добрый день', { ...second, lastTouched: true }), true, 'a pronoun means the card that was just shown or changed');
  assert.equal(refersTo('Убери третью', { number: 3, title: 'x', otherTitles: [] }), true); assert.equal(refersTo('Убери пять карточек', { number: 5, title: 'x', otherTitles: [] }), false, 'a cardinal is not an ordinal');
  const instalment = { number: 1, title: 'Рассрочка платежа', otherTitles: ['Возврат платежа'] };
  assert.equal(refersTo('Поправь карточку про рассрочку', instalment), true, 'a title word no other card shares'); assert.equal(refersTo('Поправь карточку про платежи', instalment), false, 'a word every title shares names nothing');
  assert.equal(refersTo('Объедини вторую группу с первой', second, 'group'), true); assert.equal(refersTo('Объедини вторую карточку', second, 'group'), false);
  const said = ['Исправь первую реплику'];
  assert.equal(authorize({ messages: said, intent: 'edit', summary: '', objects: { kind: 'card', targets: [second] } }).kind, 'confirm');
  assert.equal(authorize({ messages: said, intent: 'edit', summary: '', objects: { kind: 'card', targets: [second], exhaustive: true } }).kind, 'conversation', 'with one card in the library nothing else can be meant');
});

test('an edit reaches only the card the owner named: another card waits for the native dialog, which shows its title and the change', { timeout: 60000 }, async () => {
  const fixture = await draft('chat-object-');
  const { tools, shutdown } = registered();
  try {
    const said = ['Исправь первую реплику'];
    const { ctx, confirms } = terminal(fixture.cwd, said, [false, false]);
    const tool = tools.get('agent_lab_scenarios')!;
    await tool.execute('show', { operation: 'show' }, undefined, undefined, ctx);
    const before = libraryHash((await fixture.read()).librarySnapshot!);
    const change = { field: 'opening', value: 'Добрый день, когда вернут деньги?' };
    const guessed = json(await tool.execute('guess', { operation: 'edit', variant: '2', verify: 'later', change }, undefined, undefined, ctx));
    assert.equal(guessed.status, 'declined'); assert.equal(confirms.length, 1); assert.match(confirms[0]!.body, /Карточка «Возврат 2» · первая реплика: «Добрый день, когда вернут деньги\?»/);
    assert.equal(libraryHash((await fixture.read()).librarySnapshot!), before, 'a «no» writes nothing');
    said.push('Исправь первую реплику во второй карточке: Добрый день, когда вернут деньги?');
    assert.equal(json(await tool.execute('named', { operation: 'edit', variant: '2', verify: 'later', change }, undefined, undefined, ctx)).mutated, true);
    assert.equal(confirms.length, 1, 'the card is named: no extra stop');
    assert.equal((await fixture.read()).librarySnapshot!.variants.find(item => item.id === 'variant_2')!.userState.opening, change.value);
    // «её» is the card that was just shown — and no other.
    await tool.execute('show-2', { operation: 'show', variant: '2' }, undefined, undefined, ctx);
    said.push('Поправь её первую реплику: Здравствуйте, когда вернут деньги?');
    const pronoun = { field: 'opening', value: 'Здравствуйте, когда вернут деньги?' };
    assert.equal(json(await tool.execute('other', { operation: 'edit', variant: '1', verify: 'later', change: pronoun }, undefined, undefined, ctx)).status, 'declined');
    assert.equal(confirms.length, 2); assert.match(confirms[1]!.body, /Карточка «Возврат 1»/);
    assert.equal(json(await tool.execute('shown', { operation: 'edit', variant: '2', verify: 'later', change: pronoun }, undefined, undefined, ctx)).mutated, true);
    assert.equal(confirms.length, 2);
    const library = (await fixture.read()).librarySnapshot!;
    assert.deepEqual(library.variants.map(item => item.userState.opening), ['Помогите с возвратом', pronoun.value]);
  } finally { await shutdown(); await fixture.cleanup(); }
});
