import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initTheme, ToolExecutionComponent, type ExtensionAPI, type ExtensionContext, type Theme, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, Text, visibleWidth, type Component } from '@earendil-works/pi-tui';
import agentLab from '../extensions/agent-lab.ts';
import { forgetViews, isVerdictDetails, rememberView, renderAgentLabResult, VERDICT_KIND, VerdictBlock, viewFor, type VerdictDetails } from '../extensions/render/verdict-block.ts';
import type { PaintTheme } from '../extensions/render/theme.ts';
import { emptyUsage, goalAttainment, replyQuality, settingsSchema, simulatorFidelity, type Experiment, type MetricAssessment, type Trial } from '../src/contracts.js';
import { SPLIT_RATIONALE_PREFIX } from '../src/judge.js';
import { buildResultView, type ResultView } from '../src/result-view.js';
import { verdictLine } from '../src/verdict.js';

/*
 * The phase-4 tracer: a real `agent_lab_run` result is drawn by Pi's own tool row as the verdict
 * block, from `details` that hold ids only (REV-01). The fake `pi` and `output()` mirror the ones
 * in extension.test.ts; nothing is imported across test files.
 */

const MARKER = 'QUOTE-MARKER-7f3a';
const SHOWN_TO_OWNER = 'Блок-вердикт уже показан владельцу. Не пересказывайте число и причины; ответьте на вопрос или предложите следующий шаг.';

function registered() {
  const tools = new Map<string, ToolDefinition>();
  let shutdown!: () => Promise<void>;
  agentLab({
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: () => {},
    on: (name: string, handler: () => Promise<void>) => { if (name === 'session_shutdown') shutdown = handler; },
    sendMessage: () => {},
    sendUserMessage: () => {},
  } as unknown as ExtensionAPI);
  assert.ok(shutdown);
  return { tools, shutdown };
}
type ToolResult = Awaited<ReturnType<ToolDefinition['execute']>>;
const output = (result: ToolResult) => JSON.parse(result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'));

/** A finished demo run through the chat path: build one situation, confirm, run. `edit` changes the draft before the run. */
async function demoRun(directory: string, tools: Map<string, ToolDefinition>, edit?: (draft: any) => any) {
  const ctx = { cwd: directory, mode: 'tui', hasUI: true, ui: { confirm: async () => true } } as unknown as ExtensionContext;
  const call = async (name: string, params: unknown) => tools.get(name)!.execute('fixture', params, undefined, undefined, ctx);
  const built = output(await call('agent_lab_build', { mode: 'demo', scenarioCount: 1 }));
  let draft = output(await call('agent_lab_inspect', { id: built.id }));
  if (edit) {
    const scenarios = edit(draft.scenarios);
    draft = output(await call('agent_lab_edit', { id: built.id, expectedHash: draft.draftHash, patch: { scenarios } }));
  }
  const result = await call('agent_lab_run', { id: built.id, expectedHash: draft.draftHash });
  return { result, run: output(result), scenarios: output(await call('agent_lab_inspect', { id: built.id })).scenarios as { title: string }[] };
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
  const { result, run } = await demoRun(directory, tools);
  assert.equal(run.phase, 'results_review');

  // The session holds a kind, a version and two ids: no view, no text (REV-01, T-04-03).
  const details = result.details as VerdictDetails;
  assert.ok(isVerdictDetails(details));
  assert.equal(details.kind, VERDICT_KIND);
  assert.deepEqual(Object.keys(details).sort(), ['kind', 'resultKey', 'runId', 'version']);
  assert.equal(details.version, 1);
  assert.equal(details.runId, run.id);
  assert.equal(details.resultKey, `${run.id}:${run.resultHash}`);
  // The model gets today's JSON plus the one new field that tells it the block is already shown (C-119).
  assert.equal(run.shownToOwner, SHOWN_TO_OWNER);
  assert.ok(Array.isArray(run.viewLines) && run.viewLines.length > 0);

  // Pi's real tool row draws the block: the verdict line is the first row under the call row.
  initTheme('dark', false);
  const view = viewFor(details);
  assert.ok(view, 'the view produced with the result is remembered for the block');
  const { raw, lines } = toolRow(tools.get('agent_lab_run')!, result, 80);
  assert.equal(lines[0], 'Проверка агента');
  assert.equal(lines[1], verdictLine(view));
  assert.ok(lines.some(line => line.startsWith('Дальше: ')), 'the block ends with the «Дальше» row');
  assert.ok(lines.some(line => line.endsWith('подробнее')), 'the expand hint is under the block');
  for (const line of raw) assert.ok(visibleWidth(line) <= 80, `wider than 80: «${stripTerminalSequences(line)}»`);
  // The model-only text is never drawn.
  const shown = lines.join('\n');
  assert.doesNotMatch(shown, /shownToOwner/);
  assert.doesNotMatch(shown, /Блок-вердикт уже показан/);
  assert.doesNotMatch(shown, /"viewLines"/);
});

