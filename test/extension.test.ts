import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, access, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { DefaultResourceLoader, initTheme, SettingsManager, type ExtensionContext, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, type Component } from '@earendil-works/pi-tui';
import { REVIEW_DONE } from '../extensions/judge-review.ts';
import { demoInput, demoTarget } from '../src/demo.js';
import { ExperimentLab, draftHash } from '../src/experiment.js';
import { spawn, spawnSync } from 'node:child_process';
import { createInputSchema, goalAttainment } from '../src/contracts.js';
import { ExperimentStore } from '../src/store.js';
import { buildResultView } from '../src/result-view.js';
import { chatBlock, fitRows, MAX_WIDTH, plainText, resultScreen } from '../src/result-text.js';
import { markTargets, primaryMetricId } from '../src/outcomes.js';
import { demoEvaluateRecord, legacyDemoRuntime, legacyDraft } from './helpers/demo-record.js';
import { libraryHash } from '../src/scenario-library.js';
import { CLOSE, KEY, legacyDraftIn, noticeOf, output, registered, renderContext, workspaceSession } from './helpers/pi-session.js';

test('the chat guidance and the shipped skill name only registered tools; the owner answers a situation\'s question through its own tool', async () => {
  const { tools, beforeAgentStart } = registered();
  const previous = process.env.AGENT_LAB_SESSION;
  process.env.AGENT_LAB_SESSION = '1';
  try {
    const prompt = (await beforeAgentStart({ systemPrompt: '' }, { ui: {} } as unknown as ExtensionContext))!.systemPrompt;
    const skill = await readFile(new URL('../skills/agent-builder/SKILL.md', import.meta.url), 'utf8');
    for (const [where, text] of [['guidance', prompt], ['skill', skill]] as const) {
      const named = [...new Set(text.match(/agent_lab_[a-z_]+/g) ?? [])];
      assert.ok(named.includes('agent_lab_card_answer'), `${where}: the owner's answer to a situation's question goes through its own tool`);
      for (const name of named) assert.ok(tools.has(name), `${where}: ${name} is named but not registered`);
    }
    assert.doesNotMatch(prompt, /operation resolve/);
  } finally { if (previous === undefined) delete process.env.AGENT_LAB_SESSION; else process.env.AGENT_LAB_SESSION = previous; }
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
  const asked: { title: string; options: string[] }[] = [];
  const ctx = { cwd: directory, mode: 'tui', hasUI: true, model: { provider: 'fixture', id: 'fixture' }, ui: {
    // Scripted consent: the first answer of each native question — «Собрать ситуации», then «Запустить».
    select: async (title: string, options: string[]) => { asked.push({ title, options }); return options[0]; },
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
  assert.deepEqual(result.validation, { sourceDialogues: 300, usable: 300, promised: 15 });
  // One native question with Russian answers: what is read, how many situations at most, the spending ceiling.
  const [consent] = asked;
  assert.deepEqual(consent!.options, ['Собрать ситуации', 'Не сейчас']);
  assert.match(consent!.title, /^Собрать 15 ситуаций из логов\?\n\nВ логах 300 разговоров, подходят 300\. Ситуаций будет не больше 15/);
  assert.match(consent!.title, /не больше 385 вызовов модели/, 'the spending question names the limit the run will be saved with');
  assert.doesNotMatch(consent!.title, /validation set|outcome-blind/i, 'the owner is asked in plain words');
  await tools.get('agent_lab_run')!.execute('run-validation', { id: result.id, expectedHash: result.draftHash }, undefined, undefined, ctx);
  const launch = asked[1];
  assert.deepEqual(launch!.options, ['Запустить', 'Не сейчас'], 'one native dialog with Russian answers');
  assert.match(launch!.title, /^Подтвердить ожидания и запустить\?\n/);
  assert.match(launch!.title, /Что агент должен сделать: 15 ситуаций\. Номер правила — порядок в ваших материалах\./);
  assert.equal(startOptions?.parallel, 8, 'an external agent is checked on several dialogues at once');
  assert.equal(startOptions?.requireAccepted, true, 'the Pi run starts only on confirmed expectations');
  assert.equal(acceptedHash, result.draftHash, 'the same dialogue confirmed the shown version');
  assert.match(launch!.title, /Клиента играет Lab: на уточнения агента он отвечает только фактами из лога\./);
  assert.equal(launch!.title.match(/Ситуация:/g)?.length, 15);
  assert.doesNotMatch(launch!.title, /\/agent-lab|Версия ожиданий|[a-f0-9]{12}/, 'the owner reads the expectations, never a pointer or a hash');
  assert.ok(launch!.title.endsWith('Запуск подтверждает ожидания ситуаций выше. Оценки судьи вы не проверяли.'));
});

test('conversation runs only the confirmed plan, then saves and loads the same case without claiming human review', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-conversation-'));
  const { tools, shutdown } = registered();
  t.after(async () => { await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const plans: string[] = [];
  let consent = false;
  const ctx = { cwd: directory, mode: 'tui', hasUI: true,
    ui: { select: async (plan: string) => { plans.push(plan); return consent ? 'Запустить' : 'Не сейчас'; } } } as unknown as ExtensionContext;
  const call = async (name: string, params: unknown) => output(await tools.get(name)!.execute('fixture', params, undefined, undefined, ctx));
  // The owner accepted one ready situation of the built-in example in its first-format library; the run is confirmed separately.
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
    { ...ctx, hasUI: false, mode: 'print' } as unknown as ExtensionContext), /интерактивном терминале Pi/);
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
  // A first-format card is judged through its projection: each required checkpoint is an expectation with its own verdict.
  assert.doesNotMatch(proofText, /КОНТРОЛЬНЫЕ ТОЧКИ/);
  assert.match(proofText, /ОЦЕНКИ\n(?:PASS|FAIL) \[ask_once\] Если номер уже сообщён, не запрашивать его повторно/);
  assert.match(proofText, /ОЦЕНКИ\n(?:PASS|FAIL|UNKNOWN) \[[^\]]+\].*события: #\d+/);
  // The set was accepted earlier, so the dialog only starts the run: the plan it shows is what «Запустить» runs.
  assert.match(plans[1]!, /^Запустить прогон\?\n\n1 ситуация · 1 разговор: клиента играет Lab, ответы агента оценивает судья\./);
  assert.match(plans[1]!, /Учебный пример: без модели и оплаты\./);
  assert.doesNotMatch(plans[1]!, /Подтвердить ожидания|утвердит/, 'nothing is accepted again');
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
  const shown: { title: string; options: string[] }[] = [];
  let consent = false;
  const launches: string[] = [];
  const ctx = { cwd: directory, mode: 'tui', hasUI: true, ui: {
    // One native question with Russian answers: the definition under the question, «Подтвердить» or «Не сейчас».
    select: async (title: string, options: string[]) => {
      if (options.includes('Запустить')) { launches.push(title); return 'Запустить'; }
      shown.push({ title, options }); return consent ? options[0] : options[1];
    },
  } } as unknown as ExtensionContext;
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
  assert.deepEqual(shown[0]!.options, ['Подтвердить', 'Не сейчас']);
  assert.match(shown[0]!.title, /^Этот тест действительно проверяет нужное поведение\?\n\nТест\nСитуация\n/);
  assert.match(shown[0]!.title, /Наблюдение\n  ответ агента$/m);
  // The confirmation is bound to the exact version by its hash, which the start checks; the owner reads the definition, never the hash.
  assert.doesNotMatch(shown[0]!.title, /Версия|[a-f0-9]{12}/);
  assert.ok(shown[0]!.title.includes(draft.scenarios[0].user.opening.trimEnd().replace('\n', '\n  ')));
  assert.ok(shown[0]!.title.includes(draft.scenarios[0].successCriteria.replace('\n', '\n  ')));

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
  assert.match(shown.at(-1)!.title, /\(всего ходов в разговоре: 5\)/, 'the confirmation shows the edited version');
  assert.equal((await call('agent_lab_inspect', { id: built.id })).trialCount, 0);
  const run = await call('agent_lab_run', { id: built.id, expectedHash: edited.draftHash });
  assert.match(launches[0]!, /^Запустить прогон\?/, 'confirmed expectations are not asked again with the run');
  assert.equal(run.phase, 'results_review');
  assert.equal(run.acceptedDraftHash, edited.draftHash, 'explicit execution preserves acceptance metadata');
});

test('Pi connects a new request, conversational correction, reviewed run, evidence discussion and repeat without UI JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-journey-fixture-'));
  const opened: string[] = [];
  const { tools, shutdown, command, contexts, userMessages } = registered(() => {
    assert.equal(existsSync(join(directory, '.agent-lab', '.lock')), false, 'conversation starts only after the workspace releases its writer lock');
  }, { openReport: async path => { opened.push(path); } });
  const session = workspaceSession(directory);
  const ctx = session.ctx;
  const errors: string[] = []; const editorCommands: string[] = [];
  let editorText = '';
  Object.assign(ctx.ui, {
    getEditorText: () => editorText,
    setEditorText: (text: string) => { editorText = text; editorCommands.push(text); },
    notify: (message: string, type: string) => { if (type === 'error') errors.push(message); },
  });
  const call = async (name: string, params: object) => output(await tools.get(name)!.execute(name, params, undefined, undefined, ctx));
  try {
    await command('/fixture/agent', ctx);
    assert.equal(userMessages[0], 'Проверь агента в /fixture/agent'); assert.equal(contexts[0]!.display, false);
    // The outer Pi model's actions are scripted here; real tools and the native workspace execute every state transition.
    const built = await call('agent_lab_build', { mode: 'demo' });
    assert.equal(built.phase, 'review', built.error ?? 'draft not ready');
    assert.equal(built.trialCount, 0); assert.equal(built.reviewMode, null); assert.equal(editorCommands.length, 0);
    // The workspace opens a draft on its situations with the first one selected: «a» asks Lab about it in one line.
    session.state.steps = [['a']]; session.state.words = 'Одной попытки на ситуацию достаточно.';
    await command(built.id, ctx); assert.equal(userMessages.at(-1), session.state.words);
    assert.match(session.inputCalls.at(-1)!, /^Спросить Lab про ситуацию 1 «.+»$/);
    const selected = JSON.parse(contexts.at(-1)!.content); assert.equal(selected.experimentId, built.id); assert.equal(selected.situation, 1, JSON.stringify(selected));
    editorText = 'Ещё пишу уточнение';
    const draft = await call('agent_lab_inspect', { id: built.id });
    assert.equal(editorText, 'Ещё пишу уточнение', 'tool must preserve unfinished user input'); editorText = '';
    const edited = await call('agent_lab_edit', { id: built.id, expectedHash: draft.draftHash, patch: { settings: { repeats: 1 } } });
    assert.notEqual(edited.draftHash, draft.draftHash); assert.equal(edited.trialCount, 0);
    // → the plan, Enter: one dialog accepts the ready situation and starts the run; its result opens by itself.
    // The run hands its lease back after its result is recorded; the conversation starts only once it is free.
    const free = () => !existsSync(join(directory, '.agent-lab', '.lock'));
    session.state.steps = [[KEY.right, KEY.enter], { until: 'Точность агента', ready: free, keys: [KEY.enter, 'a'] }];
    session.state.words = 'Почему этот диалог провалился и что нужно исправить?';
    await command(built.id, ctx); assert.equal(userMessages.at(-1), session.state.words);
    assert.match(session.selectCalls.at(-1)!.title, /^Принять 1 ситуацию и запустить\?/);
    const discussion = JSON.parse(contexts.at(-1)!.content); assert.equal(discussion.experimentId, built.id); assert.ok(discussion.trialId);
    const evidence = await call('agent_lab_inspect', { id: built.id, trialId: discussion.trialId });
    assert.ok(evidence.events.length);
    assert.ok(evidence.assessments.some((a: { metricId: string; result: string }) => a.metricId === 'e1' && a.result === 'fail'), 'the agent asked again for the number it was given (duty e1)');
    // «1» — «да, судья прав» — on the one failure: the queue is answered, so the check of the judge ends by itself.
    session.state.steps = [[KEY.enter, '1'], CLOSE];
    await command(built.id, ctx);
    assert.ok(noticeOf(session.screens.at(-1)!).endsWith(REVIEW_DONE), session.screens.at(-1));
    const reviewed = await call('agent_lab_inspect', { id: built.id, export: true });
    assert.equal(reviewed.phase, 'complete');
    // One answer lands on every judgment that decided the situation: here on each failed expectation.
    const mark = reviewed.humanReviews[0];
    const marked = await call('agent_lab_inspect', { id: built.id, trialId: mark.trialId });
    const markedCard = reviewed.scenarios.find((card: { id: string }) => card.id === marked.scenarioId);
    assert.deepEqual(reviewed.humanReviews.map((each: { metricId: string }) => each.metricId), markTargets(markedCard, marked)!.metricIds);
    for (const each of reviewed.humanReviews) {
      assert.equal(each.source, 'quick');
      assert.equal(each.countingRules, 'all-expectations-v1', 'stamped with the rule of its card');
      assert.equal(each.verdict, marked.assessments.find((a: { metricId: string }) => a.metricId === each.metricId).result);
    }
    assert.equal(mark.note, 'Быстрая отметка: согласен с судьёй.');
    assert.equal(typeof mark.durationMs, 'number');
    const original = await call('agent_lab_inspect', { id: built.id, trialId: discussion.trialId }); assert.deepEqual(original, evidence);
    const repeated = await call('agent_lab_repeat', { id: built.id });
    assert.equal(repeated.positiveControlScenarioIds, undefined);
    assert.equal(repeated.parentRunId, built.id); assert.equal(repeated.phase, 'review'); assert.equal(repeated.trialCount, 0); assert.equal(repeated.reviewMode, null);
    assert.equal(editorCommands.length, 0);
    // The fix is a new version of the agent: the corrected module no longer asks for a number it already has.
    await call('agent_lab_edit', { id: repeated.id, expectedHash: repeated.draftHash, patch: { target: demoTarget(true), targetVersion: 'fixture-fixed' } });
    // From the finished run: Esc to the runs, «2» runs the set again — the repeat; its result opens in «Прогоны».
    session.state.steps = [[KEY.escape, '2'], { until: 'Точность агента: 100%', ready: free, keys: [KEY.enter, 'a'] }];
    session.state.words = 'Покажи конкретное исправление до и после.';
    await command(built.id, ctx);
    assert.equal(userMessages.at(-1), session.state.words);
    const pairDiscussion = JSON.parse(contexts.at(-1)!.content);
    assert.deepEqual(pairDiscussion.comparisonSource, { kind: 'parent', beforeId: built.id, afterId: repeated.id });
    assert.equal(pairDiscussion.comparedPair.beforeTrialId, discussion.trialId);
    assert.equal(pairDiscussion.comparedPair.afterTrialId, pairDiscussion.trialId);
    // «1» on the repeat: the report for the customer, with the comparison, saved and opened.
    session.state.steps = [['1'], CLOSE];
    await command(repeated.id, ctx);
    assert.equal(opened.length, 1);
    assert.match(noticeOf(session.screens.at(-1)!), /^Отчёт для заказчика открыт в браузере: /);
    assert.match(await readFile(opened[0]!, 'utf8'), /Оценка выросла у 1, снизилась у 0/);
    assert.deepEqual(errors, []); assert.equal(session.state.steps.length, 0);
  } finally { await shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('the built-in example runs from the workspace in one dialog, and the owner\'s answer about the judge is kept apart from the judge', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-human-ui-fixture-'));
  const { tools, shutdown, command } = registered();
  const session = workspaceSession(directory);
  try {
    const report = output(await tools.get('agent_lab_build')!.execute('prepare', { mode: 'demo' }, undefined, undefined, session.ctx));
    // The owner asked for one attempt; the ready situation is accepted in the dialog that starts the run.
    const seed = new ExperimentLab(join(directory, '.agent-lab'));
    await seed.init();
    try { await seed.updateDraft(report.id, draftHash(await seed.get(report.id)), { settings: { repeats: 1 } }); } finally { await seed.close(); }
    // The run dialog is declined once, then accepted; «2» on the failure is «нет, судья ошибся» — about every failed duty — with the owner's reason.
    let launches = 0;
    session.state.choice = (_title, options) => !options.includes('Запустить') ? options.at(-1) : ++launches === 1 ? 'Не сейчас' : options[0];
    session.state.reason = 'Human fixture: disagreement with the model; see #1.';
    session.state.steps = [[KEY.right, KEY.enter], [KEY.enter], { until: 'Точность агента', keys: [KEY.enter, '2'] }, CLOSE];
    await command(report.id, session.ctx);
    const plans = session.selectCalls.filter(item => item.options.includes('Запустить'));
    assert.equal(plans.length, 2);
    for (const plan of plans) assert.match(plan.title, /^Принять 1 ситуацию и запустить\?/);
    assert.ok(!session.selectCalls.some(item => /результат/i.test(item.title)), 'nothing asks to confirm the results');
    const exported = output(await tools.get('agent_lab_inspect')!.execute('export-reviewed', { id: report.id, export: true }, undefined, undefined, session.ctx));
    const evidence = JSON.parse(await readFile(exported.artifacts.evidence, 'utf8'));
    // The run dialog accepted the situation; the owner's answer about the judge is recorded apart from the judge's own.
    assert.equal(evidence.reviewMode, 'expectations');
    assert.equal(evidence.trials.length, 1);
    assert.ok(evidence.humanReviews.length >= 1);
    for (const mark of evidence.humanReviews) {
      assert.deepEqual([mark.source, mark.judgeVerdict, mark.verdict], ['quick', 'fail', 'pass']);
      assert.match(mark.note, /fixture/);
    }
    // The only answer the queue waited for is given, so the check of the judge ended by itself.
    assert.equal(evidence.phase, 'complete'); assert.ok(evidence.resultsReviewedAt); assert.ok(evidence.resultsReviewHash);
    assert.ok(evidence.trials[0].assessments.some((a: { result: string }) => a.result === 'fail'), 'the judge\'s own assessments remain as recorded');
    const trial = output(await tools.get('agent_lab_inspect')!.execute('inspect-trial', { id: report.id, trialId: evidence.trials[0].id }, undefined, undefined, session.ctx));
    assert.deepEqual(trial.checks, evidence.trials[0].checks);
    assert.deepEqual(trial.assessments, evidence.trials[0].assessments);
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
    assert.equal(report.scenarioCount, 0, 'nothing is runnable before the owner accepts a situation');
    assert.equal(report.comparison, undefined); assert.equal(report.view, undefined, 'a draft has no result yet');
    // The owner accepts the ready situation; the draft then carries it as a situation from a real dialogue.
    const lab = new ExperimentLab(join(directory, '.agent-lab'));
    await lab.init();
    try {
      const { library } = await lab.cardContext(report.id);
      // The sample orders situations by the content hash, not by the log: the ready one is the card of the dialogue that names the number at once.
      const ready = library.cards.find(card => card.origin.kind === 'dialogue' && card.origin.dialogueId === 'known')!;
      await lab.acceptCards(report.id, libraryHash(library), [ready.id]);
    } finally { await lab.close(); }
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
    const rendered = inspect.renderResult!(result as never, { expanded: false, isPartial: false }, theme as never, renderContext()) as unknown as Component;
    const shown = rendered.render(MAX_WIDTH).map(line => stripTerminalSequences(line).trimEnd());
    // The block hangs under the branch sign of its action: the same number, then the same trust line, as the result screen.
    assert.equal(shown[0], `  └${payload.resultLines[0]}`, 'the chat and the board open with the same number');
    assert.equal(shown[1]!.trim(), payload.resultLines[1]!.trim());
    const block = fitRows(chatBlock(payload.view, { expanded: false }), MAX_WIDTH).filter(line => line.text.trim());
    assert.ok(shown.filter(line => line.trim()).length > block.length, 'the rows of the block, then the hint for ctrl+o');
    assert.ok(!shown.join('\n').includes('"resultLines"'), 'the block is drawn, not the raw payload');
    if (payload.view.failures.length) assert.ok(shown.join(' ').includes('«покажи ошибку 1»'), shown.join('\n'));
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
      { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never, renderContext()) as unknown as Component;
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

test('в чате agent_lab_accept показывает лист ожиданий и даёт подтвердить все или не подтверждать', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-chat-accept-'));
  const { tools, shutdown } = registered();
  t.after(async () => { await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const asked: { title: string; options: string[] }[] = [];
  const editorCalls: { title: string; prefill: string }[] = [];
  const notices: { message: string; type: string }[] = [];
  let answers: boolean[] = [];
  const ctx = { cwd: directory, mode: 'tui', hasUI: true, ui: {
    select: async (title: string, options: string[]) => { asked.push({ title, options }); return answers[asked.length - 1] ? options[0] : options[1]; },
    editor: async (title: string, prefill: string) => { editorCalls.push({ title, prefill }); return undefined; },
    notify: (message: string, type: string) => { notices.push({ message, type }); },
  } } as unknown as ExtensionContext;
  const call = async (name: string, params: unknown) => output(await tools.get(name)!.execute('chat', params, undefined, undefined, ctx));
  // Two old-format cards judged by the goal rubric, as a repeat of an old run leaves them.
  const built = await legacyDraftIn(directory, { count: 2 }, record => { for (const scenario of record.scenarios) scenario.metrics = [goalAttainment]; });
  const prepared = await call('agent_lab_inspect', { id: built.id });
  assert.ok(Array.isArray(prepared.sheetLines) && prepared.sheetLines.length, 'inspect черновика несёт весь лист');
  assert.match(prepared.sheetLines.join('\n'), /Что агент должен сделать: 2 ситуации\./);

  // Declined: nothing is written, and the run will not start until they are confirmed.
  answers = [false];
  const declined = await call('agent_lab_accept', { id: built.id });
  assert.equal(declined.accepted, false);
  assert.equal(declined.message, 'Ожидания не подтверждены. Прогон не начнётся, пока они не подтверждены.');
  assert.deepEqual(asked[0]!.options, ['Подтвердить все', 'Не сейчас'], 'one native question with Russian answers');
  assert.match(asked[0]!.title, /^Подтвердить ожидания: 2 ситуации\?\n\nЧто агент должен сделать: 2 ситуации\./);
  assert.doesNotMatch(asked[0]!.title, /\/agent-lab|Версия ожиданий|[a-f0-9]{12}/);
  assert.equal((await call('agent_lab_inspect', { id: built.id })).acceptedDraftHash, undefined);

  // The whole sheet is confirmed with one answer.
  asked.length = 0; answers = [true];
  const accepted = await call('agent_lab_accept', { id: built.id });
  assert.equal(asked.length, 1);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.message, 'Ожидания подтверждены. Можно запускать.');
  const after = await call('agent_lab_inspect', { id: built.id });
  assert.equal(after.acceptedDraftHash, after.draftHash);
  assert.equal(after.trialCount, 0, 'подтверждение не запускает агента');
  assert.deepEqual(accepted.sheetLines, after.sheetLines, 'ответ инструмента несёт весь лист');
  // The tool asks for no words: an expectation changes only in the scenario library.
  assert.deepEqual(editorCalls, []);

  // The schema still takes only the id: the consent comes from the native dialog alone.
  const parameters = tools.get('agent_lab_accept')!.parameters as { properties: Record<string, unknown>; required?: string[] };
  assert.deepEqual(Object.keys(parameters.properties), ['id']);
  answers = [true, true];
  const result = await tools.get('agent_lab_accept')!.execute('chat-row', { id: built.id }, undefined, undefined, ctx);
  const rendered = tools.get('agent_lab_accept')!.renderResult!(result as never, { expanded: false, isPartial: false }, { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never,
    renderContext()) as unknown as Component;
  const shown = stripTerminalSequences(rendered.render(100).join('\n'));
  assert.match(shown, /Ожидания подтверждены: 2 ситуации; агент не запускался — скажите «запусти»\./);
  assert.doesNotMatch(shown, /[{}"]|[a-f0-9]{12}/, 'the row is words, never the payload');
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

/** Every tool the extension registers, in order: preparing and reading, the situation commands, the draft, the run and the results. */
const TOOL_NAMES = ['agent_lab_build', 'agent_lab_inspect', 'agent_lab_status', 'agent_lab_cards', 'agent_lab_card_answer', 'agent_lab_resume_preparation', 'agent_lab_card_check',
  'agent_lab_card_fact', 'agent_lab_card_expectation', 'agent_lab_card_client', 'agent_lab_card_similar', 'agent_lab_card_remove', 'agent_lab_edit', 'agent_lab_accept',
  'agent_lab_repeat', 'agent_lab_run', 'agent_lab_suite', 'agent_lab_connection', 'agent_lab_reassess', 'agent_lab_review', 'agent_lab_agree'];

test('headless model tools prepare and edit only; approvals and human assessments are not callable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-extension-'));
  const { tools, shutdown, command } = registered();
  const ctx = { cwd: directory, model: undefined, mode: 'print', hasUI: false } as ExtensionContext;
  const updates: string[] = [];
  try {
    assert.deepEqual([...tools.keys()], TOOL_NAMES);
    const report = output(await tools.get('agent_lab_build')!.execute('build-1', { mode: 'demo' }, undefined,
      value => { updates.push(JSON.stringify(value)); }, ctx));
    assert.equal(report.phase, 'review'); assert.equal(report.workflow, 'evaluate');
    assert.equal(report.reviewMode, null); assert.equal(report.trialCount, 0);
    assert.equal(report.comparison, undefined); assert.equal(report.scenarioCount, 0, 'the situations wait for the owner to accept them');
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
    await assert.rejects(command(report.id, ctx as ExtensionCommandContext), /интерактивном терминале Pi/);
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
    assert.deepEqual([...loaded.extensions[0]!.tools.keys()], TOOL_NAMES);
    assert.ok(loaded.extensions[0]!.commands.has('agent-lab'));
    assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
    const skills = loader.getSkills();
    assert.deepEqual(skills.diagnostics, []); assert.equal(skills.skills.length, 1);
    assert.equal(skills.skills[0]!.name, 'agent-builder');
    const protocol = await readFile(skills.skills[0]!.filePath, 'utf8');
    assert.match(protocol, /agent_lab_build|agent_lab_inspect/); assert.doesNotMatch(protocol, /https?:\/\//);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
