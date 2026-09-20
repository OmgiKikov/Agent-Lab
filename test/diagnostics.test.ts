import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareDiagnostic, runDiagnostic } from '../src/diagnostics.js';
import { syncIssues } from '../src/issues.js';
import { issueRecord } from './helpers/issues.js';
import { ExperimentLab } from '../src/experiment.js';
import { createDemoRuntime } from '../src/demo.js';
import { fingerprint, type Runtime } from '../src/contracts.js';

const intervention = { kind: 'tool-response' as const, tool: 'update_record' as const, call: 1, response: { ok: true }, hypothesis: 'Причина — временная ошибка инструмента' };
function fixture() { const source = issueRecord(); return { source, issue: syncIssues(source, []).issues[0]! }; }

test('immutable paired plan rejects unsupported HTTP and unverified RAG before any target call', () => {
  const { source, issue } = fixture();
  const plan = prepareDiagnostic(issue, source, intervention, 2);
  source.scenarios[0]!.title = 'changed'; assert.equal(plan.source.scenarios[0]!.title, 'Возврат');
  assert.throws(() => { plan.source.scenarios[0]!.title = 'tamper'; }, TypeError);
  assert.equal(plan.repeats, 2); assert.equal(plan.source.settings.repeats, 1);
  source.target = { kind: 'http', url: 'http://localhost:1', headersEnv: {}, timeoutMs: 1000 };
  assert.throws(() => prepareDiagnostic(issue, source, intervention, 2), /возможност|поддерж/i);
  source.target = { kind: 'sandbox' }; source.scenarios[0]!.title = 'Возврат';
  assert.throws(() => prepareDiagnostic(issue, source, { kind: 'rag-fragment', sourceId: 'absent', sourceHash: 'a'.repeat(64), content: 'invented', hypothesis: 'Нет контекста' }, 1), /фрагмент|источник/i);
});

test('real runner substitutes reply without faking state mutation; diagnostic does not add issue evidence; duplicated start spends nothing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'diagnostics-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let sessions = 0;
  const runtime: Runtime = { ...createDemoRuntime(), async openTarget(_agent, _sources, tools, ctx) { sessions++; return { async respond() { ctx.beforeCall(); const reply = await tools.find(t => t.name === 'update_record')!.execute({ recordId: 'item', changes: { status: 'done' } }); return JSON.stringify(reply); }, async close() {} }; } };
  const lab = new ExperimentLab(dir, runtime); await lab.init(); t.after(() => lab.close());
  const { source } = fixture(); await lab.store.save(source); await lab.store.syncIssues(source);
  const issue = (await lab.store.readIssues())[0]!;
  const plan = await lab.prepareDiagnostic(issue.id, source.id, intervention, 2);
  const started = await lab.startDiagnostic(plan.id); await lab.waitForIdle();
  const record = await lab.get(started.id), diagnostic = await lab.store.readDiagnostic(plan.id);
  assert.equal(sessions, 4); assert.equal(record.runKind, 'diagnostic'); assert.equal(record.trials.length, 4);
  assert.equal(diagnostic.result!.conclusion, 'refutes');
  const changed = record.trials.filter(t => t.diagnosticReceipt!.arm === 'intervention');
  assert.ok(changed.every(t => t.finalState.records.item!.status === 'pending'));
  assert.ok(changed.every(t => t.events.some(e => e.type === 'tool_result' && (e.result as any).ok === true)));
  assert.equal((await lab.store.readIssues())[0]!.evidence.length, 1);
  const duplicate = await lab.startDiagnostic(plan.id); await lab.waitForIdle(); assert.equal(duplicate.id, started.id); assert.equal(sessions, 4);
});

test('partial, cancelled, unacknowledged and missing-reset pairs are inconclusive', async () => {
  const { source, issue } = fixture(), plan = prepareDiagnostic(issue, source, intervention, 2);
  const partial = await runDiagnostic(plan, async () => []);
  assert.equal(partial.conclusion, 'inconclusive');
  const cancelled = await runDiagnostic(plan, async () => { throw new Error('Остановлено'); });
  assert.equal(cancelled.conclusion, 'inconclusive'); assert.match(cancelled.reasons.join(' '), /Остановлено/);
  const incomplete = await runDiagnostic(plan, async () => source.trials);
  assert.equal(incomplete.conclusion, 'inconclusive');
});

