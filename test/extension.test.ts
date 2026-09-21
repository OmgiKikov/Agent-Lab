import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, access, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { DefaultResourceLoader, SettingsManager, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, type Component } from '@earendil-works/pi-tui';
import agentLab from '../extensions/agent-lab.ts';
import { createDemoRuntime, demoInput } from '../src/demo.js';
import { ExperimentLab, draftHash, planDiscovery } from '../dist/experiment.js';
import { spawn, spawnSync } from 'node:child_process';
import { createInputSchema, goalAttainment, promptCompliance, type Experiment } from '../src/contracts.js';
import { resultHash } from '../src/experiment.js';
import { judgeAgreement } from '../src/agreement.js';
import { assertPlainCopy } from './helpers/copy-check.js';
import { demoEvaluationInput } from '../src/demo.js';
import { ExperimentStore } from '../src/store.js';
import { buildResultView, resultViewLines } from '../src/result-view.js';
import { COUNTING_RULES, markTargets, measurementUsable, primaryMetricId } from '../src/outcomes.js';
import { demoEvaluateRecord } from './helpers/demo-record.js';
import { libraryFixture } from './helpers/scenario-library.js';
import { assessScenarioLibrary } from '../src/scenario-work.js';
import { libraryHash } from '../src/scenario-library.js';

function registered(onUserMessage?: (message: unknown) => void) {
  const tools = new Map<string, ToolDefinition>();
  const contexts: { content: string; display: boolean }[] = [];
  const userMessages: unknown[] = [];
  let shutdown!: () => Promise<void>;
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  let beforeAgentStart!: (event: { systemPrompt: string }, ctx: ExtensionContext) => Promise<{ systemPrompt: string } | undefined>;
  agentLab({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: (name: string, options: { handler: typeof command }) => { assert.equal(name, 'agent-lab'); command = options.handler; },
    on: (name: string, handler: () => Promise<void>) => {
      if (name === 'session_shutdown') shutdown = handler;
      else if (name === 'before_agent_start') beforeAgentStart = handler as typeof beforeAgentStart;
      else assert.equal(name, 'session_start');
    },
    sendMessage: (message: { content: string; display: boolean }, options: { deliverAs: string }) => { assert.equal(options.deliverAs, 'followUp'); contexts.push(message); },
    sendUserMessage: (message: unknown, options: { deliverAs: string; expandPromptTemplates: boolean }) => { assert.equal(options.deliverAs, 'followUp'); assert.equal(options.expandPromptTemplates, false); userMessages.push(message); onUserMessage?.(message); },
  } as unknown as ExtensionAPI);
  assert.ok(shutdown); assert.ok(command); assert.ok(beforeAgentStart);
  return { tools, shutdown, command, beforeAgentStart, contexts, userMessages };
}
function output(result: Awaited<ReturnType<ToolDefinition['execute']>>) {
  return JSON.parse(result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'));
}

test('injected Pi instructions hand saved discovery directly to one test after the owner answers', async () => {
  const previous = process.env.AGENT_LAB_SESSION;
  process.env.AGENT_LAB_SESSION = '1';
  const { beforeAgentStart, shutdown } = registered();
  try {
    const result = await beforeAgentStart({ systemPrompt: 'base' }, { cwd: '.', hasUI: false, mode: 'print' } as ExtensionContext);
    const prompt = result?.systemPrompt ?? '';
    assert.match(prompt, /primary.*flow.*Логи.*Сценарии.*Прогон.*Результаты/is);
    assert.match(prompt, /agent_lab_scenarios/i);
    assert.match(prompt, /accepted revision/i);
    assert.match(prompt, /source quotes.*semantic readiness/is);
    assert.match(prompt, /Acceptance.*does not run the agent/is);
    assert.match(prompt, /remaining cumulative budget/is);
    assert.match(prompt, /estimated card accuracy/is);
    assert.match(prompt, /agent_lab_build mode=discover/i);
    assert.match(prompt, /selection, not an accuracy estimate/i);
    assert.match(prompt, /Show that saved brief exactly; do not reconstruct or paraphrase it/i);
    assert.match(prompt, /answers yes.*exact fromRunId and hypothesis/is);
    assert.match(prompt, /re-reads the saved evidence and builds exactly one editable test/is);
    assert.match(prompt, /refusal or correction builds nothing/i);
    assert.match(prompt, /agent_lab_accept for this supplemental one-test flow/i);
    assert.match(prompt, /owner confirm or correct it in their own words/i);
    assert.match(prompt, /agent_lab_run asks to confirm expectations first when they are not confirmed/i);
  } finally {
    if (previous === undefined) delete process.env.AGENT_LAB_SESSION; else process.env.AGENT_LAB_SESSION = previous;
    await shutdown();
  }
});

test('scenario tool paginates large libraries and expands only an explicitly selected variant', async () => {
  let library = libraryFixture();
  const seed = library.variants[0]!;
  library.variants = Array.from({ length: 200 }, (_, index) => ({ ...structuredClone(seed), id: `bounded_${index}`, title: `Вариант ${index}` }));
  // Use the current assessment pipeline: an unversioned final assessment is historical,
  // and correctly requires new calls after a semantic context change.
  library = await assessScenarioLibrary(library, { async assessScenarioProposals(input) {
    return input.fields.flatMap(field => field.paths.map(path => ({
      variantId: field.variantId, path, status: 'ready' as const, reason: 'Проверено',
    })));
  } }, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} }, async () => {});
  const fixture = await boardFixture('scenario-tool-large-', record => {
    record.phase = 'review'; record.scenarios = []; record.trials = [];
    record.librarySnapshot = library; record.sources = library.sources; record.requirements = library.requirements;
  });
  const { tools, shutdown } = registered();
  try {
    const ctx = { cwd: fixture.cwd, hasUI: false, mode: 'print' } as ExtensionContext;
    const compactResult = await tools.get('agent_lab_scenarios')!.execute('compact', { id: fixture.record.id, operation: 'inspect' }, undefined, undefined, ctx);
    const compactText = compactResult.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    const compact = JSON.parse(compactText);
    assert.equal(compact.variants.length, 20); assert.equal(compact.page.total, 200); assert.equal(compact.page.nextCursor, 20);
    assert.equal(compact.detail, undefined); assert.ok(Buffer.byteLength(compactText) < 100_000, 'default model context stays bounded');
    assert.equal(compact.budget.semanticCompletedJobs, compact.budget.semanticTotalJobs);
    assert.equal(compact.budget.semanticPendingJobs, 0, 'completed same-content assessment is not offered for repeat spending');
    const detailed = output(await tools.get('agent_lab_scenarios')!.execute('detail', {
      id: fixture.record.id, operation: 'inspect', variantId: 'bounded_199', limit: 1,
    }, undefined, undefined, ctx));
    assert.equal(detailed.variants.length, 1); assert.equal(detailed.detail[0].id, 'bounded_199');
    assert.match(detailed.detail[0].facts[0].origin.quote, /1234/);
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('scenario tool resume estimate excludes receipts and permits a bounded partial assessment', async t => {
  const library = libraryFixture();
  let partial = library; let calls = 0;
  await assert.rejects(() => assessScenarioLibrary(library, { async assessScenarioProposals(input) {
    if (++calls === 2) throw new Error('pause fixture');
    return input.fields.flatMap(field => field.paths.map(path => ({ variantId: field.variantId, path, status: 'ready' as const, reason: 'Проверено' })));
  } }, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} }, async value => { partial = structuredClone(value); }), /pause fixture/);
  const fixture = await boardFixture('scenario-tool-resume-', record => {
    record.phase = 'review'; record.scenarios = []; record.trials = [];
    record.librarySnapshot = partial; record.sources = partial.sources; record.requirements = partial.requirements;
    record.usage.calls = record.settings.maxCalls - 1;
  });
  const { tools, shutdown } = registered();
  const original = ExperimentLab.prototype.assessLibrary;
  let resumed = 0;
  ExperimentLab.prototype.assessLibrary = async function(id) { resumed++; return (await this.readLibrary(id)).experiment; };
  t.after(() => { ExperimentLab.prototype.assessLibrary = original; });
  try {
    const ctx = { cwd: fixture.cwd, hasUI: false, mode: 'print' } as ExtensionContext;
    const before = output(await tools.get('agent_lab_scenarios')!.execute('inspect', { id: fixture.record.id, operation: 'inspect' }, undefined, undefined, ctx));
    assert.ok(before.budget.semanticCompletedJobs > 0);
    assert.equal(before.budget.semanticPendingJobs, before.budget.semanticTotalJobs - before.budget.semanticCompletedJobs);
    assert.ok(before.budget.semanticPendingJobs > before.budget.remainingCalls);
    await tools.get('agent_lab_scenarios')!.execute('resume', { id: fixture.record.id, operation: 'assess', expectedLibraryHash: libraryHash(partial) }, undefined, undefined, ctx);
    assert.equal(resumed, 1, 'available calls may make partial progress instead of demanding the full nominal budget');
  } finally { await shutdown(); await fixture.cleanup(); }
});

test('Pi validation takes a 40-dialogue outcome-blind pool for the default 15-card set', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-validation-surface-'));
  const fixtureLab = new ExperimentLab(join(directory, 'fixture'), createDemoRuntime());
  await fixtureLab.init();
  const seeded = await fixtureLab.create({ ...demoInput(), workflow: 'evaluate', scenarioCount: 1 });
  await fixtureLab.waitForIdle();
  const prepared = await fixtureLab.get(seeded.id);
  await fixtureLab.close();

  const originalCreate = ExperimentLab.prototype.create;
  const originalGet = ExperimentLab.prototype.get;
  const originalWait = ExperimentLab.prototype.waitForIdle;
  const originalStart = ExperimentLab.prototype.start;
  let captured: Parameters<ExperimentLab['create']>[0] | undefined;
  let record = structuredClone(prepared);
  ExperimentLab.prototype.create = async function(raw) {
    captured = raw;
    const dialogues = raw.dialogues!.slice(0, 15);
    record = { ...structuredClone(prepared), id: 'validation-run', task: raw.task, mode: 'live', phase: 'review',
      settings: raw.settings, target: raw.target!, dialogues: structuredClone(dialogues),
      scenarios: dialogues.map((dialogue, index) => ({ ...structuredClone(prepared.scenarios[0]!), id: dialogue.id, provenance: 'production' as const,
        familyId: dialogue.id, title: `Карточка ${index + 1}`, user: { ...structuredClone(prepared.scenarios[0]!.user),
          opening: dialogue.messages[0]!.content, script: [] } })) };
    return structuredClone(record);
  };
  ExperimentLab.prototype.get = async function(id) { return id === record.id ? structuredClone(record) : originalGet.call(this, id); };
  ExperimentLab.prototype.waitForIdle = async function() {};
  let startOptions: Parameters<ExperimentLab['start']>[1] | undefined;
  ExperimentLab.prototype.start = async function(_id, options) { startOptions = options; return structuredClone(record); };
  // The Pi run confirms the expectations first, so the stubbed record also answers acceptDraft.
  const originalAccept = ExperimentLab.prototype.acceptDraft;
  let acceptedHash: string | undefined;
  ExperimentLab.prototype.acceptDraft = async function(_id, hash) { acceptedHash = hash; return structuredClone(record); };
  t.after(async () => {
    ExperimentLab.prototype.create = originalCreate;
    ExperimentLab.prototype.get = originalGet;
    ExperimentLab.prototype.waitForIdle = originalWait;
    ExperimentLab.prototype.start = originalStart;
    ExperimentLab.prototype.acceptDraft = originalAccept;
    await rm(directory, { recursive: true, force: true });
  });

  const { tools, shutdown } = registered();
  t.after(shutdown);
  const confirmations: { title: string; body: string }[] = [];
  const ctx = { cwd: directory, mode: 'tui', hasUI: true, model: { provider: 'fixture', id: 'fixture' }, ui: {
    confirm: async (title: string, body: string) => { confirmations.push({ title, body }); return true; },
  } } as unknown as ExtensionContext;
  const dialogues = Array.from({ length: 300 }, (_, index) => ({ id: `dialogue_${index}`, outcome: index % 2 ? 'success' : 'failure',
    messages: [{ role: 'user', content: `Вопрос ${index}` }, { role: 'assistant', content: `Старый ответ ${index}` }] }));
  const result = output(await tools.get('agent_lab_build')!.execute('validate', { mode: 'validate', task: 'Проверить агента',
    materials: [{ name: 'policy.md', content: 'Отвечать по базе знаний.' }], dialogues,
    target: { kind: 'command', command: process.execPath, args: [] } }, undefined, undefined, ctx));

  assert.equal(captured?.validationCount, 15);
  assert.equal(captured?.dialogues?.length, 40);
  assert.deepEqual(captured?.settings.userModes, ['reactive']);
  assert.equal(captured?.settings.maxTurns, 6);
  assert.equal(captured?.settings.maxCalls, 385);
  assert.equal(captured?.settings.timeoutMs, 600000, 'grounding ten materials with a small model takes longer than the two-minute default');
  assert.equal(result.validation.sourceDialogues, 300);
  assert.equal(result.validation.candidateDialogues, 40);
  assert.equal(result.validation.sampledDialogues, 15);
  assert.match(confirmations[0]!.body, /Исходных диалогов: 300; outcome-blind пул: 40; карточек: 15/);
  await tools.get('agent_lab_run')!.execute('run-validation', { id: result.id, expectedHash: result.draftHash }, undefined, undefined, ctx);
  assert.equal(confirmations[1]!.title, 'Подтвердить ожидания и запустить?');
  assert.match(confirmations[1]!.body, /Что агент должен сделать: 15 ситуаций\. Номер правила — порядок в ваших материалах\./);
  assert.equal(startOptions?.parallel, 8, 'an external agent is checked on several dialogues at once');
  assert.equal(startOptions?.requireAccepted, true, 'the Pi run starts only on confirmed expectations');
  assert.equal(acceptedHash, result.draftHash, 'the same dialogue confirmed the shown version');
  assert.match(confirmations[1]!.body, /Клиент отвечает на уточнения симулятором/);
  assert.equal(confirmations[1]!.body.match(/Ситуация:/g)?.length, 15);
  assert.match(confirmations[1]!.body, /Все правила — \/agent-lab [a-zA-Z0-9_-]{1,8}, раздел 2\./);
  assert.ok(confirmations[1]!.body.endsWith('Да — подтвердить все ожидания и начать прогон.'));
});

