import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initTheme, keyHint, ToolExecutionComponent, type ExtensionAPI, type ExtensionContext, type Theme, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, Text, visibleWidth, type Component } from '@earendil-works/pi-tui';
import agentLab from '../extensions/agent-lab.ts';
import { forgetViews, isVerdictDetails, MISSING_RESULT, rememberView, renderAgentLabResult, VERDICT_KIND, VerdictBlock, viewFor, type VerdictDetails } from '../extensions/render/verdict-block.ts';
import type { PaintTheme } from '../extensions/render/theme.ts';
import { forgetFeeds, rememberFeed } from '../extensions/render/feed.ts';
import { messageBlock, RUN_MESSAGE } from '../extensions/background.ts';
import { emptyUsage, settingsSchema, type Experiment, type Trial } from '../src/contracts.js';
import { goalAttainment, replyQuality, simulatorFidelity, type MetricAssessment } from '../src/assessment.js';
import { resultHash } from '../src/lab/record.js';
import { ExperimentStore } from '../src/store.js';
import { SPLIT_RATIONALE_PREFIX } from '../src/judge.js';
import { accuracyRow, alarmRow, chatBlock, fitRows, nextRows } from '../src/result-text.js';
import { buildResultView, type ResultView } from '../src/result-view.js';

/*
 * The phase-4 tracer: a real `agent_lab_run` result is drawn by Pi's own tool row as the result
 * block — the chat rows of result-text.ts laid out by `fitRows` — from `details` that hold ids only
 * (REV-01). The fake `pi` and `output()` mirror the ones in extension.test.ts; nothing is imported
 * across test files.
 */

/** The hint under a collapsed block: what to press or say next. */
const collapsedHint = (view: ResultView) => view.failures.length ? 'причины с примерами · «покажи ошибку 1» · «отчёт для заказчика»' : 'подробнее · «отчёт для заказчика»';

const SHOWN_TO_OWNER = 'Блок с точностью и причинами уже показан владельцу. Не копируйте его строки. Назовите точность одной фразой и объясните по-человечески, где и почему агент хромает: что просили клиенты, что агент сделал вместо этого, какое правило владельца это нарушает; что он делает хорошо и насколько числу можно верить. Затем предложите следующий шаг.';