test('module child receives exact intervention and acknowledges it; missing ack/reset cannot support hypothesis', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'diagnostic-module-')); t.after(() => rm(dir, { recursive: true, force: true }));
  for (const mode of ['good', 'no-ack', 'no-reset'] as const) {
    const path = join(dir, `${mode}.mjs`);
    await writeFile(path, `export function createSession(input) { const d=input.diagnosticRequest; if(!d) throw new Error('No diagnostic request in child'); return { async respond() {return { reply: d.arm==='intervention'?'готово':'ошибка', records:input.initialState.records, resetConfirmed:${mode !== 'no-reset'}, eventsComplete:true, version:'v1', ${mode === 'no-ack' ? '' : "diagnosticReceipt:{protocol:d.protocol, requestHash:d.requestHash, arm:d.arm, factorHash:d.factorHash, appliedCount:d.arm==='intervention'?1:0},"} }; } }; }`);
    const lab = new ExperimentLab(join(dir, mode), createDemoRuntime()); await lab.init();
    try {
      const source = issueRecord(); source.target = { kind: 'module', path, exportName: 'createSession', diagnosticCapabilities: { protocol: 'paired-intervention-v1', toolResponse: true, ragFragment: true } };
      source.scenarios[0]!.checks = [{ id: 'done', kind: 'answer_equals', description: 'Подтверждение', value: 'готово' }];
      await lab.store.save(source); await lab.store.syncIssues(source);
      const issue = (await lab.store.readIssues())[0]!, plan = await lab.prepareDiagnostic(issue.id, source.id, intervention, 1);
      const run = await lab.startDiagnostic(plan.id); await lab.waitForIdle();
      const saved = await lab.store.readDiagnostic(plan.id);
      assert.equal(saved.result!.conclusion, mode === 'good' ? 'supports' : 'inconclusive', JSON.stringify(await lab.get(run.id)));
      if (mode === 'good') assert.ok((await lab.get(run.id)).trials.every(t => t.events.some(e => e.type === 'observation' && (e.result as any)?.diagnosticReceipt)));
    } finally { await lab.close(); }
  }
});

test('verified RAG fragment changes actual target-visible tool context while frozen source and evaluator stay identical', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'diagnostic-rag-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime: Runtime = { ...createDemoRuntime(), async openTarget(_agent, _sources, tools, ctx) { return { async respond() { ctx.beforeCall(); const result = await tools.find(t => t.name === 'search_materials')!.execute({ query: 'unfindable' }) as any; return result.matches[0]?.content ?? 'не найдено'; }, async close() {} }; } };
  const lab = new ExperimentLab(dir, runtime); await lab.init(); t.after(() => lab.close());
  const source = issueRecord(); source.sources = [{ id: 'verified', name: 'Правило', content: 'Возврат возможен', hash: fingerprint('Возврат возможен') }];
  source.scenarios[0]!.checks = [{ id: 'done', kind: 'answer_equals', description: 'Верное правило', value: 'Возврат возможен' }];
  await lab.store.save(source); await lab.store.syncIssues(source);
  const issue = (await lab.store.readIssues())[0]!;
  const plan = await lab.prepareDiagnostic(issue.id, source.id, { kind: 'rag-fragment', sourceId: 'verified', sourceHash: fingerprint('Возврат возможен'), content: 'Возврат возможен', hypothesis: 'Отсутствует релевантный контекст' }, 2);
  const run = await lab.startDiagnostic(plan.id); await lab.waitForIdle();
  const record = await lab.get(run.id), result = (await lab.store.readDiagnostic(plan.id)).result!;
  assert.equal(result.conclusion, 'supports'); assert.equal(result.pairs.length, 2);
  assert.equal(new Set(record.trials.map(t => t.manifestHash)).size, 1);
  assert.deepEqual(record.scenarios, source.scenarios); assert.deepEqual(record.sources, source.sources);
  assert.ok(record.trials.filter(t => t.diagnosticReceipt!.arm === 'intervention').every(t => t.events.some(e => e.type === 'assistant' && e.text === 'Возврат возможен')));
});

test('shared budget cancellation persists both partial traces and inconclusive result', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'diagnostic-budget-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime: Runtime = { ...createDemoRuntime(), async openTarget(_agent, _sources, tools, ctx) { return { async respond() { for (let i = 0; i < 5; i++) ctx.beforeCall(); await tools.find(t => t.name === 'update_record')!.execute({ recordId: 'item', changes: { status: 'done' } }); return 'не получилось'; }, async close() {} }; } };
  const lab = new ExperimentLab(dir, runtime); await lab.init(); t.after(() => lab.close());
  const source = issueRecord(); source.settings.maxCalls = 5;
  await lab.store.save(source); await lab.store.syncIssues(source);
  const issue = (await lab.store.readIssues())[0]!, plan = await lab.prepareDiagnostic(issue.id, source.id, intervention, 1);
  const run = await lab.startDiagnostic(plan.id); await lab.waitForIdle();
  const saved = await lab.get(run.id);
  assert.equal(saved.usage.calls, 5); assert.ok(saved.trials.some(t => t.outcome === 'cancelled'));
  assert.equal((await lab.store.readDiagnostic(plan.id)).result!.conclusion, 'inconclusive');
  assert.ok(saved.trials.every(t => t.events.length > 0));
});

