import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { ExperimentStore } from '../src/store.js';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assessTrial, evaluateTrial } from '../src/evaluation.js';
import { compareTrials } from '../src/comparison.js';
import { assessRepeated, hasCompleteJudgment, observableSources } from '../src/judge.js';
import { createDemoRuntime, demoInput } from '../src/demo.js';
import { checkSchema, fingerprint, observedGoalSchema, validationScenario, validatePreparation, type CallContext, type JudgeAudit, type MetricAssessment, type Revision, type Rubric, type Runtime, type Scenario, type Source, type Tool, type Trial } from '../src/contracts.js';

function context(signal = new AbortController().signal): CallContext {
  return { signal, timeoutMs: 1000, beforeCall() { signal.throwIfAborted(); }, addUsage() {} };
}
async function fixture() {
  const input = demoInput();
  const sources: Source[] = input.materials.map((m, i) => ({ ...m, id: `source_${i}`, hash: fingerprint(m.content) }));
  const runtime = createDemoRuntime();
  const preparation = validatePreparation(await runtime.prepare({ task: input.task, sources }, context()), sources);
  const baseline: Revision = { id: 'baseline', parentId: null, createdAt: '2026-01-01T00:00:00Z', hypothesis: 'Original', spec: preparation.agent };
  const candidate: Revision = { ...structuredClone(baseline), id: 'candidate', parentId: 'baseline', spec: { ...preparation.agent, tools: [...preparation.agent.tools, 'update_record'] } };
  const evaluate = (scenario = preparation.scenarios[0]!, revision = baseline, actor = runtime, ctx = context(), repeat = 0, onStage?: Parameters<typeof evaluateTrial>[0]['onStage']) => evaluateTrial({ requirements: [], runtime: actor, revision, scenario, repeat, manifestHash: 'frozen', sources, settings: input.settings, ctx, userMode: 'reactive', target: { kind: 'sandbox' }, onStage });
  return { input, sources, runtime, preparation, baseline, candidate, evaluate };
}

test('scripted sample executes real tools, repairs observed failures, handles clarification/retries/preference changes, and preserves read-only cases', async () => {
  const f = await fixture();
  const trials: Trial[] = [];
  for (const scenario of f.preparation.scenarios) trials.push(await f.evaluate(scenario));
  assert.equal(trials.filter(t => t.outcome === 'pass').length, 2);
  assert.ok(trials.filter(t => t.outcome === 'fail').length >= 8);
  const proposal = await f.runtime.improve({ task: f.input.task, sources: f.sources, requirements: f.preparation.requirements, agent: f.baseline.spec,
    feedback: f.preparation.scenarios.filter(s => s.split === 'dev').map(scenario => ({ scenario, trials: trials.filter(t => t.scenarioId === scenario.id) })) }, context());
  assert.ok(proposal.agent.tools.includes('update_record'));
  const revision = { ...f.candidate, spec: proposal.agent };
  for (const scenario of f.preparation.scenarios) {
    const trial = await f.evaluate(scenario, revision);
    assert.equal(trial.outcome, 'pass', `${scenario.id}: ${trial.reason}`);
    assert.ok(trial.usage.calls >= 1);
    trials.push(trial);
  }
  const control = compareTrials({ baselineId: f.baseline.id, candidateId: revision.id, manifestHash: 'frozen', scenarios: f.preparation.scenarios, repeats: 1, trials, split: 'control', mode: 'demo' });
  assert.equal(control.validPairs, 4);
  assert.equal(control.fixed, 2);
  assert.equal(control.regressed, 0);
  assert.equal(control.verdict, 'insufficient');
  assert.equal(control.families, 2);
  for (const family of new Set(f.preparation.scenarios.map(s => s.familyId))) {
    assert.equal(new Set(f.preparation.scenarios.filter(s => s.familyId === family).map(s => s.split)).size, 1);
  }
  assert.match(control.reasons.join(' '), /Scripted offline/);
  const retry = trials.find(t => t.scenarioId === 'f_retry_control' && t.revisionId === revision.id)!;
  const results = retry.events.filter(e => e.type === 'tool_result' && e.tool === 'update_record');
  assert.equal(results.length, 3);
  assert.equal(results[0]!.state!.records.A106!.time, '09:00');
  assert.equal(results[2]!.state!.records.A106!.time, '15:30');
  assert.equal(retry.initialState.records.A106!.time, '09:00');
});

test('demo rejects arbitrary user tasks and never silently simulates custom generation', async () => {
  const f = await fixture();
  await assert.rejects(f.runtime.prepare({ task: 'An unrelated task', sources: f.sources }, context()), /Reset the sample or choose live/);
});

test('evaluation demo prepares the requested diverse cards for a working agent and labels its narrow scripted assessments', async () => {
  const f = await fixture();
  assert.equal(f.input.workflow, 'compare');
  const preparation = validatePreparation(await f.runtime.prepare({ task: f.input.task, sources: f.sources, workflow: 'evaluate', scenarioCount: 5 }, context()), f.sources, 'evaluate');
  assert.equal(preparation.scenarios.length, 5);
  assert.equal(new Set(preparation.scenarios.map(s => s.familyId)).size, 5);
  assert.ok(preparation.agent.tools.includes('update_record'));
  assert.ok(preparation.scenarios.every(s => s.user.persona && s.user.characteristics?.length && s.successCriteria && s.metrics?.length));
  const revision = { ...f.candidate, spec: preparation.agent };
  const clarification = preparation.scenarios.find(s => s.id === 'c_clarify')!;
  const trial = await f.evaluate(clarification, revision);
  assert.equal(trial.outcome, 'pass');
  assert.equal(trial.assessments?.length, 2);
  assert.ok(trial.assessments?.every(a => a.result === 'pass' && a.evidence.length && /scripted/i.test(a.rationale)));
  const edited = structuredClone(clarification);
  edited.metrics![0]!.passCriteria = 'The user felt understood.';
  const custom = await f.evaluate(edited, revision);
  assert.equal(custom.assessments?.[0]!.result, 'unknown');
  assert.match(custom.assessments![0]!.rationale, /custom or edited/);
  const single = await f.runtime.prepare({ task: f.input.task, sources: f.sources, workflow: 'evaluate', scenarioCount: 1 }, context());
  assert.equal(single.scenarios.length, 1);
});

function targetRuntime(base: Runtime, respond: (tools: Tool[], message: string) => Promise<string>): Runtime {
  return { ...base, async openTarget(_agent, _sources, tools) { return { respond: message => respond(tools, message), async close() {} }; }, async userTurn() { return { message: '', done: true }; } };
}