test('Pi discovery confirms a computed budget, accepts 300 logs and hands the exact saved hypothesis to one visible test', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-discovery-surface-'));
  const fixtureLab = new ExperimentLab(join(directory, 'fixture'), createDemoRuntime());
  await fixtureLab.init();
  const seeded = await fixtureLab.create({ ...demoInput(), workflow: 'evaluate', scenarioCount: 1 });
  await fixtureLab.waitForIdle();
  const prepared = await fixtureLab.get(seeded.id);
  await fixtureLab.close();
  prepared.id = 'draft-from-discovery';
  prepared.scenarios = [prepared.scenarios[0]!];
  prepared.scenarios[0]!.goalObservation = 'reply';
  prepared.phase = 'review';
  prepared.message = 'Тест готов.';
  prepared.error = null;

  const originalDiscover = ExperimentLab.prototype.discover;
  const originalResume = ExperimentLab.prototype.resumeDiscovery;
  const originalBuild = ExperimentLab.prototype.buildFromDiscovery;
  const originalGet = ExperimentLab.prototype.get;
  const originalWait = ExperimentLab.prototype.waitForIdle;
  let ready: typeof prepared | undefined;
  let discoverCalls = 0;
  let resumeCalls = 0;
  let discoverySettings: { maxCalls: number; maxDurationMs: number } | undefined;
  let handoff: { fromRunId: string; hypothesis: string } | undefined;
  ExperimentLab.prototype.discover = async function(raw) {
    discoverCalls++;
    const plan = planDiscovery(raw);
    discoverySettings = { maxCalls: raw.settings.maxCalls, maxDurationMs: raw.settings.maxDurationMs };
    const { batches: _batches, batchCount: _batchCount, oversizedIds: _oversizedIds, seed: _seed, ...callPlan } = plan;
    const requirement = { id: 'support', text: 'Назвать адрес поддержки', sourceId: prepared.sources[0]!.id,
      quote: prepared.sources[0]!.content.slice(0, 20), critical: true };
    const hypothesis = 'Агент может не назвать адрес поддержки.\nНАБЛЮДЕНИЕ: ответ агента (reply)';
    ready = { ...structuredClone(prepared), id: 'discovery-run', phase: 'complete', dialogues: structuredClone(raw.dialogues), scenarios: [], trials: [],
      discovery: { protocol: 'discovery-1', phase: 'ready', error: null, requirements: [requirement],
        observations: [
          { dialogueId: raw.dialogues[0]!.id, classification: 'candidate', requirementId: requirement.id, summary: 'Адрес не назван.', citations: [{ seq: 1, quote: raw.dialogues[0]!.messages[1]!.content }] },
          { dialogueId: raw.dialogues[1]!.id, classification: 'candidate', requirementId: requirement.id, summary: 'Адрес не назван.', citations: [{ seq: 1, quote: raw.dialogues[1]!.messages[1]!.content }] },
          { dialogueId: raw.dialogues[2]!.id, classification: 'clean', summary: 'Контроль.', citations: [] },
        ], seed: plan.seed, focusRequirementId: requirement.id, representativeIds: [raw.dialogues[0]!.id, raw.dialogues[1]!.id],
        controlIds: [raw.dialogues[2]!.id], selectedIds: [raw.dialogues[0]!.id, raw.dialogues[1]!.id, raw.dialogues[2]!.id],
        completedBatchCount: plan.batchCount, groupingComplete: true,
        completedDeepIds: [raw.dialogues[0]!.id, raw.dialogues[1]!.id, raw.dialogues[2]!.id], deep: [],
        hypothesis: { text: hypothesis, proposedGoalObservation: 'reply', requirementId: requirement.id,
          eventIds: [{ dialogueId: raw.dialogues[0]!.id, seq: 1 }, { dialogueId: raw.dialogues[1]!.id, seq: 1 }] },
        callPlan: { ...callPlan, batches: plan.batchCount },
        callsUsed: plan.nominalCalls, totalDialogues: raw.dialogues.length, oversizedIds: plan.oversizedIds } };
    return structuredClone(ready);
  };
  ExperimentLab.prototype.buildFromDiscovery = async function(fromRunId, hypothesis) {
    handoff = { fromRunId, hypothesis };
    return structuredClone(prepared);
  };
  ExperimentLab.prototype.resumeDiscovery = async function(id) {
    resumeCalls++;
    assert.equal(id, 'discovery-run');
    assert.ok(ready?.discovery);
    ready.discovery.phase = 'ready';
    ready.phase = 'complete';
    return structuredClone(ready);
  };
  ExperimentLab.prototype.get = async function(id) {
    if (id === ready?.id) return structuredClone(ready);
    if (id === prepared.id) return structuredClone(prepared);
    return originalGet.call(this, id);
  };
  ExperimentLab.prototype.waitForIdle = async function() {};
  t.after(async () => {
    ExperimentLab.prototype.discover = originalDiscover;
    ExperimentLab.prototype.resumeDiscovery = originalResume;
    ExperimentLab.prototype.buildFromDiscovery = originalBuild;
    ExperimentLab.prototype.get = originalGet;
    ExperimentLab.prototype.waitForIdle = originalWait;
    await rm(directory, { recursive: true, force: true });
  });

  const { tools, shutdown } = registered();
  t.after(shutdown);
  const confirmations: { title: string; body: string }[] = [];
  let consent = false;
  const ctx = { cwd: directory, mode: 'tui', hasUI: true, model: { provider: 'fixture', id: 'fixture' }, ui: {
    confirm: async (title: string, body: string) => { confirmations.push({ title, body }); return consent; },
  } } as unknown as ExtensionContext;
  const call = async (params: unknown) => output(await tools.get('agent_lab_build')!.execute('fixture', params, undefined, undefined, ctx));
  const logs = Array.from({ length: 300 }, (_, index) => ({ id: `dialogue_${index}`,
    messages: [{ role: 'user', content: `Где поддержка ${index}?` }, { role: 'assistant', content: 'Позвоните позже.' }] }));
  const base = { mode: 'discover', task: 'Найти один полезный тест', materials: [{ name: 'policy.md', content: 'Называйте support@example.com.' }] };

  const cancelled = await call({ ...base, dialogues: logs });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.calls, 0); assert.equal(cancelled.mutated, false);
  assert.equal(discoverCalls, 0);
  assert.match(confirmations[0]!.body, /потолок: (\d+)/);
  assert.ok(Number(confirmations[0]!.body.match(/потолок: (\d+)/)![1]) > 20);
  assert.match(confirmations[0]!.body, /время: до (\d+) секунд/);
  assert.ok(Number(confirmations[0]!.body.match(/время: до (\d+) секунд/)![1]) > 180);
  await assert.rejects(access(join(directory, '.agent-lab')), /ENOENT/);
  await assert.rejects(call({ ...base, dialogues: [...logs, { ...logs[0], id: 'dialogue_300' }] }), /300|Too big|слишком/i);
  assert.equal(discoverCalls, 0);

  consent = true;
  const found = await call({ ...base, dialogues: logs.slice(0, 50) });
  assert.equal(discoverCalls, 1);
  assert.ok(found.plan.maxCalls > 20);
  assert.ok(found.plan.maxDurationMs > 180000);
  assert.deepEqual(discoverySettings, { maxCalls: 20, maxDurationMs: 180000 }, 'core derives discovery ceilings while retaining the test defaults');
  assert.equal(found.fromRunId, 'discovery-run');
  assert.match(found.brief, /отбор, не accuracy/);
  assert.match(found.brief, /диалог dialogue_0, событие #1/);
  assert.match(found.brief, /НАБЛЮДЕНИЕ: ответ агента \(reply\)\n\nПроверим\?$/);

  assert.ok(ready?.discovery);
  ready.discovery.phase = 'partial';
  ready.phase = 'interrupted';
  const saved = new ExperimentLab(join(directory, '.agent-lab'), createDemoRuntime());
  await saved.init();
  await saved.store.save(ready);
  await saved.close();

  consent = false;
  const resumeCancelled = await call({ mode: 'discover', resumeRunId: ready.id });
  assert.equal(resumeCancelled.status, 'cancelled'); assert.equal(resumeCancelled.mutated, false); assert.equal(resumeCalls, 0);
  assert.match(confirmations.at(-1)!.body, /Статус: partial/);
  assert.match(confirmations.at(-1)!.body, new RegExp(`Вызовы: ${ready.discovery.callsUsed}/${ready.discovery.callPlan.maxCalls}`));
  assert.match(confirmations.at(-1)!.body, /Сохранённый общий лимит времени: до \d+ секунд/);

  consent = true;
  const resumed = await call({ mode: 'discover', resumeRunId: ready.id });
  assert.equal(resumeCalls, 1); assert.equal(resumed.resumed, true); assert.equal(resumed.phase, 'ready');
  assert.equal(resumed.brief, resumed.discovery.lines.join('\n'));
  const completed = new ExperimentLab(join(directory, '.agent-lab'), createDemoRuntime());
  await completed.init(); await completed.store.save(ready); await completed.close();
  await assert.rejects(call({ mode: 'discover', resumeRunId: ready.id }), /не требует возобновления/);

  const built = await call({ mode: 'discover', fromRunId: found.fromRunId, hypothesis: found.hypothesis });
  assert.deepEqual(handoff, { fromRunId: found.fromRunId, hypothesis: found.hypothesis });
  assert.equal(built.builtTests, 1); assert.equal(built.accepted, false); assert.equal(built.agentRun, false);
  assert.deepEqual(built.testPlan.lines.join('\n'), built.brief);
  assert.match(built.brief, /^ТЕСТ\nСИТУАЦИЯ/m);
  assert.match(built.brief, /ВХОД\n/);
  assert.match(built.brief, /УСПЕХ\n/);
  assert.match(built.brief, /НАБЛЮДЕНИЕ\n  ответ агента \(reply\)/);
  assert.match(built.brief, /Этот тест действительно проверяет нужное поведение\?$/);
});