test('accepted multi-variant library retains immutable full snapshot while diagnostics executes only selected variant through controller/checkpoints', async t => {
  const { libraryFixture } = await import('./helpers/scenario-library.js');
  const { acceptLibrary, compileLibrary, libraryHash } = await import('../src/scenario-library.js');
  const dir = await mkdtemp(join(tmpdir(), 'diagnostic-library-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const library = libraryFixture();
  const accepted = acceptLibrary(library, libraryHash(library), ['variant_1', 'variant_2']);
  const source = issueRecord(); source.librarySnapshot = accepted; source.scenarios = compileLibrary(accepted); source.sources = accepted.sources; source.requirements = accepted.requirements;
  source.settings.userModes = ['reactive']; source.selectedScenarioIds = source.scenarios.map(s => s.id);
  const scenario = source.scenarios[0]!, trial = source.trials[0]!; trial.scenarioId = scenario.id; trial.familyId = scenario.familyId; trial.userMode = 'reactive'; trial.checks = [];
  trial.initialState = scenario.initialState; trial.finalState = scenario.initialState;
  trial.checkpoints = [{ checkpointId: 'ask_terminal', requirementId: 'terminal_rule', role: 'required', observation: 'reply', result: 'fail', evidence: [1], rationale: 'Не уточнил номер' }];
  let sessions = 0;
  const runtime: Runtime = { ...createDemoRuntime(), async selectUserAction() { return { actionId: 'finish', factIds: [] };  }, async assessCheckpoints() { return [{ checkpointId: 'ask_terminal', result: 'fail', evidence: [1], rationale: 'Не уточнил номер' }]; }, async openTarget(_a, _s, tools, ctx) { sessions++; return { async respond() { await tools.find(t => t.name === 'search_materials')!.execute({ query: 'правило' }); return 'Возврат выполнен'; }, async close() {} }; } };
  const lab = new ExperimentLab(dir, runtime); await lab.init(); t.after(() => lab.close());
  await lab.store.save(source); await lab.store.syncIssues(source);
  const issue = (await lab.store.readIssues())[0]!, plan = await lab.prepareDiagnostic(issue.id, source.id, { ...intervention, tool: 'search_materials' }, 1);
  assert.equal(plan.source.scenarios.length, 2); assert.equal(plan.source.librarySnapshot!.acceptance!.variantIds.length, 2);
  const run = await lab.startDiagnostic(plan.id); await lab.waitForIdle(); const saved = await lab.get(run.id);
  assert.equal(sessions, 2); assert.equal(saved.phase, 'results_review'); assert.equal(saved.scenarios.length, 1);
  assert.ok(saved.trials.every(t => t.checkpointReceipt && t.checkpoints?.length === 1));
  assert.deepEqual((await lab.store.readDiagnostic(plan.id)).plan.source.scenarios, source.scenarios);
});

test('arm failure after a completed trial remains inconclusive and retains the completed pair reference', async () => {
  const { diagnosticRequest } = await import('../src/diagnostics.js');
  const { source, issue } = fixture(), plan = prepareDiagnostic(issue, source, intervention, 1);
  const result = await runDiagnostic(plan, async arm => {
    const trial = structuredClone(source.trials[0]!), request = diagnosticRequest(plan, arm);
    trial.diagnosticReceipt = { protocol: request.protocol, requestHash: request.requestHash, arm, factorHash: request.factorHash, appliedCount: arm === 'baseline' ? 0 : 1 };
    return { trials: [trial], error: 'Версия изменилась после диалога' };
  });
  assert.equal(result.conclusion, 'inconclusive'); assert.equal(result.pairs[0]!.baselineTrialId, 'trial_a'); assert.match(result.reasons.join(' '), /Версия изменилась/);
});

test('identical fixture response does not attest a changed factor', async () => {
  const { sandbox } = await import('../src/sandbox.js');
  const { diagnosticRequest } = await import('../src/diagnostics.js');
  const { source, issue } = fixture();
  const plan = prepareDiagnostic(issue, source, { ...intervention, response: { ok: false, error: 'Temporary update failure; retry is safe', retryable: true } }, 1);
  let receipt: any;
  const tools = sandbox(structuredClone(source.scenarios[0]!.initialState), [], () => {}, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {}, diagnosticRequest: diagnosticRequest(plan, 'intervention'), onDiagnosticReceipt(value) { receipt = value; } });
  await tools.find(t => t.name === 'update_record')!.execute({ recordId: 'item', changes: { status: 'done' } });
  assert.equal(receipt.appliedCount, 0);
});