test('validation simulator answers the current clarification, never blindly replays old user turns', async () => {
  const f = await fixture();
  const card = { ...validationScenario({ id: 'real', messages: [
    { role: 'user', content: 'Как оформить возврат?' }, { role: 'assistant', content: 'Как называется магазин?' },
    { role: 'user', content: 'Все для дома' }, { role: 'assistant', content: 'OLD_AGENT_SECRET' },
  ] }, observedGoalSchema.parse({ id: 'refund', goal: 'Узнать как оформить возврат', opening: 'Как оформить возврат?', facts: 'Магазин: Все для дома. Модель терминала неизвестна.',
    evidenceDialogueIds: ['real'], successCriteria: 'Инструкция возврата по базе знаний.' })), split: 'dev' as const };
  const messages: string[] = [];
  const runtime = targetRuntime(f.runtime, async (_tools, message) => { messages.push(message); return messages.length === 1 ? 'Какая модель терминала?' : 'Используйте меню возврата.'; });
  runtime.userTurn = async ({ user, messages: history }) => {
    assert.match(user.facts, /Все для дома/); assert.equal(user.script, undefined);
    assert.doesNotMatch(JSON.stringify({ user, history }), /OLD_AGENT_SECRET/);
    return history.at(-1)?.content === 'Какая модель терминала?' ? { message: 'Модель не знаю.', done: false } : { message: '', done: true };
  };
  runtime.assess = async ({ scenario, trial }) => scenario.metrics!.map(m => ({ metricId: m.id, result: 'pass', rationale: 'Fixture', evidence: [trial.events.find(e => e.type === 'assistant')!.seq] }));
  const result = await f.evaluate(card, f.candidate, runtime);
  assert.equal(result.outcome, 'ungraded');
  assert.deepEqual(messages, ['Как оформить возврат?', 'Модель не знаю.']);
  assert.ok(result.assessments?.every(a => a.result === 'pass'));
});