test('conversation runs only the confirmed plan, then saves and loads the same case without claiming human review', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-conversation-'));
  const { tools, shutdown } = registered();
  t.after(async () => { await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const plans: string[] = [];
  let consent = false;
  const ctx = { cwd: directory, mode: 'tui', hasUI: true, ui: { confirm: async (_title: string, plan: string) => { plans.push(plan); return consent; } } } as ExtensionContext;
  const call = async (name: string, params: unknown) => output(await tools.get(name)!.execute('fixture', params, undefined, undefined, ctx));
  const draft = await call('agent_lab_build', { mode: 'demo', scenarioCount: 1 });
  const cancelled = await call('agent_lab_run', { id: draft.id, expectedHash: draft.draftHash });
  assert.equal(cancelled.cancelled, true);
  assert.equal((await call('agent_lab_inspect', { id: draft.id })).trialCount, 0);
  await assert.rejects(call('agent_lab_run', { id: draft.id, expectedHash: '0'.repeat(64) }), /План изменился/);
  assert.equal(plans.length, 1);
  await assert.rejects(tools.get('agent_lab_run')!.execute('fixture', { id: draft.id, expectedHash: draft.draftHash }, undefined, undefined,
    { ...ctx, hasUI: false, mode: 'print' } as unknown as ExtensionContext), /интерактивный терминал/);
  consent = true;
  const result = await call('agent_lab_run', { id: draft.id, expectedHash: draft.draftHash });
  assert.equal(result.phase, 'results_review'); assert.equal(result.trialCount, 1);
  // Пи-путь стартует только на подтверждённых ожиданиях — это и записано, не больше: владелец
  // подтвердил ожидания, а вердикты судьи он не видел, потому что их ещё не было.
  assert.equal(result.reviewMode, 'expectations'); assert.deepEqual(result.humanReviews, []);
  assert.equal(result.acceptedDraftHash, draft.draftHash);
  assert.doesNotMatch(result.limitations.join(' '), /without human validation/);
  assert.match(result.limitations.join(' '), /Владелец подтвердил ожидания ситуаций перед запуском\. Определения карточек и оценки судьи человеком не проверялись\./);
  assert.equal(result.proofs.length, 1);
  const proof = result.proofs[0];
  const proofText = proof.lines.join('\n');
  assert.equal(proof.trialId, (await call('agent_lab_inspect', { id: draft.id })).trials[0].id);
  assert.match(proofText, /^ДОКАЗАТЕЛЬСТВО\nТест:/);
  assert.match(proofText, /Диалог: .*\nИсход: (pass|fail|unknown|invalid|ungraded|cancelled)/);
  assert.match(proofText, /РЕПЛИКИ\n#0 ПОЛЬЗОВАТЕЛЬ: [^\n]+\n#\d+ АГЕНТ:/);
  assert.match(proofText, /ПРОВЕРКИ\n(?:PASS|FAIL) \[/);
  assert.match(proofText, /ОЦЕНКИ\n(?:PASS|FAIL|UNKNOWN) \[[^\]]+\].*события: #\d+/);
  // Диалог подтверждения говорит ровно то, что «Да» записывает, и не отрицает это же.
  assert.match(plans[1]!, /Подтверждая, вы подтверждаете ожидания ситуаций выше\. Оценки судьи вы не проверяли\./);
  assert.doesNotMatch(plans[1]!, /Запуск не означает/);
  assert.match(plans[1]!, /20 вызовов/);
  const inspection = await call('agent_lab_inspect', { id: draft.id });
  const ids = [inspection.scenarios[0].id];
  const saved = await call('agent_lab_suite', { action: 'save', id: draft.id, scenarioIds: ids, file: '.evals/regression.json' });
  const loaded = await call('agent_lab_suite', { action: 'load', file: saved.file });
  assert.equal(loaded.phase, 'review'); assert.equal(loaded.scenarioCount, 1); assert.equal(loaded.trialCount, 0);
  assert.equal(loaded.reviewMode, null); assert.equal(loaded.usage.calls, 0);
});

test('accept tool shows and records only the current one-test definition, while refusal and edits stay inert', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-accept-'));
  const { tools, shutdown } = registered();
  t.after(async () => { await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const shown: { question: string; body: string }[] = [];
  let consent = false;
  const ctx = { cwd: directory, mode: 'tui', hasUI: true, ui: {
    confirm: async (question: string, body: string) => { shown.push({ question, body }); return consent; },
  } } as ExtensionContext;
  const call = async (name: string, params: unknown) => output(await tools.get(name)!.execute('fixture', params, undefined, undefined, ctx));
  const built = await call('agent_lab_build', { mode: 'demo', scenarioCount: 1 });
  const draft = await call('agent_lab_inspect', { id: built.id });
  draft.scenarios[0].goalObservation = 'reply';
  draft.scenarios[0].user.opening = `Первая строка\n${'полный вход '.repeat(200)}`;
  const prepared = await call('agent_lab_edit', { id: built.id, expectedHash: built.draftHash, patch: { scenarios: draft.scenarios } });

  const refused = await call('agent_lab_accept', { id: built.id });
  assert.equal(refused.accepted, false);
  let current = await call('agent_lab_inspect', { id: built.id });
  assert.equal(current.acceptedDraftHash, undefined);
  assert.equal(current.trialCount, 0); assert.equal(current.usage.calls, prepared.usage.calls);
  assert.equal(shown[0]!.question, 'Этот тест действительно проверяет нужное поведение?');
  assert.match(shown[0]!.body, /^ТЕСТ\nСИТУАЦИЯ/m);
  assert.match(shown[0]!.body, /НАБЛЮДЕНИЕ\n  ответ агента \(reply\)/);
  assert.match(shown[0]!.body, new RegExp(`Версия: ${prepared.draftHash.slice(0, 12)}`));
  assert.ok(shown[0]!.body.includes(draft.scenarios[0].user.opening.trimEnd().replace('\n', '\n  ')));
  assert.ok(shown[0]!.body.includes(draft.scenarios[0].successCriteria.replace('\n', '\n  ')));

  consent = true;
  const accepted = await call('agent_lab_accept', { id: built.id });
  assert.equal(accepted.accepted, true); assert.equal(accepted.acceptedDraftHash, prepared.draftHash);
  current = await call('agent_lab_inspect', { id: built.id });
  assert.equal(current.acceptedDraftHash, prepared.draftHash);
  assert.equal(current.reviewMode, null); assert.equal(current.resultsReviewedAt, undefined); assert.equal(current.trialCount, 0);
  assert.equal(current.usage.calls, prepared.usage.calls);

  current.scenarios[0].user.opening = 'Исправленный полный вход';
  const edited = await call('agent_lab_edit', { id: built.id, expectedHash: current.draftHash, patch: { scenarios: current.scenarios } });
  assert.notEqual(edited.draftHash, prepared.draftHash);
  assert.equal(edited.acceptedDraftHash, prepared.draftHash, 'old acceptance remains audit metadata but is visibly stale');
  const acceptedAgain = await call('agent_lab_accept', { id: built.id });
  assert.equal(acceptedAgain.acceptedDraftHash, edited.draftHash);
  assert.match(shown.at(-1)!.body, /Исправленный полный вход/);
  assert.match(shown.at(-1)!.body, new RegExp(`Версия: ${edited.draftHash.slice(0, 12)}`));
  assert.equal((await call('agent_lab_inspect', { id: built.id })).trialCount, 0);
  const run = await call('agent_lab_run', { id: built.id, expectedHash: edited.draftHash });
  assert.equal(run.phase, 'results_review');
  assert.equal(run.acceptedDraftHash, edited.draftHash, 'explicit execution preserves acceptance metadata');
});

test('Pi connects a new request, conversational correction, reviewed run, evidence discussion and repeat without UI JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-journey-fixture-'));
  const { tools, shutdown, command, contexts, userMessages } = registered(() => {
    assert.equal(existsSync(join(directory, '.agent-lab', '.lock')), false, 'conversation starts only after the board releases its writer lock');
  });
  const errors: string[] = []; const editorCommands: string[] = [];
  const ctx = { cwd: directory, model: undefined, mode: 'tui', hasUI: true } as ExtensionCommandContext;
  let steps: string[][] = []; let request = ''; let awaitResults = false; let editorText = '';
  ctx.ui = {
    getEditorText: () => editorText,
    setEditorText: (text: string) => { editorText = text; editorCommands.push(text); },
    editor: async () => request,
    confirm: async () => true, // Explicit scripted test consent; never used for a live user or model.
    notify: (message: string, type: string) => { if (type === 'error') errors.push(message); },
    custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => Component & { dispose?(): void }) => new Promise((resolve, reject) => {
      const component = factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, {}, value => { component.dispose?.(); resolve(value); });
      void (async () => {
        const keys = steps.shift(); assert.ok(keys, 'unexpected board');
        if (awaitResults && keys[0] !== 'r') {
          const deadline = Date.now() + 5000;
          while (!component.render(120).join('\n').includes('ПРОВЕРЬТЕ РЕЗУЛЬТАТЫ')) {
            if (Date.now() > deadline) throw new Error('fixture did not finish');
            await new Promise(r => setTimeout(r, 100));
          }
          awaitResults = false;
        }
        for (const key of keys) {
          if (key === 'x') assert.match(component.render(120).join('\n'), /Оценка выросла у 1, снизилась у 0/);
          component.handleInput!(key);
        }
      })().catch(error => { component.dispose?.(); reject(error); });
    }),
  } as unknown as ExtensionContext['ui'];
  const call = async (name: string, params: object) => output(await tools.get(name)!.execute(name, params, undefined, undefined, ctx));
  try {
    await command('/fixture/agent', ctx);
    assert.equal(userMessages[0], 'Проверь агента в /fixture/agent'); assert.equal(contexts[0]!.display, false);
    // The outer Pi model's actions are scripted here; real tools and the native board execute every state transition.
    const sample = demoInput();
    const fixture = await createDemoRuntime().prepare({ task: sample.task, sources: sample.materials.map(m => ({ ...m, id: 'source-1', hash: 'fixture' })), workflow: 'compare' },
      { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} });
    const built = await call('agent_lab_build', { mode: 'demo', scenarioCount: 1, existingAgent: fixture.agent });
    assert.equal(built.phase, 'review', built.error ?? 'draft not ready');
    assert.equal(built.trialCount, 0); assert.equal(built.reviewMode, null); assert.equal(editorCommands.length, 0);
    steps = [['a']]; request = 'Убери персону: хочу проверить только задачу.';
    await command(built.id, ctx); assert.equal(userMessages.at(-1), request);
    const selected = JSON.parse(contexts.at(-1)!.content); assert.equal(selected.experimentId, built.id); assert.ok(selected.scenarioId, JSON.stringify(selected));
    editorText = 'Ещё пишу уточнение';
    const draft = await call('agent_lab_inspect', { id: built.id });
    assert.equal(editorText, 'Ещё пишу уточнение', 'tool must preserve unfinished user input'); editorText = '';
    delete draft.scenarios[0].user.persona; delete draft.scenarios[0].user.characteristics;
    const edited = await call('agent_lab_edit', { id: built.id, expectedHash: draft.draftHash, patch: { scenarios: draft.scenarios } });
    assert.notEqual(edited.draftHash, draft.draftHash); assert.equal(edited.trialCount, 0);
    steps = [['r'], ['a']]; awaitResults = true; request = 'Почему этот диалог провалился и что нужно исправить?';
    await command(built.id, ctx); assert.equal(userMessages.at(-1), request);
    const discussion = JSON.parse(contexts.at(-1)!.content); assert.equal(discussion.experimentId, built.id); assert.ok(discussion.trialId);
    const evidence = await call('agent_lab_inspect', { id: built.id, trialId: discussion.trialId });
    assert.equal(evidence.outcome, 'fail'); assert.ok(evidence.events.length); assert.ok(evidence.checks.some((c: { passed: boolean }) => !c.passed));
    steps = [['3', 'y'], ['f'], ['q']];
    await command(built.id, ctx);
    const reviewed = await call('agent_lab_inspect', { id: built.id, export: true });
    assert.equal(reviewed.phase, 'complete'); assert.equal(reviewed.humanReviews.length, 1);
    // Одна клавиша пишет быструю отметку на главную оценку ситуации и закрывает её (UI-SPEC F13).
    const mark = reviewed.humanReviews[0];
    const marked = await call('agent_lab_inspect', { id: built.id, trialId: mark.trialId });
    const markedCard = reviewed.scenarios.find((card: { id: string }) => card.id === marked.scenarioId);
    assert.equal(mark.source, 'quick');
    assert.equal(mark.metricId, primaryMetricId(markedCard, marked));
    assert.equal(mark.verdict, marked.assessments.find((a: { metricId: string }) => a.metricId === mark.metricId).result);
    assert.equal(mark.note, 'Быстрая отметка: согласен с судьёй.');
    assert.equal(typeof mark.durationMs, 'number');
    const original = await call('agent_lab_inspect', { id: built.id, trialId: discussion.trialId }); assert.deepEqual(original, evidence);
    const controlId = draft.scenarios[0].id;
    const controlled = await call('agent_lab_repeat', { id: built.id, controlScenarioIds: [controlId] });
    assert.deepEqual(controlled.positiveControlScenarioIds, [controlId]);
    const repeated = await call('agent_lab_repeat', { id: built.id });
    assert.equal(repeated.positiveControlScenarioIds, undefined);
    assert.equal(repeated.parentRunId, built.id); assert.equal(repeated.phase, 'review'); assert.equal(repeated.trialCount, 0); assert.equal(repeated.reviewMode, null);
    assert.equal(editorCommands.length, 0);
    await call('agent_lab_edit', { id: repeated.id, expectedHash: repeated.draftHash, patch: {
      agent: { ...fixture.agent, tools: [...fixture.agent.tools, 'update_record'] }, targetVersion: 'fixture-fixed',
    } });
    steps = [['r'], ['3', 'a']]; awaitResults = true; request = 'Покажи конкретное исправление до и после.';
    await command(repeated.id, ctx);
    const pairDiscussion = JSON.parse(contexts.at(-1)!.content);
    assert.deepEqual(pairDiscussion.comparisonSource, { kind: 'parent', beforeId: built.id, afterId: repeated.id });
    assert.equal(pairDiscussion.comparedPair.beforeTrialId, discussion.trialId);
    assert.equal(pairDiscussion.comparedPair.afterTrialId, pairDiscussion.trialId);
    steps = [['1', 'x'], ['q']];
    await command(repeated.id, ctx);
    const exportDir = join(directory, '.agent-lab', 'exports');
    const html = (await readdir(exportDir)).find(name => name.startsWith(repeated.id) && name.endsWith('.html'));
    assert.ok(html); assert.match(await readFile(join(exportDir, html), 'utf8'), /Оценка выросла у 1, снизилась у 0/);
    assert.deepEqual(errors, []); assert.equal(steps.length, 0);
  } finally { await shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('headless model tools prepare and edit only; approvals and human assessments are not callable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-extension-'));
  const { tools, shutdown, command } = registered();
  const ctx = { cwd: directory, model: undefined, mode: 'print', hasUI: false } as ExtensionContext;
  const updates: string[] = [];
  try {
    assert.deepEqual([...tools.keys()], ['agent_lab_generator', 'agent_lab_build', 'agent_lab_inspect', 'agent_lab_scenarios', 'agent_lab_edit', 'agent_lab_accept', 'agent_lab_repeat', 'agent_lab_issues', 'agent_lab_resolution', 'agent_lab_diagnostics', 'agent_lab_run', 'agent_lab_suite', 'agent_lab_connection', 'agent_lab_reassess', 'agent_lab_review', 'agent_lab_prompt']);
    const report = output(await tools.get('agent_lab_build')!.execute('build-1', { mode: 'demo', scenarioCount: 2 }, undefined,
      value => { updates.push(JSON.stringify(value)); }, ctx));
    assert.equal(report.phase, 'review'); assert.equal(report.workflow, 'evaluate');
    assert.equal(report.reviewMode, null); assert.equal(report.trialCount, 0);
    assert.equal(report.comparison, undefined); assert.equal(report.scenarioCount, 2);
    assert.ok(updates.length >= 1); assert.match(report.nextStep, /Дальше/);
    const evidence = JSON.parse(await readFile(report.artifacts.evidence, 'utf8'));
    assert.equal(evidence.settings.repeats, 1); assert.equal(evidence.trials.length, 0);
    assert.equal(evidence.controlConsumedAt, null);
    assert.deepEqual(JSON.parse(await readFile(report.artifacts.agent, 'utf8')), evidence.revisions[0].spec);
    assert.match(await readFile(report.artifacts.report, 'utf8'), /Проверка карточек: ожидается/);
    const inspect = output(await tools.get('agent_lab_inspect')!.execute('inspect-1', { id: report.id }, undefined, undefined, ctx));
    assert.equal(inspect.scenarios.length, 2); assert.equal(inspect.draftHash, report.draftHash);
    const scenarios = inspect.scenarios;
    scenarios[0].user.persona = 'Пользователь отредактирован в черновике';
    const edited = output(await tools.get('agent_lab_edit')!.execute('edit-1', { id: report.id, expectedHash: report.draftHash, patch: { scenarios } }, undefined, undefined, ctx));
    assert.notEqual(edited.draftHash, report.draftHash); assert.equal(edited.reviewMode, null); assert.equal(edited.trialCount, 0);
    await assert.rejects(tools.get('agent_lab_edit')!.execute('edit-stale', { id: report.id, expectedHash: report.draftHash, patch: { settings: { repeats: 2 } } }, undefined, undefined, ctx), /изменился/);
    await assert.rejects(tools.get('agent_lab_edit')!.execute('edit-approval', { id: report.id, expectedHash: edited.draftHash, patch: { approved: true, reviewMode: 'human' } }, undefined, undefined, ctx));
    await assert.rejects(command(report.id, ctx as ExtensionCommandContext), /native Pi terminal/);
    const unchanged = JSON.parse(await readFile(report.artifacts.evidence, 'utf8'));
    assert.equal(unchanged.reviewMode, null); assert.equal(unchanged.phase, 'review');
    await assert.rejects(access(join(directory, '.agent-lab', '.lock')));
  } finally { await shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('native command demo fixture requires two separate confirmations and preserves human annotation separately', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-human-ui-fixture-'));
  const { tools, shutdown, command } = registered();
  const ctx = { cwd: directory, model: undefined, mode: 'tui', hasUI: true } as ExtensionCommandContext;
  try {
    const report = output(await tools.get('agent_lab_build')!.execute('prepare', { mode: 'demo', scenarioCount: 1 }, undefined, undefined, ctx));
    const errors: string[] = [];
    const confirmations: string[] = [];
    let screen = 0;
    let selection = 0;
    const keys = ['r', 'r', 'v', 'f', 'f', 'q'];
    ctx.ui = {
      custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => Component & { dispose?(): void }) => new Promise((resolve, reject) => {
        let component: Component & { dispose?(): void };
        const current = screen++;
        const finish = (value: unknown) => { component.dispose?.(); resolve(value); };
        component = factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, {}, finish);
        assert.match(component.render(100).join('\n'), /AGENT LAB/);
        // Scripted integration fixture only: emulate native keyboard/confirm callbacks, never a live model or real user consent.
        const drive = async () => {
          if (current === 2) {
            const deadline = Date.now() + 4000;
            while (!component.render(100).join('\n').includes('ПРОВЕРЬТЕ РЕЗУЛЬТАТЫ')) {
              if (Date.now() > deadline) throw new Error('Demo did not reach results review');
              await new Promise(r => setTimeout(r, 100));
            }
          }
          assert.ok(keys[current], `unexpected board ${current}`);
          component.handleInput!(keys[current]!);
        };
        void drive().catch(error => { component.dispose?.(); reject(error); });
      }),
      confirm: async (_title: string, message: string) => {
        confirmations.push(message);
        assert.match(message, /[a-f0-9]{12}/, 'a readable fingerprint identifies the exact plan; start checks the full hash');
        return confirmations.length === 2 || confirmations.length === 4;
      },
      select: async (_title: string, choices: string[]) => { selection++; return selection === 1 ? choices[0] : choices.find(c => c === 'Ошибся агент'); },
      editor: async () => 'Human fixture: disagreement with the model; see #1.',
      notify: (message: string, type: string) => { if (type === 'error') errors.push(message); },
    } as unknown as ExtensionContext['ui'];
    await command(report.id, ctx);
    assert.deepEqual(errors, []); assert.equal(confirmations.length, 4);
    assert.match(confirmations[0]!, /Версия тестов/); assert.match(confirmations[2]!, /результатов/);
    const evidence = JSON.parse(await readFile(report.artifacts.evidence, 'utf8'));
    // Первое подтверждение — ожидания, второе — результаты: они записаны раздельно.
    assert.equal(evidence.phase, 'complete'); assert.equal(evidence.reviewMode, 'expectations');
    assert.ok(evidence.resultsReviewedAt); assert.ok(evidence.resultsReviewHash);
    assert.equal(evidence.trials.length, 1); assert.equal(evidence.humanReviews.length, 1);
    assert.equal(evidence.humanReviews[0].verdict, 'fail'); assert.match(evidence.humanReviews[0].note, /fixture/);
    assert.ok(evidence.trials[0].assessments.length, 'original rubric assessments remain present');
    const trial = output(await tools.get('agent_lab_inspect')!.execute('inspect-trial', { id: report.id, trialId: evidence.trials[0].id }, undefined, undefined, ctx));
    assert.deepEqual(trial.checks, evidence.trials[0].checks);
    assert.deepEqual(trial.assessments, evidence.trials[0].assessments);
    const exported = output(await tools.get('agent_lab_inspect')!.execute('export-reviewed', { id: report.id, export: true }, undefined, undefined, ctx));
    const markdown = await readFile(exported.artifacts.report, 'utf8');
    assert.match(markdown, /Сценарная оценка демо/); assert.doesNotMatch(markdown, /Оценка модели/);
    await assert.rejects(access(join(directory, '.agent-lab', '.lock')));
  } finally { await shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('native tool cancellation preserves partial preparation and releases ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-extension-cancel-'));
  const { tools, shutdown } = registered();
  const controller = new AbortController();
  try {
    const result = await tools.get('agent_lab_build')!.execute('build-cancel', { mode: 'demo' }, controller.signal,
      () => controller.abort(new Error('User cancelled')), { cwd: directory, model: undefined } as ExtensionContext);
    const report = output(result);
    assert.equal(report.cancelled, true); assert.equal(report.trialCount, 0);
    assert.notEqual(report.phase, 'complete');
    await assert.rejects(access(join(directory, '.agent-lab', '.lock')));
  } finally { await shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('actual Pi SDK loader imports native cards, preparation-only tools and embedded skill without discovered resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-loader-'));
  try {
    const loader = new DefaultResourceLoader({
      cwd: directory, agentDir: join(directory, 'agent'),
      settingsManager: SettingsManager.inMemory({ packages: [], enableAnalytics: false, enableInstallTelemetry: false }),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [fileURLToPath(new URL('../extensions/agent-lab.ts', import.meta.url))],
      additionalSkillPaths: [fileURLToPath(new URL('../skills/agent-builder/SKILL.md', import.meta.url))],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []); assert.equal(loaded.extensions.length, 1);
    assert.deepEqual([...loaded.extensions[0]!.tools.keys()], ['agent_lab_generator', 'agent_lab_build', 'agent_lab_inspect', 'agent_lab_scenarios', 'agent_lab_edit', 'agent_lab_accept', 'agent_lab_repeat', 'agent_lab_issues', 'agent_lab_resolution', 'agent_lab_diagnostics', 'agent_lab_run', 'agent_lab_suite', 'agent_lab_connection', 'agent_lab_reassess', 'agent_lab_review', 'agent_lab_prompt']);
    assert.ok(loaded.extensions[0]!.commands.has('agent-lab'));
    assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
    const skills = loader.getSkills();
    assert.deepEqual(skills.diagnostics, []); assert.equal(skills.skills.length, 1);
    assert.equal(skills.skills[0]!.name, 'agent-builder');
    const protocol = await readFile(skills.skills[0]!.filePath, 'utf8');
    assert.match(protocol, /agent_lab_build|agent_lab_inspect/); assert.doesNotMatch(protocol, /https?:\/\//);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('build accepts an external module target, real dialogues and golden cases; inspect and exports carry the evidence summary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-extension-v2-'));
  const { tools, shutdown } = registered();
  const ctx = { cwd: directory, model: undefined, mode: 'print', hasUI: false } as ExtensionContext;
  try {
    const target = { kind: 'module', path: fileURLToPath(new URL('../examples/echo-agent.mjs', import.meta.url)), exportName: 'createSession' };
    const report = output(await tools.get('agent_lab_build')!.execute('build-v2', {
      mode: 'demo', scenarioCount: 1, target, settings: { userModes: ['static', 'reactive'] },
      goldenCases: [{ id: 'gold_move', goal: 'Move appointment A101 to 14:00', opening: 'Please move appointment A101 to 14:00.', successCriteria: 'A101 is at 14:00',
        initialState: { records: { A101: { time: '09:00', owner: 'Sample customer', status: 'booked' } }, writableFields: ['time'], transientFailures: 0 },
        checks: [{ id: 'time', kind: 'state_equals', description: 'moved', recordId: 'A101', field: 'time', value: '14:00' }] }],
      dialogues: [{ id: 'd1', messages: [{ role: 'user', content: 'move A101 to 14:00 pls' }], outcome: 'success' }],
    }, undefined, undefined, ctx));
    assert.equal(report.phase, 'review', report.error ?? '');
    assert.deepEqual(report.target, target);
    assert.equal(report.scenarioCount, 3);
    assert.equal(report.profileCount, 0, 'logs supply test evidence, not inferred user profiles');
    assert.equal(report.evidence.verdict.provenance.production.cards, 1);
    assert.equal(report.evidence.comparison, null);
    const inspect = output(await tools.get('agent_lab_inspect')!.execute('inspect-v2', { id: report.id, export: true }, undefined, undefined, ctx));
    assert.equal(inspect.artifacts.agent, undefined, 'external agent is not exported as a sandbox AgentSpec');
    assert.match(await readFile(inspect.artifacts.htmlReport, 'utf8'), /<!doctype html>/);
    assert.equal(inspect.scenarios.filter((s: { provenance: string }) => s.provenance === 'curated').length, 1);
    const markdown = await readFile(inspect.artifacts.report, 'utf8');
    assert.match(markdown, /Наблюдаемый результат/); assert.match(markdown, /Диалоги и основания/); assert.match(markdown, /Карточки бизнес-сценария/); assert.match(markdown, /Границы доказательств/);
    assert.match(markdown, /Испытуемый: модуль/);
    await assert.rejects(access(join(directory, '.agent-lab', '.lock')));
  } finally { await shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('the plain verdict leads every surface without research presets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-extension-verdict-'));
  const { tools, shutdown } = registered();
  const ctx = { cwd: directory, model: undefined, mode: 'print', hasUI: false } as ExtensionContext;
  try {
    const quick = output(await tools.get('agent_lab_build')!.execute('build-quick', { mode: 'demo', scenarioCount: 1, notes: 'Users rarely know their ID.' }, undefined, undefined, ctx));
    assert.equal(quick.phase, 'review');
    assert.deepEqual(quick.evidence.verdict.provenance.synthetic.cards, 1);
    assert.match(quick.evidence.verdict.headline, /Черновик готов.*после подтверждения/);
    assert.ok(quick.evidence.verdict.nextSteps.length >= 1);
    await assert.rejects(tools.get('agent_lab_build')!.execute('build-thorough', { mode: 'demo', preset: 'thorough' }, undefined, undefined, ctx));
    const markdown = await readFile(quick.artifacts.report, 'utf8');
    assert.ok(markdown.indexOf('## Итог') < markdown.indexOf('## Наблюдаемый результат'));
    assert.match(markdown, /Карточки: синтетических 1, golden 0, из продакшна 0/);
    await assert.rejects(access(join(directory, '.agent-lab', '.lock')));
  } finally { await shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('live preparation asks for optional logs before creating a run; explicit skip and imports cross that gate', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-intake-'));
  const { tools, shutdown } = registered();
  t.after(async () => { await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const ctx = { cwd: directory, hasUI: false, mode: 'print' } as ExtensionContext;
  const build = (params: unknown) => tools.get('agent_lab_build')!.execute('intake', params, undefined, undefined, ctx);
  const question = output(await build({ task: 'Check my agent', dialogues: [] }));
  assert.equal(question.status, 'needs_input'); assert.match(question.message, /начать без логов/);
  assert.deepEqual(await readdir(directory), [], 'asking must not spend, preflight or create a run');
  // Deliberately invalid task fails input validation only after the intake gate opens, without a provider call.
  await assert.rejects(build({ task: '', withoutDialogues: true }), /task/);
  const dialogues = [{ id: 'provided', messages: [{ role: 'user', content: 'Move A101 to 14:00 please' }], outcome: 'success' }];
  const file = join(directory, 'dialogues.jsonl'); await writeFile(file, JSON.stringify(dialogues[0]) + '\n');
  await assert.rejects(build({ task: '', dialoguesFile: file }), /task/);
  await assert.rejects(build({ task: '', dialogues }), /task/);
  const imported = output(await build({ mode: 'demo', scenarioCount: 1, dialoguesFile: file }));
  assert.equal(imported.phase, 'review'); assert.equal(imported.dialogueCount, 1);
  assert.equal(imported.evidence.verdict.provenance.production.cards, 1);
  await writeFile(file, 'invalid json');
  await assert.rejects(build({ dialoguesFile: file, withoutDialogues: true }), /JSON/);
});

test('Pi score imports recorded evidence code-only and gates every model call with native consent', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-score-extension-'));
  const { tools, shutdown } = registered();
  t.after(async () => { await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const build = tools.get('agent_lab_build')!;
  const dialogues = [{ id: 'd1', messages: [{ role: 'user' as const, content: 'Создай заявку' }, { role: 'assistant' as const, content: 'Готово ✅' }] }];
  const params = { mode: 'score', task: 'Проверить заявления о действиях', materials: [{ name: 'policy.md', content: 'Успех подтверждается наблюдаемым результатом.' }], dialogues };

  const headless = { cwd: directory, hasUI: false, mode: 'print' } as ExtensionContext;
  const missing = output(await build.execute('missing', { mode: 'score', task: 'Score', materials: params.materials }, undefined, undefined, headless));
  assert.equal(missing.status, 'needs_input');
  assert.match(missing.message, /Есть реальные диалоги с агентом/);
  const empty = output(await build.execute('empty', { mode: 'score', task: 'Score', materials: params.materials, withoutDialogues: true }, undefined, undefined, headless));
  assert.equal(empty.status, 'insufficient');
  assert.match(empty.brief, /^Недостаточно данных для гипотезы/);

  const updates: string[] = [];
  const scoreResult = await build.execute('code-only', { ...params, codeOnly: true }, undefined,
    value => { updates.push(value.content.filter(item => item.type === 'text').map(item => item.text).join('\n')); }, headless);
  const codeOnly = output(scoreResult);
  assert.equal(codeOnly.phase, 'results_review', codeOnly.error ?? '');
  assert.equal(codeOnly.usage.calls, 0);
  assert.match(codeOnly.scoreState, /без вызовов модели/);
  assert.equal(codeOnly.brief, 'Недостаточно данных для гипотезы\nДобавьте требования владельца и хотя бы одно наблюдение из репозитория или записанного диалога.');
  assert.ok(codeOnly.artifacts.evidence && codeOnly.artifacts.report && codeOnly.artifacts.traceJournal);
  assert.equal(updates[0], 'Читаю требования и записи…');
  assert.ok(updates.some(line => /Импортировано 1 из 1 диалогов/.test(line)));
  assert.ok(updates.every(line => !/Оценено/.test(line)), 'code-only never reports judge progress');
  assert.ok(build.renderResult);
  const rendered = build.renderResult(scoreResult, { expanded: false, isPartial: false }, { fg: (_color: string, text: string) => text } as never);
  assert.match(rendered.render(80).join('\n'), /Недостаточно данных для гипотезы/);

  const connectionFile = join(directory, 'score-connection.json');
  await writeFile(connectionFile, JSON.stringify({ format: 'agent-lab-connection-1', target: { kind: 'command', command: 'never-run', args: [] }, targetVersion: 'recorded-v1' }));
  const connected = output(await build.execute('connected', { ...params, codeOnly: true, connectionFile }, undefined, undefined, headless));
  assert.equal(connected.target.kind, 'command');
  assert.equal(connected.targetVersion, 'recorded-v1');

  await assert.rejects(build.execute('headless-model', params, undefined, undefined, headless), /native Pi confirmation/);
  const confirmations: string[] = [];
  const tui = { cwd: directory, hasUI: true, mode: 'tui', ui: { confirm: async (_title: string, body: string) => { confirmations.push(body); return false; } } } as ExtensionContext;
  const cancelled = output(await build.execute('cancel-model', params, undefined, undefined, tui));
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.phase, 'results_review');
  assert.equal(cancelled.usage.calls, 0);
  assert.match(confirmations[0]!, /Агент и симулятор не запускаются.*1 диалог.*План: 7–9 модельных вызовов; потолок: 20.*Время: до 3 минут/s);

  const invalid = join(directory, 'invalid.jsonl');
  await writeFile(invalid, '{bad}\n');
  await assert.rejects(build.execute('bad-file', { ...params, dialogues: undefined, dialoguesFile: invalid, codeOnly: true }, undefined, undefined, headless), /Не удалось прочитать записи:.*повторите.*агент не запускался/is);
});

test('Pi code-only score preserves the public 200-dialogue and configured budget bounds', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-score-max-'));
  const { tools, shutdown } = registered();
  t.after(async () => { await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const dialogues = Array.from({ length: 200 }, (_, index) => ({ id: `d${index}`, messages: [{ role: 'user' as const, content: `Question ${index}` }, { role: 'assistant' as const, content: `Answer ${index}` }] }));
  const report = output(await tools.get('agent_lab_build')!.execute('max-score', { mode: 'score', codeOnly: true, task: 'Score all records',
    materials: [{ name: 'policy.md', content: 'Answer from the owner policy.' }], dialogues, settings: { maxCalls: 7, maxDurationMs: 14_400_000 },
  }, undefined, undefined, { cwd: directory, hasUI: false, mode: 'print' } as ExtensionContext));
  assert.equal(report.dialogueCount, 200);
  assert.equal(report.trialCount, 200);
  const saved = JSON.parse(await readFile(report.artifacts.evidence, 'utf8'));
  assert.equal(saved.settings.maxCalls, 7);
  assert.equal(saved.settings.maxDurationMs, 14_400_000);
});

test('Pi score scales its default batch budget and preserves explicit owner limits', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-score-budget-'));
  const { tools, shutdown } = registered();
  const score = ExperimentLab.prototype.score;
  const reassess = ExperimentLab.prototype.reassess;
  const inputs: { maxCalls: number; maxDurationMs: number; codeOnly: boolean }[] = [];
  let providerRuns = 0;
  ExperimentLab.prototype.score = function(raw, options) {
    inputs.push({ maxCalls: raw.settings.maxCalls, maxDurationMs: raw.settings.maxDurationMs, codeOnly: options?.codeOnly === true });
    if (!options?.codeOnly) providerRuns++;
    return score.call(this, raw, { ...options, codeOnly: true });
  };
  ExperimentLab.prototype.reassess = function(id) { return this.get(id); };
  t.after(async () => {
    ExperimentLab.prototype.score = score;
    ExperimentLab.prototype.reassess = reassess;
    await shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  const confirmations: string[] = [];
  let consent = true;
  const ctx = { cwd: directory, hasUI: true, mode: 'tui', ui: { confirm: async (_title: string, body: string) => {
    confirmations.push(body); return consent;
  } } } as ExtensionContext;
  const dialogues = Array.from({ length: 15 }, (_, index) => ({ id: `d${index}`,
    messages: [{ role: 'user' as const, content: `Question ${index}` }, { role: 'assistant' as const, content: `Answer ${index}` }] }));
  const params = { mode: 'score', task: 'Score recorded dialogues', materials: [{ name: 'policy.md', content: 'Answer from the owner policy.' }], dialogues };

  const report = output(await tools.get('agent_lab_build')!.execute('scaled-score', params, undefined, undefined, ctx));
  assert.equal(report.phase, 'results_review', report.error ?? JSON.stringify(report));
  assert.match(confirmations[0]!, /15 диалогов/);
  assert.match(confirmations[0]!, /План: 77–107 модельных вызовов; потолок: 120/);
  assert.match(confirmations[0]!, /Время: до 30 минут/);
  assert.deepEqual(inputs.slice(0, 2), [
    { maxCalls: 120, maxDurationMs: 1_800_000, codeOnly: true },
    { maxCalls: 120, maxDurationMs: 1_800_000, codeOnly: false },
  ]);
  assert.equal(providerRuns, 1);
  const saved = JSON.parse(await readFile(report.artifacts.evidence, 'utf8'));
  assert.equal(saved.settings.maxCalls, 120);
  assert.equal(saved.settings.maxDurationMs, 1_800_000);

  consent = false;
  const cancelled = output(await tools.get('agent_lab_build')!.execute('explicit-score', {
    ...params, settings: { maxCalls: 23, maxDurationMs: 300_000 },
  }, undefined, undefined, ctx));
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.usage.calls, 0);
  assert.equal(providerRuns, 1, 'cancellation performs no provider call');
  assert.match(confirmations[1]!, /потолок: 23/);
  assert.match(confirmations[1]!, /Время: до 5 минут/);
  assert.deepEqual(inputs.at(-1), { maxCalls: 23, maxDurationMs: 300_000, codeOnly: true });
});

test('CLI and Pi code-only score of the same dialogue and task save the same settings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-score-parity-'));
  const { tools, shutdown } = registered();
  t.after(async () => { await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const task = { task: 'Проверить ответ по тарифу', materials: [{ name: 'policy.md', content: 'Тариф показывается в разделе «Мои точки продаж».' }] };
  const dialogue = { id: 'recorded_1', messages: [{ role: 'user' as const, content: 'Где тариф?' }, { role: 'assistant' as const, content: 'Откройте «Мои точки продаж».' }] };
  const taskFile = join(directory, 'task.json');
  const dialoguesFile = join(directory, 'dialogues.jsonl');
  await writeFile(taskFile, JSON.stringify(task));
  await writeFile(dialoguesFile, JSON.stringify(dialogue) + '\n');

  const pi = output(await tools.get('agent_lab_build')!.execute('parity', { mode: 'score', codeOnly: true, ...task, dialoguesFile },
    undefined, undefined, { cwd: directory, hasUI: false, mode: 'print' } as ExtensionContext));
  assert.equal(pi.phase, 'results_review', pi.error ?? '');
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'score', '--input', dialoguesFile, '--task', taskFile,
    '--code-only', '--json', '--data-dir', join(directory, 'cli-data')], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const piRecord = JSON.parse(await readFile(pi.artifacts.evidence, 'utf8'));
  const cliRecord = JSON.parse(await readFile(JSON.parse(cli.stdout).artifacts.evidence, 'utf8'));
  const pick = (settings: Record<string, unknown>) => ({ maxCalls: settings.maxCalls, maxDurationMs: settings.maxDurationMs, timeoutMs: settings.timeoutMs,
    judge: settings.judge, repeats: settings.repeats, userModes: settings.userModes });
  assert.deepEqual(pick(piRecord.settings), pick(cliRecord.settings));
  assert.deepEqual(pick(piRecord.settings), { maxCalls: 20, maxDurationMs: 180_000, timeoutMs: 600_000,
    judge: { provider: 'openrouter', model: 'openai/gpt-5.6-sol', upstream: 'openai' }, repeats: 1, userModes: ['scripted'] });
});

test('Pi inspect of a repeat shows the same first block as the CLI summary, stability line included', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-repeat-view-'));
  const { tools, shutdown } = registered();
  t.after(async () => { await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const data = join(directory, '.agent-lab');
  const lab = new ExperimentLab(data, createDemoRuntime());
  let repeatId: string;
  try {
    await lab.init();
    const base = demoEvaluationInput();
    const input = createInputSchema.parse({ ...base, scenarioCount: 2, settings: { ...base.settings, maxCalls: 20, maxDurationMs: 180000 } });
    const draft = await lab.create(input); await lab.waitForIdle();
    await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(await lab.get(draft.id)) }); await lab.waitForIdle();
    const repeat = await lab.repeat(draft.id);
    repeatId = repeat.id;
    await lab.start(repeatId, { approved: true, reviewer: 'automated', expectedHash: draftHash(await lab.get(repeatId)) }); await lab.waitForIdle();
    assert.equal((await lab.get(repeatId)).phase, 'results_review');
  } finally { await lab.close(); }

  const inspected = output(await tools.get('agent_lab_inspect')!.execute('repeat-view', { id: repeatId }, undefined, undefined,
    { cwd: directory, hasUI: false, mode: 'print' } as ExtensionContext));
  const viewLines: string[] = inspected.viewLines;
  assert.ok(viewLines.some(line => line.startsWith('Нестабильных:') || line.startsWith('Стабильность не проверена:')), viewLines.join('\n'));
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'summary', '--id', repeatId, '--data-dir', data], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const block = cli.stdout.split('\n');
  const first = block.slice(0, block.indexOf(''));
  const detailsAt = first.indexOf('Не измерено по причинам:');
  const cliBlock = (detailsAt < 0 ? first : first.slice(0, detailsAt)).filter(line => !line.startsWith('  нестабильно:'));
  assert.deepEqual(viewLines, cliBlock);
});

test('Pi score reports judge progress only after reassessment starts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-score-progress-'));
  const { tools, shutdown } = registered();
  const score = ExperimentLab.prototype.score;
  const reassess = ExperimentLab.prototype.reassess;
  let scoreCalls = 0;
  let reassessmentStarted = false;
  ExperimentLab.prototype.score = async function(raw, options) {
    scoreCalls++;
    const result = await score.call(this, raw, { ...options, codeOnly: true });
    if (scoreCalls === 2) {
      await this.waitForIdle();
      const saved = await this.get(result.id);
      const source = saved.sources[0]!;
      saved.requirements = [{ id: 'owner_rule', text: source.content, sourceId: source.id, quote: source.content, critical: true }];
      for (const scenario of saved.scenarios) scenario.requirementIds = ['owner_rule'];
      await this.store.save(saved);
      return saved;
    }
    return result;
  };
  ExperimentLab.prototype.reassess = function(id, raw, options) {
    reassessmentStarted = true;
    return reassess.call(this, id, { ...raw, codeOnly: true }, options);
  };
  t.after(async () => {
    ExperimentLab.prototype.score = score;
    ExperimentLab.prototype.reassess = reassess;
    await shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  const updates: { text: string; reassessmentStarted: boolean }[] = [];
  const result = await tools.get('agent_lab_build')!.execute('progress', {
    mode: 'score', task: 'Проверить ответ', materials: [{ name: 'policy.md', content: 'Отвечать по правилам.' }],
    dialogues: [{ id: 'd1', goal: 'Пользователь получает адрес поддержки.', messages: [{ role: 'user', content: 'Как связаться?' }, { role: 'assistant', content: 'Напишите в поддержку.' }] }],
  }, undefined, value => updates.push({
    text: value.content.filter(item => item.type === 'text').map(item => item.text).join('\n'), reassessmentStarted,
  }), { cwd: directory, hasUI: true, mode: 'tui', ui: { confirm: async () => true } } as ExtensionContext);
  const report = output(result);
  assert.equal(report.phase, 'results_review', report.error ?? JSON.stringify(report));
  assert.ok(updates.some(update => /Оценено/.test(update.text)));
  assert.ok(updates.filter(update => /Оценено/.test(update.text)).every(update => update.reassessmentStarted));
});

test('conversation completes human finding → prompt diff → unchanged SQLite suite → comparison', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-prompt-journey-'));
  const { tools, shutdown } = registered();
  t.after(async () => { await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const screens: string[] = [];
  let note: string | undefined;
  let targetLabel = 'Проверка ·';
  let cancelTarget = false;
  const targetChoices: string[][] = [];
  const ctx = { cwd: directory, hasUI: true, mode: 'tui', ui: {
    confirm: async (_title: string, body: string) => { screens.push(body); return true; },
    select: async (title: string, choices: string[]) => {
      if (title === 'Область вашей оценки') {
        targetChoices.push(choices);
        if (cancelTarget) return undefined;
        return choices.find(choice => choice.startsWith(targetLabel));
      }
      return choices.find(choice => choice === 'Ошибся агент');
    },
    editor: async (_title: string, initial: string) => { if (initial) { screens.push(initial); return initial; } return note; },
  } } as ExtensionContext;
  const call = async (name: string, params: unknown) => output(await tools.get(name)!.execute('journey', params, undefined, undefined, ctx));
  const prompt = join(directory, 'prompt.md'); await writeFile(prompt, 'Updates disabled.');
  const built = await call('agent_lab_build', { mode: 'demo', scenarioCount: 1, settings: { userModes: ['static'] } });
  const inspection = await call('agent_lab_inspect', { id: built.id });
  const initialState = { records: { A: { time: '09:00' } }, writableFields: ['time'], transientFailures: 0 };
  const move = { ...inspection.scenarios[0], initialState, goalObservation: 'state' as const, successCriteria: 'Move A to 14:00',
    user: { ...inspection.scenarios[0].user, opening: 'Move A to 14:00' },
    checks: [{ id: 'time', kind: 'state_equals', recordId: 'A', field: 'time', value: '14:00', description: 'Move the record' }] };
  const guard = { ...move, id: 'read_only', familyId: 'read_only', title: 'Read without changes', successCriteria: 'Report that A is still at 09:00',
    user: { ...move.user, opening: 'What time is A?' }, checks: [{ ...move.checks[0], description: 'Shared failing fixture check' }] };
  const prepared = await call('agent_lab_edit', { id: built.id, expectedHash: built.draftHash, patch: {
    target: { kind: 'command', command: 'python3', args: [fileURLToPath(new URL('../examples/stateful-agent.py', import.meta.url))], promptFile: prompt },
    scenarios: [move, guard],
  } });
  const baseline = await call('agent_lab_run', { id: prepared.id, expectedHash: prepared.draftHash });
  assert.equal(baseline.phase, 'results_review'); assert.equal(baseline.trialCount, 2);
  const before = await call('agent_lab_inspect', { id: prepared.id });
  assert.deepEqual(before.trials.map((trial: { outcome: string }) => trial.outcome), ['fail', 'fail']);
  const trialId = before.trials[0].id;
  const proposalInput = { action: 'propose', id: before.id, candidate: 'Allow updates after lookup.', hypothesis: 'Enable the requested update; preserve read-only access.', trialIds: [trialId] };
  await assert.rejects(call('agent_lab_prompt', proposalInput), /подтверждённые/);
  await assert.rejects(call('agent_lab_review', { id: before.id, trialId, verdict: 'fail' }), /verdict/);
  await assert.rejects(tools.get('agent_lab_review')!.execute('headless', { id: before.id, trialId }, undefined, undefined, { ...ctx, hasUI: false } as ExtensionContext), /интерактивного/);
  assert.equal((await call('agent_lab_review', { id: before.id, trialId })).cancelled, true);
  assert.deepEqual((await call('agent_lab_inspect', { id: before.id })).humanReviews, []);
  assert.ok(targetChoices.at(-1)!.some(choice => choice.startsWith('Критерий ·')));
  assert.ok(targetChoices.at(-1)!.some(choice => choice.startsWith('Проверка ·')));
  assert.ok(targetChoices.at(-1)!.every(choice => !/Такие же|Причина/.test(choice)), targetChoices.at(-1)!.join('\n'));
  const abort = new AbortController();
  const abortedCtx = { ...ctx, ui: { ...ctx.ui, editor: async (_title: string, initial: string) => { if (initial) return initial; abort.abort(new Error('Review interrupted')); return 'Not a saved verdict'; } } } as ExtensionContext;
  await assert.rejects(tools.get('agent_lab_review')!.execute('abort', { id: before.id, trialId }, abort.signal, undefined, abortedCtx), /Review interrupted/);
  assert.deepEqual((await call('agent_lab_inspect', { id: before.id })).humanReviews, []);
  note = 'Test fixture, not a real owner verdict: #1 retained 09:00 instead of the requested 14:00.';
  const reviewed = await call('agent_lab_review', { id: before.id, trialId });
  assert.equal(reviewed.humanReviews.length, 1); assert.equal(reviewed.humanReviews[0].verdict, 'fail');
  assert.equal(reviewed.humanReviews[0].note, note);
  assert.equal(reviewed.humanReviews[0].trialId, trialId);
  assert.equal(reviewed.humanReviews[0].reviewedDialogue, undefined);
  assert.match(reviewed.quality.headline, /разобрано человеком 0 из 2 диалогов/);
  assert.equal(reviewed.humanReviews.some((review: { trialId: string }) => review.trialId === before.trials[1].id), false);

  targetLabel = 'Весь диалог';
  note = 'Test fixture full review: #1 shows the retained time.';
  const complete = await call('agent_lab_review', { id: before.id, trialId });
  assert.equal(complete.humanReviews.length, 2);
  assert.equal(complete.humanReviews.at(-1).trialId, trialId);
  assert.equal(complete.humanReviews.at(-1).reviewedDialogue, true);
  assert.match(complete.quality.headline, /разобрано человеком 1 из 2 диалогов/);

  note = 'Invalid event reference: #999.';
  const invalidReference = await call('agent_lab_review', { id: before.id, trialId });
  assert.equal(invalidReference.cancelled, true);
  assert.equal((await call('agent_lab_inspect', { id: before.id })).humanReviews.length, 2);
  cancelTarget = true;
  assert.equal((await call('agent_lab_review', { id: before.id, trialId })).cancelled, true);
  cancelTarget = false;
  assert.equal((await call('agent_lab_inspect', { id: before.id })).humanReviews.length, 2);
  assert.ok(screens.some(body => body.includes('Move A to 14:00') && body.includes('#0') && body.includes('09:00')));
  const proposal = await call('agent_lab_prompt', proposalInput);
  const diff = await call('agent_lab_prompt', { action: 'inspect', file: proposal.file });
  assert.match(diff.diff, /-Updates disabled/); assert.match(diff.diff, /\+Allow updates after lookup/);
  const candidate = await call('agent_lab_prompt', { action: 'apply', file: proposal.file });
  const candidateDraft = await call('agent_lab_inspect', { id: candidate.id });
  assert.deepEqual(candidateDraft.scenarios, before.scenarios);
  assert.ok(candidateDraft.scenarios.every((scenario: { goalObservation?: string }) => scenario.goalObservation === 'state'), 'owner-selected state observation survives the fresh draft');
  assert.deepEqual(candidateDraft.humanReviews, []);
  const after = await call('agent_lab_run', { id: candidate.id, expectedHash: candidate.draftHash });
  assert.equal(after.comparison.fixed.length, 1); assert.equal(after.comparison.regressed.length, 0);
  assert.equal(after.comparison.coverage.validPairs, 2);
  assert.equal(await readFile(prompt, 'utf8'), 'Updates disabled.');
  assert.ok(screens.some(body => body.includes('-Updates disabled.') && body.includes('+Allow updates after lookup.')));
  const evidence = JSON.parse(await readFile(after.artifacts.evidence, 'utf8'));
  assert.equal(evidence.parentRunId, before.id);
});

/** A finished demo evaluation copied into a fresh Pi working directory, ready for `/agent-lab`. */
async function boardFixture(prefix: string, mutate?: (record: Experiment) => void) {
  const demo = await demoEvaluateRecord(prefix);
  const cwd = await mkdtemp(join(tmpdir(), `${prefix}cwd-`));
  await demo.lab.close();
  const record = structuredClone(demo.record);
  mutate?.(record);
  const store = new ExperimentStore(join(cwd, '.agent-lab'));
  await store.init();
  try { await store.save(record); } finally { await store.close(); }
  return { cwd, record,
    cleanup: async () => { await rm(cwd, { recursive: true, force: true }); await rm(demo.directory, { recursive: true, force: true }); } };
}

/** Situations the judge decided: exactly what a one-key answer can land on (UI-SPEC F10, 03.1 markTargets). */
function judgedSituations(record: Experiment) {
  const controls = new Set(record.positiveControlScenarioIds ?? []);
  return record.trials.flatMap(trial => {
    const scenario = record.scenarios.find(card => card.id === trial.scenarioId);
    if (!scenario || controls.has(scenario.id) || !measurementUsable(scenario, trial, record.humanReviews)) return [];
    const targets = markTargets(scenario, trial);
    if (!targets) return [];
    return [{ trial, scenario, metricIds: targets.metricIds, judgeVerdict: targets.verdict }];
  });
}

/**
 * A scripted owner at the board: `steps` is one key list per board opening, `reason` is what the
 * native editor returns, `choice` what the native select returns, and `screens` keeps what each
 * board showed when it opened — that is where the notice of the previous answer is read from.
 */
function boardSession(cwd: string) {
  const screens: string[] = [];
  const editorCalls: { title: string; initial: string }[] = [];
  const selectCalls: { title: string; options: string[] }[] = [];
  const confirmBodies: string[] = [];
  // A step is either the keys the owner presses, or — for a board state that keys cannot reach
  // twice in a row — the exact action the board would have emitted.
  const state = { steps: [] as (string[] | (() => unknown))[], reason: undefined as string | undefined, choice: undefined as string | undefined };
  const ctx = { cwd, hasUI: true, mode: 'tui', ui: {
    editor: async (title: string, initial: string) => { editorCalls.push({ title, initial }); return state.reason; },
    select: async (title: string, options: string[]) => { selectCalls.push({ title, options }); return state.choice; },
    confirm: async (_title: string, body: string) => { confirmBodies.push(body); return true; },
    notify: () => {},
    custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => Component & { dispose?(): void }) => new Promise((resolve, reject) => {
      const component = factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, {}, value => { component.dispose?.(); resolve(value); });
      void (async () => {
        const step = state.steps.shift(); assert.ok(step, 'unexpected board');
        screens.push(stripTerminalSequences(component.render(160).join('\n')));
        if (typeof step === 'function') { component.dispose?.(); resolve(step()); return; }
        for (const key of step) component.handleInput!(key);
      })().catch(error => { component.dispose?.(); reject(error); });
    }),
  } } as unknown as ExtensionCommandContext;
  return { ctx, screens, editorCalls, selectCalls, confirmBodies, state };
}