function registered() {
  const tools = new Map<string, ToolDefinition>();
  let shutdown!: () => Promise<void>;
  agentLab({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: () => {},
    on: (name: string, handler: () => Promise<void>) => { if (name === 'session_shutdown') shutdown = handler; },
    sendMessage: () => {},
    sendUserMessage: () => {},
    getActiveTools: () => [], setActiveTools: () => {},
  } as unknown as ExtensionAPI);
  assert.ok(shutdown);
  return { tools, shutdown };
}
type ToolResult = Awaited<ReturnType<ToolDefinition['execute']>>;
const output = (result: ToolResult) => JSON.parse(result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'));

/** A finished demo run through the chat path: prepare the situations, then run the ready one — accepted in the run's own dialog. */
async function demoRun(directory: string, tools: Map<string, ToolDefinition>) {
  const ctx = { cwd: directory, mode: 'tui', hasUI: true, ui: { select: async (_title: string, options: string[]) => options[0] } } as unknown as ExtensionContext;
  const call = async (name: string, params: unknown) => tools.get(name)!.execute('fixture', params, undefined, undefined, ctx);
  const built = output(await call('agent_lab_prepare', { demo: true }));
  // The demo's second situation waits for the owner's answer; the ready one is accepted and run in one dialog.
  const result = await call('agent_lab_run', {});
  const record = await new ExperimentStore(join(directory, '.agent-lab')).get(built.run);
  return { result, run: output(result), record, scenarios: record.scenarios };
}

/** Pi's own tool row for the registered tool, with the result applied; the stripped, trimmed, non-empty lines. */
function toolRow(tool: ToolDefinition, result: ToolResult, width: number): { raw: string[]; lines: string[] } {
  const row = new ToolExecutionComponent('agent_lab_run', 'call-1', {}, {}, tool, { requestRender() {} } as never, '/tmp');
  row.updateResult({ content: result.content as never, details: result.details, isError: false });
  const raw = row.render(width);
  return { raw, lines: raw.map(line => stripTerminalSequences(line).trim()).filter(Boolean) };
}

test('после agent_lab_run Pi рисует блок-вердикт из details, в которых только идентификаторы', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-verdict-block-'));
  const { tools, shutdown } = registered();
  t.after(async () => { await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const { result, run, record } = await demoRun(directory, tools);
  assert.equal(record.phase, 'results_review');

  // The session holds a kind, a version and two ids: no view, no text (REV-01, T-04-03).
  const details = result.details as VerdictDetails;
  assert.ok(isVerdictDetails(details));
  assert.equal(details.kind, VERDICT_KIND);
  assert.deepEqual(Object.keys(details).sort(), ['kind', 'resultKey', 'runId', 'version']);
  assert.equal(details.version, 1);
  assert.equal(details.runId, run.run);
  assert.equal(details.resultKey, `${record.id}:${resultHash(record)}`);
  // The model reads the result screen's lines and the one field that tells it the block is already shown (C-119).
  assert.equal(run.shownToOwner, SHOWN_TO_OWNER);
  assert.ok(Array.isArray(run.lines) && run.lines.length > 0);

  // Pi's real tool row draws the block: the first chat row under the call row, the number among the rows.
  initTheme('dark', false);
  const view = viewFor(details);
  assert.ok(view, 'the view produced with the result is remembered for the block');
  assert.ok(run.lines.some((line: string) => line.trim() === accuracyRow(view).text), 'the model reads the same number');
  assert.equal(run.next, nextRows(view, 'chat')[0]?.text);
  const { raw, lines } = toolRow(tools.get('agent_lab_run')!, result, 80);
  assert.equal(lines[0], '● Запускаю прогон', 'the action\'s own row, Claude-Code-like');
  assert.equal(lines[1], `└ ${accuracyRow(view).text}`, 'the number hangs under the action, in one piece');
  assert.ok(!lines.some(line => line.startsWith('Дальше: ')), 'the collapsed block leaves «Дальше» to the hint and the expanded block');
  assert.ok(lines.at(-1)!.endsWith(collapsedHint(view)), `the expand hint is under the block, got «${lines.at(-1)}»`);
  for (const line of raw) assert.ok(visibleWidth(line) <= 80, `wider than 80: «${stripTerminalSequences(line)}»`);
  // The model-only text is never drawn.
  const shown = lines.join('\n');
  assert.doesNotMatch(shown, /shownToOwner/);
  assert.doesNotMatch(shown, /уже показан владельцу/);
  assert.doesNotMatch(shown, /"lines"/);
});

test('ни текст ситуаций, ни их названия не попадают в details', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-verdict-marker-'));
  const { tools, shutdown } = registered();
  t.after(async () => { await shutdown(); await rm(directory, { recursive: true, force: true }); });
  // What reaches the view and the transcript — the titles and the customer's words — never reaches the session.
  const { result, scenarios } = await demoRun(directory, tools);
  const stored = JSON.stringify(result.details);
  assert.ok(scenarios.length > 0, 'the run has situations');
  for (const card of scenarios) {
    assert.ok(!stored.includes(card.title), `title «${card.title}» reached details`);
    assert.ok(!stored.includes(card.user.opening), `opening «${card.user.opening}» reached details`);
  }
  assert.deepEqual(Object.keys(result.details as object).sort(), ['kind', 'resultKey', 'runId', 'version']);
  // The remembered view does carry the titles: they are drawn, not stored.
  const view = viewFor(result.details as VerdictDetails);
  assert.ok(view && scenarios.every(card => view.cards.some(shown => shown.title === card.title)));
});

test('в открытой заново сессии результат рисуется из его сохранённых строк; без них строка честно говорит, что блок нельзя показать', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-verdict-missing-'));
  const { tools, shutdown } = registered();
  t.after(async () => { await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const { result, run } = await demoRun(directory, tools);
  initTheme('dark', false);
  const view = viewFor(result.details as VerdictDetails)!;
  forgetViews();
  assert.equal(viewFor(result.details as VerdictDetails), null);
  // What the session file holds of the result — the model's content — carries the screen's own lines: the number comes back.
  const { raw, lines } = toolRow(tools.get('agent_lab_run')!, result, 80);
  assert.equal(lines[0], '● Запускаю прогон');
  assert.equal(lines[1], `└ ${accuracyRow(view).text}`, 'the number the owner saw, in the same words');
  assert.ok(lines.some(line => line.startsWith('Вероятно, от')), 'and its trust line under it');
  assert.ok(!lines.join(' ').includes(run.run.slice(0, 8)), 'no id on screen');
  assert.ok(!lines.some(line => line.includes('"lines"') || line.includes(SHOWN_TO_OWNER)), 'never the JSON or what only the model reads');
  for (const line of raw) assert.ok(visibleWidth(line) <= 80);
  // Expanded, every stored line is there, the causes too.
  const expanded = strip(renderAgentLabResult(result as never, { expanded: true, isPartial: false }, realTheme(), () => new Text('legacy', 0, 0)).render(100));
  for (const line of run.lines as string[]) if (line.trim()) assert.ok(expanded.some(shown => shown.includes(line.trim())), `«${line.trim()}» is missing`);
  // A result whose content holds no such lines, or holds something else under that name, keeps the honest row.
  for (const content of ['{}', '{"lines":"Точность агента: 100%"}', '{"lines":[1,2]}', 'не JSON']) {
    const drawn = strip(renderAgentLabResult({ content: [{ type: 'text', text: content }], details: result.details } as never, { expanded: false, isPartial: false }, realTheme(), () => new Text('legacy', 0, 0)).render(80));
    assert.deepEqual(drawn, [`└ ${MISSING_RESULT}`], content);
  }
  // An escape sequence in a stored line never reaches the terminal.
  const tampered = strip(renderAgentLabResult({ content: [{ type: 'text', text: JSON.stringify({ lines: [' Точность агента: \u001b[2J50%'] }) }], details: result.details } as never,
    { expanded: false, isPartial: false }, realTheme(), () => new Text('legacy', 0, 0)).render(80));
  assert.deepEqual(tampered, ['└ Точность агента: 50%']);
});

// ---- Task 3: both Pi themes at every width, old sessions untouched, a failing view never reaches Pi. ----

const WIDTHS = [40, 60, 80, 100, 160];
const HEX_ID = '0123abcd-0000-4000-8000-000000000000';
const world = { records: {}, writableFields: [], transientFailures: 0 };
type Card = Experiment['scenarios'][number];
type Result = MetricAssessment['result'];
const SPLIT = `${SPLIT_RATIONALE_PREFIX} pass / fail. Основания каждой оценки сохранены в judgeAudit.`;
/** A long Cyrillic reply with a line break and an escape sequence: the quote the explanation rows carry. */
const LONG_REPLY = 'Возврат по операции через терминал оформляется через кассу: \x1b[31mвыберите операцию\x1b[0m в журнале, нажмите «Возврат», дождитесь ответа банка;\nденьги вернутся на карту покупателя в срок до пяти рабочих дней, в зависимости от банка-эмитента, о чём стоит предупредить клиента заранее.';

function card(id: string, title: string): Card {
  return {
    id, familyId: id, title, requirementIds: [], provenance: 'production', tier: 'regression', goalObservation: 'reply',
    user: { goal: 'g', facts: 'f', behavior: 'b', opening: 'o', maxFollowUps: 3 }, initialState: world, checks: [],
    metrics: [{ ...goalAttainment }, { ...replyQuality }, { ...simulatorFidelity }], split: 'dev',
  };
}
const vote = (metricId: string, result: Result, rationale = 'Обоснование.'): MetricAssessment => ({ metricId, result, rationale, evidence: result === 'unknown' ? [] : [1] });
function attempt(scenarioId: string, goal: Result, rationale?: string): Trial {
  return {
    id: `t-${scenarioId}`, revisionId: 'rev', scenarioId, familyId: scenarioId, repeat: 0, userMode: 'reactive', split: 'dev', manifestHash: 'h',
    outcome: 'ungraded', reason: 'Диалог дошёл до конца.', checks: [],
    events: [{ seq: 0, type: 'user', text: 'Здравствуйте' }, { seq: 1, type: 'assistant', text: LONG_REPLY }, { seq: 2, type: 'simulator', result: { message: '', done: true } }],
    initialState: world, finalState: world, usage: emptyUsage(), elapsedMs: 1,
    assessments: [vote('goal_attainment', goal, rationale), vote('reply_quality', 'pass'), vote('user_fidelity', 'pass')],
  };
}
/**
 * Two passed, three failed and two unmeasured situations with long titles: «?» rows, «✗» rows and long quotes to wrap.
 * Two of seven unmeasured raise the alarm above the number.
 */
function fixtureView(): ResultView {
  const cards: Card[] = [];
  const trials: Trial[] = [];
  const add = (id: string, title: string, goal: Result, rationale?: string) => { cards.push(card(id, title)); trials.push(attempt(id, goal, rationale)); };
  add('p0', 'Смена реквизитов', 'pass'); add('p1', 'Выписка за месяц', 'pass');
  add('f0', 'Возврат через терминал покупателю по закрытому чеку при незавершённой смене', 'fail');
  add('f1', 'Подключение СБП', 'fail'); add('f2', 'Отмена платежа', 'fail');
  add('u0', 'Чек не пришёл покупателю на электронную почту после оплаты картой на кассе самообслуживания', 'unknown', SPLIT);
  add('u1', 'Тариф эквайринга', 'unknown', SPLIT);
  return buildResultView(record(cards, trials));
}
/** Two passed situations: nothing failed, so the collapsed block offers only «подробнее» and the report. */
const cleanView = (): ResultView => buildResultView(record([card('p0', 'Смена реквизитов'), card('p1', 'Выписка за месяц')], [attempt('p0', 'pass'), attempt('p1', 'pass')]));
function record(cards: Card[], trials: Trial[]): Experiment {
  return {
    schemaVersion: '1', id: HEX_ID, task: 't', mode: 'live', workflow: 'evaluate', createdAt: 'now', updatedAt: 'now', phase: 'results_review', message: '',
    sources: [], settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1 }),
    target: { kind: 'command', command: 'python3', args: ['agent.py'], timeoutMs: 60000 },
    requirements: [], questions: [], goldenCases: [], dialogues: [], profiles: [], notes: '', scenarios: cards, revisions: [], selectedRevisionId: null,
    manifestHash: 'h', reviewedAt: null, reviewMode: 'human', controlConsumedAt: null, acceptedTests: [], trials, comparisons: [], iterations: [],
    usage: emptyUsage(), error: null, limitations: [], humanReviews: [],
  };
}
const verdictResult = (resultKey: string, text = '{"shownToOwner":"скрытый текст для модели"}'): ToolResult =>
  ({ content: [{ type: 'text', text }], details: { kind: VERDICT_KIND, version: 1, runId: HEX_ID, resultKey } as VerdictDetails });
