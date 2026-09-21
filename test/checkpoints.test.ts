import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCheckpoints, checkpointInput, requiredCheckpointResult } from '../src/checkpoints.js';
import { acceptLibrary, compileLibrary, libraryHash } from '../src/scenario-library.js';
import { libraryFixture } from './helpers/scenario-library.js';
import { emptyUsage, trialSchema, type Scenario, type Trial } from '../src/contracts.js';
import { headlineTrialResult } from '../src/outcomes.js';
import { grade, assessTrial } from '../src/evaluation.js';

function fixture() {
  const library = libraryFixture();
  const scenario = compileLibrary(acceptLibrary(library, libraryHash(library), ['variant_1']))[0]!;
  const trial: Trial = { id: 'trial', revisionId: 'base', scenarioId: scenario.id, familyId: scenario.familyId, repeat: 0, userMode: 'reactive', split: 'dev', manifestHash: 'snapshot', outcome: 'ungraded', reason: '', checks: [],
    events: [{ seq: 0, type: 'user', text: 'Нет номера терминала, помогите с возвратом' }, { seq: 1, type: 'assistant', text: 'Без номера возврат невозможен. Обратитесь в отдел поддержки.' }],
    initialState: scenario.initialState, finalState: scenario.initialState, observation: { state: 'sandbox', tools: 'sandbox' }, usage: emptyUsage(), elapsedMs: 0 };
  scenario.execution!.evaluatorView.checkpoints[0]!.rule = 'При отсутствии номера корректно объяснить отказ или передать поддержке';
  return { scenario, trial };
}
const decision = (result: string, evidence = [1]) => [{ checkpointId: 'ask_terminal', result, evidence, rationale: 'Правило применимо к запросу возврата; ответ подтверждает допустимый отказ.' }];

test('checkpoint results preserve requirement/event references, correct refusal and inactive alternative path', () => {
  const { scenario, trial } = fixture();
  const results = evaluateCheckpoints(scenario, trial, decision('pass'), grade);
  assert.deepEqual(results.map(({ checkpointId, requirementId, result, evidence }) => ({ checkpointId, requirementId, result, evidence })), [{ checkpointId: 'ask_terminal', requirementId: 'terminal_rule', result: 'pass', evidence: [1] }]);
  assert.equal(evaluateCheckpoints(scenario, trial, decision('fail'), grade)[0]!.result, 'fail');
  assert.equal(evaluateCheckpoints(scenario, trial, decision('not_applicable', [0]), grade)[0]!.result, 'not_applicable');
  assert.throws(() => evaluateCheckpoints(scenario, trial, decision('pass', [99]), grade), /событ|доказ/i);
});

test('missing tool/state evidence and wrong-channel check cannot pass by assistant assertion', () => {
  const { scenario, trial } = fixture();
  const cp = scenario.execution!.evaluatorView.checkpoints[0]!;
  cp.observation = 'state'; trial.observation = { state: 'missing', tools: 'partial' };
  assert.equal(evaluateCheckpoints(scenario, trial, decision('pass'), grade)[0]!.result, 'unknown');
  cp.observation = 'tool';
  assert.equal(evaluateCheckpoints(scenario, trial, decision('pass'), grade)[0]!.result, 'unknown');
  cp.observation = 'reply'; cp.check = { id: 'mutation', kind: 'state_equals', description: 'Статус изменён', recordId: 'item', field: 'status', value: 'done' };
  assert.equal(evaluateCheckpoints(scenario, trial, decision('pass'), grade)[0]!.result, 'unknown');
  const payload = checkpointInput(scenario, trial);
  assert.doesNotMatch(JSON.stringify(payload), /finalState|initialState|assessments|outcome|simulatorChecks/);
});