test('history remains readable while another instance owns the data directory', async () => {
  const fixture = await boardFixture('agent-lab-read-only-history-');
  const owner = new ExperimentStore(join(fixture.cwd, '.agent-lab'));
  await owner.init();
  const running = { ...fixture.record, phase: 'evaluating' as const };
  await owner.save(running);
  const before = await readFile(join(owner.directory, `${running.id}.json`), 'utf8');
  const lock = await readFile(join(owner.directory, '.lock'), 'utf8');
  const { command, shutdown, tools } = registered();
  const session = boardSession(fixture.cwd);
  try {
    session.state.steps = [['q']];
    await command(running.id.slice(0, 8), session.ctx);
    const inspected = output(await tools.get('agent_lab_inspect')!.execute('read', { id: running.id }, undefined, undefined, session.ctx));
    assert.equal(inspected.phase, 'evaluating');
    assert.ok(session.screens[0]?.includes('ИДУТ ДИАЛОГИ'));
    assert.equal(session.confirmBodies.length, 0, 'leaving a reader does not ask to cancel the owner');
    assert.equal(await readFile(join(owner.directory, `${running.id}.json`), 'utf8'), before);
    assert.equal(await readFile(join(owner.directory, '.lock'), 'utf8'), lock, 'reader never releases another instance lock');
  } finally { await shutdown(); await owner.close(); await rm(fixture.cwd, { recursive: true, force: true }); }
});