const strip = (lines: string[]) => lines.map(line => stripTerminalSequences(line).trim()).filter(Boolean);
const realTheme = (): Theme => {
  let captured: Theme | undefined;
  const probe = new ToolExecutionComponent('agent_lab_run', 'c', {}, {}, { renderResult: (_r: unknown, _o: unknown, theme: Theme) => { captured = theme; return new Text('', 0, 0); } }, { requestRender() {} } as never, '/tmp');
  probe.updateResult({ content: [{ type: 'text', text: 'x' }], details: undefined, isError: false });
  probe.render(40);
  assert.ok(captured, 'Pi hands its current theme to the renderer');
  return captured;
};

test('legacy: old-session details, no details and non-JSON content are drawn by legacyResult, exactly as it returns them', () => {
  initTheme('dark', false);
  const theme = realTheme();
  const calls: unknown[][] = [];
  const sentinel = new Text('legacy', 0, 0);
  const legacy = (...args: unknown[]) => { calls.push(args); return sentinel; };
  const view = fixtureView();
  const cases: [string, ToolResult][] = [
    ['a phase-1 session: the whole summary object as details', { content: [{ type: 'text', text: JSON.stringify({ id: HEX_ID, view, viewLines: ['Справился…'] }) }], details: { id: HEX_ID, view, viewLines: ['Справился…'], proofs: [] } }],
    ['no details at all', { content: [{ type: 'text', text: '{"id":"x","phase":"review"}' }], details: undefined }],
    ['a plain text result', { content: [{ type: 'text', text: 'не JSON' }], details: { message: 'x' } }],
    ['the right kind but another version', { content: [{ type: 'text', text: '{}' }], details: { kind: VERDICT_KIND, version: 2, runId: HEX_ID, resultKey: 'k' } }],
    ['the right kind without ids', { content: [{ type: 'text', text: '{}' }], details: { kind: VERDICT_KIND, version: 1 } }],
  ];
  for (const [label, result] of cases) {
    const options = { expanded: false, isPartial: false };
    const rendered = renderAgentLabResult(result as never, options, theme, legacy as never);
    assert.equal(rendered, sentinel, label);
    assert.deepEqual(calls.at(-1), [result, options, theme], `${label}: legacyResult gets the untouched result, options and theme`);
    assert.equal(isVerdictDetails(result.details), false, label);
  }
  assert.equal(calls.length, cases.length);
});