test('answer_equals checks the last answer with exact case, whitespace and newlines, never an earlier matching answer', async () => {
  const f = await fixture();
  const scenario = structuredClone(f.preparation.scenarios[0]!);
  const expected = '  Готово!\n';
  scenario.checks = [checkSchema.parse({ id: 'literal', kind: 'answer_equals', description: 'Exact final reply', value: expected })];
  assert.equal(scenario.checks[0]!.kind === 'answer_equals' && scenario.checks[0]!.value, expected, 'schema must not trim expected text');
  scenario.user.maxFollowUps = 0;
  for (const response of [expected, expected.toLowerCase(), expected.trim(), expected.replace('\n', '\r\n'), `Prefix ${expected}`]) {
    const trial = await f.evaluate(scenario, f.candidate, targetRuntime(f.runtime, async () => response));
    assert.equal(trial.checks[0]!.passed, response === expected, JSON.stringify(response));
    assert.equal(trial.outcome, response === expected ? 'pass' : 'fail');
    assert.match(trial.checks[0]!.evidence, /Последний ответ #1/);
  }
  scenario.user.maxFollowUps = 1;
  let replies = 0;
  const actor = targetRuntime(f.runtime, async () => ++replies === 1 ? expected : 'Другой ответ');
  actor.userTurn = async () => ({ message: 'Ответь ещё раз.', done: true });
  const lastOnly = await f.evaluate(scenario, f.candidate, actor);
  assert.equal(replies, 2);
  assert.equal(lastOnly.checks[0]!.passed, false);
  assert.match(lastOnly.checks[0]!.evidence, /Последний ответ #4/);
});

test('invented success does not mutate state; target receives no denied tool or private assertions', async () => {
  const f = await fixture();
  let names: string[] = [];
  const runtime = targetRuntime(f.runtime, async tools => { names = tools.map(t => t.name); return 'I successfully moved appointment A101 to 14:00.'; });
  const trial = await f.evaluate(undefined, undefined, runtime);
  assert.equal(trial.outcome, 'fail');
  assert.equal(trial.finalState.records.A101!.time, '09:00');
  assert.ok(!names.includes('update_record'));
  let projection: unknown;
  await f.evaluate(f.preparation.scenarios.find(s => s.id === 'c_clarify'), f.candidate, { ...f.runtime, async userTurn(input) { projection = input; return { message: '', done: true }; } });
  assert.deepEqual(Object.keys(projection as object).sort(), ['messages', 'turn', 'user']);
  assert.ok(!JSON.stringify(projection).includes('state_equals'));
});

test('tool updates validate all fields atomically and preserve trace snapshots', async () => {
  const f = await fixture();
  const outputs: unknown[] = [];
  const runtime = targetRuntime(f.runtime, async tools => {
    const update = tools.find(t => t.name === 'update_record')!;
    outputs.push(await update.execute({ recordId: 'A101', changes: { time: '14:00', owner: 'Intruder' } }));
    outputs.push(await update.execute({ recordId: 'A101', changes: { time: '14:00' }, unexpected: true }));
    outputs.push(await update.execute({ recordId: '__proto__', changes: { time: '14:00' } }));
    outputs.push(await update.execute({ recordId: 'A101', changes: { time: '14:00' } }));
    return 'Completed';
  });
  const trial = await f.evaluate(undefined, f.candidate, runtime);
  assert.deepEqual(outputs.map(o => (o as { ok: boolean }).ok), [false, false, false, true]);
  assert.equal(trial.finalState.records.A101!.owner, 'Sample customer');
  assert.equal(trial.events.find(e => e.type === 'tool_result')!.state!.records.A101!.time, '09:00');
  assert.equal(trial.finalState.records.A101!.time, '14:00');
});

test('ordering and retry-limit checks grade real same-record tool transitions, not tool presence or assistant claims', async t => {
  const cases: Array<{ name: string; actions: Array<['lookup_record' | 'update_record', string]>; failures: number; fresh: boolean; count: boolean }> = [
    { name: 'update then read cannot repair the violated ordering', actions: [['update_record', 'A101'], ['lookup_record', 'A101']], failures: 0, fresh: false, count: true },
    { name: 'reading another record does not authorize this update', actions: [['lookup_record', 'A999'], ['update_record', 'A101']], failures: 0, fresh: false, count: true },
    { name: 'failed lookup supplies no fresh record', actions: [['lookup_record', 'missing'], ['update_record', 'A101']], failures: 0, fresh: false, count: true },
    { name: 'successful update consumes the earlier read', actions: [['lookup_record', 'A101'], ['update_record', 'A101'], ['update_record', 'A101']], failures: 0, fresh: false, count: true },
    { name: 'a new successful lookup permits a subsequent change', actions: [['lookup_record', 'A101'], ['update_record', 'A101'], ['lookup_record', 'A101'], ['update_record', 'A101']], failures: 0, fresh: true, count: true },
    { name: 'failed retries retain the fresh read until success', actions: [['lookup_record', 'A101'], ['update_record', 'A101'], ['update_record', 'A101'], ['update_record', 'A101']], failures: 2, fresh: true, count: true },
    { name: 'four attempts violate the configured retry limit', actions: Array.from({ length: 4 }, () => [['lookup_record', 'A101'], ['update_record', 'A101']] as Array<['lookup_record' | 'update_record', string]>).flat(), failures: 0, fresh: true, count: false },
  ];
  for (const sample of cases) await t.test(sample.name, async () => {
    const f = await fixture();
    const scenario = structuredClone(f.preparation.scenarios[0]!);
    scenario.initialState.transientFailures = sample.failures;
    scenario.initialState.records.A999 = { time: '08:00', owner: 'Another customer', status: 'booked' };
    scenario.checks.push(
      { id: 'fresh', kind: 'fresh_read_before_update', description: 'Read the same current record before each successful change' },
      { id: 'attempt_limit', kind: 'tool_count', tool: 'update_record', min: 1, max: 3, description: 'Attempt the intended update no more than three times' },
    );
    const runtime = targetRuntime(f.runtime, async tools => {
      for (const [name, recordId] of sample.actions) {
        await tools.find(tool => tool.name === name)!.execute({ recordId, ...(name === 'update_record' ? { changes: { time: '14:00' } } : {}) });
      }
      return 'I read the current record first and respected the retry limit.';
    });
    const trial = await f.evaluate(scenario, f.candidate, runtime);
    assert.equal(trial.finalState.records.A101!.time, '14:00');
    assert.equal(trial.checks.find(check => check.id === 'fresh')!.passed, sample.fresh);
    assert.equal(trial.checks.find(check => check.id === 'attempt_limit')!.passed, sample.count);
    assert.equal(trial.outcome, sample.fresh && sample.count ? 'pass' : 'fail');
    if (!sample.fresh) assert.match(trial.checks.find(check => check.id === 'fresh')!.evidence, /event \d+/);
  });
});

test('tool_count includes rejected SDK attempts and ordering does not invent action when none happened', async () => {
  const f = await fixture();
  const scenario = structuredClone(f.preparation.scenarios[0]!);
  scenario.checks = [
    { id: 'count', kind: 'tool_count', tool: 'update_record', min: 0, max: 0, description: 'No update attempts' },
    { id: 'fresh', kind: 'fresh_read_before_update', description: 'Each update must follow a fresh read' },
  ];
  const idle = await f.evaluate(scenario, f.candidate, targetRuntime(f.runtime, async () => 'Nothing changed.'));
  assert.equal(idle.outcome, 'pass');
  assert.match(idle.checks[1]!.evidence, /not exercised/);
  const runtime: Runtime = { ...f.runtime, async openTarget(_agent, _sources, _tools, ctx) {
    return { async respond() {
      ctx.onTargetEvent?.({ type: 'tool_call', tool: 'update_record', args: { recordId: 'A101', changes: {} } });
      ctx.onTargetEvent?.({ type: 'tool_result', tool: 'update_record', result: { ok: false, rejected: true } });
      return 'The invalid update was rejected.';
    }, async close() {} };
  }, async userTurn() { return { done: true, message: '' }; } };
  const rejected = await f.evaluate(scenario, f.candidate, runtime);
  assert.equal(rejected.checks[0]!.passed, false);
  assert.match(rejected.checks[0]!.evidence, /attempted 1/);
});

test('forbidden wording in a reply fails its check while the same phrase elsewhere does not', async () => {
  const f = await fixture();
  // Дефект, ради которого проверка и нужна: клиенту уходит текст, написанный для оператора.
  const scenario = structuredClone(f.preparation.scenarios[0]!);
  scenario.checks = [
    { id: 'no_staff_text', kind: 'answer_omits', description: 'В ответе клиенту нет инструкций для оператора', value: 'Оператору необходимо' },
  ];
  const leaking = targetRuntime(f.runtime, async () => 'Оператору необходимо осуществить ручной поиск.');
  const leaked = await f.evaluate(scenario, f.candidate, leaking);
  assert.equal(leaked.checks[0]!.passed, false);
  assert.match(leaked.checks[0]!.evidence, /contains/);

  const clean = targetRuntime(f.runtime, async () => 'Посмотрите тариф в разделе «Мои точки продаж».');
  const kept = await f.evaluate(scenario, f.candidate, clean);
  assert.equal(kept.checks[0]!.passed, true);
});

test('simulator protocol/provider errors are invalid; exhausting target turns is a valid failure', async () => {
  const f = await fixture();
  const legacy = structuredClone(f.preparation.scenarios[0]!);
  delete legacy.user.maxFollowUps;
  const malformed = { ...f.runtime, async userTurn() { return { message: '', done: false }; } };
  const invalid = await f.evaluate(legacy, f.candidate, malformed);
  assert.equal(invalid.outcome, 'invalid');
  assert.match(invalid.reason, /реплика симулированного пользователя/);
  const failed = await f.evaluate(legacy, f.candidate, { ...f.runtime, async userTurn() { throw new Error('Provider offline'); } });
  assert.equal(failed.outcome, 'invalid');
  const neverDone = await f.evaluate(legacy, f.candidate, { ...f.runtime, async userTurn() { return { message: 'Please confirm again.', done: false }; } });
  assert.equal(neverDone.outcome, 'invalid');
  assert.match(neverDone.reason, /не завершился в отведённое число реплик/);
});

test('a card follow-up budget bounds an adversarial retrying simulator without passing an unchanged task', async () => {
  for (const budget of [0, 1]) {
    const f = await fixture();
    const scenario = structuredClone(f.preparation.scenarios[0]!);
    scenario.user.maxFollowUps = budget;
    const received: string[] = [];
    let simulations = 0;
    const runtime = targetRuntime(f.runtime, async (_tools, message) => { received.push(message); return 'The update is unavailable; no change was made.'; });
    runtime.userTurn = async ({ messages }) => { simulations += 1; assert.match(messages.at(-1)!.content, /unavailable/); return { done: false, message: 'Please retry the same change.' }; };
    const trial = await f.evaluate(scenario, f.candidate, runtime);
    assert.equal(simulations, budget);
    assert.equal(received.length, budget + 1);
    if (budget) assert.equal(received[1], 'Please retry the same change.');
    assert.equal(trial.outcome, 'fail');
    assert.equal(trial.reason, 'Часть объективных проверок провалена.');
    assert.equal(trial.finalState.records.A101!.time, '09:00');
  }
});

test('a terminal simulator message is delivered before stopping; empty terminal messages stop without an invented user turn', async () => {
  for (const message of ['A103', '', '   ']) {
    const f = await fixture();
    const scenario = structuredClone(f.preparation.scenarios.find(s => s.id === 'c_clarify')!);
    scenario.user.maxFollowUps = 2; // The terminal signal, not budget exhaustion, must stop the next simulation.
    let simulations = 0;
    const runtime: Runtime = { ...f.runtime, async userTurn() { simulations += 1; return { done: true, message }; } };
    const trial = await f.evaluate(scenario, f.candidate, runtime);
    const userMessages = trial.events.filter(e => e.type === 'user').map(e => e.text);
    assert.deepEqual(trial.events.filter(e => e.type === 'simulator').map(e => e.result), [{ done: true, message }]);
    assert.equal(simulations, 1);
    if (message.trim()) {
      assert.deepEqual(userMessages, [scenario.user.opening, 'A103']);
      assert.equal(trial.outcome, 'pass');
      assert.equal(trial.finalState.records.A103!.time, '11:30');
    } else {
      assert.deepEqual(userMessages, [scenario.user.opening]);
      assert.equal(trial.outcome, 'fail');
      assert.equal(trial.finalState.records.A103!.time, '09:00');
    }
    const noFollowUp = structuredClone(scenario);
    noFollowUp.user.maxFollowUps = 0;
    simulations = 0;
    const bounded = await f.evaluate(noFollowUp, f.candidate, runtime);
    assert.equal(simulations, 0);
    assert.equal(bounded.events.filter(e => e.type === 'simulator').length, 0);
    assert.equal(bounded.outcome, 'fail');
  }
});

const testMetrics: Rubric[] = [
  { id: 'goal', name: 'Goal achieved', subject: 'agent', description: 'Judge the requested outcome.', passCriteria: 'The user goal was achieved.', failCriteria: 'The user goal was not achieved.' },
  { id: 'role', name: 'Role fidelity', subject: 'simulator', description: 'Judge the simulated user behavior.', passCriteria: 'The user followed the assigned role.', failCriteria: 'The user introduced contradictory facts.' },
];

test('rubric-only dialogues stay ungraded; assessments run after cleanup, cite real events, and cannot mutate target evidence or objective outcomes', async () => {
  const f = await fixture();
  const scenario = structuredClone(f.preparation.scenarios[0]!);
  scenario.checks = [];
  scenario.metrics = structuredClone(testMetrics);
  let closed = false;
  const stages: string[] = [];
  const actor: Runtime = { ...f.runtime,
    async openTarget() { return { async respond() { return 'I cannot make that change.'; }, async close() { closed = true; } }; },
    async assess(input, ctx) {
      assert.equal(closed, true);
      assert.equal(stages.at(-1), 'assessment', 'progress enters assessment before the slow judge starts');
      assert.equal(ctx.onTargetEvent, undefined);
      assert.equal(ctx.onTrace, undefined);
      assert.equal(input.trial.outcome, 'ungraded');
      ctx.beforeCall();
      ctx.addUsage({ inputTokens: 20, outputTokens: 5, costUsd: 0.01 });
      input.trial.events[0]!.text = 'Tampered';
      input.scenario.metrics![0]!.name = 'Tampered';
      return [
        { metricId: 'goal', result: 'fail', rationale: 'The agent explicitly could not complete the request.', evidence: [1] },
        { metricId: 'role', result: 'unknown', rationale: 'No dynamic user reply was exercised.', evidence: [] },
      ];
    },
  };
  const trial = await f.evaluate(scenario, { ...f.candidate, spec: { ...f.candidate.spec, tools: [] } }, actor, context(), 0, stage => stages.push(stage));
  assert.equal(trial.outcome, 'ungraded');
  assert.deepEqual(trial.checks, []);
  assert.equal(trial.assessments?.[0]!.result, 'fail');
  assert.equal(trial.assessments?.[1]!.result, 'unknown');
  assert.equal(trial.assessmentError, undefined);
  assert.equal(stages[0], 'target');
  assert.equal(trial.events[0]!.text, scenario.user.opening);
  assert.equal(scenario.metrics[0]!.name, 'Goal achieved');
  assert.deepEqual(trial.usage, { calls: 1, inputTokens: 20, outputTokens: 5, costUsd: 0.01 });
  const objective = structuredClone(f.preparation.scenarios[0]!);
  objective.metrics = [structuredClone(testMetrics[0]!)];
  actor.assess = async () => [{ metricId: 'goal', result: 'pass', rationale: 'This intentionally wrong judgment cannot replace the state check.', evidence: [1] }];
  const failed = await f.evaluate(objective, f.candidate, actor);
  assert.equal(failed.outcome, 'fail');
  assert.equal(failed.assessments?.[0]!.result, 'pass');
  assert.equal(failed.finalState.records.A101!.time, '09:00');
});

test('missing, forged, or failed rubric assessments stay separate from successful objective results', async t => {
  const valid: MetricAssessment[] = testMetrics.map(metric => ({ metricId: metric.id, result: 'pass', rationale: 'Supported by the cited trace event.', evidence: [0] }));
  const samples: Array<{ name: string; assess?: Runtime['assess']; error: RegExp }> = [
    { name: 'missing metric', assess: async () => valid.slice(0, 1), error: /every requested metric exactly once/ },
    { name: 'duplicate metric', assess: async () => [valid[0]!, valid[0]!], error: /every requested metric exactly once/ },
    { name: 'unknown metric', assess: async () => [{ ...valid[0]!, metricId: 'invented' }, valid[1]!], error: /every requested metric exactly once/ },
    { name: 'nonexistent event', assess: async () => [{ ...valid[0]!, evidence: [999] }, valid[1]!], error: /nonexistent trace event/ },
    { name: 'pass without evidence', assess: async () => [{ ...valid[0]!, evidence: [] }, valid[1]!], error: /needs trace evidence/ },
    { name: 'fail without evidence', assess: async () => [{ ...valid[0]!, result: 'fail', evidence: [] }, valid[1]!], error: /needs trace evidence/ },
    { name: 'provider exception', assess: async () => { throw new Error('Judge unavailable'); }, error: /Judge unavailable/ },
    { name: 'unavailable assessor', error: /unavailable for this runtime/ },
  ];
  for (const sample of samples) await t.test(sample.name, async () => {
    const f = await fixture();
    const scenario = structuredClone(f.preparation.scenarios[0]!);
    scenario.metrics = structuredClone(testMetrics);
    const trial = await f.evaluate(scenario, f.candidate, { ...f.runtime, assess: sample.assess });
    assert.equal(trial.outcome, 'pass');
    assert.equal(trial.finalState.records.A101!.time, '14:00');
    assert.equal(trial.assessments, undefined);
    assert.match(trial.assessmentError!, sample.error);
  });
});

test('an incomplete or invalid dialogue is not sent to the rubric assessor', async () => {
  const f = await fixture();
  const scenario = structuredClone(f.preparation.scenarios[0]!);
  scenario.metrics = structuredClone(testMetrics);
  let assessments = 0;
  const actor = targetRuntime(f.runtime, async () => '');
  actor.assess = async () => { assessments += 1; return []; };
  const incomplete = await f.evaluate(scenario, f.candidate, actor);
  assert.equal(incomplete.outcome, 'invalid');
  actor.openTarget = async () => { throw new Error('Target provider offline'); };
  const invalid = await f.evaluate(scenario, f.candidate, actor);
  assert.equal(invalid.outcome, 'invalid');
  assert.equal(assessments, 0);
});

test('cancellation disposes the target and stops subsequent simulator calls', async () => {
  const f = await fixture();
  const controller = new AbortController();
  let closed = false;
  let simulated = 0;
  const runtime: Runtime = { ...f.runtime,
    async openTarget() { return { async respond() { controller.abort(); controller.signal.throwIfAborted(); return ''; }, async close() { closed = true; } }; },
    async userTurn() { simulated += 1; return { message: '', done: true }; },
  };
  const trial = await f.evaluate(undefined, undefined, runtime, context(controller.signal));
  assert.equal(trial.outcome, 'cancelled');
  assert.equal(closed, true);
  assert.equal(simulated, 0);
});

test('trace sink sees immutable events and persistence errors escape instead of becoming a grade', async () => {
  const f = await fixture();
  const ctx = context();
  const observed: unknown[] = [];
  ctx.onTrace = (_id, event) => { observed.push(structuredClone(event)); event.text = 'tampered'; };
  const trial = await f.evaluate(undefined, f.candidate, f.runtime, ctx);
  assert.equal(observed.length, trial.events.length);
  assert.notEqual(trial.events[0]!.text, 'tampered');
  const failing = context();
  failing.onTrace = () => { throw new Error('Disk full'); };
  await assert.rejects(f.evaluate(undefined, undefined, f.runtime, failing), /Disk full/);
});

test('SDK-rejected tool events and intermediate text enter target evidence without exposing that callback to the simulator', async () => {
  const f = await fixture();
  const scenario = structuredClone(f.preparation.scenarios[0]!);
  scenario.user.maxFollowUps = 1;
  let simulatorHasTargetCallback = true;
  const runtime: Runtime = { ...f.runtime,
    async openTarget(_agent, _sources, _tools, ctx) {
      return { async respond() {
        ctx.onTargetEvent?.({ type: 'assistant', text: 'Attempting an unavailable tool.' });
        ctx.onTargetEvent?.({ type: 'tool_call', tool: 'bash', args: { command: 'cat hidden.json' } });
        ctx.onTargetEvent?.({ type: 'tool_result', tool: 'bash', result: { error: 'Tool is unavailable' } });
        return 'I could not perform the update.';
      }, async close() {} };
    },
    async userTurn(_input, ctx) { simulatorHasTargetCallback = Boolean(ctx.onTargetEvent); return { message: '', done: true }; },
  };
  const trial = await f.evaluate(scenario, undefined, runtime);
  assert.equal(simulatorHasTargetCallback, false);
  assert.equal(trial.events.filter(e => e.tool === 'bash').length, 2);
  assert.deepEqual(trial.events.map(e => e.seq), trial.events.map((_e, i) => i));
  assert.equal(trial.outcome, 'fail');
  const ctx = context();
  ctx.onTrace = (_id, event) => { if (event.tool === 'bash') throw undefined; };
  const swallowingRuntime: Runtime = { ...runtime, async openTarget(_agent, _sources, _tools, targetCtx) {
    return { async respond() {
      try { targetCtx.onTargetEvent?.({ type: 'tool_call', tool: 'bash' }); } catch {}
      return 'Done';
    }, async close() {} };
  } };
  let rejected = false;
  try { await f.evaluate(undefined, undefined, swallowingRuntime, ctx); } catch { rejected = true; }
  assert.equal(rejected, true, 'even an undefined persistence error swallowed by the SDK must escape');
});

test('unknown provider cost remains unknown in trial evidence', async () => {
  const f = await fixture();
  const actor = targetRuntime(f.runtime, async () => 'Done');
  const original = actor.openTarget;
  actor.openTarget = async (agent, sources, tools, ctx) => {
    ctx.beforeCall(); ctx.addUsage({ inputTokens: 12, outputTokens: 3, costUsd: null });
    return original(agent, sources, tools, ctx);
  };
  const trial = await f.evaluate(undefined, undefined, actor);
  assert.equal(trial.usage.costUsd, null);
  assert.equal(trial.usage.inputTokens, 12);
});

test('comparison rejects missing, invalid, duplicate, or incompatible pairs and exposes regressions', async () => {
  const f = await fixture();
  const scenario = f.preparation.scenarios[0]!;
  const base = await f.evaluate(scenario);
  const candidate = await f.evaluate(scenario, f.candidate);
  const compare = (trials: Trial[]) => compareTrials({ baselineId: 'baseline', candidateId: 'candidate', manifestHash: 'frozen', scenarios: [scenario], repeats: 1, trials, split: 'dev', mode: 'live' });
  assert.equal(compare([base]).invalidPairs, 1);
  assert.equal(compare([base, { ...candidate, outcome: 'invalid' }]).verdict, 'insufficient');
  assert.equal(compare([base, candidate, candidate]).verdict, 'incomparable');
  assert.equal(compare([base, { ...candidate, manifestHash: 'changed' }]).verdict, 'incomparable');
  assert.equal(compare([base, { ...candidate, familyId: 'different' }]).verdict, 'incomparable');
  assert.equal(compare([base, { ...candidate, id: base.id }]).verdict, 'incomparable');
  const initialState = structuredClone(candidate.initialState);
  initialState.records.A101!.time = '14:00';
  assert.equal(compare([base, { ...candidate, initialState }]).verdict, 'incomparable');
  assert.equal(compare([{ ...base, outcome: 'pass' }, { ...candidate, outcome: 'fail' }]).verdict, 'regressed');
  assert.equal(compare([{ ...base, outcome: 'pass' }, candidate]).verdict, 'no_change');
  const same = compareTrials({ baselineId: 'baseline', candidateId: 'baseline', manifestHash: 'frozen', scenarios: [scenario], repeats: 1, trials: [base], split: 'dev', mode: 'live' });
  assert.equal(same.verdict, 'no_change');
  assert.equal(same.validPairs, 1);
});

test('family clustering prevents repeats/paraphrases from inventing independent evidence; empty data stays finite', async () => {
  const f = await fixture();
  const scenario = f.preparation.scenarios[0]!;
  const base = await f.evaluate(scenario);
  const candidate = await f.evaluate(scenario, f.candidate);
  const scenarios: Scenario[] = Array.from({ length: 8 }, (_, i) => ({ ...scenario, split: 'control', id: `case_${i}`, familyId: `family_${i}` }));
  const trials = scenarios.flatMap(s => [{ ...base, split: s.split, id: `b_${s.id}`, scenarioId: s.id, familyId: s.familyId }, { ...candidate, split: s.split, id: `c_${s.id}`, scenarioId: s.id, familyId: s.familyId }]);
  const input = { baselineId: 'baseline', candidateId: 'candidate', manifestHash: 'frozen', scenarios, repeats: 1, trials, split: 'control' as const, mode: 'live' as const };
  const independent = compareTrials(input);
  assert.equal(independent.families, 8);
  assert.equal(independent.verdict, 'improved');
  const adaptive = compareTrials({ ...input, split: 'dev', scenarios: scenarios.map(s => ({ ...s, split: 'dev' })), trials: trials.map(t => ({ ...t, split: 'dev' })) });
  assert.equal(adaptive.verdict, 'insufficient', 'development data used for adaptation cannot independently confirm improvement');
  const fewChanged = compareTrials({ ...input, trials: trials.map(t => t.revisionId === 'baseline' && Number(t.familyId.split('_')[1]) >= 4 ? { ...t, outcome: 'pass' as const } : t) });
  assert.equal(fewChanged.verdict, 'insufficient', 'four changed families do not pass the sign test even with eight families total');
  const repeated = compareTrials({ ...input, repeats: 5, trials: trials.flatMap(t => Array.from({ length: 5 }, (_, repeat) => ({ ...t, repeat, id: `${t.id}_${repeat}` }))) });
  assert.equal(repeated.families, independent.families);
  assert.deepEqual(repeated.interval, independent.interval);
  const paraphrases = compareTrials({ ...input, scenarios: scenarios.map(s => ({ ...s, familyId: 'shared' })), trials: trials.map(t => ({ ...t, familyId: 'shared' })) });
  assert.equal(paraphrases.families, 1);
  assert.equal(paraphrases.interval, null);
  assert.equal(paraphrases.verdict, 'insufficient');
  const empty = compareTrials({ ...input, scenarios: [], trials: [] });
  assert.equal(empty.delta, null);
  assert.equal(empty.verdict, 'insufficient');
  assert.equal(JSON.stringify(empty).includes('NaN'), false);
  for (const repeats of [Infinity, NaN, -1, 0, 0.5, 6]) {
    const invalid = compareTrials({ ...input, repeats });
    assert.equal(invalid.verdict, 'incomparable');
    assert.equal(invalid.plannedPairs, 0);
  }
});

test('static and scripted user modes never call the simulator and stop within their own bounds', async () => {
  const f = await fixture();
  const runtime: Runtime = { ...f.runtime, userTurn: async () => { throw new Error('simulator must not run'); } };
  const clarify = f.preparation.scenarios.find(s => s.id === 'c_clarify')!;
  const run = (scenario: Scenario, userMode: 'static' | 'scripted') => evaluateTrial({ requirements: [], runtime, revision: f.candidate, scenario, repeat: 0, manifestHash: 'frozen', sources: f.sources, settings: f.input.settings, ctx: context(), userMode, target: { kind: 'sandbox' } });
  const staticTrial = await run(clarify, 'static');
  assert.equal(staticTrial.userMode, 'static');
  assert.equal(staticTrial.events.filter(e => e.type === 'user').length, 1);
  assert.equal(staticTrial.events.some(e => e.type === 'simulator'), false);
  assert.equal(staticTrial.outcome, 'fail');
  const scripted: Scenario = { ...clarify, user: { ...clarify.user, script: ['My appointment ID is A103.', 'Thanks, that is all.'], maxFollowUps: 5 } };
  const scriptedTrial = await run(scripted, 'scripted');
  assert.equal(scriptedTrial.userMode, 'scripted');
  assert.equal(scriptedTrial.outcome, 'pass', scriptedTrial.reason);
  assert.deepEqual(scriptedTrial.events.filter(e => e.type === 'user').map(e => e.text), [clarify.user.opening, 'My appointment ID is A103.', 'Thanks, that is all.']);
  const scriptedEvents = scriptedTrial.events.filter(e => e.type === 'simulator');
  assert.equal(scriptedEvents.length, 2);
  assert.ok(scriptedEvents.every(e => (e.result as { scripted?: boolean }).scripted === true));
  const bounded = await run({ ...scripted, user: { ...scripted.user, maxFollowUps: 1 } }, 'scripted');
  assert.equal(bounded.outcome, 'invalid');
  assert.equal(bounded.events.filter(e => e.type === 'user').length, 0, 'unreachable scripted messages are rejected before calling the agent');
  const noScript = await run({ ...clarify, user: { ...clarify.user, script: undefined } }, 'scripted');
  assert.equal(noScript.events.filter(e => e.type === 'user').length, 1);
  assert.equal(noScript.outcome, 'fail');
});

test('external module targets bypass the sandbox and are graded on reported records and events', async t => {
  const f = await fixture();
  const runtime: Runtime = { ...f.runtime, openTarget: async () => { throw new Error('sandbox target must not open'); } };
  const direct = f.preparation.scenarios.find(s => s.id === 'a_direct')!;
  const run = (scenario: Scenario, path: string) => evaluateTrial({ requirements: [], runtime, revision: f.baseline, scenario, repeat: 0, manifestHash: 'frozen', sources: f.sources, settings: f.input.settings, ctx: context(), userMode: 'static', target: { kind: 'module', path, exportName: 'createSession' } });
  const reported = await run(direct, resolve('examples/echo-agent.mjs'));
  assert.equal(reported.outcome, 'pass', reported.reason);
  assert.equal(reported.finalState.records.A101!.time, '14:00');
  assert.deepEqual(reported.events.filter(e => e.type === 'tool_call').map(e => e.tool), ['lookup_record', 'update_record']);
  assert.ok(reported.events.every((e, i) => e.seq === i));
  assert.doesNotMatch(reported.reason, /not reported/);
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-evaluation-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(directory, { recursive: true, force: true }); });
  const silent = join(directory, 'silent.mjs');
  await writeFile(silent, 'export function createSession() { return { async respond() { return "Done, moved it."; } }; }\n');
  const unreported = await run(direct, silent);
  assert.equal(unreported.outcome, 'invalid');
  assert.match(unreported.reason, /не сообщил итоговое состояние/);
  assert.equal(unreported.finalState.records.A101!.time, '09:00');
  const broken = join(directory, 'broken.mjs');
  await writeFile(broken, 'export function createSession() { return { async respond() { throw new Error("adapter boom"); } }; }\n');
  const invalid = await run(direct, broken);
  assert.equal(invalid.outcome, 'invalid');
  assert.match(invalid.reason, /ответ испытуемого: .*adapter boom/);
  const unavailable = join(directory, 'unavailable.mjs');
  await writeFile(unavailable, `export function createSession() { return { async respond() { return {
    reply: 'Нет данных для ответа.', measurementError: 'В фикстуре отсутствует lookup_record.',
    events: [{ tool: 'lookup_record', result: { fixtureMissing: true } }]
  }; } }; }`);
  let assessed = false;
  const infrastructure = await evaluateTrial({ requirements: [], runtime: { ...runtime, async assess() { assessed = true; throw new Error('must not grade'); } },
    revision: f.baseline, scenario: { ...direct, metrics: [{ id: 'goal', name: 'Goal', subject: 'agent', description: 'Goal', passCriteria: 'Done', failCriteria: 'Not done' }] },
    repeat: 0, manifestHash: 'frozen', sources: f.sources, settings: f.input.settings, ctx: context(), userMode: 'static',
    target: { kind: 'module', path: unavailable, exportName: 'createSession' } });
  assert.equal(infrastructure.outcome, 'invalid');
  assert.equal(assessed, false, 'an adapter-reported measurement error cannot become an agent verdict');
  assert.deepEqual(infrastructure.events.map(e => e.type), ['user', 'tool_call', 'tool_result', 'assistant', 'error']);
  assert.equal(infrastructure.events[3]!.text, 'Нет данных для ответа.');
  assert.match(infrastructure.reason, /В фикстуре отсутствует lookup_record/);
});