test('a board-started run outlives the board and releases ownership after completion', { timeout: 20000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-board-background-'));
  const script = join(cwd, 'target.cjs');
  await writeFile(script, `process.stdin.once('data', () => setTimeout(() => process.stdout.write(JSON.stringify({reply:'Проверка завершена.', resetConfirmed:true})+'\\n'), 500));`);
  const fixture = new ExperimentLab(join(cwd, '.agent-lab'), createDemoRuntime());
  await fixture.init();
  const input = demoEvaluationInput();
  const draft = await fixture.create({ ...input, scenarioCount: 1,
    target: { kind: 'command', command: process.execPath, args: [script], timeoutMs: 5000 },
    settings: { ...input.settings, userModes: ['static'], maxTurns: 2 } });
  await fixture.waitForIdle(); await fixture.close();
  const { command, shutdown } = registered();
  const session = boardSession(cwd);
  const store = new ExperimentStore(join(cwd, '.agent-lab'));
  try {
    session.state.steps = [['r'], ['q']];
    await command(draft.id, session.ctx);
    assert.equal((await store.get(draft.id)).phase, 'evaluating', 'closing the board must not cancel the run');
    assert.equal(session.confirmBodies.length, 1, 'only the launch, not exit, asks for confirmation');
    session.state.steps = [['q']];
    await command('', session.ctx);
    assert.ok(session.screens.at(-1)?.includes('ИДУТ ДИАЛОГИ'), 'history remains available during own background work');
    const deadline = Date.now()+10000;
    while ((await store.get(draft.id)).phase === 'evaluating' || existsSync(join(store.directory, '.lock'))) {
      assert.ok(Date.now()<deadline, 'background run did not finish and release its lock');
      await new Promise(resolve=>setTimeout(resolve, 20));
    }
    assert.equal((await store.get(draft.id)).phase, 'results_review');
    assert.equal((await store.get(draft.id)).trials.length, 1);
  } finally { await shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

test('одна клавиша на доске сохраняет согласие, несогласие с причиной и сомнение', { timeout: 120000 }, async () => {
  const fixture = await boardFixture('agent-lab-board-agree-');
  const { tools, shutdown, command } = registered();
  const session = boardSession(fixture.cwd);
  const inspect = async () => output(await tools.get('agent_lab_inspect')!.execute('board', { id: fixture.record.id }, undefined, undefined,
    { cwd: fixture.cwd, hasUI: false, mode: 'print' } as ExtensionContext));
  const titleOf = (report: { scenarios: { id: string; title: string }[]; trials: { id: string; scenarioId: string }[] }, trialId: string) =>
    report.scenarios.find(card => card.id === report.trials.find(trial => trial.id === trialId)!.scenarioId)!.title;
  try {
    // «Не согласен» всегда спрашивает причину, и причина владельца сохраняется дословно.
    session.state.reason = 'Проверка: судья не учёл уточнение клиента.';
    session.state.steps = [['3', 'n'], ['q']];
    await command(fixture.record.id, session.ctx);
    const disagreed = await inspect();
    assert.equal(disagreed.humanReviews.length, 1, JSON.stringify(disagreed.humanReviews));
    const mark = disagreed.humanReviews[0];
    assert.equal(mark.source, 'quick');
    assert.equal(mark.note, 'Проверка: судья не учёл уточнение клиента.');
    assert.ok(['pass', 'fail'].includes(mark.judgeVerdict));
    assert.notEqual(mark.verdict, mark.judgeVerdict, 'несогласие пишет противоположный вердикт');
    assert.equal(session.editorCalls.at(-1)!.title,
      `Судья решил: ${mark.judgeVerdict === 'fail' ? 'не справился' : 'справился'}. Почему вы не согласны? Коротко, своими словами.`);
    assert.equal(session.editorCalls.at(-1)!.initial, '');
    // CTX-15: a legacy card has one target, so no «с чем именно» question; CR-02: the demo card's
    // strict verdict also rests on failed checks, so the notice names what still fails instead of
    // claiming the number moved.
    assert.equal(session.selectCalls.length, 0, 'one failed metric is answered without a question');
    assert.ok(session.screens.at(-1)!.includes(`Отмечено: не согласен · «${titleOf(disagreed, mark.trialId)}». Ситуация остаётся «не справился»: остальные провалы — через v.`),
      session.screens.at(-1));

    // «Не могу сказать» — сомнение: оценка судьи остаётся, ситуация ждёт решения.
    session.state.steps = [['3', 's'], ['q']];
    await command(fixture.record.id, session.ctx);
    const unsure = await inspect();
    assert.equal(unsure.humanReviews.length, 2);
    const doubt = unsure.humanReviews.at(-1);
    assert.equal(doubt.source, 'quick'); assert.equal(doubt.verdict, 'unknown');
    assert.equal(doubt.note, 'Быстрая отметка: не могу сказать.');
    assert.ok(session.screens.at(-1)!.includes(`Отмечено: не могу сказать · «${titleOf(unsure, doubt.trialId)}». В итоге остаётся оценка судьи; чтобы закрыть ситуацию, позже нажмите y или n.`),
      session.screens.at(-1));

    // Закрытый редактор ничего не пишет и ничего не говорит.
    session.state.reason = undefined;
    session.state.steps = [['3', 'n'], ['q']];
    await command(fixture.record.id, session.ctx);
    assert.equal((await inspect()).humanReviews.length, 2);
    assert.doesNotMatch(session.screens.at(-1)!, /Отмечено:|Несогласие не сохранено|Отметка уже стоит/);

    // Пустая причина — несогласия нет, и доска говорит, чего не хватает.
    session.state.reason = '   \n  ';
    session.state.steps = [['3', 'n'], ['q']];
    await command(fixture.record.id, session.ctx);
    assert.equal((await inspect()).humanReviews.length, 2);
    assert.ok(session.screens.at(-1)!.includes('Несогласие не сохранено: напишите причину.'), session.screens.at(-1));
  } finally {
    await shutdown();
    await fixture.cleanup();
  }
});

test('повтор ответа, длинная причина и сменившаяся оценка судьи ничего не пишут и названы словами', { timeout: 120000 }, async () => {
  const fixture = await boardFixture('agent-lab-board-edges-');
  const { tools, shutdown, command } = registered();
  const session = boardSession(fixture.cwd);
  const notices: string[] = [];
  const inspect = async () => output(await tools.get('agent_lab_inspect')!.execute('edges', { id: fixture.record.id }, undefined, undefined,
    { cwd: fixture.cwd, hasUI: false, mode: 'print' } as ExtensionContext));
  const target = judgedSituations(fixture.record).find(item => item.judgeVerdict === 'fail');
  assert.ok(target, 'у демо-прогона есть провал, с которым можно не согласиться');
  const queued = judgeAgreement(fixture.record).queueFailures.length;
  /** One board opening that answers the same situation, so a repeat can be pressed twice. */
  const answer = async (over: Record<string, unknown>) => {
    session.state.steps = [() => ({ type: 'agree', record: fixture.record, section: 'results', selected: 0,
      trialId: target.trial.id, metricIds: target.metricIds, judgeVerdict: target.judgeVerdict, ...over }), ['q']];
    await command(fixture.record.id, session.ctx);
    const screen = session.screens.at(-1)!;
    const notice = screen.split('\n').map(row => row.replace(/^[^\p{L}\p{N}]*/u, '').replace(/[^\p{L}\p{N}.»]*$/u, ''))
      .find(row => /^(Отмечено:|Отметка уже стоит:|Несогласие не сохранено|Причина длиннее|Оценка судьи изменилась|Не разобрано)/.test(row)) ?? '';
    if (notice) notices.push(notice);
    return { screen, notice, reviews: (await inspect()).humanReviews as { verdict: string; note: string; durationMs?: number }[] };
  };
  try {
    // CTX-05: время чтения доски доезжает до записанной отметки.
    const agreed = await answer({ answer: 'agree', reviewMs: 900 });
    assert.equal(agreed.reviews.length, 1);
    assert.ok(agreed.reviews[0]!.durationMs! >= 900, JSON.stringify(agreed.reviews[0]));
    assert.equal(agreed.notice, `Отмечено: согласен с судьёй · «${target.scenario.title}». Проверено провалов: 1 из ${queued}.`);

    // UI-D-19: тот же ответ второй раз ничего не пишет.
    const again = await answer({ answer: 'agree' });
    assert.equal(again.notice, 'Отметка уже стоит: согласен.');
    assert.equal(again.reviews.length, 1);

    const doubt = await answer({ answer: 'unsure' });
    assert.equal(doubt.reviews.length, 2);
    const doubtAgain = await answer({ answer: 'unsure' });
    assert.equal(doubtAgain.notice, 'Отметка уже стоит: не могу сказать.');
    assert.equal(doubtAgain.reviews.length, 2);

    // UI-D-28: `n` всегда открывает редактор — им же правится уже написанная причина.
    session.state.reason = 'Клиент назвал время сам, судья это пропустил.';
    const disagreed = await answer({ answer: 'disagree' });
    assert.equal(disagreed.reviews.length, 3);
    assert.equal(disagreed.reviews.at(-1)!.note, 'Клиент назвал время сам, судья это пропустил.');
    // CR-02: the demo card is a legacy strict card whose checks also failed, so the number did not move and the notice says so.
    assert.equal(disagreed.notice, `Отмечено: не согласен · «${target.scenario.title}». Ситуация остаётся «не справился»: остальные провалы — через v.`);

    session.state.reason = '  Клиент назвал время сам, судья это пропустил.  ';
    const same = await answer({ answer: 'disagree' });
    assert.equal(session.editorCalls.at(-1)!.initial, 'Клиент назвал время сам, судья это пропустил.');
    assert.equal(same.notice, 'Отметка уже стоит: не согласен.');
    assert.equal(same.reviews.length, 3);

    session.state.reason = 'я'.repeat(3001);
    const long = await answer({ answer: 'disagree' });
    assert.equal(long.notice, 'Причина длиннее 3000 знаков. Сократите и попробуйте снова.');
    assert.equal(long.reviews.length, 3);

    session.state.reason = 'Другая причина: судья не прочитал запись до конца.';
    const rewritten = await answer({ answer: 'disagree' });
    assert.equal(rewritten.reviews.length, 4);
    assert.equal(rewritten.reviews.at(-1)!.note, 'Другая причина: судья не прочитал запись до конца.');

    // Последний ответ побеждает: у ситуации остаётся одна действующая отметка.
    const back = await answer({ answer: 'agree' });
    assert.equal(back.reviews.length, 5);
    const stored = await new ExperimentStore(join(fixture.cwd, '.agent-lab')).get(fixture.record.id);
    const current = judgeAgreement(stored).marks.filter(mark => mark.trialId === target.trial.id && !mark.stale);
    assert.equal(current.length, 1);
    assert.equal(current[0]!.answer, 'agree');

    // T-03-13: доска показывала другое решение судьи — лаборатория отказывает, и отказ назван.
    // Ответ здесь новый: правило «отметка уже стоит» стоит раньше и иначе перехватило бы отказ.
    const moved = await answer({ answer: 'unsure', judgeVerdict: target.judgeVerdict === 'fail' ? 'pass' : 'fail' });
    assert.equal(moved.notice, 'Оценка судьи изменилась, пока вы смотрели. Проверьте ситуацию ещё раз.');
    assert.equal(moved.reviews.length, 5);

    for (const notice of notices) assertPlainCopy(notice.replace(/«[^»]*»/gu, ''), 'уведомление');
  } finally {
    await shutdown();
    await fixture.cleanup();
  }
});

/**
 * Every demo card becomes a goal card with prompt rules (CTX-01): the agent metrics are the goal and
 * the rules, the card's simulator metrics stay, and the judge is recorded as failing both on every
 * trial, citing an agent reply — a double failure on every situation.
 */
function goalAndRules(record: Experiment) {
  for (const card of record.scenarios) {
    card.metrics = [structuredClone(goalAttainment), structuredClone(promptCompliance), ...(card.metrics ?? []).filter(m => m.subject === 'simulator')];
  }
  for (const trial of record.trials) {
    const said = trial.events.find(event => event.type === 'assistant')!;
    trial.assessments = [
      { metricId: 'goal_attainment', result: 'fail', rationale: 'Агент не перенёс запись и отправил клиента в поддержку.', evidence: [said.seq], citations: [{ seq: said.seq, quote: said.text ?? '' }] },
      { metricId: 'prompt_compliance', result: 'fail', rationale: 'Агент направил клиента в поддержку.', evidence: [said.seq], citations: [{ seq: said.seq, quote: said.text ?? '' }] },
      ...(trial.assessments ?? []).filter(a => card(record, trial)?.metrics?.some(m => m.id === a.metricId && m.subject === 'simulator')),
    ];
  }
}
const card = (record: Experiment, trial: Experiment['trials'][number]) => record.scenarios.find(item => item.id === trial.scenarioId);
const GOAL_AND_RULES_OPTIONS = ['Запрос выполнен — судья ошибся', 'Правила промпта соблюдены — судья ошибся', 'С обоими: запрос выполнен и правила соблюдены'];

test('на двойном провале n спрашивает, с чем именно, и пишет отметку на каждую оценку', { timeout: 180000 }, async () => {
  const fixture = await boardFixture('agent-lab-board-both-', goalAndRules);
  const unchanged = await boardFixture('agent-lab-board-both-still-', record => { goalAndRules(record); record.settings.repeats = 2; });
  const { tools, shutdown, command } = registered();
  const session = boardSession(fixture.cwd);
  const notices: string[] = [];
  type Review = { trialId: string; metricId: string; verdict: string; note: string; countingRules?: string; durationMs?: number };
  const inspect = async (of = fixture) => output(await tools.get('agent_lab_inspect')!.execute('both', { id: of.record.id }, undefined, undefined,
    { cwd: of.cwd, hasUI: false, mode: 'print' } as ExtensionContext)).humanReviews as Review[];
  const noticeOf = (screen: string) => screen.split('\n').map(row => row.replace(/^[^\p{L}\p{N}]*/u, '').replace(/[^\p{L}\p{N}.»]*$/u, ''))
    .find(row => /^(Отмечено:|Отметка уже стоит:|Несогласие не сохранено|Причина длиннее|Оценка судьи изменилась)/.test(row)) ?? '';
  const titleOf = (trialId: string) => fixture.record.scenarios.find(item => item.id === fixture.record.trials.find(trial => trial.id === trialId)!.scenarioId)!.title;
  const situations = judgedSituations(fixture.record);
  assert.equal(situations.length, 2);
  for (const item of situations) assert.deepEqual([item.judgeVerdict, item.metricIds], ['fail', ['goal_attainment', 'prompt_compliance']]);
  const store = new ExperimentStore(join(fixture.cwd, '.agent-lab'));
  try {
    // CTX-16: «не согласен» on a double failure asks which half; the rules alone → a disagreement on
    // the rules and an agreement on the goal, both stamped by the lab, one situation checked.
    session.state.choice = GOAL_AND_RULES_OPTIONS[1];
    session.state.reason = 'Проверка: агент не отправлял клиента в поддержку.';
    session.state.steps = [['3', 'n'], ['q']];
    await command(fixture.record.id, session.ctx);
    assert.deepEqual(session.selectCalls, [{ title: 'С чем вы не согласны?', options: GOAL_AND_RULES_OPTIONS }]);
    assertPlainCopy('С чем вы не согласны?', 'вопрос');
    for (const option of GOAL_AND_RULES_OPTIONS) assertPlainCopy(option, 'вариант');
    assert.equal(session.editorCalls.at(-1)!.title, 'Судья решил: не справился. Почему вы не согласны? Коротко, своими словами.');
    const first = await inspect();
    assert.equal(first.length, 2, JSON.stringify(first));
    const [goalMark, rulesMark] = first;
    assert.equal(goalMark!.trialId, rulesMark!.trialId);
    assert.deepEqual([goalMark!.metricId, goalMark!.verdict, goalMark!.note], ['goal_attainment', 'fail', 'Быстрая отметка: согласен с судьёй.']);
    assert.deepEqual([rulesMark!.metricId, rulesMark!.verdict, rulesMark!.note], ['prompt_compliance', 'pass', 'Проверка: агент не отправлял клиента в поддержку.']);
    assert.deepEqual(first.map(mark => mark.countingRules), [COUNTING_RULES, COUNTING_RULES]);
    assert.equal(typeof goalMark!.durationMs, 'number');
    const firstTrial = goalMark!.trialId;
    notices.push(noticeOf(session.screens.at(-1)!));
    assert.equal(notices.at(-1), `Отмечено: не согласен · «${titleOf(firstTrial)}». Ситуация остаётся «не справился»: запрос не выполнен.`);
    const checked = judgeAgreement(await store.get(fixture.record.id));
    assert.equal(checked.checked, 1);
    assert.deepEqual(checked.disagreements.map(item => [item.trialId, item.overturned]), [[firstTrial, ['prompt_compliance']]]);

    // Esc in the question: nothing is written, the editor never opens, the board says nothing.
    const editors = session.editorCalls.length;
    session.state.choice = undefined;
    session.state.steps = [['3', 'n'], ['q']];
    await command(fixture.record.id, session.ctx);
    assert.equal((await inspect()).length, 2);
    assert.equal(session.editorCalls.length, editors, 'a cancelled question opens no editor');
    assert.doesNotMatch(session.screens.at(-1)!, /Отмечено:|Несогласие не сохранено|Отметка уже стоит/);

    // «С обоими» on the other double failure: two overturned halves, and the situation's verdict moved.
    session.state.choice = GOAL_AND_RULES_OPTIONS[2];
    session.state.reason = 'Клиент получил перенос, правила соблюдены.';
    session.state.steps = [['3', 'n'], ['q']];
    await command(fixture.record.id, session.ctx);
    const both = (await inspect()).slice(2);
    assert.equal(both.length, 2);
    assert.notEqual(both[0]!.trialId, firstTrial, 'the second answer lands on the next queued double failure');
    assert.deepEqual(both.map(mark => [mark.metricId, mark.verdict, mark.note, mark.countingRules]),
      [['goal_attainment', 'pass', 'Клиент получил перенос, правила соблюдены.', COUNTING_RULES], ['prompt_compliance', 'pass', 'Клиент получил перенос, правила соблюдены.', COUNTING_RULES]]);
    notices.push(noticeOf(session.screens.at(-1)!));
    assert.equal(notices.at(-1), `Отмечено: не согласен · «${titleOf(both[0]!.trialId)}». Итог пересчитан с учётом вашей отметки.`);

    // CTX-17: «согласен» writes the same answer on both metrics without a question.
    session.state.steps = [['3', 'y'], ['q']];
    await command(fixture.record.id, session.ctx);
    const agreed = (await inspect()).slice(4);
    assert.deepEqual(agreed.map(mark => [mark.trialId, mark.metricId, mark.verdict, mark.note]),
      [[firstTrial, 'goal_attainment', 'fail', 'Быстрая отметка: согласен с судьёй.'], [firstTrial, 'prompt_compliance', 'fail', 'Быстрая отметка: согласен с судьёй.']]);
    assert.equal(session.selectCalls.length, 3, '«согласен» asks nothing');
    notices.push(noticeOf(session.screens.at(-1)!));
    assert.equal(notices.at(-1), `Отмечено: согласен с судьёй · «${titleOf(firstTrial)}». Проверено провалов: 2 из 2.`);

    // UI-D-19 over every target: the same answer again writes nothing.
    const again = () => ({ type: 'agree', answer: 'agree', record: fixture.record, section: 'results', selected: 0,
      trialId: firstTrial, metricIds: ['goal_attainment', 'prompt_compliance'], judgeVerdict: 'fail' });
    session.state.steps = [again, ['q']];
    await command(fixture.record.id, session.ctx);
    assert.equal((await inspect()).length, 6);
    notices.push(noticeOf(session.screens.at(-1)!));
    assert.equal(notices.at(-1), 'Отметка уже стоит: согласен.');

    // «Не могу сказать» — doubt on both metrics, the judge's verdict stays.
    session.state.steps = [() => ({ ...again(), answer: 'unsure' }), ['q']];
    await command(fixture.record.id, session.ctx);
    const unsure = (await inspect()).slice(6);
    assert.deepEqual(unsure.map(mark => [mark.metricId, mark.verdict, mark.note]),
      [['goal_attainment', 'unknown', 'Быстрая отметка: не могу сказать.'], ['prompt_compliance', 'unknown', 'Быстрая отметка: не могу сказать.']]);
    notices.push(noticeOf(session.screens.at(-1)!));
    assert.equal(notices.at(-1), `Отмечено: не могу сказать · «${titleOf(firstTrial)}». В итоге остаётся оценка судьи; чтобы закрыть ситуацию, позже нажмите y или n.`);
    assert.equal(session.selectCalls.length, 3, '«не могу сказать» asks nothing');

    // A situation whose card verdict cannot move (a planned attempt is missing) hears that the number did not change.
    const still = boardSession(unchanged.cwd);
    still.state.choice = GOAL_AND_RULES_OPTIONS[2];
    still.state.reason = 'Клиент получил перенос.';
    still.state.steps = [['3', 'n'], ['q']];
    await command(unchanged.record.id, still.ctx);
    const stillMarks = await inspect(unchanged);
    assert.equal(stillMarks.length, 2);
    notices.push(noticeOf(still.screens.at(-1)!));
    assert.equal(notices.at(-1), `Отмечено: не согласен · «${unchanged.record.scenarios.find(item => item.id === unchanged.record.trials.find(trial => trial.id === stillMarks[0]!.trialId)!.scenarioId)!.title}». Итог не изменился.`);

    for (const notice of notices) assertPlainCopy(notice.replace(/«[^»]*»/gu, ''), 'уведомление');
  } finally {
    await store.close();
    await shutdown();
    await fixture.cleanup();
    await unchanged.cleanup();
  }
});

test('отметка на завершённом прогоне снова открывает разбор, а прогон без провалов считает успехи', { timeout: 120000 }, async () => {
  const finished = await boardFixture('agent-lab-board-complete-', record => {
    record.resultsReviewHash = resultHash(record);
    record.resultsReviewedAt = record.updatedAt;
    record.phase = 'complete';
  });
  const passesOnly = await boardFixture('agent-lab-board-passes-', record => {
    for (const trial of record.trials) for (const assessment of trial.assessments ?? []) assessment.result = 'pass';
  });
  const { tools, shutdown, command } = registered();
  try {
    for (const [fixture, expected] of [
      [finished, ' Разбор снова открыт: f — завершить.'],
      [passesOnly, `Проверено успехов: 1 из ${judgeAgreement(passesOnly.record).sampledPasses.length}.`],
    ] as const) {
      const session = boardSession(fixture.cwd);
      const target = judgedSituations(fixture.record)[0]!;
      session.state.steps = [() => ({ type: 'agree', answer: 'agree', record: fixture.record, section: 'results', selected: 0,
        trialId: target.trial.id, metricIds: target.metricIds, judgeVerdict: target.judgeVerdict }), ['q']];
      await command(fixture.record.id, session.ctx);
      assert.ok(session.screens.at(-1)!.includes(expected), session.screens.at(-1));
      const report = output(await tools.get('agent_lab_inspect')!.execute('reopen', { id: fixture.record.id }, undefined, undefined,
        { cwd: fixture.cwd, hasUI: false, mode: 'print' } as ExtensionContext));
      assert.equal(report.phase, 'results_review');
      assert.equal(report.humanReviews.length, 1);
    }
  } finally {
    await shutdown();
    await finished.cleanup();
    await passesOnly.cleanup();
  }
});

test('f называет, сколько ситуаций не разобрано, и подтверждение говорит, на что ставится отметка', { timeout: 120000 }, async () => {
  const fixture = await boardFixture('agent-lab-board-finalize-');
  const { tools, shutdown, command } = registered();
  const session = boardSession(fixture.cwd);
  const [doubted, ...rest] = judgedSituations(fixture.record);
  assert.ok(doubted, 'у демо-прогона есть решённая судьёй ситуация');
  const mark = (item: ReturnType<typeof judgedSituations>[number], answer: string) => () => ({ type: 'agree', answer,
    record: fixture.record, section: 'results', selected: 0, trialId: item.trial.id, metricIds: item.metricIds, judgeVerdict: item.judgeVerdict });
  try {
    session.state.steps = [mark(doubted, 'unsure'), ...rest.map(item => mark(item, 'agree')), ['f'], ['q']];
    await command(fixture.record.id, session.ctx);
    const blocked = session.screens.at(-1)!;
    assert.ok(blocked.includes('Не разобрано ситуаций: 1. y / n — согласие с судьёй · v — подробная оценка.'), blocked);
    assert.ok(blocked.includes('● Только неразобранные'), blocked);
    assertPlainCopy('Не разобрано ситуаций: 1. y / n — согласие с судьёй · v — подробная оценка.', 'уведомление');

    session.state.steps = [mark(doubted, 'agree'), ['f'], ['q']];
    await command(fixture.record.id, session.ctx);
    const body = session.confirmBodies.at(-1)!.split('\n');
    const notesAt = body.findIndex(row => row.startsWith('Отдельных заметок человека:'));
    assert.ok(notesAt >= 0, session.confirmBodies.at(-1));
    // CTX-21/CTX-28 (C-325 replaces C-65): the confirmation names the metrics a mark lands on under the new counting rule.
    assert.equal(body[notesAt + 1], 'Отметка согласия ставится на оценки, из-за которых ситуация решена: запрос и правила промпта; остальные критерии — через v.');
    assertPlainCopy(body[notesAt + 1]!, 'подтверждение');
    const report = output(await tools.get('agent_lab_inspect')!.execute('finalized', { id: fixture.record.id }, undefined, undefined,
      { cwd: fixture.cwd, hasUI: false, mode: 'print' } as ExtensionContext));
    assert.equal(report.phase, 'complete');
  } finally {
    await shutdown();
    await fixture.cleanup();
  }
});

test('Pi inspect payload, its collapsed result and CLI summary open with the same ResultView block', { timeout: 60000 }, async () => {
  const demo = await demoEvaluateRecord('agent-lab-pi-view-');
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-pi-view-cwd-'));
  const { tools, shutdown } = registered();
  try {
    await demo.lab.close();
    const record = demo.record;
    assert.ok(record.trials.length > 0);
    const store = new ExperimentStore(join(cwd, '.agent-lab'));
    await store.init();
    try { await store.save(record); } finally { await store.close(); }
    const inspect = tools.get('agent_lab_inspect')!;
    const result = await inspect.execute('inspect-view', { id: record.id }, undefined, undefined, { cwd, hasUI: false, mode: 'print' } as ExtensionContext);
    const payload = output(result);
    const expected = resultViewLines(buildResultView(record));
    assert.deepEqual(payload.viewLines, expected);
    assert.equal(payload.view.headline.text, expected[0]);
    const rendered = inspect.renderResult!(result as never, { expanded: false, isPartial: false }, { fg: (_color: string, text: string) => text } as never) as unknown as Component;
    const text = rendered.render(400).map(line => line.trimEnd()).join('\n').trim();
    assert.ok(text.startsWith(payload.viewLines.join('\n')), 'the collapsed tool result opens with the ResultView block');
    if (payload.view.failures.length) {
      assert.ok(Array.isArray(payload.failureLines) && payload.failureLines.length, 'a run with failures carries the failure section');
      assert.ok(['Главные причины провалов:', 'Провалы:'].includes(payload.failureLines[0]), payload.failureLines[0]);
      const pointer = `Все провалы — /agent-lab ${record.id.slice(0, 8)}, раздел 1, Enter.`;
      assert.equal(payload.failureLines.at(-1), pointer);
      // The pointer to the board is the last row: the disagreements (F7) and the next step (F8)
      // come between the causes and it, so the Pi order matches the CLI one.
      const causes = payload.failureLines.slice(0, -1).join('\n');
      const agreement = (payload.disagreementLines ?? []).join('\n');
      assert.ok(text.startsWith([payload.viewLines.join('\n'), causes, agreement, pointer].filter(Boolean).join('\n\n')),
        'the block, the failure section, the agreement section and the pointer follow in that order');
      assert.ok(!text.includes('ЧТО ТРЕБУЕТ ВНИМАНИЯ'));
    }
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const child = spawn(process.execPath, [cli, 'summary', '--id', record.id, '--data-dir', join(cwd, '.agent-lab')]);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    assert.equal(code, 0, stderr);
    const lines = stdout.split('\n');
    const block = lines.slice(0, lines.indexOf(''));
    const details = block.indexOf('Не измерено по причинам:');
    assert.deepEqual(details < 0 ? block : block.slice(0, details), payload.viewLines);
  } finally {
    await shutdown();
    await rm(cwd, { recursive: true, force: true });
    await rm(demo.directory, { recursive: true, force: true });
  }
});

test('the owner’s disagreement with the judge reads the same in the Pi payload, its collapsed result and the CLI summary', { timeout: 60000 }, async () => {
  const demo = await demoEvaluateRecord('agent-lab-pi-disagreement-');
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-pi-disagreement-cwd-'));
  const { tools, shutdown } = registered();
  try {
    const source = demo.record;
    // The first situation the judge failed; the mark answers exactly that judgment.
    const marked = source.trials.flatMap(trial => {
      const scenario = source.scenarios.find(item => item.id === trial.scenarioId);
      const metricId = scenario && primaryMetricId(scenario, trial);
      if (!scenario || !metricId) return [];
      if (trial.assessments?.find(item => item.metricId === metricId)?.result !== 'fail') return [];
      return [{ trial, scenario, metricId }];
    })[0];
    assert.ok(marked, 'the demo run has a failed situation to disagree about');
    await demo.lab.addHumanReview(source.id, { trialId: marked.trial.id, metricId: marked.metricId, source: 'quick',
      verdict: 'pass', note: 'Проверка:  судья не учёл\nуточнение клиента.', durationMs: 1200 });
    const record = await demo.lab.get(source.id);
    await demo.lab.close();
    const store = new ExperimentStore(join(cwd, '.agent-lab'));
    await store.init();
    try { await store.save(record); } finally { await store.close(); }

    const expected = ['Несогласия с судьёй (1):', `! ${marked.scenario.title}`,
      '  Судья: не справился → владелец: справился', '  Причина: «Проверка: судья не учёл уточнение клиента.»'];
    const nextStep = `Отметить согласие с судьёй можно в Pi: /agent-lab ${record.id.slice(0, 8)}, раздел 3.`;
    const inspect = tools.get('agent_lab_inspect')!;
    const result = await inspect.execute('inspect-disagreement', { id: record.id }, undefined, undefined, { cwd, hasUI: false, mode: 'print' } as ExtensionContext);
    const payload = output(result);
    assert.deepEqual(payload.disagreementLines, [...expected, '', nextStep]);

    const rendered = inspect.renderResult!(result as never, { expanded: false, isPartial: false }, { fg: (_color: string, text: string) => text } as never) as unknown as Component;
    const shown = rendered.render(400).map(line => line.trimEnd().trim());
    for (const line of [...expected, nextStep]) assert.ok(shown.includes(line.trim()), `${line} is missing from the collapsed result`);

    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const child = spawn(process.execPath, [cli, 'summary', '--id', record.id, '--data-dir', join(cwd, '.agent-lab')]);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    assert.equal(code, 0, stderr);
    const lines = stdout.split('\n');
    const causeAt = lines.findIndex(line => ['Главные причины провалов:', 'Провалы:'].includes(line));
    const startAt = lines.findIndex(line => line.startsWith('Несогласия с судьёй ('));
    const endAt = lines.findIndex(line => line.startsWith('Все провалы (') || line === 'Подробности:');
    assert.ok(causeAt >= 0 && causeAt < startAt && startAt < endAt, `${causeAt} / ${startAt} / ${endAt}`);
    assert.deepEqual(lines.slice(startAt, endAt).filter(line => line.trim()), [...expected, nextStep]);

    // No chat path writes a mark: no tool takes a verdict, a one-key mark or the judgment it
    // answers, and the review tool still asks only which dialogue to show the owner. The one
    // `source` in any schema belongs to `agent_lab_build`: it names where the owner's materials
    // came from, its own schema fixes it to `owner`, and it can never name a mark.
    for (const tool of tools.values()) {
      const schema = JSON.stringify(tool.parameters ?? {});
      for (const forbidden of ['"verdict"', '"judgeVerdict"', '"quick"']) {
        assert.ok(!schema.includes(forbidden), `${tool.name} offers ${forbidden}`);
      }
    }
    const review = tools.get('agent_lab_review')!.parameters as { properties: Record<string, unknown> };
    assert.deepEqual(Object.keys(review.properties), ['id', 'trialId']);
  } finally {
    await shutdown();
    await rm(cwd, { recursive: true, force: true });
    await rm(demo.directory, { recursive: true, force: true });
  }
});

test('на доске y подтверждает все ожидания черновика и доска возвращается с уведомлением', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-board-accept-'));
  const { tools, shutdown, command } = registered();
  t.after(async () => { await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const ctx = { cwd: directory, model: undefined, mode: 'tui', hasUI: true } as ExtensionCommandContext;
  const report = output(await tools.get('agent_lab_build')!.execute('prepare', { mode: 'demo', scenarioCount: 2 }, undefined, undefined, ctx));
  const screens: { text: string; notice?: { message: string; kind: string } }[] = [];
  const keys = ['y', 'y', 'q'];
  ctx.ui = {
    custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => Component & { dispose?(): void },
      options: unknown, boardOptions?: unknown) => new Promise(resolve => {
      const current = screens.length;
      let component: Component & { dispose?(): void };
      component = factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_: string, text: string) => text, bold: (text: string) => text }, {},
        value => { component.dispose?.(); resolve(value); });
      screens.push({ text: component.render(100).join('\n') });
      void Promise.resolve().then(() => component.handleInput!(keys[current]!));
      void boardOptions; void options;
    }),
    confirm: async () => false,
    notify: () => {},
  } as unknown as ExtensionContext['ui'];
  await command(`${report.id}`, ctx);
  assert.equal(screens.length, 3);
  // Экран 1 — лист ожиданий без подтверждения; после y доска открыта снова и говорит, что подтверждено.
  assert.match(screens[0]!.text, /ЧТО АГЕНТ ДОЛЖЕН СДЕЛАТЬ/);
  assert.match(screens[0]!.text, /Проверьте ожидания: 2 ситуации\./);
  assert.match(screens[1]!.text, /Ожидания подтверждены: 2 ситуации\. r — запуск\./);
  assert.match(screens[1]!.text, /Ожидания подтверждены\. r — запуск\./, 'заголовок черновика тоже переключился');
  assert.match(screens[2]!.text, /Ожидания уже подтверждены\. r — запуск\./);
  const stored = output(await tools.get('agent_lab_inspect')!.execute('after', { id: report.id }, undefined, undefined, ctx));
  assert.equal(stored.acceptedDraftHash, stored.draftHash, 'подтверждена именно показанная версия');
  assert.equal(stored.trialCount, 0, 'подтверждение не запускает агента');
});