test('a view that throws while the rows are built ends as one honest row, never as an exception inside Pi and never as the model\'s text', () => {
  initTheme('dark', false);
  const theme = realTheme();
  const broken = fixtureView();
  Object.defineProperty(broken, 'control', { get() { throw new Error('сломанный вид'); } });
  rememberView(`${HEX_ID}:broken`, broken);
  const content = '\x1b[2Jкраткий текст для модели\x1b]52;c;x\x07';
  let tone = '';
  const rendered = renderAgentLabResult(verdictResult(`${HEX_ID}:broken`, content), { expanded: true, isPartial: false }, theme, () => { throw new Error('legacy must not be asked'); }, own => { tone = own; });
  const shown = strip(rendered.render(200));
  assert.deepEqual(shown, ['└ Этот результат не удалось показать — попросите показать его ещё раз.']);
  assert.equal(tone, 'muted', 'the action\'s sign does not claim success');
  assert.ok(!rendered.render(200).join('').includes('\x1b[2J'));
  // A legacy renderer that throws falls back the same way.
  const legacyThrows = renderAgentLabResult({ content: [{ type: 'text', text: 'старый текст' }], details: { id: 'x' } } as never, { expanded: false, isPartial: false }, theme, () => { throw new Error('boom'); });
  assert.deepEqual(strip(legacyThrows.render(200)), ['└ Этот результат не удалось показать — попросите показать его ещё раз.']);
});