test('diagnostic failures never change required checkpoint outcome or the existing headline', () => {
  const { scenario, trial } = fixture();
  scenario.execution!.evaluatorView.checkpoints.push({ ...scenario.execution!.evaluatorView.checkpoints[0]!, id: 'diagnostic', role: 'diagnostic' });
  trial.checkpoints = evaluateCheckpoints(scenario, trial, [...decision('pass'), { ...decision('fail')[0]!, checkpointId: 'diagnostic' }], grade);
  trial.assessments = [{ metricId: 'library_required', result: 'pass', rationale: 'Корректный отказ', evidence: [1] }];
  assert.equal(requiredCheckpointResult(scenario, trial), 'pass');
  assert.equal(headlineTrialResult(scenario, trial), 'pass');
  trial.checkpoints[0]!.result = 'unknown';
  assert.equal(headlineTrialResult(scenario, trial), 'unknown');
  trial.checkpoints[0]!.result = 'fail';
  assert.equal(headlineTrialResult(scenario, trial), 'fail');
  trial.checkpoints[0]!.result = 'not_applicable';
  assert.equal(headlineTrialResult(scenario, trial), 'pass');
  assert.ok(trialSchema.safeParse(trial).success);
});

test('reassessment replaces checkpoint results using frozen requirements and immutable observation identity', async () => {
  const { scenario, trial } = fixture();
  let result = 'fail';
  const runtime = { async assessCheckpoints(input: unknown, ctx: { beforeCall(): void }) { ctx.beforeCall(); assert.match(JSON.stringify(input), /terminal_rule/); return decision(result); },
    async assess() { return [{ metricId: 'library_required', result: 'pass', rationale: 'Допустимый ответ', evidence: [1] }]; } } as any;
  const ctx = { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} };
  await assessTrial(runtime, scenario, [], trial, ctx, []);
  assert.equal(trial.checkpoints?.[0]?.result, 'fail');
  const first = structuredClone(trial.checkpointReceipt);
  result = 'pass';
  await assessTrial(runtime, scenario, [], trial, ctx, []);
  assert.equal(trial.checkpoints?.[0]?.result, 'pass');
  assert.equal(trial.checkpointReceipt?.inputHash, first?.inputHash);
  assert.notEqual(trial.checkpointReceipt?.resultHash, first?.resultHash);
  assert.ok(trialSchema.safeParse(trial).success);
});

test('deterministic checkpoint honors conditional applicability and never trusts a judge over actual text', () => {
  const { scenario, trial } = fixture();
  const cp = scenario.execution!.evaluatorView.checkpoints[0]!;
  cp.check = { id: 'literal', kind: 'answer_equals', description: 'Точный отказ', value: 'Недостаточно данных' };
  scenario.checks = [cp.check as any];
  assert.deepEqual(grade(scenario, trial), [], 'conditional checks must wait for applicability');
  assert.equal(evaluateCheckpoints(scenario, trial, decision('pass'), grade)[0]!.result, 'fail');
  assert.equal(evaluateCheckpoints(scenario, trial, decision('not_applicable', [0]), grade)[0]!.result, 'not_applicable');
});

test('all-deterministic compiled card still evaluates checkpoints without a rubric assessor', async () => {
  const { scenario, trial } = fixture();
  delete scenario.metrics;
  const runtime = { async assessCheckpoints() { return decision('pass'); } } as any;
  await assessTrial(runtime, scenario, [], trial, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} }, []);
  assert.equal(trial.checkpoints?.[0]!.result, 'pass');
});

test('actual model mixed reply/context citations keep channel proof while never substituting prose for tools', () => {
  const { scenario, trial } = fixture();
  trial.events.push({ seq: 3, type: 'user', text: 'Номер терминала: 1234' }, { seq: 4, type: 'assistant', text: 'Возврат принят' });
  const raw = decision('pass', [0, 1, 3, 4]);
  const reply = evaluateCheckpoints(scenario, trial, raw, grade)[0]!;
  assert.equal(reply.result, 'pass');
  assert.deepEqual(reply.evidence, [1, 4]);
  assert.deepEqual(reply.contextEvidence, [0, 3]);
  scenario.execution!.evaluatorView.checkpoints[0]!.observation = 'tool';
  assert.equal(evaluateCheckpoints(scenario, trial, raw, grade)[0]!.result, 'unknown');
});

