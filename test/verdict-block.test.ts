import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initTheme, ToolExecutionComponent, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import agentLab from '../extensions/agent-lab.ts';
import { forgetViews, isVerdictDetails, VERDICT_KIND, viewFor, type VerdictDetails } from '../extensions/render/verdict-block.ts';
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