test('through Pi\'s real tool row in the dark and light themes, at 40–160 columns, collapsed and expanded, no line is wider than the width', () => {
  const view = fixtureView();
  const key = `${HEX_ID}:matrix`;
  rememberView(key, view);
  const { tools, shutdown } = registered();
  const tool = tools.get('agent_lab_run')!;
  const result = verdictResult(key);
  const heights: Record<string, number> = {};
  const themes: [string, () => void][] = [['dark', () => initTheme('dark', false)], ['light', () => initTheme('light', false)]];
  for (const [name, apply] of themes) {
    apply();
    for (const width of WIDTHS) {
      for (const expanded of [false, true]) {
        const row = new ToolExecutionComponent('agent_lab_run', 'call-1', {}, {}, tool, { requestRender() {} } as never, '/tmp');
        row.updateResult({ content: result.content as never, details: result.details, isError: false });
        row.setExpanded(expanded);
        const raw = row.render(width);
        const lines = strip(raw);
        const label = `${name} ${width} ${expanded ? 'развёрнуто' : 'свёрнуто'}`;
        for (const line of raw) assert.ok(visibleWidth(line) <= width, `${label}: «${stripTerminalSequences(line)}» is wider than ${width}`);
        assert.ok(!lines.some(line => line.includes('…')), `${label}: an ellipsis was produced`);
        assert.equal(lines[0], '● Запускаю прогон', label);
        assert.ok(lines[1]!.startsWith('└ ✗ Числу пока не верить'), `${label}: the alarm opens the block`);
        if (width >= 100) assert.equal(lines[1], `└ ${alarmRow(view)!.text}`, label);
        assert.ok(lines.join(' ').includes('Точность агента: 40% — справился в 2 из 5 ситуаций'), `${label}: the number is drawn`);
        assert.ok(!lines.some(line => line.includes('shownToOwner') || line.includes('скрытый текст')), `${label}: the model text stays hidden`);
        assert.ok(!raw.join('').includes('\x1b[31m'), `${label}: the escape sequence of the quote is gone`);
        const text = lines.join(' ');
        assert.ok(text.includes('не измерено 2 из 7 ситуаций — судья не уверен — его оценки разошлись'), `${label}: the unmeasured share is drawn in both forms`);
        assert.equal(text.includes('Чаще всего: '), !expanded, `${label}: the causes in one row only when collapsed`);
        assert.equal(text.includes('Дальше: '), expanded, `${label}: «Дальше» only when expanded`);
        assert.equal(text.includes('Тариф эквайринга: судья не уверен — его оценки разошлись'), expanded, `${label}: the unmeasured situations only when expanded`);
        assert.equal(text.includes('выберите операцию в журнале'), expanded, `${label}: the long quote only in the expanded block`);
        assert.ok(lines.at(-1)!.endsWith(expanded ? 'свернуть' : 'заказчика»'), `${label}: the hint is the last row, got «${lines.at(-1)}»`);
        assert.ok(text.includes(expanded ? 'свернуть' : collapsedHint(view)), `${label}: the whole hint is drawn`);
        heights[label] = lines.length;
      }
    }
  }
  // Both themes draw the same text: only the colours differ.
  for (const width of WIDTHS) for (const form of ['свёрнуто', 'развёрнуто']) assert.equal(heights[`dark ${width} ${form}`], heights[`light ${width} ${form}`], `${width} ${form}`);
  return shutdown();
});