test('checkpoint receipts bind raw decisions, result and frozen requirements before reuse', async () => {
  const { checkpointReceipt, checkpointReceiptValid } = await import('../src/checkpoints.js');
  const { scenario, trial } = fixture();
  const raw = decision('pass') as any;
  trial.checkpoints = evaluateCheckpoints(scenario, trial, raw, grade);
  trial.checkpointReceipt = checkpointReceipt(scenario, trial, trial.checkpoints, raw);
  assert.equal(checkpointReceiptValid(scenario, trial), true);
  trial.checkpointReceipt.decisions[0]!.rationale = 'Переписанный ответ';
  assert.equal(checkpointReceiptValid(scenario, trial), false);
  trial.checkpointReceipt = checkpointReceipt(scenario, trial, trial.checkpoints, raw);
  scenario.execution!.evaluatorView.requirements[0]!.text = 'Другое требование';
  assert.equal(checkpointReceiptValid(scenario, trial), false);
});

test('checkpoint audit survives the existing writer and code-only reassessment cannot reuse a stale result', async t => {
  const { checkpointReceipt } = await import('../src/checkpoints.js');
  const { demoEvaluateRecord } = await import('./helpers/demo-record.js');
  const { rm, stat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { lab, directory, record } = await demoEvaluateRecord();
  t.after(async () => { await lab.close(); await rm(directory, { recursive: true, force: true }); });
  const { scenario, trial } = fixture();
  const raw = decision('pass') as any;
  trial.checkpoints = evaluateCheckpoints(scenario, trial, raw, grade);
  trial.checkpointReceipt = checkpointReceipt(scenario, trial, trial.checkpoints, raw);
  record.scenarios = [scenario]; record.trials = [trial]; record.settings.repeats = 1; record.settings.userModes = ['reactive'];
  record.requirements = scenario.execution!.evaluatorView.requirements;
  record.sources = [{ id: 'policy', name: 'Правило', content: 'Уточните номер терминала', hash: 'source-hash' }];
  await lab.store.save(record);
  const saved = await lab.get(record.id);
  assert.deepEqual(saved.trials[0]!.checkpointReceipt, trial.checkpointReceipt);
  assert.deepEqual(saved.trials[0]!.checkpoints, trial.checkpoints);
  assert.equal((await stat(join(directory, 'runs', `${record.id}.json`))).mode & 0o777, 0o600);
  const copy = await lab.reassess(record.id, { codeOnly: true }); await lab.waitForIdle();
  const reassessed = await lab.get(copy.id);
  assert.equal(reassessed.trials[0]!.checkpoints, undefined);
  assert.match(reassessed.trials[0]!.assessmentError ?? '', /не переоценивались/);
  assert.deepEqual((await lab.get(record.id)).trials[0]!.checkpoints, trial.checkpoints, 'historical evidence stays immutable');
});

test('missing or ungrounded diagnostic decisions cannot erase a supported required checkpoint', () => {
  const { scenario, trial } = fixture();
  scenario.execution!.evaluatorView.checkpoints.push({ ...scenario.execution!.evaluatorView.checkpoints[0]!, id: 'diagnostic', role: 'diagnostic' });
  const omitted = evaluateCheckpoints(scenario, trial, decision('pass'), grade);
  assert.deepEqual(omitted.map(c => c.result), ['pass', 'unknown']);
  const ungrounded = evaluateCheckpoints(scenario, trial, [...decision('pass'), { ...decision('fail', [99])[0]!, checkpointId: 'diagnostic' }], grade);
  assert.deepEqual(ungrounded.map(c => c.result), ['pass', 'unknown']);
});

test('checkpoint receipt identity survives schema-normalized persistence', async () => {
  const { checkpointReceipt, checkpointReceiptValid } = await import('../src/checkpoints.js');
  const { scenario, trial } = fixture();
  const raw = decision('pass') as any; raw[0].rationale = '  Подтверждено ответом  ';
  trial.checkpoints = evaluateCheckpoints(scenario, trial, raw, grade);
  trial.checkpointReceipt = checkpointReceipt(scenario, trial, trial.checkpoints, raw);
  assert.equal(checkpointReceiptValid(scenario, trialSchema.parse(trial)), true);
});

test('missing required observations cannot become agent failure through the grouped prose rubric', () => {
  const { scenario, trial } = fixture();
  trial.checkpoints = evaluateCheckpoints(scenario, trial, decision('unknown', []), grade);
  trial.assessments = [{ metricId: 'library_required', result: 'fail', rationale: 'Не выполнил действие', evidence: [1] }];
  assert.equal(headlineTrialResult(scenario, trial), 'unknown');
});

test('duplicate or malformed known diagnostics preserve exact required pass and headline through assessment and persistence', async () => {
  const { checkpointReceiptValid } = await import('../src/checkpoints.js');
  const diagnostic = { ...decision('unknown', [])[0]!, checkpointId: 'diagnostic' };
  for (const diagnostics of [[diagnostic, diagnostic], Array.from({ length: 12 }, () => diagnostic), [{ checkpointId: 'diagnostic', result: 7, evidence: 'bad', rationale: null }]]) {
    const { scenario, trial } = fixture(); delete scenario.metrics;
    const required = scenario.execution!.evaluatorView.checkpoints[0]!;
    required.check = { id: 'exact', kind: 'answer_contains', description: 'Корректный отказ', value: 'Без номера возврат невозможен' };
    scenario.checks = [required.check as any];
    scenario.execution!.evaluatorView.checkpoints.push({ ...required, id: 'diagnostic', role: 'diagnostic' });
    const raw = [...decision('pass'), ...diagnostics];
    await assessTrial({ async assessCheckpoints() { return raw; } } as any, scenario, [], trial, { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} }, []);
    assert.deepEqual(trial.checkpoints?.map(c => [c.checkpointId, c.result]), [['ask_terminal', 'pass'], ['diagnostic', 'unknown']]);
    assert.equal(headlineTrialResult(scenario, trial), 'pass');
    const persisted = trialSchema.parse(trial);
    assert.equal(checkpointReceiptValid(scenario, persisted), true);
    assert.equal(headlineTrialResult(scenario, persisted), 'pass');
    assert.deepEqual(persisted.checkpointReceipt?.decisions, raw, 'retain malformed/duplicate diagnostic evidence rather than silently dropping it');
  }
});

