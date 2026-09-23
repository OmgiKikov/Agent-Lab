import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, access, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { DefaultResourceLoader, initTheme, SettingsManager, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, type Component } from '@earendil-works/pi-tui';
import agentLab from '../extensions/agent-lab.ts';
import { demoInput, demoTarget } from '../src/demo.js';
import { ExperimentLab, draftHash } from '../src/experiment.js';
import { spawn, spawnSync } from 'node:child_process';
import { createInputSchema, goalAttainment, promptCompliance, type Experiment } from '../src/contracts.js';
import { resultHash } from '../src/experiment.js';
import { judgeAgreement } from '../src/agreement.js';
import { assertPlainCopy } from './helpers/copy-check.js';
import { ExperimentStore } from '../src/store.js';
import { buildResultView } from '../src/result-view.js';
import { chatBlock, fitRows, MAX_WIDTH, plainText, resultScreen } from '../src/result-text.js';
import { COUNTING_RULES, markTargets, measurementUsable, primaryMetricId } from '../src/outcomes.js';
import { demoEvaluateRecord, legacyDemoRuntime, legacyDraft } from './helpers/demo-record.js';
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
test('the chat guidance names only registered tools and never the retired resolve operation', async () => {
  const { tools, beforeAgentStart } = registered();
  const previous = process.env.AGENT_LAB_SESSION;
  process.env.AGENT_LAB_SESSION = '1';
  try {
    const prompt = (await beforeAgentStart({ systemPrompt: '' }, { ui: {} } as unknown as ExtensionContext))!.systemPrompt;
    const named = [...new Set(prompt.match(/agent_lab_[a-z_]+/g) ?? [])];
    assert.ok(named.includes('agent_lab_resolve'), 'an owner decision on a checker question goes through its own tool');
    for (const name of named) assert.ok(tools.has(name), `${name} is named in the guidance but not registered`);
    assert.doesNotMatch(prompt, /operation resolve/);
  } finally { if (previous === undefined) delete process.env.AGENT_LAB_SESSION; else process.env.AGENT_LAB_SESSION = previous; }
});
/** A draft of old-format cards in `cwd/.agent-lab`, as a repeat of an old run leaves it; `mutate` shapes its cards before it is saved. */
async function legacyDraftIn(cwd: string, options: Parameters<typeof legacyDraft>[1] = {}, mutate?: (record: Experiment) => void): Promise<Experiment> {
  const lab = new ExperimentLab(join(cwd, '.agent-lab'), legacyDemoRuntime());
  await lab.init();
  try {
    const draft = await legacyDraft(lab, options);
    if (!mutate) return draft;
    mutate(draft); await lab.store.save(draft);
    return await lab.get(draft.id);
  } finally { await lab.close(); }
}