test('VerdictBlock takes the hint as a function and paints the rows with the theme it is given, in both forms', () => {
  const view = fixtureView();
  const marks: string[] = [];
  const fake: PaintTheme = {
    fg: (color, value) => { marks.push(color); return `<${color}>${value}</${color}>`; },
    bold: value => `<b>${value}</b>`,
    bg: (color, value) => `<bg:${color}>${value}</bg>`,
  } as PaintTheme;
  const hint = (expanded: boolean) => expanded ? 'ПОДСКАЗКА-СВЕРНУТЬ' : 'ПОДСКАЗКА-ПОДРОБНЕЕ';
  const plain = (line: string) => line.replace(/<\/?[a-zA-Z:]+>/g, '');
  for (const width of WIDTHS) {
    for (const expanded of [false, true]) {
      const lines = new VerdictBlock(view, expanded, fake, hint).render(width);
      for (const line of lines) assert.ok(visibleWidth(plain(line)) <= width, `${width}: «${plain(line)}»`);
      assert.equal(lines.at(-1)!.trim(), expanded ? 'ПОДСКАЗКА-СВЕРНУТЬ' : 'ПОДСКАЗКА-ПОДРОБНЕЕ', 'the injected hint closes the block, unpainted and unescaped');
      assert.ok(lines[0]!.startsWith('  <muted>└</muted>') && lines[0]!.includes('<error><b>'), `${width}: the alarm is bold error under the branch sign`);
      assert.ok(plain(lines[0]!).trim().startsWith('└ ✗ Числу пока не верить'), `${width}: «${plain(lines[0]!)}»`);
      assert.ok(lines.some(line => plain(line).trim().startsWith('Точность агента: 40%') && line.includes('<error><b>')), `${width}: the number is bold error too`);
      // The painted lines are exactly the laid-out rows under the branch: fitRows decides the layout, the theme only paints.
      const laid = fitRows(chatBlock(view, { expanded }).map(row => row.indent >= 2 ? { ...row, indent: row.indent - 2 } : row), width - 3).map(line => stripTerminalSequences(line.text));
      assert.deepEqual(lines.slice(0, -1).map(plain), laid.map((line, index) => `${index ? '   ' : '  └'}${line}`), `${width}: painting changed the layout`);
      assert.equal(lines.some(line => plain(line).trim() === 'Не измерено'), expanded, `${width}: the unmeasured situations only when expanded`);
    }
  }
  assert.ok(new Set(marks).size <= 8 && ['error', 'accent', 'muted', 'text'].every(tone => marks.includes(tone)), `tones used: ${[...new Set(marks)].join(', ')}`);
  const component: Component = new VerdictBlock(view, false, fake, hint);
  component.invalidate();
  assert.ok(Array.isArray(component.render(80)));
});