/** Drives the native board: renders each screen, then plays one scripted step on it. */
function boardDriver(screens: string[], steps: ((component: Component & { handleInput?(data: string): void }) => void)[]) {
  return (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => Component & { dispose?(): void }) =>
    new Promise(resolve => {
      const current = screens.length;
      let component: Component & { dispose?(): void };
      component = factory({ terminal: { rows: 40 }, requestRender() {} },
        { fg: (_: string, text: string) => text, bold: (text: string) => text }, {},
        value => { component.dispose?.(); resolve(value); });
      screens.push(component.render(100).join('\n'));
      const step = steps[current];
      assert.ok(step, `лишний экран доски ${current}`);
      void Promise.resolve().then(() => step(component as Component & { handleInput?(data: string): void }));
    });
}

test('на доске e правит одно ожидание словами владельца, и каждый отказ назван', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-board-expect-'));
  const { tools, shutdown, command } = registered();
  const originalSet = ExperimentLab.prototype.setExpectation;
  const setCalls: { scenarioId: string; text: string }[] = [];
  ExperimentLab.prototype.setExpectation = async function(id, hash, scenarioId, text) {
    setCalls.push({ scenarioId, text }); return originalSet.call(this, id, hash, scenarioId, text);
  };
  t.after(async () => { ExperimentLab.prototype.setExpectation = originalSet; await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const ctx = { cwd: directory, model: undefined, mode: 'tui', hasUI: true } as ExtensionCommandContext;
  const built = output(await tools.get('agent_lab_build')!.execute('prepare', { mode: 'demo', scenarioCount: 2 }, undefined, undefined, ctx));
  const draft = output(await tools.get('agent_lab_inspect')!.execute('read', { id: built.id }, undefined, undefined, ctx));
  // Первую ситуацию оценивает судья по словам владельца; вторую — только точные проверки.
  draft.scenarios[0].metrics = [goalAttainment];
  await tools.get('agent_lab_edit')!.execute('rubric', { id: built.id, expectedHash: built.draftHash, patch: { scenarios: draft.scenarios } }, undefined, undefined, ctx);
  const own = 'Перенести запись и назвать новое время словами клиента.';
  const editorCalls: { title: string; prefill: string }[] = [];
  const replies: (string | undefined)[] = [undefined, '   \n ', 'я'.repeat(3001), own, 'Другой текст'];
  const screens: string[] = [];
  ctx.ui = {
    custom: boardDriver(screens, [
      c => c.handleInput!('y'), c => c.handleInput!('e'), c => c.handleInput!('e'), c => c.handleInput!('e'),
      c => c.handleInput!('e'), c => { c.handleInput!('j'); c.handleInput!('e'); }, c => c.handleInput!('q'),
    ]),
    editor: async (title: string, prefill: string) => { editorCalls.push({ title, prefill }); return replies[editorCalls.length - 1]; },
    confirm: async () => false,
    notify: () => {},
  } as unknown as ExtensionContext['ui'];
  await command(built.id, ctx);

  assert.equal(editorCalls.length, 5);
  for (const call of editorCalls) assert.equal(call.title, 'Что агент должен сделать в этой ситуации? Своими словами.');
  assert.equal(editorCalls[0]!.prefill, draft.scenarios[0].successCriteria, 'редактор открывается текущим ожиданием');
  // Пустой текст и текст длиннее 3000 знаков не доходят до записи; текст владельца уходит дословно.
  assert.deepEqual(setCalls[0], { scenarioId: draft.scenarios[0].id, text: own }, 'текст владельца записан дословно');
  assert.equal(setCalls.length, 2, 'только две попытки записи: своими словами и отказ точных проверок');
  assert.ok(!setCalls.some(call => call.text.trim() === '' || call.text.length > 3000));
  assert.doesNotMatch(screens[2]!, /Ожидание не изменено|Ожидание изменено|Ожидание длиннее/, 'отмена редактора молчит');
  assert.match(screens[3]!, /Ожидание не изменено\./);
  assert.match(screens[4]!, /Ожидание длиннее 3000 знаков\. Сократите и попробуйте снова\./);
  assert.match(screens[5]!, new RegExp(`Ожидание изменено: «${draft.scenarios[0].title}»\\. Подтвердите ожидания снова: y\\.`));
  assert.match(screens[5]!, /Ожидание изменено после подтверждения\. y — подтвердить снова\./);
  assert.match(screens[5]!, /Ожидание изменено владельцем — с прошлыми прогонами не сравнивается\./);
  assert.match(screens[5]!, / · ожидание изменено/);
  assert.match(screens[6]!, /Эту ситуацию проверяют точные проверки, а не судья\. Поправьте её словами: a\./);
  const stored = output(await tools.get('agent_lab_inspect')!.execute('after', { id: built.id }, undefined, undefined, ctx));
  assert.equal(stored.scenarios[0].successCriteria, own, 'слова владельца стали критерием дословно');
  assert.equal(stored.trialCount, 0);
});

test('r подтверждает ожидания и запускает одним диалогом, а отказ запуска назван', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-board-run-'));
  const { tools, shutdown, command } = registered();
  const originalStart = ExperimentLab.prototype.start;
  const startCalls: Parameters<ExperimentLab['start']>[1][] = [];
  let refuse = false;
  ExperimentLab.prototype.start = async function(id, options) {
    startCalls.push(options);
    if (refuse) throw new Error('Сначала подтвердите ожидания ситуаций: они изменились или ещё не подтверждены.');
    return originalStart.call(this, id, options);
  };
  t.after(async () => { ExperimentLab.prototype.start = originalStart; await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const ctx = { cwd: directory, model: undefined, mode: 'tui', hasUI: true } as ExtensionCommandContext;
  const first = output(await tools.get('agent_lab_build')!.execute('one', { mode: 'demo', scenarioCount: 2 }, undefined, undefined, ctx));
  const confirms: { title: string; body: string }[] = [];
  const answers = [false, true, true];
  const screens: string[] = [];
  ctx.ui = {
    custom: boardDriver(screens, [c => c.handleInput!('r'), c => c.handleInput!('r'), c => c.handleInput!('q')]),
    confirm: async (title: string, body: string) => { confirms.push({ title, body }); return answers[confirms.length - 1]!; },
    editor: async () => undefined, notify: () => {},
  } as unknown as ExtensionContext['ui'];
  await command(first.id, ctx);

  // Closing the board no longer cancels/waits for its run. Wait for completion explicitly
  // before assertions about final trial counts and starting another write operation.
  const completedStore = new ExperimentStore(join(directory, '.agent-lab'));
  const deadline = Date.now() + 10000;
  while ((await completedStore.get(first.id)).phase === 'evaluating' || existsSync(join(directory, '.agent-lab', '.lock'))) {
    assert.ok(Date.now() < deadline, 'background fixture did not finish');
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  assert.equal(confirms[0]!.title, 'Подтвердить ожидания и запустить?');
  assert.match(confirms[0]!.body, /Что агент должен сделать: 2 ситуации\. Номер правила — порядок в ваших материалах\./);
  assert.equal(confirms[0]!.body.match(/Ситуация:/g)?.length, 2);
  assert.match(confirms[0]!.body, /Все правила — \/agent-lab [a-z0-9_-]{1,8}, раздел 2\./);
  assert.match(confirms[0]!.body, /Версия тестов: [a-f0-9]{12}/);
  assert.ok(confirms[0]!.body.endsWith('Да — подтвердить все ожидания и начать прогон.'));
  // Подтверждение запечатывает определение каждой карточки целиком, поэтому набор, собранный не
  // из продакшн-логов, показывает и первую реплику, и точные проверки — их владелец замораживает.
  const scope = output(await tools.get('agent_lab_inspect')!.execute('scope', { id: first.id }, undefined, undefined, ctx));
  type ScopeCard = { user: { opening: string }; checks: unknown[]; provenance: string; title: string };
  const cards = scope.scenarios as ScopeCard[];
  assert.ok(cards.length > 1 && cards.every(s => s.provenance !== 'production'), 'демо-набор не из логов');
  assert.match(confirms[0]!.body, /Что вы подтверждаете дословно:/);
  for (const scenario of cards) assert.ok(confirms[0]!.body.includes(`Запрос: ${scenario.user.opening}`), scenario.title);
  assert.equal(confirms[0]!.body.match(/ {2}Проверка: /g)?.length ?? 0, cards.reduce((n, s) => n + s.checks.length, 0));
  assert.equal(startCalls.length, 1, 'отказ ничего не запускает');
  assert.equal(startCalls[0]!.requireAccepted, true);
  assert.equal(startCalls[0]!.reviewer, 'expectations', 'подтверждены ожидания, а не результаты');
  const ran = output(await tools.get('agent_lab_inspect')!.execute('ran', { id: first.id }, undefined, undefined, ctx));
  assert.equal(ran.acceptedDraftHash, ran.draftHash, 'подтверждение записано перед запуском');
  assert.ok(ran.trialCount > 0);

  // Подтверждённый черновик спрашивает как раньше; отказ старта называет следующий шаг.
  const second = output(await tools.get('agent_lab_build')!.execute('two', { mode: 'demo', scenarioCount: 2 }, undefined, undefined, ctx));
  const laterConfirms: { title: string; body: string }[] = [];
  const laterScreens: string[] = [];
  refuse = true;
  ctx.ui = {
    custom: boardDriver(laterScreens, [c => c.handleInput!('y'), c => c.handleInput!('r'), c => c.handleInput!('q')]),
    confirm: async (title: string, body: string) => { laterConfirms.push({ title, body }); return true; },
    editor: async () => undefined, notify: () => {},
  } as unknown as ExtensionContext['ui'];
  await command(second.id, ctx);
  assert.equal(laterConfirms[0]!.title, 'Запустить проверку?');
  assert.equal(startCalls.at(-1)!.requireAccepted, true);
  assert.match(laterScreens[2]!, /Сначала подтвердите ожидания ситуаций: они изменились или ещё не подтверждены\. y — подтвердить\./);
});

test('в чате agent_lab_accept показывает лист ожиданий и даёт подтвердить все или поправить одну ситуацию', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-chat-accept-'));
  const { tools, shutdown } = registered();
  const originalSet = ExperimentLab.prototype.setExpectation;
  const setCalls: { scenarioId: string; text: string }[] = [];
  ExperimentLab.prototype.setExpectation = async function(id, hash, scenarioId, text) {
    setCalls.push({ scenarioId, text }); return originalSet.call(this, id, hash, scenarioId, text);
  };
  t.after(async () => { ExperimentLab.prototype.setExpectation = originalSet; await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const confirms: { title: string; body: string }[] = [];
  const selects: { title: string; options: string[] }[] = [];
  const editorCalls: { title: string; prefill: string }[] = [];
  const notices: { message: string; type: string }[] = [];
  let answers: boolean[] = [];
  let choices: (string | undefined)[] = [];
  let written: (string | undefined)[] = [];
  const ctx = { cwd: directory, mode: 'tui', hasUI: true, ui: {
    confirm: async (title: string, body: string) => { confirms.push({ title, body }); return answers[confirms.length - 1] ?? false; },
    select: async (title: string, options: string[]) => { selects.push({ title, options }); return choices[selects.length - 1]; },
    editor: async (title: string, prefill: string) => { editorCalls.push({ title, prefill }); return written[editorCalls.length - 1]; },
    notify: (message: string, type: string) => { notices.push({ message, type }); },
  } } as unknown as ExtensionContext;
  const call = async (name: string, params: unknown) => output(await tools.get(name)!.execute('chat', params, undefined, undefined, ctx));
  const built = await call('agent_lab_build', { mode: 'demo', scenarioCount: 2 });
  const draft = await call('agent_lab_inspect', { id: built.id });
  for (const scenario of draft.scenarios) scenario.metrics = [goalAttainment];
  await call('agent_lab_edit', { id: built.id, expectedHash: built.draftHash, patch: { scenarios: draft.scenarios } });
  const prepared = await call('agent_lab_inspect', { id: built.id });
  assert.ok(Array.isArray(prepared.sheetLines) && prepared.sheetLines.length, 'inspect черновика несёт весь лист');
  assert.match(prepared.sheetLines.join('\n'), /Что агент должен сделать: 2 ситуации\./);

  // Отказ без правки: ничего не записано, и сказано, что прогон не начнётся.
  answers = [false]; choices = ['Не подтверждать сейчас'];
  const declined = await call('agent_lab_accept', { id: built.id });
  assert.equal(declined.accepted, false);
  assert.equal(declined.message, 'Ожидания не подтверждены. Прогон не начнётся, пока они не подтверждены.');
  assert.equal(confirms[0]!.title, 'Подтвердить ожидания: 2 ситуации?');
  assert.ok(confirms[0]!.body.endsWith('Да — подтвердить все. Нет — поправить одну ситуацию или отменить.'));
  assert.match(confirms[0]!.body, /Что агент должен сделать: 2 ситуации\./);
  assert.deepEqual(selects[0]!.options, ['Поправить ожидание одной ситуации', 'Не подтверждать сейчас']);
  assert.equal(selects[0]!.title, 'Что сделать с ожиданиями?');
  assert.equal((await call('agent_lab_inspect', { id: built.id })).acceptedDraftHash, undefined);
  assert.deepEqual(setCalls, []);

  // Правка одной ситуации словами владельца, затем подтверждение обновлённого листа.
  const own = 'Назвать срок зачисления и подтвердить новое время словами клиента.';
  confirms.length = 0; selects.length = 0;
  answers = [false, true];
  choices = ['Поправить ожидание одной ситуации', `2. ${prepared.scenarios[1].title}`];
  written = [own];
  const accepted = await call('agent_lab_accept', { id: built.id });
  assert.equal(editorCalls[0]!.title, 'Что агент должен сделать в этой ситуации? Своими словами.');
  assert.equal(editorCalls[0]!.prefill, prepared.scenarios[1].successCriteria);
  assert.deepEqual(setCalls, [{ scenarioId: prepared.scenarios[1].id, text: own }]);
  assert.equal(selects[1]!.title, 'Какую ситуацию поправить?');
  assert.deepEqual(selects[1]!.options, prepared.scenarios.map((s: { title: string }, i: number) => `${i + 1}. ${s.title}`));
  assert.equal(confirms.length, 2, 'после правки лист показан снова');
  assert.match(confirms[1]!.body, /Ожидание изменено владельцем — с прошлыми прогонами не сравнивается\./);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.message, 'Ожидания подтверждены: 2 ситуации. Можно запускать.');
  const after = await call('agent_lab_inspect', { id: built.id });
  assert.equal(after.acceptedDraftHash, after.draftHash);
  assert.equal(after.trialCount, 0, 'подтверждение не запускает агента');
  assert.deepEqual(accepted.sheetLines, after.sheetLines, 'ответ инструмента несёт весь лист');

  // Схема инструмента по-прежнему принимает только id: текст и согласие приходят только из диалогов Pi.
  const parameters = tools.get('agent_lab_accept')!.parameters as { properties: Record<string, unknown>; required?: string[] };
  assert.deepEqual(Object.keys(parameters.properties), ['id']);
  const rendered = tools.get('agent_lab_accept')!.renderResult!(
    { content: [{ type: 'text', text: JSON.stringify(accepted) }] } as never,
    { expanded: false, isPartial: false }, { fg: (_color: string, text: string) => text } as never) as unknown as Component;
  const shown = rendered.render(100).join('\n');
  assert.match(shown, /Ожидания подтверждены: 2 ситуации\. Можно запускать\./);
  assert.match(shown, /Что агент должен сделать: 2 ситуации\./);
  assert.deepEqual(notices, []);
});

test('normal live ingress retains 300 original dialogues while bounding the legacy projection before parsing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-full-import-'));
  const originalCreate = ExperimentLab.prototype.create;
  let captured: Parameters<ExperimentLab['create']>[0] | undefined;
  ExperimentLab.prototype.create = async function(raw) { captured = raw; throw new Error('captured full import'); };
  const { tools, shutdown } = registered();
  try {
    const dialogues = Array.from({ length: 300 }, (_, i) => ({ id: `full_${i}`, messages: [{ role: 'user', content: `Вопрос ${i}` }] }));
    const ctx = { cwd: directory, mode: 'tui', hasUI: true, model: { provider: 'fixture', id: 'fixture' }, ui: { confirm: async () => true } } as unknown as ExtensionContext;
    await assert.rejects(() => tools.get('agent_lab_build')!.execute('full-import', { mode: 'live', task: 'Проверить агента',
      materials: [{ name: 'Правила', content: 'Ответить на вопрос.' }], dialogues, target: { kind: 'command', command: process.execPath, args: [] } },
      undefined, undefined, ctx), /captured full import/);
    assert.equal(captured!.dialogues.length, 200);
    assert.equal(captured!.originalImport!.dialogues.length, 300);
    assert.deepEqual(captured!.originalImport!.dialogues[299]!.original, dialogues[299]);
  } finally { ExperimentLab.prototype.create = originalCreate; await shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('generator tool inspection stays compact and read only while an existing writer owns the data',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'generator-tool-')),store=new ExperimentStore(join(directory,'.agent-lab'));await store.init();
  const {tools,shutdown}=registered();
  try {
    await store.saveGeneratorRecord({id:'gen_inspect',formatVersion:'1',kind:'generator-evaluation',runKind:'generator',transport:'deterministic-test',cases:[{id:'case',errors:['provenance'],unknown:false,rawOutput:{secret:'RAW_OUTPUT_MUST_STAY_LOCAL'}}],dimensions:{provenance:{total:1,errors:1,unknown:0}},usage:{calls:0},controls:null,limitations:['Предварительная разметка']});
    const result=output(await tools.get('agent_lab_generator')!.execute('inspect',{operation:'inspect',id:'gen_inspect'},undefined,undefined,{cwd:directory,hasUI:false} as ExtensionContext));
    assert.equal(result.id,'gen_inspect');assert.equal(result.dimensions.provenance.errors,1);assert.doesNotMatch(JSON.stringify(result),/RAW_OUTPUT_MUST_STAY_LOCAL/);
  }finally{await shutdown();await store.close();await rm(directory,{recursive:true,force:true});}
});