test('ни маркер из текста ситуаций, ни их названия не попадают в details', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-verdict-marker-'));
  const { tools, shutdown } = registered();
  t.after(async () => { await shutdown(); await rm(directory, { recursive: true, force: true }); });
  // The expectation itself stays as it is: a changed `successCriteria` without a changed check is refused (02-07).
  // The marker rides on what reaches the view and the transcript — the title, the opening and the facts.
  const { result, scenarios } = await demoRun(directory, tools, cards => cards.map((card: any, i: number) => ({
    ...card,
    title: `Ситуация ${MARKER} ${i + 1}`,
    user: { ...card.user, opening: `${card.user.opening} ${MARKER}`, facts: `${card.user.facts ?? ''} ${MARKER}`.trim() },
  })));
  const stored = JSON.stringify(result.details);
  assert.ok(scenarios.length > 0 && scenarios.every(card => card.title.includes(MARKER)), 'the fixture titles carry the marker');
  assert.doesNotMatch(stored, new RegExp(MARKER));
  for (const card of scenarios) assert.ok(!stored.includes(card.title), `title «${card.title}» reached details`);
  assert.deepEqual(Object.keys(result.details as object).sort(), ['kind', 'resultKey', 'runId', 'version']);
  // The remembered view does carry the titles: they are drawn, not stored.
  const view = viewFor(result.details as VerdictDetails);
  assert.ok(view && view.cards.some(card => card.title.includes(MARKER)));
});