test('reactive dialogues record simulator checks that never change the objective outcome', async () => {
  const f = await fixture();
  const clarify = f.preparation.scenarios.find(s => s.id === 'c_clarify')!;
  const inventing: Runtime = { ...f.runtime, async userTurn() { return { message: 'My appointment ID is A999.', done: false }; } };
  const trial = await f.evaluate(clarify, f.candidate, inventing);
  const fabrication = trial.simulatorChecks!.find(c => c.id === 'simulator_fabrication')!;
  assert.equal(fabrication.passed, false);
  assert.match(fabrication.evidence, /a999/);
  assert.equal(trial.simulatorChecks!.find(c => c.id === 'simulator_leak')!.passed, true);
  assert.equal(trial.outcome, 'fail', 'the agent could not find A999; the simulator check does not decide that');
  assert.doesNotMatch(trial.reason, /симулятор/i);
  const honest = await f.evaluate(clarify, f.candidate);
  assert.ok(honest.simulatorChecks!.every(c => c.passed), JSON.stringify(honest.simulatorChecks));
  assert.equal(honest.outcome, 'pass');
  const opening = await f.evaluate(f.preparation.scenarios[0]!, f.candidate);
  assert.deepEqual(opening.simulatorChecks, [], 'a dialogue that stops after the opening has nothing to check');
});