test('scenario tool paginates large libraries and expands only an explicitly selected variant', async () => {
  let library = libraryFixture();
  const seed = library.variants[0]!;
  library.variants = Array.from({ length: 200 }, (_, index) => ({ ...structuredClone(seed), id: `bounded_${index}`, title: `Вариант ${index}` }));
  // This is a pagination fixture, not a thousands-of-calls semantic benchmark.
  const { recordSemanticAssessment, semanticPaths } = await import('../src/scenario-library.js');
  const { SEMANTIC_CONTEXT_VERSION } = await import('../src/scenario-work.js');
  library = recordSemanticAssessment(library, library.variants.flatMap(variant => semanticPaths(variant).map(path => ({ variantId: variant.id, path, status: 'ready' as const, reason: 'Pagination fixture' }))));
  library.semanticAssessment!.contextVersion = SEMANTIC_CONTEXT_VERSION;
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
  // A draft of old-format cards is the base the stubbed preparation copies for every sampled dialogue.
  const fixtureLab = new ExperimentLab(join(directory, 'fixture'), legacyDemoRuntime());
  await fixtureLab.init();
  const prepared = await legacyDraft(fixtureLab, { count: 1 });
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

  assert.equal(captured?.originalImport?.dialogues.length, 300, 'the whole outcome-blind export is kept as the import');
  assert.equal(captured?.dialogues?.length, 40);
  assert.deepEqual(captured?.settings.userModes, ['reactive']);
  assert.equal(captured?.settings.maxTurns, 6);
  assert.equal(captured?.settings.maxCalls, 385);
  assert.equal(captured?.settings.timeoutMs, 600000, 'grounding ten materials with a small model takes longer than the two-minute default');
  assert.equal(result.validation.sourceDialogues, 300);
  assert.equal(result.validation.candidateDialogues, 40);
  assert.equal(result.validation.sampledDialogues, 15);
  assert.match(confirmations[0]!.body, /Диалогов в выгрузке: 300; к разбору подходят 40; карточек получится не больше 15/);
  assert.match(confirmations[0]!.body, /не больше 385 вызовов/, 'the spending question names the limit the run will be saved with');
  assert.doesNotMatch(confirmations[0]!.body, /validation set|outcome-blind/i, 'the owner is asked in plain words');
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

test('conversation runs only the confirmed plan, then saves and loads the same case without claiming human review', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-conversation-'));
  const { tools, shutdown } = registered();
  t.after(async () => { await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const plans: string[] = [];
  let consent = false;
  const ctx = { cwd: directory, mode: 'tui', hasUI: true, ui: { confirm: async (_title: string, plan: string) => { plans.push(plan); return consent; } } } as ExtensionContext;
  const call = async (name: string, params: unknown) => output(await tools.get(name)!.execute('fixture', params, undefined, undefined, ctx));
  // The owner accepted one ready situation of the built-in example in its library; the run is confirmed separately.
  const seed = new ExperimentLab(join(directory, '.agent-lab'));
  await seed.init();
  const base = demoInput();
  const created = await seed.create(createInputSchema.parse({ ...base, settings: { ...base.settings, repeats: 1, maxCalls: 20 } })); await seed.waitForIdle();
  await seed.acceptLibrary(created.id, libraryHash((await seed.readLibrary(created.id)).library), ['known_number']);
  await seed.close();
  const draft = await call('agent_lab_inspect', { id: created.id });
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
  assert.match(proofText, /КОНТРОЛЬНЫЕ ТОЧКИ\n(?:ВЫПОЛНЕНО|НАРУШЕНО) \[ask_once\]/);
  assert.match(proofText, /ОЦЕНКИ\n(?:PASS|FAIL|UNKNOWN) \[[^\]]+\].*события: #\d+/);
  // Диалог подтверждения говорит ровно то, что «Да» записывает: набор принят раньше, «Да» запускает агента по этому плану.
  assert.match(plans[1]!, /Принятие набора уже записано отдельно; это подтверждение запуска агента именно по этому плану\./);
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
  // One old-format card, as a repeat of an old one-test run leaves it: the one-test definition is what the owner confirms.
  const built = await legacyDraftIn(directory, { count: 1 }, record => {
    record.scenarios[0]!.goalObservation = 'reply';
    record.scenarios[0]!.user.opening = `Первая строка\n${'полный вход '.repeat(200)}`;
  });
  const prepared = await call('agent_lab_inspect', { id: built.id });
  const draft = prepared;

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

  // A changed run condition is a new version of the draft; the acceptance of the old version does not carry over.
  const edited = await call('agent_lab_edit', { id: built.id, expectedHash: current.draftHash, patch: { settings: { maxTurns: 5 } } });
  assert.notEqual(edited.draftHash, prepared.draftHash);
  assert.equal(edited.acceptedDraftHash, undefined, 'an edit clears the acceptance of the version it replaced');
  const acceptedAgain = await call('agent_lab_accept', { id: built.id });
  assert.equal(acceptedAgain.acceptedDraftHash, edited.draftHash);
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
        if (awaitResults && !keys.includes('r')) {
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
    const built = await call('agent_lab_build', { mode: 'demo' });
    assert.equal(built.phase, 'review', built.error ?? 'draft not ready');
    assert.equal(built.trialCount, 0); assert.equal(built.reviewMode, null); assert.equal(editorCommands.length, 0);
    // The owner accepts the ready situation of the example (native confirmation in the scenarios tool).
    await tools.get('agent_lab_scenarios')!.execute('accept', { operation: 'accept', select: 'ready', id: built.id }, undefined, undefined, ctx);
    steps = [['2', 'a']]; request = 'Одной попытки на ситуацию достаточно.';
    await command(built.id, ctx); assert.equal(userMessages.at(-1), request);
    const selected = JSON.parse(contexts.at(-1)!.content); assert.equal(selected.experimentId, built.id); assert.equal(selected.variantId, 'known_number', JSON.stringify(selected));
    editorText = 'Ещё пишу уточнение';
    const draft = await call('agent_lab_inspect', { id: built.id });
    assert.equal(editorText, 'Ещё пишу уточнение', 'tool must preserve unfinished user input'); editorText = '';
    const edited = await call('agent_lab_edit', { id: built.id, expectedHash: draft.draftHash, patch: { settings: { repeats: 1 } } });
    assert.notEqual(edited.draftHash, draft.draftHash); assert.equal(edited.trialCount, 0);
    // A library run starts from its run section (3); results are section 4.
    steps = [['3', 'r'], ['4', 'a']]; awaitResults = true; request = 'Почему этот диалог провалился и что нужно исправить?';
    await command(built.id, ctx); assert.equal(userMessages.at(-1), request);
    const discussion = JSON.parse(contexts.at(-1)!.content); assert.equal(discussion.experimentId, built.id); assert.ok(discussion.trialId);
    const evidence = await call('agent_lab_inspect', { id: built.id, trialId: discussion.trialId });
    assert.ok(evidence.events.length);
    assert.ok(evidence.checkpoints.some((c: { result: string }) => c.result === 'fail'), 'the agent asked again for the number it was given');
    steps = [['4', 'y'], ['f'], ['q']];
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
    const repeated = await call('agent_lab_repeat', { id: built.id });
    assert.equal(repeated.positiveControlScenarioIds, undefined);
    assert.equal(repeated.parentRunId, built.id); assert.equal(repeated.phase, 'review'); assert.equal(repeated.trialCount, 0); assert.equal(repeated.reviewMode, null);
    assert.equal(editorCommands.length, 0);
    // The fix is a new version of the agent: the corrected module no longer asks for a number it already has.
    await call('agent_lab_edit', { id: repeated.id, expectedHash: repeated.draftHash, patch: { target: demoTarget(true), targetVersion: 'fixture-fixed' } });
    steps = [['3', 'r'], ['4', 'a']]; awaitResults = true; request = 'Покажи конкретное исправление до и после.';
    await command(repeated.id, ctx);
    const pairDiscussion = JSON.parse(contexts.at(-1)!.content);
    assert.deepEqual(pairDiscussion.comparisonSource, { kind: 'parent', beforeId: built.id, afterId: repeated.id });
    assert.equal(pairDiscussion.comparedPair.beforeTrialId, discussion.trialId);
    assert.equal(pairDiscussion.comparedPair.afterTrialId, pairDiscussion.trialId);
    steps = [['3', 'x'], ['q']];
    await command(repeated.id, ctx);
    const exportDir = join(directory, '.agent-lab', 'exports');
    const html = (await readdir(exportDir)).find(name => name.startsWith(repeated.id) && name.endsWith('.html'));
    assert.ok(html); assert.match(await readFile(join(exportDir, html), 'utf8'), /Оценка выросла у 1, снизилась у 0/);
    assert.deepEqual(errors, []); assert.equal(steps.length, 0);
  } finally { await shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('native command demo fixture requires two separate confirmations and preserves human annotation separately', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-human-ui-fixture-'));
  const { tools, shutdown, command } = registered();
  const ctx = { cwd: directory, model: undefined, mode: 'tui', hasUI: true } as ExtensionCommandContext;
  try {
    const report = output(await tools.get('agent_lab_build')!.execute('prepare', { mode: 'demo' }, undefined, undefined, ctx));
    // The owner accepted the ready situation of the example and asked for one attempt; the run itself is confirmed on the board.
    const seed = new ExperimentLab(join(directory, '.agent-lab'));
    await seed.init();
    try {
      const accepted = await seed.acceptLibrary(report.id, libraryHash((await seed.readLibrary(report.id)).library), ['known_number']);
      await seed.updateDraft(report.id, draftHash(accepted.experiment), { settings: { repeats: 1 } });
    } finally { await seed.close(); }
    const errors: string[] = [];
    const confirmations: string[] = [];
    let screen = 0;
    let selection = 0;
    // A library run starts from its run section (3); results are section 4.
    const keys = [['3', 'r'], ['3', 'r'], ['4', 'v'], ['f'], ['f'], ['q']];
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
          for (const key of keys[current]!) component.handleInput!(key);
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
    // The demo's scripted estimate is labelled as the training example and never passed off as a model judgment.
    assert.match(markdown, / · учебный пример$/m); assert.doesNotMatch(markdown, /Оценка модели/);
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

test('the built-in example prepares a library for its external module agent from real dialogues; inspect and exports show the situation from its dialogue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-extension-v2-'));
  const { tools, shutdown } = registered();
  const ctx = { cwd: directory, model: undefined, mode: 'print', hasUI: false } as ExtensionContext;
  try {
    const report = output(await tools.get('agent_lab_build')!.execute('build-v2', { mode: 'demo' }, undefined, undefined, ctx));
    assert.equal(report.phase, 'review', report.error ?? '');
    assert.deepEqual(report.target, demoTarget());
    assert.equal(report.dialogueCount, 2, 'the example is prepared from its own two dialogues');
    assert.equal(report.scenarioCount, 0, 'nothing is runnable before the owner accepts a variant');
    assert.equal(report.comparison, undefined); assert.equal(report.view, undefined, 'a draft has no result yet');
    // The owner accepts the ready variant in the library; the draft then carries it as a card from a real dialogue.
    const lab = new ExperimentLab(join(directory, '.agent-lab'));
    await lab.init();
    try { await lab.acceptLibrary(report.id, libraryHash((await lab.readLibrary(report.id)).library), ['known_number']); } finally { await lab.close(); }
    const inspect = output(await tools.get('agent_lab_inspect')!.execute('inspect-v2', { id: report.id, export: true }, undefined, undefined, ctx));
    assert.equal(inspect.artifacts.agent, undefined, 'an external agent is not exported as an AgentSpec');
    assert.match(await readFile(inspect.artifacts.htmlReport, 'utf8'), /<!doctype html>/);
    assert.equal(inspect.scenarios.filter((s: { provenance: string }) => s.provenance === 'production').length, 1);
    // The report of the draft names the situation taken from the owner's own dialogue and says the run has not started.
    const markdown = await readFile(inspect.artifacts.report, 'utf8');
    assert.match(markdown, /^# Проверка агента · 1 ситуация$/m);
    assert.match(markdown, /^\*\*Точность агента:\*\* прогон ещё не запускался$/m);
    assert.match(markdown, /^## Ситуации$/m); assert.match(markdown, /^из диалога №1$/m);
    await assert.rejects(access(join(directory, '.agent-lab', '.lock')));
  } finally { await shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('the plain verdict leads every surface without research presets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-extension-verdict-'));
  const { tools, shutdown } = registered();
  const ctx = { cwd: directory, model: undefined, mode: 'print', hasUI: false } as ExtensionContext;
  try {
    const quick = output(await tools.get('agent_lab_build')!.execute('build-quick', { mode: 'demo' }, undefined, undefined, ctx));
    assert.equal(quick.phase, 'review');
    // A draft has no result yet: no number, no «Дальше» line; its report says the run has not started.
    assert.equal(quick.view, undefined); assert.equal(quick.nextStep, undefined);
    await assert.rejects(tools.get('agent_lab_build')!.execute('build-thorough', { mode: 'live', task: 'Проверить агента', withoutDialogues: true,
      materials: [{ name: 'Правила', content: 'Отвечать по правилам.' }], target: { kind: 'command', command: process.execPath, args: [] }, preset: 'thorough' }, undefined, undefined, ctx));
    const markdown = await readFile(quick.artifacts.report, 'utf8');
    assert.match(markdown, /^# Проверка агента · 0 ситуаций$/m);
    const answer = markdown.indexOf('**Точность агента:** прогон ещё не запускался');
    assert.ok(answer > 0 && answer < markdown.indexOf('## Как считали'), 'the answer leads the report');
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
  // An import opens the gate: the draft is created with the owner's dialogue, and preparation then needs a model.
  const imported = output(await build({ task: 'Проверить агента', materials: [{ name: 'Правила', content: 'Переносить запись по просьбе клиента.' }], dialoguesFile: file,
    target: { kind: 'module', path: fileURLToPath(new URL('../examples/echo-agent.mjs', import.meta.url)), exportName: 'createSession' } }));
  assert.equal(imported.dialogueCount, 1);
  await writeFile(file, 'invalid json');
  await assert.rejects(build({ dialoguesFile: file, withoutDialogues: true }), /JSON/);
});

test('Pi inspect of a repeat shows the same first block as the CLI summary, stability line included', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-repeat-view-'));
  const { tools, shutdown } = registered();
  t.after(async () => { await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const data = join(directory, '.agent-lab');
  const lab = new ExperimentLab(data, legacyDemoRuntime());
  let repeatId: string;
  try {
    await lab.init();
    const draft = await legacyDraft(lab, { count: 2, settings: { maxCalls: 20, maxDurationMs: 180000 } });
    await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft) }); await lab.waitForIdle();
    const repeat = await lab.repeat(draft.id);
    repeatId = repeat.id;
    await lab.start(repeatId, { approved: true, reviewer: 'automated', expectedHash: draftHash(await lab.get(repeatId)) }); await lab.waitForIdle();
    assert.equal((await lab.get(repeatId)).phase, 'results_review');
  } finally { await lab.close(); }

  const inspected = output(await tools.get('agent_lab_inspect')!.execute('repeat-view', { id: repeatId }, undefined, undefined,
    { cwd: directory, hasUI: false, mode: 'print' } as ExtensionContext));
  // A repeat is checked against its source run; a flip would be counted in the trust line as «нестабильно N».
  assert.ok(inspected.view.stability, 'a repeat is compared with its source run');
  const unstable = inspected.view.cards.filter((card: { control: boolean; flaky: boolean; unstable: boolean }) => !card.control && (card.flaky || card.unstable)).length;
  const lines: string[] = inspected.resultLines;
  const head = (all: string[]) => all.slice(0, all.indexOf(''));
  assert.equal(head(lines).some(line => line.includes(`нестабильно ${unstable}`)), unstable > 0, head(lines).join('\n'));
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'summary', '--id', repeatId, '--data-dir', data], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  // The number, the trust line and the reality line read the same in Pi and on the command line.
  assert.ok(head(lines).length >= 2, lines.join('\n'));
  assert.deepEqual(head(cli.stdout.split('\n')), head(lines));
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
  const draft = await legacyDraftIn(cwd, { count: 1, target: { kind: 'command', command: process.execPath, args: [script], timeoutMs: 5000 },
    settings: { userModes: ['static'], maxTurns: 2 } });
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
    // The payload carries the one view and the board's full result screen made from it; «Дальше» is the chat line of the same view.
    assert.deepEqual(payload.view.headline, buildResultView(record).headline);
    assert.deepEqual(payload.resultLines, plainText(resultScreen(payload.view, { surface: 'board', details: true }), MAX_WIDTH).split('\n'));
    assert.match(payload.nextStep, /^Дальше: /);
    // The collapsed chat block is drawn from that view: it opens with the same number and trust line as the board.
    initTheme('dark', false);
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const rendered = inspect.renderResult!(result as never, { expanded: false, isPartial: false }, theme as never) as unknown as Component;
    const shown = rendered.render(MAX_WIDTH).map(line => stripTerminalSequences(line).trimEnd());
    const block = fitRows(chatBlock(payload.view, { expanded: false }), MAX_WIDTH).map(line => line.text.trimEnd());
    assert.deepEqual(shown.slice(0, block.length), block);
    assert.equal(shown[0], payload.resultLines[0], 'the chat and the board open with the same number');
    assert.ok(!shown.join('\n').includes('"resultLines"'), 'the block is drawn, not the raw payload');
    if (payload.view.failures.length) assert.ok(shown.slice(block.length).join(' ').includes('«покажи ошибку 1»'), shown.join('\n'));
    // The CLI summary prints the same screen: the same head, and every failure listed the same way.
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const child = spawn(process.execPath, [cli, 'summary', '--id', record.id, '--data-dir', join(cwd, '.agent-lab')]);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    assert.equal(code, 0, stderr);
    const lines = stdout.split('\n');
    const head = (all: string[]) => all.slice(0, all.indexOf(''));
    assert.deepEqual(head(lines), head(payload.resultLines));
    const section = (all: string[], title: string) => { const at = all.indexOf(title); return at < 0 ? [] : all.slice(at, all.indexOf('', at)); };
    assert.deepEqual(section(lines, ' Все ошибки'), section(payload.resultLines, ' Все ошибки'));
    assert.equal(section(lines, ' Все ошибки').filter(line => line.trimStart().startsWith('✗ ')).length, payload.view.failures.length);
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

    // F7: the situation, both verdicts and the owner's reason in full, whitespace folded.
    const expected = [' Вы не согласились с судьёй', `   ${marked.scenario.title}`,
      '     Судья: не справился → вы: справился', '     Причина: «Проверка: судья не учёл уточнение клиента.»'];
    const inspect = tools.get('agent_lab_inspect')!;
    const result = await inspect.execute('inspect-disagreement', { id: record.id }, undefined, undefined, { cwd, hasUI: false, mode: 'print' } as ExtensionContext);
    const payload = output(result);
    const section = (all: string[]) => { const at = all.indexOf(expected[0]!); return at < 0 ? [] : all.slice(at, all.indexOf('', at)); };
    assert.deepEqual(section(payload.resultLines), expected);
    assert.deepEqual([payload.view.agreement.checked, payload.view.agreement.agreed], [1, 0]);

    // The collapsed chat block does not list the disagreement; its trust line counts it.
    initTheme('dark', false);
    const rendered = inspect.renderResult!(result as never, { expanded: false, isPartial: false },
      { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never) as unknown as Component;
    const shown = rendered.render(400).map(line => stripTerminalSequences(line).trimEnd());
    assert.ok(shown.some(line => line.includes('с судьёй согласны 0 из 1')), shown.join('\n'));

    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const child = spawn(process.execPath, [cli, 'summary', '--id', record.id, '--data-dir', join(cwd, '.agent-lab')]);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    assert.equal(code, 0, stderr);
    const lines = stdout.split('\n');
    assert.deepEqual(section(lines), expected);
    // On the result screen the disagreement follows every error and comes before «Дальше».
    const causeAt = lines.indexOf(' Почему ошибается'), errorsAt = lines.indexOf(' Все ошибки'), startAt = lines.indexOf(expected[0]!), nextAt = lines.indexOf(' Дальше');
    assert.ok(causeAt >= 0 && causeAt < errorsAt && errorsAt < startAt && startAt < nextAt, `${causeAt} / ${errorsAt} / ${startAt} / ${nextAt}`);

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
  // Two old-format cards, as a repeat of an old run leaves them: their expectations are confirmed on the sheet.
  const report = await legacyDraftIn(directory, { count: 2 });
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
  const first = await legacyDraftIn(directory, { count: 2 });
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
  const second = await legacyDraftIn(directory, { count: 2 });
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

test('в чате agent_lab_accept показывает лист ожиданий и даёт подтвердить все или не подтверждать', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-chat-accept-'));
  const { tools, shutdown } = registered();
  t.after(async () => { await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const confirms: { title: string; body: string }[] = [];
  const selects: { title: string; options: string[] }[] = [];
  const editorCalls: { title: string; prefill: string }[] = [];
  const notices: { message: string; type: string }[] = [];
  let answers: boolean[] = [];
  const ctx = { cwd: directory, mode: 'tui', hasUI: true, ui: {
    confirm: async (title: string, body: string) => { confirms.push({ title, body }); return answers[confirms.length - 1] ?? false; },
    select: async (title: string, options: string[]) => { selects.push({ title, options }); return undefined; },
    editor: async (title: string, prefill: string) => { editorCalls.push({ title, prefill }); return undefined; },
    notify: (message: string, type: string) => { notices.push({ message, type }); },
  } } as unknown as ExtensionContext;
  const call = async (name: string, params: unknown) => output(await tools.get(name)!.execute('chat', params, undefined, undefined, ctx));
  // Two old-format cards judged by the goal rubric, as a repeat of an old run leaves them.
  const built = await legacyDraftIn(directory, { count: 2 }, record => { for (const scenario of record.scenarios) scenario.metrics = [goalAttainment]; });
  const prepared = await call('agent_lab_inspect', { id: built.id });
  assert.ok(Array.isArray(prepared.sheetLines) && prepared.sheetLines.length, 'inspect черновика несёт весь лист');
  assert.match(prepared.sheetLines.join('\n'), /Что агент должен сделать: 2 ситуации\./);

  // Отказ: ничего не записано, и сказано, что прогон не начнётся и где меняется ожидание.
  answers = [false];
  const declined = await call('agent_lab_accept', { id: built.id });
  assert.equal(declined.accepted, false);
  assert.equal(declined.message, 'Ожидания не подтверждены. Прогон не начнётся, пока они не подтверждены. Ожидание ситуации меняется правкой библиотеки сценариев.');
  assert.equal(confirms[0]!.title, 'Подтвердить ожидания: 2 ситуации?');
  assert.ok(confirms[0]!.body.endsWith('Да — подтвердить все. Нет — не подтверждать сейчас.'));
  assert.match(confirms[0]!.body, /Что агент должен сделать: 2 ситуации\./);
  assert.equal((await call('agent_lab_inspect', { id: built.id })).acceptedDraftHash, undefined);

  // Подтверждение всего листа одним «Да».
  confirms.length = 0; answers = [true];
  const accepted = await call('agent_lab_accept', { id: built.id });
  assert.equal(confirms.length, 1);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.message, 'Ожидания подтверждены: 2 ситуации. Можно запускать.');
  const after = await call('agent_lab_inspect', { id: built.id });
  assert.equal(after.acceptedDraftHash, after.draftHash);
  assert.equal(after.trialCount, 0, 'подтверждение не запускает агента');
  assert.deepEqual(accepted.sheetLines, after.sheetLines, 'ответ инструмента несёт весь лист');
  // Своих слов инструмент не просит: ожидание меняется только в библиотеке сценариев.
  assert.deepEqual(selects, []); assert.deepEqual(editorCalls, []);

  // Схема инструмента по-прежнему принимает только id: согласие приходит только из диалога Pi.
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
test('headless model tools prepare and edit only; approvals and human assessments are not callable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-extension-'));
  const { tools, shutdown, command } = registered();
  const ctx = { cwd: directory, model: undefined, mode: 'print', hasUI: false } as ExtensionContext;
  const updates: string[] = [];
  try {
    assert.deepEqual([...tools.keys()], ['agent_lab_build', 'agent_lab_inspect', 'agent_lab_status', 'agent_lab_scenarios', 'agent_lab_edit_card', 'agent_lab_edit_behavior', 'agent_lab_edit_group', 'agent_lab_add_variant', 'agent_lab_resolve', 'agent_lab_merge_groups', 'agent_lab_split_group', 'agent_lab_remove_card', 'agent_lab_assess_cards', 'agent_lab_resume_preparation', 'agent_lab_accept_set', 'agent_lab_set_budget', 'agent_lab_edit', 'agent_lab_accept', 'agent_lab_repeat', 'agent_lab_run', 'agent_lab_suite', 'agent_lab_connection', 'agent_lab_reassess', 'agent_lab_review', 'agent_lab_agree']);
    const report = output(await tools.get('agent_lab_build')!.execute('build-1', { mode: 'demo' }, undefined,
      value => { updates.push(JSON.stringify(value)); }, ctx));
    assert.equal(report.phase, 'review'); assert.equal(report.workflow, 'evaluate');
    assert.equal(report.reviewMode, null); assert.equal(report.trialCount, 0);
    assert.equal(report.comparison, undefined); assert.equal(report.scenarioCount, 0, 'the library waits for the owner to accept variants');
    assert.ok(updates.length >= 1); assert.equal(report.nextStep, undefined, 'a draft has no result yet, so no «Дальше» line');
    const evidence = JSON.parse(await readFile(report.artifacts.evidence, 'utf8'));
    assert.equal(evidence.settings.repeats, 2); assert.equal(evidence.trials.length, 0);
    assert.equal(evidence.controlConsumedAt, null);
    assert.equal(report.artifacts.agent, undefined, 'an external agent is not exported as an AgentSpec');
    const inspect = output(await tools.get('agent_lab_inspect')!.execute('inspect-1', { id: report.id }, undefined, undefined, ctx));
    assert.equal(inspect.draftHash, report.draftHash);
    const edited = output(await tools.get('agent_lab_edit')!.execute('edit-1', { id: report.id, expectedHash: report.draftHash, patch: { settings: { maxTurns: 4 } } }, undefined, undefined, ctx));
    assert.notEqual(edited.draftHash, report.draftHash); assert.equal(edited.reviewMode, null); assert.equal(edited.trialCount, 0);
    await assert.rejects(tools.get('agent_lab_edit')!.execute('edit-cards', { id: report.id, expectedHash: edited.draftHash, patch: { scenarios: [] } }, undefined, undefined, ctx), /scenarios/,
      'situations change only in the scenario library');
    await assert.rejects(tools.get('agent_lab_edit')!.execute('edit-stale', { id: report.id, expectedHash: report.draftHash, patch: { settings: { repeats: 2 } } }, undefined, undefined, ctx), /изменился/);
    await assert.rejects(tools.get('agent_lab_edit')!.execute('edit-approval', { id: report.id, expectedHash: edited.draftHash, patch: { approved: true, reviewMode: 'human' } }, undefined, undefined, ctx));
    await assert.rejects(command(report.id, ctx as ExtensionCommandContext), /native Pi terminal/);
    const unchanged = JSON.parse(await readFile(report.artifacts.evidence, 'utf8'));
    assert.equal(unchanged.reviewMode, null); assert.equal(unchanged.phase, 'review');
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
    assert.deepEqual([...loaded.extensions[0]!.tools.keys()], ['agent_lab_build', 'agent_lab_inspect', 'agent_lab_status', 'agent_lab_scenarios', 'agent_lab_edit_card', 'agent_lab_edit_behavior', 'agent_lab_edit_group', 'agent_lab_add_variant', 'agent_lab_resolve', 'agent_lab_merge_groups', 'agent_lab_split_group', 'agent_lab_remove_card', 'agent_lab_assess_cards', 'agent_lab_resume_preparation', 'agent_lab_accept_set', 'agent_lab_set_budget', 'agent_lab_edit', 'agent_lab_accept', 'agent_lab_repeat', 'agent_lab_run', 'agent_lab_suite', 'agent_lab_connection', 'agent_lab_reassess', 'agent_lab_review', 'agent_lab_agree']);
    assert.ok(loaded.extensions[0]!.commands.has('agent-lab'));
    assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
    const skills = loader.getSkills();
    assert.deepEqual(skills.diagnostics, []); assert.equal(skills.skills.length, 1);
    assert.equal(skills.skills[0]!.name, 'agent-builder');
    const protocol = await readFile(skills.skills[0]!.filePath, 'utf8');
    assert.match(protocol, /agent_lab_build|agent_lab_inspect/); assert.doesNotMatch(protocol, /https?:\/\//);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
