import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { ExperimentStore } from '../src/store.js';
import { issueRecord } from './helpers/issues.js';
import extension from '../extensions/agent-lab.ts';

test('CLI and native actions prepare the same immutable plan; declined native run does not spend', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'issue-surfaces-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new ExperimentStore(join(cwd, '.agent-lab')); await store.init();
  const source = issueRecord(); await store.save(source); await store.syncIssues(source); const issue = (await store.readIssues())[0]!; await store.close();
  const tools = new Map<string, any>(); extension({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, on() {} } as any);
  const request = { issueId: issue.id, sourceRunId: source.id, repeats: 1, intervention: { kind: 'tool-response', tool: 'update_record', call: 1, response: { ok: true }, hypothesis: 'Проверка ответа' } };
  const parse = (reply: any) => JSON.parse(reply.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n'));
  const ctx = { cwd, hasUI: true, mode: 'tui', ui: { confirm: async () => false } };
  assert.ok(tools.has('agent_lab_issues')); assert.ok(tools.has('agent_lab_diagnostics'));
  const prepared = parse(await tools.get('agent_lab_diagnostics').execute('prepare', { operation: 'prepare', input: request }, new AbortController().signal, undefined, ctx));
  const file = join(cwd, 'request.json'); await writeFile(file, JSON.stringify(request));
  const cli = spawnSync(process.execPath, ['dist/cli.js', 'diagnostics', '--operation', 'prepare', '--input', file, '--data-dir', store.directory], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).plan.id, prepared.plan.id);
  const declined = parse(await tools.get('agent_lab_diagnostics').execute('run', { operation: 'run', id: prepared.plan.id }, new AbortController().signal, undefined, ctx));
  assert.equal(declined.cancelled, true); assert.equal((await store.readDiagnostic(prepared.plan.id)).runId, undefined);
  const inspected = parse(await tools.get('agent_lab_issues').execute('inspect', { operation: 'inspect', id: issue.id, assessmentId: issue.evidence[0]!.assessmentId }, new AbortController().signal, undefined, ctx));
  assert.equal(inspected.detail.assessment.trial.events.items[1].content, 'Не получилось');
});

test('results workspace exposes issues action and compact tools paginate evidence without loading full traces', async () => {
  const { LabBoard } = await import('../extensions/cards.ts');
  const { compactIssues } = await import('../src/issue-view.js');
  const { syncIssues } = await import('../src/issues.js');
  const record = issueRecord(); let selected: any;
  const board = new LabBoard({ record, section: 'results' }, { fg: (_: string, value: string) => value, bold: (value: string) => value } as any, action => { selected = action; }, () => {});
  board.render(120); board.handleInput('i'); assert.equal(selected.type, 'issues');
  selected = undefined; const overview = new LabBoard({ record, section: 'agent' }, { fg: (_: string, value: string) => value, bold: (value: string) => value } as any, action => { selected = action; }, () => {});
  overview.render(120); overview.handleInput('i'); assert.equal(selected?.type, 'issues');
  const issues = syncIssues(record, []).issues; const first = issues[0]!;
  first.evidence = Array.from({ length: 100 }, (_, n) => ({ ...first.evidence[0]!, assessmentId: String(n).padStart(64, 'a') }));
  const summary = compactIssues({ formatVersion: '1', issues, suggestions: [], decisions: [] }, { id: first.id, offset: 0, limit: 5 });
  assert.ok(JSON.stringify(summary).length < 12000); assert.doesNotMatch(JSON.stringify(summary), /Не получилось/);
  assert.equal(summary.issues[0]!.evidence.items.length, 5); assert.equal(summary.issues[0]!.evidence.nextOffset, 5);
});

test('native issue workspace navigates immutable evidence, prepares and runs a pair through the shared lab', async t => {
  const { ExperimentLab } = await import('../src/experiment.js');
  const { createDemoRuntime } = await import('../src/demo.js');
  const { showIssueWorkspace } = await import('../extensions/issues.ts');
  const dir = await mkdtemp(join(tmpdir(), 'issue-workspace-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const lab = new ExperimentLab(dir, { ...createDemoRuntime(), async openTarget(_a, _s, tools, ctx) { return { async respond() { await tools.find(t => t.name === 'update_record')!.execute({ recordId: 'item', changes: { status: 'done' } }); return 'Не получилось'; }, async close() {} }; } });
  await lab.init(); t.after(() => lab.close()); const source = issueRecord(); await lab.store.save(source); await lab.store.syncIssues(source);
  let issueActions = 0, planActions = 0, editorCalls = 0; const viewed: string[] = [];
  const ctx = { signal: new AbortController().signal, ui: {
    select: async (title: string, choices: string[]) => {
      if (title === 'Ошибка возврата') return issueActions++ === 0 ? 'Точная исходная оценка и трасса' : 'Подготовить парную диагностику';
      if (title === 'Парная диагностика') return ['План и результат', 'Запустить обе стороны', 'Открыть трассу пары', 'Открыть прогон'][planActions++];
      return choices[0];
    }, editor: async () => editorCalls++ === 0 ? 'Проверяем ошибку ответа' : '{"ok":true}', input: async () => '1', confirm: async () => true,
    custom: async (factory: any) => { const component = factory({ requestRender() {}, terminal: { rows: 100 } }, { fg: (_: string, value: string) => value }, {}, () => {}); viewed.push(component.render(120).join('\n')); component.handleInput('\r'); },
  } };
  const runId = await showIssueWorkspace(ctx as any, source, lab, async () => lab);
  assert.ok(runId); assert.equal((await lab.get(runId)).runKind, 'diagnostic'); assert.equal((await lab.get(runId)).trials.length, 2);
  assert.ok(viewed.some(text => text.includes('Критерий:'))); assert.ok(viewed.some(text => text.includes('Гипотеза:'))); assert.ok(viewed.some(text => text.includes('#1')));
});