test('an unconfirmed external world is named in the reason without inventing an agent failure', async t => {
  const f = await fixture();
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-external-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(directory, { recursive: true, force: true }); });
  const silent = join(directory, 'no-reset.mjs');
  await writeFile(silent, 'export function createSession({ initialState }) { return { async respond() { return { reply: `cards: ${initialState.external.cards.length}`, records: initialState.records }; } }; }\n');
  const confirming = join(directory, 'reset.mjs');
  await writeFile(confirming, 'export function createSession({ initialState }) { return { async respond() { return { reply: `cards: ${initialState.external.cards.length}`, records: initialState.records, resetConfirmed: true }; } }; }\n');
  const scenario: Scenario = { ...f.preparation.scenarios[0]!, checks: [], metrics: undefined, initialState: { records: {}, writableFields: [], transientFailures: 0, external: { cards: [{ id: 'c1', status: 'blocked' }] } } };
  const run = (path: string) => evaluateTrial({ requirements: [], runtime: { ...f.runtime, openTarget: async () => { throw new Error('sandbox must not open'); } }, revision: f.baseline, scenario, repeat: 0, manifestHash: 'frozen',
    sources: f.sources, settings: f.input.settings, ctx: context(), userMode: 'static', target: { kind: 'module', path, exportName: 'createSession' } });
  const unconfirmed = await run(silent);
  assert.equal(unconfirmed.outcome, 'invalid');
  assert.match(unconfirmed.reason, /Внешнее состояние карточки не подтверждено адаптером/);
  assert.equal(unconfirmed.events.find(e => e.type === 'assistant')?.text, 'cards: 1', 'the external world reached the adapter');
  const confirmed = await run(confirming);
  assert.doesNotMatch(confirmed.reason, /не подтверждено адаптером/);
  assert.equal(confirmed.observation?.resetConfirmed, true);
});