test('required malformed or duplicate results and unknown checkpoint IDs remain strict', () => {
  const { scenario, trial } = fixture();
  for (const raw of [
    [...decision('pass'), ...decision('pass')],
    [{ ...decision('pass')[0], result: 7 }],
    [...decision('pass'), { ...decision('unknown')[0], checkpointId: 'undeclared' }],
  ]) assert.throws(() => evaluateCheckpoints(scenario, trial, raw, grade));
});

test('reply checkpoint retains observed tool failure as context while requiring actual reply evidence',()=>{
 const {scenario,trial}=fixture();trial.events=[{seq:0,type:'user',text:'Обновите адрес'},{seq:1,type:'tool_result',tool:'update_record',result:{ok:false,error:'Ошибка обновления'},state:trial.initialState},{seq:2,type:'assistant',text:'Адрес обновлён'}];
 const input=checkpointInput(scenario,trial);assert.deepEqual(input.checkpoints[0].context,[{seq:1,type:'tool_result',tool:'update_record',result:{ok:false,error:'Ошибка обновления'}}]);
 const evaluated=evaluateCheckpoints(scenario,trial,decision('fail',[1,2]),grade)[0];assert.equal(evaluated.result,'fail');assert.deepEqual(evaluated.evidence,[2]);assert.deepEqual(evaluated.contextEvidence,[1]);
 assert.equal(evaluateCheckpoints(scenario,trial,decision('fail',[1]),grade)[0].result,'unknown');
});

test('legacy library compilation preserves frozen checkpoint protocol and omits newly observed tool context',()=>{
 const library=libraryFixture();delete library.checkpointContext;
 const scenario=compileLibrary(acceptLibrary(library,libraryHash(library),['variant_1']))[0]!;
 assert.equal(scenario.execution!.checkpointContext,undefined);
 assert.equal(scenario.execution!.checkpointHash,'670d394b822ba251e5a791dab189d1a4b9c35ec1e10649ce7d0c93b1ca9cba33');
});
