import assert from 'node:assert/strict';
import { mkdtemp, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { DefaultResourceLoader, initTheme, SettingsManager, type ExtensionContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, type Component } from '@earendil-works/pi-tui';
import { REVIEW_DONE } from '../extensions/judge-review.ts';
import { TOOL } from '../extensions/steps.ts';
import { demoTarget } from '../src/demo.js';
import { ExperimentLab, draftHash } from '../src/experiment.js';
import { spawn, spawnSync } from 'node:child_process';
import { goalAttainment } from '../src/contracts.js';
import { ExperimentStore } from '../src/store.js';
import { buildResultView } from '../src/result-view.js';
import { chatBlock, fitRows, MAX_WIDTH, plainText, resultScreen } from '../src/result-text.js';
import { markTargets, primaryMetricId } from '../src/outcomes.js';
import { demoEvaluateRecord, legacyDemoRuntime, legacyDraft } from './helpers/demo-record.js';
import { CLOSE, KEY, legacyDraftIn, noticeOf, output, registered, renderContext, workspaceSession } from './helpers/pi-session.js';

/** The nine tools, in the order they are registered: preparing, the situations, the owner's decisions, the run, reading. */
const TOOL_NAMES = [TOOL.prepare, TOOL.cards, TOOL.edit, TOOL.decide, TOOL.run, TOOL.status, TOOL.results, TOOL.explain, TOOL.agree];
const tui = (cwd: string, pick: (title: string, options: string[]) => string | undefined = (_title, options) => options[0]) => ({ cwd, mode: 'tui', hasUI: true,
  ui: { select: async (title: string, options: string[]) => pick(title, options), editor: async () => undefined, notify() {}, setStatus() {}, setWidget() {} } }) as unknown as ExtensionContext;
const headless = (cwd: string) => ({ cwd, hasUI: false, mode: 'print', model: undefined }) as ExtensionContext;

test('nine tools, each with a small closed schema: every value typed, and none takes settings, a consent, a hash, a verdict or a raw command', () => {
  const { tools } = registered();
  assert.deepEqual([...tools.keys()], TOOL_NAMES);
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
  let total = 0;
  for (const tool of tools.values()) {
    walk(tool.parameters, tool.name);
    const text = JSON.stringify(tool.parameters);
    total += text.length + tool.description.length;
    assert.ok(text.length < 5000, `${tool.name}: ${text.length} bytes of schema`);
    for (const forbidden of ['approved', 'expectedHash', 'draftHash', 'patch', 'settings', 'maxCalls', 'grant', 'authority', 'ownerWords', 'via', 'receipt',
      'verdict', 'judgeVerdict', 'quick', 'reviewMode', 'target', 'dialogues', 'command_json'])
      assert.ok(!text.includes(`"${forbidden}"`), `${tool.name} offers ${forbidden}`);
  }
  // What the model reads about all nine tools on every turn: a fraction of the 26K tokens of schemas the review found.
  assert.ok(total < 24_000, `${total} bytes of schemas and descriptions`);
});

test('the model sees the tools of the step the project is at, and Pi\'s own tools stay as they are', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-steps-'));
  const { tools, sessionStart, beforeAgentStart, active, shutdown } = registered();
  try {
    await sessionStart({}, headless(cwd));
    assert.deepEqual(active.names, ['read', 'bash', 'edit', 'write', TOOL.status, TOOL.prepare], 'nothing yet: what exists, and preparing');
    // Preparing moves the project to its situations: the tool that did it hands the model the next step's tools.
    await tools.get(TOOL.prepare)!.execute('demo', { demo: true }, undefined, undefined, headless(cwd));
    assert.deepEqual(active.names, ['read', 'bash', 'edit', 'write', TOOL.status, TOOL.prepare, TOOL.cards, TOOL.edit, TOOL.decide, TOOL.run]);
    // A result recorded elsewhere (the workspace, another session) is picked up with the owner's next message.
    const demo = await demoEvaluateRecord('agent-lab-steps-run-');
    await demo.lab.close();
    const store = new ExperimentStore(join(cwd, '.agent-lab'));
    await store.init();
    try { await store.save(demo.record); } finally { await store.close(); }
    active.names = [...active.names.filter(name => !name.startsWith('agent_lab_')), 'grep'];
    await beforeAgentStart({ systemPrompt: '' }, headless(cwd));
    assert.deepEqual(active.names, ['read', 'bash', 'edit', 'write', 'grep',
      TOOL.status, TOOL.prepare, TOOL.cards, TOOL.edit, TOOL.decide, TOOL.run, TOOL.results, TOOL.explain, TOOL.agree], 'a result: reading it, explaining it, the owner\'s word on the judge');
    await rm(demo.directory, { recursive: true, force: true });
  } finally { await shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

test('one instruction source: an Agent Lab session gets the skill\'s body, which names only registered tools', async () => {
  const { tools, beforeAgentStart } = registered();
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-guide-'));
  const previous = process.env.AGENT_LAB_SESSION;
  process.env.AGENT_LAB_SESSION = '1';
  try {
    const prompt = (await beforeAgentStart({ systemPrompt: 'BASE' }, { cwd, ui: {} } as unknown as ExtensionContext))!.systemPrompt;
    const skill = await readFile(new URL('../skills/agent-builder/SKILL.md', import.meta.url), 'utf8');
    const body = skill.slice(skill.indexOf('\n---', 3) + 4).trim();
    assert.equal(prompt, `BASE\n\n${body}`, 'the system prompt gets the skill without its frontmatter, and nothing else');
    const named = [...new Set(skill.match(/agent_lab_[a-z_]+/g) ?? [])];
    assert.ok(named.length >= 2);
    for (const name of named) assert.ok(tools.has(name), `the skill names ${name}, which is not registered`);
    assert.ok(skill.length < 8000, `${skill.length} characters: the skill says only what the tools cannot`);
    for (const tool of tools.values()) assert.ok(!skill.includes(tool.description.slice(0, 60)), `${tool.name}: its description is not repeated in the skill`);
  } finally {
    if (previous === undefined) delete process.env.AGENT_LAB_SESSION; else process.env.AGENT_LAB_SESSION = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});

test('the built-in example from the chat: prepared, its question decided, run in one dialog, then the result, one situation explained, the owner\'s word on the judge, the report and a suite', { timeout: 60000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-demo-chat-'));
  const { tools, shutdown } = registered();
  const asked: { title: string; options: string[] }[] = [];
  const ctx = tui(cwd, (title, options) => { asked.push({ title, options }); return options[0]; });
  const call = async (name: string, params: unknown) => tools.get(name)!.execute(name, params, undefined, undefined, ctx);
  try {
    const prepared = output(await call(TOOL.prepare, { demo: true }));
    assert.equal(prepared.counts, '2 ситуации: 1 готова · 1 ждёт вашего ответа');
    const store = new ExperimentStore(join(cwd, '.agent-lab'));
    assert.equal((await store.get(prepared.run)).phase, 'review');
    const waiting = prepared.situations.find((item: { status: string }) => item.status === 'needs_owner');
    assert.equal(asked.length, 0, 'the teaching example spends nothing: no consent is asked');
    const decided = output(await call(TOOL.decide, { decision: waiting.decision, choice: 1 }));
    assert.equal(decided.decided, true);
    const run = await call(TOOL.run, {});
    assert.match(asked.at(-1)!.title, /^Принять 2 ситуации и запустить\?\n\n2 ситуации · 4 разговора: клиента играет Lab, ответы агента оценивает судья\.\nАгент: /);
    assert.match(asked.at(-1)!.title, /Учебный пример: без модели и оплаты\./);
    assert.equal((run.details as { kind?: string }).kind, 'agent-lab/verdict');
    const result = output(run);
    assert.equal(result.run, prepared.run); assert.ok(result.lines.length > 2);
    const finished = await store.get(prepared.run);
    assert.deepEqual([finished.phase, finished.reviewMode, finished.trials.length], ['results_review', 'expectations', 4]);
    assert.match(finished.limitations.join(' '), /Владелец подтвердил ожидания ситуаций перед запуском\. Определения карточек и оценки судьи человеком не проверялись\./);
    const results = output(await call(TOOL.results, {}));
    assert.deepEqual(results.lines, result.lines, 'the result reads the same when asked for again');
    assert.ok(results.failures.length > 0, 'the teaching agent asks for the number it was given');
    const [failure] = results.failures;
    const explained = output(await call(TOOL.explain, { situation: failure.situation }));
    assert.equal(explained.title, failure.title); assert.ok(explained.expected); assert.ok(explained.conversation.length >= 2);
    const marked = output(await call(TOOL.agree, { situation: failure.situation }));
    assert.equal(marked.answer, 'agree');
    assert.ok((await store.get(prepared.run)).humanReviews.every(review => review.source === 'quick' && review.verdict === 'fail'));
    const report = output(await call(TOOL.results, { report: true }));
    assert.match(await readFile(report.report, 'utf8'), /<!doctype html>/);
    const suite = output(await call(TOOL.results, { save: '.evals/regression.json' }));
    assert.equal(suite.suite, join(cwd, '.evals', 'regression.json'));
    const loaded = output(await call(TOOL.prepare, { suite: '.evals/regression.json' }));
    const draft = await store.get(loaded.run);
    assert.deepEqual([draft.phase, draft.trials.length, draft.reviewMode, draft.usage.calls], ['review', 0, null, 0], 'a loaded suite is a fresh draft: nothing ran, nothing was spent');
    await assert.rejects(access(join(cwd, '.agent-lab', '.lock')));
  } finally { await shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

test('headless, reads and the free teaching example work; everything the owner decides refuses and writes nothing', { timeout: 60000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-headless-'));
  const { tools, shutdown, command } = registered();
  const ctx = headless(cwd);
  const call = async (name: string, params: unknown) => tools.get(name)!.execute(name, params, undefined, undefined, ctx);
  try {
    const prepared = output(await call(TOOL.prepare, { demo: true }));
    const store = new ExperimentStore(join(cwd, '.agent-lab'));
    const before = JSON.stringify(await store.get(prepared.run));
    assert.equal(output(await call(TOOL.status, {})).runs[0].id, prepared.run);
    assert.equal(output(await call(TOOL.cards, { situation: 1 })).situation.number, 1);
    await assert.rejects(call(TOOL.run, {}), /интерактивном терминале Pi/);
    await assert.rejects(call(TOOL.run, { action: 'accept' }), /интерактивном терминале Pi/);
    const waiting = output(await call(TOOL.cards, {})).situations.find((item: { decision?: string }) => item.decision);
    await assert.rejects(call(TOOL.decide, { decision: waiting.decision, choice: 1 }), /интерактивном терминале Pi/);
    await assert.rejects(call(TOOL.edit, { situation: 1, change: { kind: 'fact', fact: 'f1', when: 'unknown' } }), /интерактивном терминале Pi/);
    await assert.rejects(call(TOOL.prepare, { task: 'Проверить агента', withoutLogs: true, rules: 'Отвечать по правилам возврата: номер терминала не спрашивать повторно.' }), /интерактивном терминале Pi/,
      'a paid preparation needs the owner\'s consent: headless it never starts');
    await assert.rejects(command(prepared.run, ctx as never), /интерактивном терминале Pi/);
    assert.equal(JSON.stringify(await store.get(prepared.run)), before, 'nothing was written');
    assert.equal((await store.list()).length, 1, 'no preparation was started');
    await assert.rejects(access(join(cwd, '.agent-lab', '.lock')));
  } finally { await shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

test('an interrupted preparation keeps what it made and releases the folder', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-extension-cancel-'));
  const { tools, shutdown } = registered();
  const controller = new AbortController();
  try {
    const result = output(await tools.get(TOOL.prepare)!.execute('prepare-cancel', { demo: true }, controller.signal,
      () => controller.abort(new Error('User cancelled')), headless(cwd)));
    const record = await new ExperimentStore(join(cwd, '.agent-lab')).get(result.run);
    assert.equal(record.trials.length, 0); assert.notEqual(record.phase, 'complete');
    assert.ok(result.prepared === false || result.interrupted === true, JSON.stringify(result));
    await assert.rejects(access(join(cwd, '.agent-lab', '.lock')));
  } finally { await shutdown(); await rm(cwd, { recursive: true, force: true }); }
});

test('the chat payload, its collapsed result and the CLI summary open with the same result block', { timeout: 60000 }, async () => {
  const demo = await demoEvaluateRecord('agent-lab-pi-view-');
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-pi-view-cwd-'));
  const { tools, shutdown } = registered();
  try {
    await demo.lab.close();
    const record = demo.record;
    const store = new ExperimentStore(join(cwd, '.agent-lab'));
    await store.init();
    try { await store.save(record); } finally { await store.close(); }
    const results = tools.get(TOOL.results)!;
    const result = await results.execute('results-view', { run: record.id }, undefined, undefined, headless(cwd));
    const payload = output(result);
    const view = buildResultView(record);
    // The payload carries the board's full result screen; «Дальше» is the chat line of the same view.
    assert.deepEqual(payload.lines, plainText(resultScreen(view, { surface: 'board', details: true }), MAX_WIDTH).split('\n'));
    assert.match(payload.next, /^Дальше: /);
    assert.deepEqual(payload.failures.map((item: { title: string }) => item.title), view.failures.map(item => item.title));
    assert.ok(!('view' in payload) && !('proofs' in payload), 'the model reads lines and numbers, never the whole view or the proofs');
    // The collapsed chat block is drawn from that view: it opens with the same number and trust line as the board.
    initTheme('dark', false);
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const rendered = results.renderResult!(result as never, { expanded: false, isPartial: false }, theme as never, renderContext()) as unknown as Component;
    const shown = rendered.render(MAX_WIDTH).map(line => stripTerminalSequences(line).trimEnd());
    assert.equal(shown[0], `  └${payload.lines[0]}`, 'the chat and the board open with the same number');
    assert.equal(shown[1]!.trim(), payload.lines[1]!.trim());
    const block = fitRows(chatBlock(view, { expanded: false }), MAX_WIDTH).filter(line => line.text.trim());
    assert.ok(shown.filter(line => line.trim()).length > block.length, 'the rows of the block, then the hint for ctrl+o');
    if (view.failures.length) assert.ok(shown.join(' ').includes('«покажи ошибку 1»'), shown.join('\n'));
    // The CLI summary prints the same screen: the same head, and every failure listed the same way.
    const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const child = spawn(process.execPath, [cli, 'summary', '--id', record.id, '--data-dir', join(cwd, '.agent-lab')]);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const code = await new Promise<number | null>(resolve => child.on('close', resolve));
    assert.equal(code, 0, stderr);
    const lines = stdout.split('\n');
    const head = (all: string[]) => all.slice(0, all.indexOf(''));
    assert.deepEqual(head(lines), head(payload.lines));
    const section = (all: string[], title: string) => { const at = all.indexOf(title); return at < 0 ? [] : all.slice(at, all.indexOf('', at)); };
    assert.deepEqual(section(lines, ' Все ошибки'), section(payload.lines, ' Все ошибки'));
    assert.equal(section(lines, ' Все ошибки').filter(line => line.trimStart().startsWith('✗ ')).length, view.failures.length);
  } finally {
    await shutdown();
    await rm(cwd, { recursive: true, force: true });
    await rm(demo.directory, { recursive: true, force: true });
  }
});

test('the owner\'s disagreement with the judge reads the same in the chat payload, its collapsed result and the CLI summary', { timeout: 60000 }, async () => {
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
    const results = tools.get(TOOL.results)!;
    const result = await results.execute('results-disagreement', { run: record.id }, undefined, undefined, headless(cwd));
    const payload = output(result);
    const section = (all: string[]) => { const at = all.indexOf(expected[0]!); return at < 0 ? [] : all.slice(at, all.indexOf('', at)); };
    assert.deepEqual(section(payload.lines), expected);

    // The collapsed chat block does not list the disagreement; its trust line counts it.
    initTheme('dark', false);
    const rendered = results.renderResult!(result as never, { expanded: false, isPartial: false },
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
  } finally {
    await shutdown();
    await rm(cwd, { recursive: true, force: true });
    await rm(demo.directory, { recursive: true, force: true });
  }
});

test('a repeat shows the same first block in the chat as in the CLI summary, stability line included', { timeout: 60000 }, async t => {
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
  const inspected = output(await tools.get(TOOL.results)!.execute('repeat-view', { run: repeatId }, undefined, undefined, headless(directory)));
  const lines: string[] = inspected.lines;
  const head = (all: string[]) => all.slice(0, all.indexOf(''));
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'summary', '--id', repeatId, '--data-dir', data], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  // The number, the trust line and the reality line read the same in Pi and on the command line.
  assert.ok(head(lines).length >= 2, lines.join('\n'));
  assert.deepEqual(head(cli.stdout.split('\n')), head(lines));
});

test('a set of older situations is confirmed as one sheet with «accept», and its run then only starts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-chat-accept-'));
  const { tools, shutdown } = registered();
  t.after(async () => { await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const asked: { title: string; options: string[] }[] = [];
  let answers: boolean[] = [];
  const ctx = tui(directory, (title, options) => { asked.push({ title, options }); return answers[asked.length - 1] ?? true ? options[0] : options[1]; });
  const call = async (name: string, params: unknown) => output(await tools.get(name)!.execute('chat', params, undefined, undefined, ctx));
  // Two old-format cards judged by the goal rubric, as a repeat of an old run leaves them.
  const built = await legacyDraftIn(directory, { count: 2 }, record => { for (const scenario of record.scenarios) scenario.metrics = [goalAttainment]; });
  const store = new ExperimentStore(join(directory, '.agent-lab'));
  // Declined: nothing is written, and the run will not start until they are confirmed.
  answers = [false];
  const declined = await call(TOOL.run, { action: 'accept', run: built.id });
  assert.equal(declined.accepted, false);
  assert.deepEqual(asked[0]!.options, ['Подтвердить все', 'Не сейчас'], 'one native question with Russian answers');
  assert.match(asked[0]!.title, /^Подтвердить ожидания: 2 ситуации\?\n\nЧто агент должен сделать: 2 ситуации\./);
  assert.doesNotMatch(asked[0]!.title, /\/agent-lab|Версия ожиданий|[a-f0-9]{12}/);
  assert.equal((await store.get(built.id)).acceptedDraftHash, undefined);
  // The whole sheet is confirmed with one answer; the agent does not run.
  asked.length = 0; answers = [true, true];
  const accepted = await call(TOOL.run, { action: 'accept', run: built.id });
  assert.equal(accepted.accepted, true);
  const after = await store.get(built.id);
  assert.equal(after.acceptedDraftHash, draftHash(after)); assert.equal(after.trials.length, 0, 'accepting does not run the agent');
  // Confirmed expectations are not asked again: the run dialog only starts.
  const ran = await call(TOOL.run, { run: built.id });
  assert.match(asked.at(-1)!.title, /^Запустить прогон\?/);
  assert.equal(ran.run, built.id); assert.equal((await store.get(built.id)).phase, 'results_review');
});

test('the workspace and the chat share one project: a request, a question about a situation, a run, the judge\'s check, a new agent version and the report', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-journey-fixture-'));
  const opened: string[] = [];
  const { tools, shutdown, command, contexts, userMessages } = registered(() => {
    assert.equal(existsSync(join(directory, '.agent-lab', '.lock')), false, 'conversation starts only after the workspace releases its writer lock');
  }, { openReport: async path => { opened.push(path); } });
  const session = workspaceSession(directory);
  const ctx = session.ctx;
  const errors: string[] = [];
  let editorText = '';
  Object.assign(ctx.ui, {
    getEditorText: () => editorText,
    setEditorText: (text: string) => { editorText = text; },
    notify: (message: string, type: string) => { if (type === 'error') errors.push(message); },
  });
  const call = async (name: string, params: object) => output(await tools.get(name)!.execute(name, params, undefined, undefined, ctx));
  const store = new ExperimentStore(join(directory, '.agent-lab'));
  try {
    await command('/fixture/agent', ctx);
    assert.equal(userMessages[0], 'Проверь агента в /fixture/agent'); assert.equal(contexts[0]!.display, false);
    assert.match(JSON.parse(contexts[0]!.content).task, /agent_lab_prepare/);
    // The outer Pi model's actions are scripted here; real tools and the native workspace execute every state transition.
    const built = await call(TOOL.prepare, { demo: true });
    assert.equal((await store.get(built.run)).phase, 'review');
    // One attempt per situation keeps the judge's queue to the one failure. A setting of the draft, set here directly: the model never passes settings.
    const seed = new ExperimentLab(join(directory, '.agent-lab'));
    await seed.init();
    try { await seed.updateDraft(built.run, draftHash(await seed.get(built.run)), { settings: { repeats: 1 } }); } finally { await seed.close(); }
    // The workspace opens a draft on its situations with the first one selected: «a» asks Lab about it in one line.
    session.state.steps = [['a']]; session.state.words = 'Одной попытки на ситуацию достаточно.';
    await command(built.run, ctx); assert.equal(userMessages.at(-1), session.state.words);
    assert.match(session.inputCalls.at(-1)!, /^Спросить Lab про ситуацию 1 «.+»$/);
    const selected = JSON.parse(contexts.at(-1)!.content); assert.equal(selected.run, built.run); assert.equal(selected.situation, 1, JSON.stringify(selected));
    assert.match(selected.task, /agent_lab_cards/);
    editorText = 'Ещё пишу уточнение';
    await call(TOOL.cards, { run: built.run });
    assert.equal(editorText, 'Ещё пишу уточнение', 'a tool keeps the owner\'s unfinished input'); editorText = '';
    // → the plan, Enter: one dialog accepts the ready situation and starts the run; its result opens by itself.
    // The run hands its lease back after its result is recorded; the conversation starts only once it is free.
    const free = () => !existsSync(join(directory, '.agent-lab', '.lock'));
    session.state.steps = [[KEY.right, KEY.enter], { until: 'Точность агента', ready: free, keys: [KEY.enter, 'a'] }];
    session.state.words = 'Почему этот диалог провалился и что нужно исправить?';
    await command(built.run, ctx); assert.equal(userMessages.at(-1), session.state.words);
    assert.match(session.selectCalls.at(-1)!.title, /^Принять 1 ситуацию и запустить\?/);
    const discussion = JSON.parse(contexts.at(-1)!.content); assert.equal(discussion.run, built.run); assert.ok(discussion.trialId);
    const trial = (await store.get(built.run)).trials.find(item => item.id === discussion.trialId)!;
    assert.ok(trial.assessments?.some(assessment => assessment.metricId === 'e1' && assessment.result === 'fail'), 'the agent asked again for the number it was given (duty e1)');
    // «1» — «да, судья прав» — on the one failure: the queue is answered, so the check of the judge ends by itself.
    session.state.steps = [[KEY.enter, '1'], CLOSE];
    await command(built.run, ctx);
    assert.ok(noticeOf(session.screens.at(-1)!).endsWith(REVIEW_DONE), session.screens.at(-1));
    const reviewed = await store.get(built.run);
    assert.equal(reviewed.phase, 'complete');
    // One answer lands on every judgment that decided the situation: here on each failed expectation.
    const markedCard = reviewed.scenarios.find(card => card.id === trial.scenarioId)!;
    assert.deepEqual(reviewed.humanReviews.map(each => each.metricId), markTargets(markedCard, trial)!.metricIds);
    for (const each of reviewed.humanReviews) {
      assert.deepEqual([each.source, each.countingRules, each.note], ['quick', 'all-expectations-v1', 'Быстрая отметка: согласен с судьёй.']);
      assert.equal(each.verdict, trial.assessments!.find(assessment => assessment.metricId === each.metricId)!.result);
    }
    // The fix is a new version of the agent: the owner names how to start it, and «запусти» runs the same set again.
    const fixed = demoTarget(true);
    assert.ok(fixed.kind === 'module');
    const repeated = await call(TOOL.run, { agent: { module: fixed.path, factory: fixed.exportName, version: 'fixture-fixed' } });
    assert.match(session.selectCalls.at(-1)!.title, /^Запустить прогон\?\n[\s\S]*Агент: .* · версия fixture-fixed/);
    const repeat = await store.get(repeated.run);
    assert.deepEqual([repeat.parentRunId, repeat.targetVersion, repeat.target.kind === 'module' && repeat.target.exportName], [built.run, 'fixture-fixed', 'createFixedSession']);
    assert.equal((await store.get(built.run)).trials.length, reviewed.trials.length, 'the run before is untouched');
    // The repeat's result in the workspace: a conversation of it carries its pair from the run before.
    session.state.steps = [{ until: 'Точность агента: 100%', ready: free, keys: [KEY.enter, 'a'] }];
    session.state.words = 'Покажи конкретное исправление до и после.';
    await command(repeat.id, ctx);
    assert.equal(userMessages.at(-1), session.state.words);
    const pairDiscussion = JSON.parse(contexts.at(-1)!.content);
    assert.deepEqual(pairDiscussion.comparisonSource, { kind: 'parent', beforeId: built.run, afterId: repeat.id });
    assert.equal(pairDiscussion.comparedPair.afterTrialId, pairDiscussion.trialId);
    // «1» on the repeat: the report for the customer, with the comparison, saved and opened.
    session.state.steps = [['1'], CLOSE];
    await command(repeat.id, ctx);
    assert.equal(opened.length, 1);
    assert.match(noticeOf(session.screens.at(-1)!), /^Отчёт для заказчика открыт в браузере: /);
    assert.match(await readFile(opened[0]!, 'utf8'), /Оценка выросла у 1, снизилась у 0/);
    assert.deepEqual(errors, []); assert.equal(session.state.steps.length, 0);
  } finally { await shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('the actual Pi SDK loader imports the nine tools and the skill without discovered resources', async () => {
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
    assert.match(protocol, /agent_lab_prepare/); assert.doesNotMatch(protocol, /https?:\/\//);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the tool rows are the owner\'s words: a tool never draws its payload', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'agent-lab-rows-'));
  const { tools, shutdown } = registered();
  try {
    initTheme('dark', false);
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
    for (const [name, params] of [[TOOL.status, {}], [TOOL.prepare, { demo: true }], [TOOL.cards, {}], [TOOL.decide, {}]] as const) {
      const tool = tools.get(name) as ToolDefinition;
      const result = await tool.execute(name, params, undefined, undefined, headless(cwd));
      const shown = stripTerminalSequences((tool.renderResult!(result as never, { expanded: true, isPartial: false }, theme, renderContext()) as unknown as Component).render(100).join('\n'));
      assert.doesNotMatch(shown, /[{}"]|[a-f0-9]{16}|agent_lab_/, `${name}: «${shown}»`);
    }
  } finally { await shutdown(); await rm(cwd, { recursive: true, force: true }); }
});