test('demo cards carry knows and answers, and the demo simulator answers from that table', async () => {
  const f = await fixture();
  const clarify = f.preparation.scenarios.find(s => s.id === 'c_clarify')!;
  assert.deepEqual(clarify.user.knows, ['Appointment ID A103', 'Desired time 11:30']);
  assert.deepEqual(clarify.user.answers, [{ ifAsked: 'appointment ID', reply: 'My appointment ID is A103.' }]);
  const trial = await f.evaluate(clarify, f.candidate);
  assert.equal(trial.events.filter(e => e.type === 'user')[1]?.text, 'My appointment ID is A103.');
  assert.ok(trial.simulatorChecks!.every(c => c.passed));
  const time = f.preparation.scenarios.find(s => s.id === 'd_clarify_control')!;
  assert.deepEqual(time.user.answers, [{ ifAsked: 'desired time', reply: 'My desired time is 17:00.' }]);
});

test('a receipt hashes the audit exactly as the sidecar stores it, even with a whitespace-padded judge error', async t => {
  const f = await fixture();
  const scenario: Scenario = { ...structuredClone(f.preparation.scenarios[0]!), checks: [],
    metrics: [{ id: 'goal', name: 'Goal', subject: 'agent', description: 'Original task', passCriteria: 'Instruction supplied', failCriteria: 'A refusal is supplied' }] };
  const trial: Trial = { id: 'trial', revisionId: 'baseline', scenarioId: scenario.id, familyId: scenario.familyId, repeat: 0, split: 'dev', userMode: 'static', manifestHash: 'frozen',
    outcome: 'ungraded', reason: 'rubric only', checks: [], events: [{ seq: 0, type: 'user', text: scenario.user.opening }, { seq: 1, type: 'assistant', text: 'Сделайте так.' }],
    initialState: scenario.initialState, finalState: scenario.initialState, usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: null }, elapsedMs: 1 };
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-receipt-'));
  const store = new ExperimentStore(directory);
  await store.init();
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const runtime: Runtime = { ...f.runtime, async assess(input, ctx) {
    return assessRepeated(input, { provider: 'offline', id: 'judge' }, ctx, async () => { throw new Error('429 Too Many Requests\n'); });
  } };
  const ctx: CallContext = { ...context(), onJudgment: (id, audit) => store.writeJudgeAudit('run-1', id, audit) };
  await assert.rejects(assessTrial(runtime, scenario, f.sources, trial, ctx, []), /429/);
  assert.ok(trial.judgeReceipt);
  const stored = await store.readJudgeAudit('run-1', trial.id);
  assert.ok(stored?.attempts.some(attempt => attempt.error === '429 Too Many Requests'));
  assert.equal(fingerprint(stored), trial.judgeReceipt.auditHash, 'an honest receipt matches its sidecar');
});