test('the host hint: the causes and the phrases to say when something failed, «подробнее» otherwise, «свернуть» when expanded', () => {
  initTheme('dark', false);
  const theme = realTheme();
  // Pi's own key hint; the stripped row is trimmed, so is the hint (a test process may have no key bound).
  const key = (description: string) => stripTerminalSequences(keyHint('app.tools.expand', description)).trim();
  const cases: [string, ResultView, string][] = [
    ['failing', fixtureView(), `${key('причины с примерами')} · «покажи ошибку 1» · «отчёт для заказчика»`],
    ['clean', cleanView(), `${key('подробнее')} · «отчёт для заказчика»`],
  ];
  for (const [name, view, collapsed] of cases) {
    rememberView(`${HEX_ID}:hint-${name}`, view);
    for (const expanded of [false, true]) {
      const rendered = renderAgentLabResult(verdictResult(`${HEX_ID}:hint-${name}`), { expanded, isPartial: false }, theme, () => { throw new Error('legacy must not be asked'); });
      assert.ok(rendered instanceof VerdictBlock, `${name}: the block is drawn`);
      const lines = strip(rendered.render(200));
      assert.equal(lines.at(-1), expanded ? key('свернуть') : collapsed, `${name} ${expanded ? 'развёрнуто' : 'свёрнуто'}`);
      assert.equal(lines[0], `└ ${(alarmRow(view) ?? accuracyRow(view)).text}`, `${name}: the alarm, else the number, comes first`);
    }
  }
  assert.equal(accuracyRow(cleanView()).text, 'Точность агента: 100% — справился в 2 из 2 ситуаций');
});

test('a result that arrives as a message is drawn like an action row: its head, its summary under the branch, and an honest row after a restart', () => {
  initTheme('dark', false);
  const plain = { fg: (_tone: string, text: string) => text, bold: (text: string) => text, bg: (_tone: string, text: string) => text } as unknown as Theme;
  const stopped = { content: '{}', details: rememberFeed('message-stopped', { title: 'Прогон остановлен', tone: 'warning',
    rows: [{ text: 'Прогон остановлен: сохранено 7 из 18 разговоров.' }, { text: 'С места остановки не продолжить: «повтори прогон» запустит все разговоры заново.', tone: 'muted' }] }, 'Прогон') };
  const drawn = messageBlock(RUN_MESSAGE, stopped, false, plain).render(100).map(line => stripTerminalSequences(line).trimEnd());
  assert.equal(drawn[0], '● Прогон остановлен');
  assert.equal(drawn[1], '  └ Прогон остановлен: сохранено 7 из 18 разговоров.');
  assert.ok(drawn.some(line => line.includes('«повтори прогон» запустит все разговоры заново')), drawn.join('\n'));
  for (const width of [40, 70, 160]) for (const line of messageBlock(RUN_MESSAGE, stopped, true, plain).render(width)) assert.ok(visibleWidth(line) <= width, line);
  // A reopened session holds only the note of the message: it says so in one row instead of drawing the old JSON.
  forgetFeeds();
  const reopened = messageBlock(RUN_MESSAGE, stopped, false, plain).render(100).map(line => stripTerminalSequences(line).trimEnd());
  assert.equal(reopened[0], '● Прогон');
  assert.equal(reopened[1], '  └ Сессия открыта заново — попросите показать это ещё раз.');
  assert.doesNotMatch(reopened.join('\n'), /[{}]/);
});