test('generator native selection validates mandatory counters and history instead of trusting tool arguments',async()=>{
 const {tools,shutdown}=registered();const tool=tools.get('agent_lab_generator')!;
 const ready={id:'candidate',contentHash:'a'.repeat(64),quality:'ready',provenanceErrors:0,applicabilityErrors:0,validity:'valid',duplicate:'none',coverage:['new'],unmetConditions:1,reproducibleIssues:0,instability:0};
 try{
  for(const [field,value] of [['provenanceErrors',undefined],['applicabilityErrors',null],['provenanceErrors',NaN],['applicabilityErrors',Infinity]] as const){
   await assert.rejects(tool.execute('select',{operation:'select',candidates:[{...ready,[field]:value}],history:[]},undefined,undefined,{cwd:'.',hasUI:false} as ExtensionContext),new RegExp(field));
  }
  await assert.rejects(tool.execute('select',{operation:'select',candidates:[ready],history:null},undefined,undefined,{cwd:'.',hasUI:false} as ExtensionContext),/history/);
 }finally{await shutdown();}
});

test('native owner can add a fact to an empty curated card and creates a real owner receipt', async () => {
  const library = libraryFixture();
  library.variants = [library.variants[0]!];
  Object.assign(library.variants[0]!, { provenance: 'curated', sourceDialogues: [] });
  library.variants[0]!.userState.facts = [];
  const fixture = await boardFixture('scenario-owner-add-', record => {
    record.phase = 'review'; record.scenarios = []; record.trials = []; record.librarySnapshot = library;
    record.sources = library.sources; record.requirements = library.requirements;
  });
  const { command, shutdown } = registered(), session = boardSession(fixture.cwd);
  const values = ['Номер терминала: 4321', '4321', 'Я задаю данные примера'];
  session.ctx.ui.select = async (title, choices) => title.includes('Когда') ? choices[0] : (assert.ok(choices.includes('Добавить факт владельца')), 'Добавить факт владельца');
  session.ctx.ui.editor = async () => values.shift();
  session.state.steps = [['2', 'e'], ['q']];
  try {
    await command(fixture.record.id, session.ctx);
    const reader = new ExperimentLab(join(fixture.cwd, '.agent-lab'));
    const saved = await reader.readLibrary(fixture.record.id), variant = saved.library.variants[0]!;
    assert.equal(variant.userState.facts.length, 1);
    assert.equal(variant.userState.facts[0]!.value, '4321');
    assert.equal(variant.userState.facts[0]!.origin.kind, 'owner');
    assert.equal(variant.history.at(-1)!.factEdit!.factId, variant.userState.facts[0]!.id);
    assert.equal(variant.semanticReviewRequired, true);
  } finally { await shutdown(); await fixture.cleanup(); }
});