test('assessment hands the judge observable prompt rules in place of the raw prompt, with every other source intact', async () => {
  const f = await fixture();
  const scenario: Scenario = { ...structuredClone(f.preparation.scenarios[0]!), checks: [],
    metrics: [{ id: 'goal', name: 'Goal', subject: 'agent', description: 'Original task', passCriteria: 'Instruction supplied', failCriteria: 'A refusal is supplied' }] };
  const trial: Trial = { id: 'trial', revisionId: 'baseline', scenarioId: scenario.id, familyId: scenario.familyId, repeat: 0, split: 'dev', userMode: 'static', manifestHash: 'frozen',
    outcome: 'ungraded', reason: 'rubric only', checks: [], events: [{ seq: 0, type: 'user', text: scenario.user.opening }, { seq: 1, type: 'assistant', text: 'Сделайте так.' }],
    initialState: scenario.initialState, finalState: scenario.initialState, usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: null }, elapsedMs: 1 };
  const prompt: Source = { id: 'prompt_1', name: 'prompt.md', hash: 'h', kind: 'prompt', content: 'Отвечай на «вы». ВСЕГДА возвращай валидный JSON в формате {"output": "*Финальный ответ*"}.' };
  const requirements = [{ id: 'formal', text: 'formal', sourceId: 'prompt_1', quote: 'Отвечай на «вы»', critical: true }];
  let seen: Source[] | undefined;
  const runtime: Runtime = { ...f.runtime, async assess(input) { seen = input.sources; return [{ metricId: 'goal', result: 'pass', rationale: 'Instruction supplied at #1.', evidence: [1] }]; } };
  const assessments = await assessTrial(runtime, scenario, [...f.sources, prompt], trial, context(), requirements);
  assert.equal(assessments[0]!.result, 'pass');
  assert.equal(seen!.length, f.sources.length + 1);
  assert.deepEqual(seen!.slice(0, f.sources.length), f.sources, 'policy sources reach the judge unchanged');
  assert.match(seen!.at(-1)!.content, /1\. «Отвечай на «вы»»/);
  assert.doesNotMatch(JSON.stringify(seen), /JSON|output/);
});