test('без запомненного вида строка инструмента честно говорит, что блок нельзя показать', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-verdict-missing-'));
  const { tools, shutdown } = registered();
  t.after(async () => { await shutdown(); await rm(directory, { recursive: true, force: true }); });
  const { result, run } = await demoRun(directory, tools);
  initTheme('dark', false);
  forgetViews();
  assert.equal(viewFor(result.details as VerdictDetails), null);
  const { raw, lines } = toolRow(tools.get('agent_lab_run')!, result, 80);
  assert.deepEqual(lines, ['Проверка агента', `Прогон ${run.id.slice(0, 8)} не найден в .agent-lab — блок нельзя показать.`]);
  for (const line of raw) assert.ok(visibleWidth(line) <= 80);
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
/** Two passed, three failed and two unmeasured situations with long titles: «?» rows, «✗» rows and long quotes to wrap. */
function fixtureView(): ResultView {
  const cards: Card[] = [];
  const trials: Trial[] = [];
  const add = (id: string, title: string, goal: Result, rationale?: string) => { cards.push(card(id, title)); trials.push(attempt(id, goal, rationale)); };
  add('p0', 'Смена реквизитов', 'pass'); add('p1', 'Выписка за месяц', 'pass');
  add('f0', 'Возврат через терминал покупателю по закрытому чеку при незавершённой смене', 'fail');
  add('f1', 'Подключение СБП', 'fail'); add('f2', 'Отмена платежа', 'fail');
  add('u0', 'Чек не пришёл покупателю на электронную почту после оплаты картой на кассе самообслуживания', 'unknown', SPLIT);
  add('u1', 'Тариф эквайринга', 'unknown', SPLIT);
  const record: Experiment = {
    schemaVersion: '1', id: HEX_ID, task: 't', mode: 'live', workflow: 'evaluate', createdAt: 'now', updatedAt: 'now', phase: 'results_review', message: '',
    sources: [], settings: settingsSchema.parse({ userModes: ['reactive'], repeats: 1 }),
    target: { kind: 'command', command: 'python3', args: ['agent.py'], timeoutMs: 60000 },
    requirements: [], questions: [], goldenCases: [], dialogues: [], profiles: [], notes: '', scenarios: cards, revisions: [], selectedRevisionId: null,
    manifestHash: 'h', reviewedAt: null, reviewMode: 'human', controlConsumedAt: null, acceptedTests: [], trials, comparisons: [], iterations: [],
    usage: emptyUsage(), error: null, limitations: [], humanReviews: [],
  };
  return buildResultView(record);
}
const verdictResult = (resultKey: string, text = '{"shownToOwner":"скрытый текст для модели"}'): ToolResult =>
  ({ content: [{ type: 'text', text }], details: { kind: VERDICT_KIND, version: 1, runId: HEX_ID, resultKey } as VerdictDetails });
const strip = (lines: string[]) => lines.map(line => stripTerminalSequences(line).trim()).filter(Boolean);
const realTheme = (): Theme => {
  let captured: Theme | undefined;
  const probe = new ToolExecutionComponent('agent_lab_run', 'c', {}, {}, { renderResult: (_r, _o, theme) => { captured = theme; return new Text('', 0, 0); } }, { requestRender() {} } as never, '/tmp');
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

test('a view that throws while the rows are built ends as the escaped content text, never as an exception inside Pi', () => {
  initTheme('dark', false);
  const theme = realTheme();
  const broken = fixtureView();
  Object.defineProperty(broken, 'control', { get() { throw new Error('сломанный вид'); } });
  rememberView(`${HEX_ID}:broken`, broken);
  const content = '\x1b[2Jкраткий текст для модели\x1b]52;c;x\x07';
  const rendered = renderAgentLabResult(verdictResult(`${HEX_ID}:broken`, content), { expanded: true, isPartial: false }, theme, () => { throw new Error('legacy must not be asked'); });
  assert.ok(rendered instanceof Text, 'a pi-tui Text');
  // pi-tui's Text pads its lines to the width; the visible words are the escaped content text and nothing else.
  assert.deepEqual(rendered.render(200).map(line => line.trimEnd()), ['краткий текст для модели']);
  // A legacy renderer that throws falls back the same way.
  const legacyThrows = renderAgentLabResult({ content: [{ type: 'text', text: 'старый текст' }], details: { id: 'x' } } as never, { expanded: false, isPartial: false }, theme, () => { throw new Error('boom'); });
  assert.deepEqual(legacyThrows.render(200).map(line => line.trimEnd()), ['старый текст']);
});

test('through Pi\'s real tool row in the dark and light themes, at 40–160 columns, collapsed and expanded, no line is wider than the width', () => {
  const view = fixtureView();
  const key = `${HEX_ID}:matrix`;
  rememberView(key, view);
  const { tools, shutdown } = registered();
  const tool = tools.get('agent_lab_run')!;
  const result = verdictResult(key);
  const heights: Record<string, number> = {};
  for (const name of ['dark', 'light'] as const) {
    initTheme(name, false);
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
        assert.equal(lines[0], 'Проверка агента', label);
        if (width >= 80) assert.equal(lines[1], verdictLine(view), label);
        assert.ok(lines.join(' ').includes('Агент справляется плохо: 2 из 5 ситуаций'), `${label}: the verdict line is drawn`);
        assert.ok(!lines.some(line => line.includes('shownToOwner') || line.includes('скрытый текст')), `${label}: the model text stays hidden`);
        assert.ok(!raw.join('').includes('\x1b[31m'), `${label}: the escape sequence of the quote is gone`);
        const text = lines.join(' ');
        assert.ok(text.includes('Дальше: '), `${label}: the «Дальше» row is drawn`);
        assert.equal(text.includes('Тариф эквайринга — судья не уверен: голоса разошлись'), expanded, `${label}: the «?» rows only when expanded`);
        assert.equal(text.includes('Все провалы — /agent-lab 0123abcd, вкладка «Провалы».'), expanded, `${label}: the pointer only when expanded`);
        assert.ok(text.includes('выберите операцию в журнале') === expanded || !expanded, `${label}: the long quote is in the expanded block`);
        assert.ok(lines.at(-1)!.endsWith(expanded ? 'свернуть' : 'подробнее'), `${label}: the hint is the last row, got «${lines.at(-1)}»`);
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
      assert.equal(lines.at(-1), expanded ? 'ПОДСКАЗКА-СВЕРНУТЬ' : 'ПОДСКАЗКА-ПОДРОБНЕЕ', 'the injected hint closes the block, unpainted and unescaped');
      assert.ok(lines[0]!.startsWith('<error><b>Агент справляется плохо'), `${width}: V1 is bold error`);
      assert.equal(lines.some(line => plain(line).startsWith('? ') || plain(line).startsWith('  ? ')), expanded, `${width}: «?» rows only when expanded`);
    }
  }
  assert.ok(new Set(marks).size <= 8 && ['error', 'accent', 'muted', 'text'].every(tone => marks.includes(tone)), `tones used: ${[...new Set(marks)].join(', ')}`);
  const component: Component = new VerdictBlock(view, false, fake, hint);
  component.invalidate();
  assert.ok(Array.isArray(component.render(80)));
});