test('a bounded judge reference set does not restrict the target knowledge base and seals the same receipt input', async () => {
  const f = await fixture(), selected = [f.sources[0]!];
  const scenario: Scenario = { ...structuredClone(f.preparation.scenarios[0]!), checks: [], metrics: [structuredClone(testMetrics[0]!)] };
  const actor: Runtime = { ...f.runtime,
    async openTarget(_agent, sources) {
      assert.deepEqual(sources, f.sources, 'target sees the complete knowledge base');
      return { async respond() { return 'I cannot make that change.'; }, async close() {} };
    },
    async assess(input, ctx) {
      assert.deepEqual(input.sources, selected, 'judge sees the case references');
      return assessRepeated(input, { provider: 'offline', id: 'judge' }, ctx, async (_prompt, data) => {
        const parsed = JSON.parse(data), reply = parsed.trial.events.find((e: any) => e.type === 'assistant');
        return JSON.stringify({ assessments: parsed.scenario.metrics.map((m: any) => ({ metricId: m.id,
          passCondition: 'not_met', failCondition: 'met', rationale: 'The agent refused.', evidence: [reply.seq], citations: [{ seq: reply.seq, quote: reply.content }] })) });
      });
    },
  };
  const trial = await evaluateTrial({ runtime: actor, revision: f.baseline, scenario, sources: f.sources, judgeSources: selected,
    requirements: [], settings: f.input.settings, repeat: 0, manifestHash: 'frozen', userMode: 'static', target: { kind: 'sandbox' }, ctx: context() });
  assert.equal(trial.assessmentError, undefined);
  assert.equal(hasCompleteJudgment({ scenario, sources: selected, trial }), true);
});

test('live evaluation seals a receipt, reports the final judgment once, and a rejected judgment keeps its raw replies and an incomplete receipt', async () => {
  const f = await fixture();
  const scenario = structuredClone(f.preparation.scenarios[0]!);
  scenario.checks = [];
  scenario.metrics = [structuredClone(testMetrics[0]!)];
  for (const mode of ['agreeing', 'malformed'] as const) {
    const reports: { audit: JudgeAudit; final: boolean }[] = [];
    const actor: Runtime = { ...f.runtime,
      async openTarget() { return { async respond() { return 'I cannot make that change.'; }, async close() {} }; },
      async assess(input, ctx) {
        return assessRepeated(input, { provider: 'offline', id: 'judge' }, ctx, async (_prompt, data) => {
          if (mode === 'malformed') return `not json ${reports.length}`;
          const parsed = JSON.parse(data) as { scenario: { metrics: { id: string }[] }; trial: { events: { seq: number; type: string; content: string }[] } };
          const reply = parsed.trial.events.find(event => event.type === 'assistant')!;
          return JSON.stringify({ assessments: parsed.scenario.metrics.map(metric => ({ metricId: metric.id, passCondition: 'not_met', failCondition: 'met',
            rationale: 'The agent refused.', evidence: [reply.seq], citations: [{ seq: reply.seq, quote: reply.content }] })) });
        });
      },
    };
    const ctx: CallContext = { ...context(), onJudgment(_id, audit, final) { reports.push({ audit: structuredClone(audit), final: final === true }); } };
    const trial = await f.evaluate(scenario, { ...f.candidate, spec: { ...f.candidate.spec, tools: [] } }, actor, ctx);
    const finals = reports.filter(report => report.final);
    assert.equal(finals.length, 1, `${mode}: the final judgment is reported exactly once`);
    assert.ok(reports.length > 1, `${mode}: partial reports are still forwarded`);
    assert.equal(trial.judgeAudit, undefined, `${mode}: the trial never carries the full audit`);
    if (mode === 'agreeing') {
      assert.equal(trial.assessmentError, undefined);
      assert.equal(trial.assessments?.[0]!.result, 'fail');
      assert.ok(trial.judgeReceipt);
      assert.equal(trial.judgeReceipt.auditHash, fingerprint(finals[0]!.audit));
      assert.equal(hasCompleteJudgment({ scenario, sources: observableSources(f.sources, []), trial }), true);
    } else {
      assert.match(trial.assessmentError ?? '', /Judge response rejected/);
      assert.ok(trial.judgeReceipt, 'a failed judgment still points to its sidecar');
      assert.equal(trial.judgeReceipt.complete, false);
      assert.equal(trial.judgeReceipt.auditHash, fingerprint(finals[0]!.audit));
      assert.equal(hasCompleteJudgment({ scenario, sources: observableSources(f.sources, []), trial }), false);
      assert.equal(hasCompleteJudgment({ scenario, sources: observableSources(f.sources, []), trial: { ...trial, assessmentError: undefined } }), false,
        'the sealed receipt is incomplete even without the error flag');
      assert.equal(trial.assessments, undefined);
      const raws = finals[0]!.audit.attempts.map(attempt => attempt.raw);
      assert.equal(raws.length, 4, 'each malformed vote was asked once more; all four replies stay on record');
      assert.ok(raws.every(raw => raw?.startsWith('not json')), 'every raw reply survives in the final audit');
    }
  }
});

test('a reply that carries a stand service marker leaves the situation unmeasured as «стенд ответил служебным текстом», never as an agent failure', async t => {
  const f = await fixture();
  const scenario = structuredClone(f.preparation.scenarios[0]!);
  scenario.checks = [];
  scenario.metrics = structuredClone(testMetrics);
  const actor: Runtime = { ...f.runtime, async assess() { throw new Error('the judge must not grade a stand failure'); } };
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-evaluation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stand = join(directory, 'stand.mjs');
  await writeFile(stand, 'export function createSession() { return { async respond() { return "К сожалению, от смежной системы IDP.VALIDATION не получен ответ. Попробуйте позже."; } }; }\n');
  const target = { kind: 'module' as const, path: stand, exportName: 'createSession', serviceReplies: ['не получен ответ', 'Некорректная маршрутизация'] };
  const trial = await evaluateTrial({ requirements: [], runtime: actor, revision: f.baseline, scenario, repeat: 0, manifestHash: 'frozen', sources: f.sources, settings: f.input.settings, ctx: context(), userMode: 'static', target });
  assert.equal(trial.outcome, 'invalid');
  assert.match(trial.reason, /^Стенд ответил служебным текстом «не получен ответ»/);
  assert.equal(trial.assessments, undefined, 'nothing was judged');
  assert.equal(trial.events.filter(e => e.type === 'assistant').length, 1, 'the reply itself stays on record');
});
