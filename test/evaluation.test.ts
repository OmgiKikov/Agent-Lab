import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { ExperimentStore } from '../src/store.js';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assessTrial, evaluateTrial } from '../src/evaluation.js';
import { assessRepeated, hasCompleteJudgment, observableSources } from '../src/judge.js';
import { createDemoRuntime } from '../src/demo.js';
import { proposalCall } from '../src/card/proposal.js';
import { checkSchema, experimentSchema, fingerprint, SANDBOX_RETIRED, type Scenario, type Source, type Target, type Trial, type World } from '../src/contracts.js';
import { goalAttainment, replyQuality, simulatorFidelity, type JudgeAudit, type MetricAssessment, type Rubric } from '../src/assessment.js';
import type { CallContext, DialogueMessage, Runtime } from '../src/runtime.js';
import { appointmentAgent, legacyDemoRuntime } from './helpers/demo-record.js';

function context(signal = new AbortController().signal): CallContext {
  return { signal, timeoutMs: 1000, beforeCall() { signal.throwIfAborted(); }, addUsage() {} };
}

/*
 * Old-format cards (no `execution` block) of the retired built-in demo run against external agents:
 * the appointment assistant as a module (`working` has the update tool, `withoutUpdate` still lacks
 * it) or an HTTP agent the test answers itself. The free user simulator drives the reactive turns.
 */
const draft = experimentSchema.parse(JSON.parse(await readFile(new URL('./fixtures/legacy-demo-draft.json', import.meta.url), 'utf8')));
const { sources, settings } = draft;
const revision = draft.revisions[0]!;
/** A card as the retired comparison workflow stored it: objective checks only, rubrics are added by each test. */
function card(id: string): Scenario {
  const found = draft.scenarios.find(scenario => scenario.id === id);
  assert.ok(found, id);
  const { metrics: _metrics, ...plain } = structuredClone(found);
  return plain;
}
const working: Target = { ...appointmentAgent('createRepairedSession'), timeoutMs: 30000 } as Target;
const withoutUpdate: Target = { ...appointmentAgent(), timeoutMs: 30000 } as Target;
const evaluate = (scenario: Scenario = card('a_direct'), target: Target = working, runtime: Runtime = legacyDemoRuntime(), ctx = context(),
  onStage?: Parameters<typeof evaluateTrial>[0]['onStage']) =>
  evaluateTrial({ requirements: [], runtime, revision, scenario, repeat: 0, manifestHash: 'frozen', sources, settings, ctx, userMode: 'reactive', target, onStage });

type AgentRequest = { sessionId: string; scenarioId: string; initialState: World; messages: DialogueMessage[]; message: string };
const servers = new Set<Server>();
after(() => { for (const server of servers) server.close(); });
/** An external agent the test answers itself, over the real HTTP contract. */
async function httpAgent(respond: (request: AgentRequest) => unknown): Promise<Target> {
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    try { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await respond(JSON.parse(body) as AgentRequest))); }
    catch (error) { response.writeHead(500).end(String(error)); }
  });
  servers.add(server);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  server.unref();
  return { kind: 'http', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, headersEnv: {}, timeoutMs: 60000 };
}
/** An address nobody listens on: the adapter cannot even deliver the opening. */
async function refusedAgent(): Promise<Target> {
  const server = createServer();
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(done => server.close(() => done()));
  return { kind: 'http', url: `http://127.0.0.1:${port}/`, headersEnv: {}, timeoutMs: 5000 };
}
/** The reply of an adapter that confirms its reset and reports its records and complete tool events. */
const observed = (request: AgentRequest, reply: string, extra: Record<string, unknown> = {}) =>
  ({ reply, records: request.initialState.records, resetConfirmed: true, eventsComplete: true, ...extra });

test('a stored sandbox card cannot run again: the retired built-in agent is refused before any session opens', async () => {
  await assert.rejects(evaluate(card('a_direct'), { kind: 'sandbox' }), (error: Error) => error.message === SANDBOX_RETIRED);
});

test('the built-in demo refuses foreign materials and dialogues instead of simulating a custom preparation', async () => {
  const runtime = createDemoRuntime();
  await assert.rejects(runtime.groundRequirements!({ task: 'An unrelated task', sources: [{ id: 'source-1', name: 'Other policy', content: 'Another rule.', hash: 'h' }] }, context()), /Учебный пример поддерживает только/);
  await assert.rejects(runtime.proposeCard!({ task: 't', requirements: [], articles: [], topics: [], written: [],
    call: proposalCall({ source: { kind: 'dialogue', batchId: 'batch', dialogueId: 'foreign' }, messages: [], requirements: [{ id: 'rule' }], maxTurns: 3 }) }, context()), /Учебный пример поддерживает только/);
});

test('the free simulator of an old validation card answers the current clarification and sees only this conversation', async () => {
  // Recorded customer words became facts of the card, not a script; the old agent's replies are not part of it.
  const validation: Scenario = { id: 'real', familyId: 'real', title: 'Узнать как оформить возврат', requirementIds: [], provenance: 'production', tier: 'regression', split: 'dev',
    user: { goal: 'Узнать как оформить возврат', facts: 'Магазин: Все для дома. Модель терминала неизвестна.', opening: 'Как оформить возврат?', maxFollowUps: 5,
      behavior: 'Ответь на текущий вопрос агента, используя только известные факты. Старые реплики — факты, а не порядок разговора.',
      knows: ['Как оформить возврат?', 'Все для дома'], cannotKnow: ['Правильный бизнес-ответ, скрытые данные клиента и состояние банковских систем.'] },
    initialState: { records: {}, writableFields: [], transientFailures: 0 }, checks: [], goalObservation: 'reply', successCriteria: 'Инструкция возврата по базе знаний.',
    metrics: [{ ...goalAttainment }, { ...replyQuality }, { ...simulatorFidelity }] };
  const messages: string[] = [];
  const histories: string[][] = [];
  const target = await httpAgent(request => { messages.push(request.message); return messages.length === 1 ? 'Какая модель терминала?' : 'Используйте меню возврата.'; });
  const runtime: Runtime = {
    async userTurn({ user, messages: history }) {
      assert.match(user.facts, /Все для дома/); assert.equal(user.script, undefined);
      histories.push(history.map(message => message.content));
      return history.at(-1)?.content === 'Какая модель терминала?' ? { message: 'Модель не знаю.', done: false } : { message: '', done: true };
    },
    async assess({ scenario, trial }) { return scenario.metrics!.map(m => ({ metricId: m.id, result: 'pass' as const, rationale: 'Fixture', evidence: [trial.events.find(e => e.type === 'assistant')!.seq] })); },
  };
  const result = await evaluate(validation, target, runtime);
  assert.equal(result.outcome, 'ungraded');
  assert.deepEqual(messages, ['Как оформить возврат?', 'Модель не знаю.']);
  assert.deepEqual(histories.at(-1), ['Как оформить возврат?', 'Какая модель терминала?', 'Модель не знаю.', 'Используйте меню возврата.']);
  assert.ok(result.assessments?.every(a => a.result === 'pass'));
});

test('answer_equals checks the last answer with exact case, whitespace and newlines, never an earlier matching answer', async () => {
  const scenario = card('a_direct');
  const expected = '  Готово!\n';
  scenario.checks = [checkSchema.parse({ id: 'literal', kind: 'answer_equals', description: 'Exact final reply', value: expected })];
  assert.equal(scenario.checks[0]!.kind === 'answer_equals' && scenario.checks[0]!.value, expected, 'schema must not trim expected text');
  scenario.user.maxFollowUps = 0;
  for (const response of [expected, expected.toLowerCase(), expected.trim(), expected.replace('\n', '\r\n'), `Prefix ${expected}`]) {
    const trial = await evaluate(scenario, await httpAgent(() => response));
    assert.equal(trial.checks[0]!.passed, response === expected, JSON.stringify(response));
    assert.equal(trial.outcome, response === expected ? 'pass' : 'fail');
    assert.match(trial.checks[0]!.evidence, /Последний ответ #1/);
  }
  scenario.user.maxFollowUps = 1;
  let replies = 0;
  const target = await httpAgent(() => ++replies === 1 ? expected : 'Другой ответ');
  const lastOnly = await evaluate(scenario, target, { ...legacyDemoRuntime(), async userTurn() { return { message: 'Ответь ещё раз.', done: true }; } });
  assert.equal(replies, 2);
  assert.equal(lastOnly.checks[0]!.passed, false);
  assert.match(lastOnly.checks[0]!.evidence, /Последний ответ #4/);
});

test('an agent that claims success without changing its reported state fails; the simulator sees only the user card and the dialogue', async () => {
  const claiming = await httpAgent(request => observed(request, 'I successfully moved appointment A101 to 14:00.'));
  const trial = await evaluate(card('a_direct'), claiming);
  assert.equal(trial.outcome, 'fail');
  assert.equal(trial.finalState.records.A101!.time, '09:00');
  let projection: unknown;
  await evaluate(card('c_clarify'), working, { ...legacyDemoRuntime(), async userTurn(input) { projection = input; return { message: '', done: true }; } });
  assert.deepEqual(Object.keys(projection as object).sort(), ['messages', 'turn', 'user']);
  assert.ok(!JSON.stringify(projection).includes('state_equals'));
});

test('ordering and retry-limit checks grade reported same-record tool transitions, not tool presence or assistant claims', async t => {
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
    const scenario = card('a_direct');
    scenario.initialState.transientFailures = sample.failures;
    scenario.initialState.records.A999 = { time: '08:00', owner: 'Another customer', status: 'booked' };
    scenario.checks.push(
      { id: 'fresh', kind: 'fresh_read_before_update', description: 'Read the same current record before each successful change' },
      { id: 'attempt_limit', kind: 'tool_count', tool: 'update_record', min: 1, max: 3, description: 'Attempt the intended update no more than three times' },
    );
    // The adapter performs the actions on its own records and reports each call with its result.
    const target = await httpAgent(request => {
      const records = structuredClone(request.initialState.records);
      let failures = request.initialState.transientFailures;
      const events = sample.actions.map(([tool, recordId]) => {
        const record = Object.hasOwn(records, recordId) ? records[recordId] : undefined;
        if (tool === 'lookup_record') return { tool, args: { recordId }, result: record ? { ok: true, recordId, record: structuredClone(record) } : { ok: false, error: 'Record not found', retryable: false } };
        const args = { recordId, changes: { time: '14:00' } };
        if (failures > 0) { failures -= 1; return { tool, args, result: { ok: false, error: 'Temporary update failure; retry is safe', retryable: true } }; }
        record!.time = '14:00';
        return { tool, args, result: { ok: true, recordId, record: structuredClone(record) } };
      });
      return { reply: 'I read the current record first and respected the retry limit.', events, records, resetConfirmed: true, eventsComplete: true };
    });
    const trial = await evaluate(scenario, target);
    assert.equal(trial.finalState.records.A101!.time, '14:00');
    assert.equal(trial.checks.find(check => check.id === 'fresh')!.passed, sample.fresh);
    assert.equal(trial.checks.find(check => check.id === 'attempt_limit')!.passed, sample.count);
    assert.equal(trial.outcome, sample.fresh && sample.count ? 'pass' : 'fail');
    if (!sample.fresh) assert.match(trial.checks.find(check => check.id === 'fresh')!.evidence, /event \d+/);
  });
});

test('tool_count counts a reported rejected attempt, and ordering does not invent an action when none happened', async () => {
  const scenario = card('a_direct');
  scenario.checks = [
    { id: 'count', kind: 'tool_count', tool: 'update_record', min: 0, max: 0, description: 'No update attempts' },
    { id: 'fresh', kind: 'fresh_read_before_update', description: 'Each update must follow a fresh read' },
  ];
  const idle = await evaluate(scenario, await httpAgent(request => observed(request, 'Nothing changed.')));
  assert.equal(idle.outcome, 'pass');
  assert.match(idle.checks[1]!.evidence, /not exercised/);
  const rejected = await evaluate(scenario, await httpAgent(request => observed(request, 'The invalid update was rejected.',
    { events: [{ tool: 'update_record', args: { recordId: 'A101', changes: {} }, result: { ok: false, rejected: true } }] })));
  assert.equal(rejected.checks[0]!.passed, false);
  assert.match(rejected.checks[0]!.evidence, /attempted 1/);
});

test('forbidden wording in a reply fails its check while the same phrase elsewhere does not', async () => {
  // Дефект, ради которого проверка и нужна: клиенту уходит текст, написанный для оператора.
  const scenario = card('a_direct');
  scenario.checks = [
    { id: 'no_staff_text', kind: 'answer_omits', description: 'В ответе клиенту нет инструкций для оператора', value: 'Оператору необходимо' },
  ];
  const leaked = await evaluate(scenario, await httpAgent(() => 'Оператору необходимо осуществить ручной поиск.'));
  assert.equal(leaked.checks[0]!.passed, false);
  assert.match(leaked.checks[0]!.evidence, /contains/);
  const kept = await evaluate(scenario, await httpAgent(() => 'Посмотрите тариф в разделе «Мои точки продаж».'));
  assert.equal(kept.checks[0]!.passed, true);
});

test('simulator protocol/provider errors are invalid; exhausting target turns is a valid failure', async () => {
  const legacy = card('a_direct');
  delete legacy.user.maxFollowUps;
  const invalid = await evaluate(legacy, working, { ...legacyDemoRuntime(), async userTurn() { return { message: '', done: false }; } });
  assert.equal(invalid.outcome, 'invalid');
  assert.match(invalid.reason, /реплика симулированного пользователя/);
  const failed = await evaluate(legacy, working, { ...legacyDemoRuntime(), async userTurn() { throw new Error('Provider offline'); } });
  assert.equal(failed.outcome, 'invalid');
  const neverDone = await evaluate(legacy, working, { ...legacyDemoRuntime(), async userTurn() { return { message: 'Please confirm again.', done: false }; } });
  assert.equal(neverDone.outcome, 'invalid');
  assert.match(neverDone.reason, /не завершился в отведённое число реплик/);
  // A runtime without the free simulator cannot continue an old card: the dialogue is unmeasured, never an agent failure.
  const { userTurn: _userTurn, ...withoutSimulator } = legacyDemoRuntime();
  const unsupported = await evaluate(legacy, working, withoutSimulator);
  assert.equal(unsupported.outcome, 'invalid');
  assert.match(unsupported.reason, /свободного симулятора/);
});

test('a card follow-up budget bounds an adversarial retrying simulator without passing an unchanged task', async () => {
  for (const budget of [0, 1]) {
    const scenario = card('a_direct');
    scenario.user.maxFollowUps = budget;
    const received: string[] = [];
    let simulations = 0;
    const target = await httpAgent(request => { received.push(request.message); return observed(request, 'The update is unavailable; no change was made.'); });
    const runtime: Runtime = { ...legacyDemoRuntime(), async userTurn({ messages }) {
      simulations += 1; assert.match(messages.at(-1)!.content, /unavailable/); return { done: false, message: 'Please retry the same change.' };
    } };
    const trial = await evaluate(scenario, target, runtime);
    assert.equal(simulations, budget);
    assert.equal(received.length, budget + 1);
    if (budget) assert.equal(received[1], 'Please retry the same change.');
    assert.equal(trial.outcome, 'fail');
    assert.match(trial.reason, /^Часть объективных проверок провалена\./);
    assert.equal(trial.finalState.records.A101!.time, '09:00');
  }
});

test('a terminal simulator message is delivered before stopping; empty terminal messages stop without an invented user turn', async () => {
  for (const message of ['A103', '', '   ']) {
    const scenario = card('c_clarify');
    scenario.user.maxFollowUps = 2; // The terminal signal, not budget exhaustion, must stop the next simulation.
    let simulations = 0;
    const runtime: Runtime = { ...legacyDemoRuntime(), async userTurn() { simulations += 1; return { done: true, message }; } };
    const trial = await evaluate(scenario, working, runtime);
    const userMessages = trial.events.filter(e => e.type === 'user').map(e => e.text);
    assert.deepEqual(trial.events.filter(e => e.type === 'simulator').map(e => e.result), [{ done: true, message }]);
    assert.equal(simulations, 1);
    if (message.trim()) {
      assert.deepEqual(userMessages, [scenario.user.opening, 'A103']);
      assert.equal(trial.outcome, 'pass', trial.reason);
      assert.equal(trial.finalState.records.A103!.time, '11:30');
    } else {
      assert.deepEqual(userMessages, [scenario.user.opening]);
      assert.equal(trial.outcome, 'fail');
      assert.equal(trial.finalState.records.A103!.time, '09:00');
    }
    const noFollowUp = structuredClone(scenario);
    noFollowUp.user.maxFollowUps = 0;
    simulations = 0;
    const bounded = await evaluate(noFollowUp, working, runtime);
    assert.equal(simulations, 0);
    assert.equal(bounded.events.filter(e => e.type === 'simulator').length, 0);
    assert.equal(bounded.outcome, 'fail');
  }
});

const testMetrics: Rubric[] = [
  { id: 'goal', name: 'Goal achieved', subject: 'agent', description: 'Judge the requested outcome.', passCriteria: 'The user goal was achieved.', failCriteria: 'The user goal was not achieved.' },
  { id: 'role', name: 'Role fidelity', subject: 'simulator', description: 'Judge the simulated user behavior.', passCriteria: 'The user followed the assigned role.', failCriteria: 'The user introduced contradictory facts.' },
];

test('rubric-only dialogues stay ungraded; assessments run after cleanup, cite real events, and cannot mutate target evidence or objective outcomes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-evaluation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const closedMarker = join(directory, 'closed');
  const refusing = join(directory, 'refusing.mjs');
  // The adapter marks its own disposal, so the judge can see that the target session ended before it started.
  await writeFile(refusing, `import { writeFileSync } from 'node:fs';
export function createSession({ initialState }) { return {
  async respond() { return { reply: 'I cannot make that change.', records: initialState.records, resetConfirmed: true, eventsComplete: true }; },
  async close() { writeFileSync(${JSON.stringify(closedMarker)}, 'closed'); },
}; }\n`);
  const target: Target = { kind: 'module', path: refusing, exportName: 'createSession', timeoutMs: 30000 };
  const scenario = card('a_direct');
  scenario.checks = [];
  scenario.metrics = structuredClone(testMetrics);
  const stages: string[] = [];
  const actor: Runtime = { ...legacyDemoRuntime(),
    async assess(input, ctx) {
      assert.equal(existsSync(closedMarker), true, 'the target session is closed before the assessment');
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
  const trial = await evaluate(scenario, target, actor, context(), stage => stages.push(stage));
  assert.equal(trial.outcome, 'ungraded');
  assert.deepEqual(trial.checks, []);
  assert.equal(trial.assessments?.[0]!.result, 'fail');
  assert.equal(trial.assessments?.[1]!.result, 'unknown');
  assert.equal(trial.assessmentError, undefined);
  assert.equal(stages[0], 'target');
  assert.equal(trial.events[0]!.text, scenario.user.opening);
  assert.equal(scenario.metrics[0]!.name, 'Goal achieved');
  assert.deepEqual(trial.usage, { calls: 1, inputTokens: 20, outputTokens: 5, costUsd: 0.01 });
  const objective = card('a_direct');
  objective.metrics = [structuredClone(testMetrics[0]!)];
  actor.assess = async () => [{ metricId: 'goal', result: 'pass', rationale: 'This intentionally wrong judgment cannot replace the state check.', evidence: [1] }];
  const failed = await evaluate(objective, target, actor);
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
    const scenario = card('a_direct');
    scenario.metrics = structuredClone(testMetrics);
    const trial = await evaluate(scenario, working, { ...legacyDemoRuntime(), assess: sample.assess });
    assert.equal(trial.outcome, 'pass', trial.reason);
    assert.equal(trial.finalState.records.A101!.time, '14:00');
    assert.equal(trial.assessments, undefined);
    assert.match(trial.assessmentError!, sample.error);
  });
});

test('an incomplete or invalid dialogue is not sent to the rubric assessor', async () => {
  const scenario = card('a_direct');
  scenario.metrics = structuredClone(testMetrics);
  let assessments = 0;
  const actor: Runtime = { ...legacyDemoRuntime(), async assess() { assessments += 1; return []; } };
  const incomplete = await evaluate(scenario, await httpAgent(() => ''), actor);
  assert.equal(incomplete.outcome, 'invalid');
  const invalid = await evaluate(scenario, await refusedAgent(), actor);
  assert.equal(invalid.outcome, 'invalid');
  assert.match(invalid.reason, /ответ испытуемого/);
  assert.equal(assessments, 0);
});

test('cancellation stops the dialogue at the target and makes no further simulator calls', async () => {
  const controller = new AbortController();
  let requests = 0;
  let simulated = 0;
  // The owner cancels while the agent is still answering; its reply never arrives.
  const target = await httpAgent(() => { requests += 1; controller.abort(); return new Promise(() => {}); });
  const runtime: Runtime = { ...legacyDemoRuntime(), async userTurn() { simulated += 1; return { message: '', done: true }; } };
  const trial = await evaluate(card('a_direct'), target, runtime, context(controller.signal));
  assert.equal(trial.outcome, 'cancelled');
  assert.equal(requests, 1);
  assert.equal(simulated, 0);
});

test('trace sink sees immutable events and persistence errors escape instead of becoming a grade', async () => {
  const ctx = context();
  const observedEvents: unknown[] = [];
  ctx.onTrace = (_id, event) => { observedEvents.push(structuredClone(event)); event.text = 'tampered'; };
  const trial = await evaluate(card('a_direct'), working, legacyDemoRuntime(), ctx);
  assert.equal(observedEvents.length, trial.events.length);
  assert.notEqual(trial.events[0]!.text, 'tampered');
  const failing = context();
  failing.onTrace = () => { throw new Error('Disk full'); };
  await assert.rejects(evaluate(card('a_direct'), withoutUpdate, legacyDemoRuntime(), failing), /Disk full/);
});

test('reported tool events enter target evidence in order without exposing that callback to the simulator', async () => {
  const scenario = card('a_direct');
  scenario.user.maxFollowUps = 1;
  let simulatorHasTargetCallback = true;
  const target = await httpAgent(request => observed(request, 'I could not perform the update.',
    { events: [{ tool: 'bash', args: { command: 'cat hidden.json' }, result: { error: 'Tool is unavailable' } }] }));
  const runtime: Runtime = { ...legacyDemoRuntime(), async userTurn(_input, ctx) { simulatorHasTargetCallback = Boolean(ctx.onTargetEvent); return { message: '', done: true }; } };
  const trial = await evaluate(scenario, target, runtime);
  assert.equal(simulatorHasTargetCallback, false);
  assert.equal(trial.events.filter(e => e.tool === 'bash').length, 2);
  assert.deepEqual(trial.events.map(e => e.seq), trial.events.map((_e, i) => i));
  assert.equal(trial.outcome, 'fail');
  const ctx = context();
  ctx.onTrace = (_id, event) => { if (event.tool === 'bash') throw undefined; };
  let rejected = false;
  try { await evaluate(scenario, target, runtime, ctx); } catch { rejected = true; }
  assert.equal(rejected, true, 'even an undefined persistence error must escape');
});

test('unknown model cost remains unknown in trial evidence', async () => {
  const scenario = card('a_direct');
  scenario.metrics = [structuredClone(testMetrics[0]!)];
  const runtime: Runtime = { async assess(_input, ctx) {
    ctx.beforeCall(); ctx.addUsage({ inputTokens: 12, outputTokens: 3, costUsd: null });
    return [{ metricId: 'goal', result: 'pass', rationale: 'Supported by the cited reply.', evidence: [1] }];
  } };
  const trial = await evaluate(scenario, working, runtime);
  assert.equal(trial.usage.costUsd, null);
  assert.equal(trial.usage.inputTokens, 12);
});

test('static and scripted user modes never call the simulator and stop within their own bounds', async () => {
  const runtime: Runtime = { ...legacyDemoRuntime(), userTurn: async () => { throw new Error('simulator must not run'); } };
  const clarify = card('c_clarify');
  const run = (scenario: Scenario, userMode: 'static' | 'scripted') => evaluateTrial({ requirements: [], runtime, revision, scenario, repeat: 0, manifestHash: 'frozen', sources, settings, ctx: context(), userMode, target: working });
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

test('external module targets are graded on reported records and events', async t => {
  const runtime = legacyDemoRuntime();
  const direct = card('a_direct');
  const run = (scenario: Scenario, path: string) => evaluateTrial({ requirements: [], runtime, revision, scenario, repeat: 0, manifestHash: 'frozen', sources, settings, ctx: context(), userMode: 'static', target: { kind: 'module', path, exportName: 'createSession' } });
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
    revision, scenario: { ...direct, metrics: [{ id: 'goal', name: 'Goal', subject: 'agent', description: 'Goal', passCriteria: 'Done', failCriteria: 'Not done' }] },
    repeat: 0, manifestHash: 'frozen', sources, settings, ctx: context(), userMode: 'static',
    target: { kind: 'module', path: unavailable, exportName: 'createSession' } });
  assert.equal(infrastructure.outcome, 'invalid');
  assert.equal(assessed, false, 'an adapter-reported measurement error cannot become an agent verdict');
  assert.deepEqual(infrastructure.events.map(e => e.type), ['user', 'tool_call', 'tool_result', 'assistant', 'error']);
  assert.equal(infrastructure.events[3]!.text, 'Нет данных для ответа.');
  assert.match(infrastructure.reason, /В фикстуре отсутствует lookup_record/);
});

test('reactive dialogues record simulator checks that never change the objective outcome', async () => {
  const clarify = card('c_clarify');
  const inventing: Runtime = { ...legacyDemoRuntime(), async userTurn() { return { message: 'My appointment ID is A999.', done: false }; } };
  const trial = await evaluate(clarify, working, inventing);
  const fabrication = trial.simulatorChecks!.find(c => c.id === 'simulator_fabrication')!;
  assert.equal(fabrication.passed, false);
  assert.match(fabrication.evidence, /a999/);
  assert.equal(trial.simulatorChecks!.find(c => c.id === 'simulator_leak')!.passed, true);
  assert.equal(trial.outcome, 'fail', 'the agent could not find A999; the simulator check does not decide that');
  assert.doesNotMatch(trial.reason, /симулятор/i);
  const honest = await evaluate(clarify, working);
  assert.equal(honest.events.filter(e => e.type === 'user')[1]?.text, 'My appointment ID is A103.', 'the free simulator answers a clarification from the card\'s own answers');
  assert.ok(honest.simulatorChecks!.every(c => c.passed), JSON.stringify(honest.simulatorChecks));
  assert.equal(honest.outcome, 'pass', honest.reason);
  const opening = await evaluate(card('a_direct'), working);
  assert.deepEqual(opening.simulatorChecks, [], 'a dialogue that stops after the opening has nothing to check');
});

test('an unconfirmed external world is named in the reason without inventing an agent failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-external-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(directory, { recursive: true, force: true }); });
  const silent = join(directory, 'no-reset.mjs');
  await writeFile(silent, 'export function createSession({ initialState }) { return { async respond() { return { reply: `cards: ${initialState.external.cards.length}`, records: initialState.records }; } }; }\n');
  const confirming = join(directory, 'reset.mjs');
  await writeFile(confirming, 'export function createSession({ initialState }) { return { async respond() { return { reply: `cards: ${initialState.external.cards.length}`, records: initialState.records, resetConfirmed: true }; } }; }\n');
  const scenario: Scenario = { ...card('a_direct'), checks: [], metrics: undefined, initialState: { records: {}, writableFields: [], transientFailures: 0, external: { cards: [{ id: 'c1', status: 'blocked' }] } } };
  const run = (path: string) => evaluateTrial({ requirements: [], runtime: legacyDemoRuntime(), revision, scenario, repeat: 0, manifestHash: 'frozen',
    sources, settings, ctx: context(), userMode: 'static', target: { kind: 'module', path, exportName: 'createSession' } });
  const unconfirmed = await run(silent);
  assert.equal(unconfirmed.outcome, 'invalid');
  assert.match(unconfirmed.reason, /Внешнее состояние карточки не подтверждено адаптером/);
  assert.equal(unconfirmed.events.find(e => e.type === 'assistant')?.text, 'cards: 1', 'the external world reached the adapter');
  const confirmed = await run(confirming);
  assert.doesNotMatch(confirmed.reason, /не подтверждено адаптером/);
  assert.equal(confirmed.observation?.resetConfirmed, true);
});

test('a receipt hashes the audit exactly as the sidecar stores it, even with a whitespace-padded judge error', async t => {
  const scenario: Scenario = { ...card('a_direct'), checks: [],
    metrics: [{ id: 'goal', name: 'Goal', subject: 'agent', description: 'Original task', passCriteria: 'Instruction supplied', failCriteria: 'A refusal is supplied' }] };
  const trial: Trial = { id: 'trial', revisionId: 'baseline', scenarioId: scenario.id, familyId: scenario.familyId, repeat: 0, split: 'dev', userMode: 'static', manifestHash: 'frozen',
    outcome: 'ungraded', reason: 'rubric only', checks: [], events: [{ seq: 0, type: 'user', text: scenario.user.opening }, { seq: 1, type: 'assistant', text: 'Сделайте так.' }],
    initialState: scenario.initialState, finalState: scenario.initialState, usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: null }, elapsedMs: 1 };
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-receipt-'));
  const store = new ExperimentStore(directory);
  await store.init();
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const runtime: Runtime = { ...legacyDemoRuntime(), async assess(input, ctx) {
    return assessRepeated(input, { provider: 'offline', id: 'judge' }, ctx, async () => { throw new Error('429 Too Many Requests\n'); });
  } };
  const ctx: CallContext = { ...context(), onJudgment: (id, audit) => store.writeJudgeAudit('run-1', id, audit) };
  await assert.rejects(assessTrial(runtime, scenario, sources, trial, ctx, []), /429/);
  assert.ok(trial.judgeReceipt);
  const stored = await store.readJudgeAudit('run-1', trial.id);
  assert.ok(stored?.attempts.some(attempt => attempt.error === '429 Too Many Requests'));
  assert.equal(fingerprint(stored), trial.judgeReceipt.auditHash, 'an honest receipt matches its sidecar');
});

test('assessment hands the judge observable prompt rules in place of the raw prompt, with every other source intact', async () => {
  const scenario: Scenario = { ...card('a_direct'), checks: [],
    metrics: [{ id: 'goal', name: 'Goal', subject: 'agent', description: 'Original task', passCriteria: 'Instruction supplied', failCriteria: 'A refusal is supplied' }] };
  const trial: Trial = { id: 'trial', revisionId: 'baseline', scenarioId: scenario.id, familyId: scenario.familyId, repeat: 0, split: 'dev', userMode: 'static', manifestHash: 'frozen',
    outcome: 'ungraded', reason: 'rubric only', checks: [], events: [{ seq: 0, type: 'user', text: scenario.user.opening }, { seq: 1, type: 'assistant', text: 'Сделайте так.' }],
    initialState: scenario.initialState, finalState: scenario.initialState, usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: null }, elapsedMs: 1 };
  const prompt: Source = { id: 'prompt_1', name: 'prompt.md', hash: 'h', kind: 'prompt', content: 'Отвечай на «вы». ВСЕГДА возвращай валидный JSON в формате {"output": "*Финальный ответ*"}.' };
  const requirements = [{ id: 'formal', text: 'formal', sourceId: 'prompt_1', quote: 'Отвечай на «вы»', critical: true }];
  let seen: Source[] | undefined;
  const runtime: Runtime = { ...legacyDemoRuntime(), async assess(input) { seen = input.sources; return [{ metricId: 'goal', result: 'pass', rationale: 'Instruction supplied at #1.', evidence: [1] }]; } };
  const assessments = await assessTrial(runtime, scenario, [...sources, prompt], trial, context(), requirements);
  assert.equal(assessments[0]!.result, 'pass');
  assert.equal(seen!.length, sources.length + 1);
  assert.deepEqual(seen!.slice(0, sources.length), sources, 'policy sources reach the judge unchanged');
  assert.match(seen!.at(-1)!.content, /1\. «Отвечай на «вы»»/);
  assert.doesNotMatch(JSON.stringify(seen), /JSON|output/);
});

test('a bounded judge reference set does not restrict the target knowledge base and seals the same receipt input', async () => {
  const selected = [sources[0]!];
  const scenario: Scenario = { ...card('a_direct'), checks: [], metrics: [structuredClone(testMetrics[0]!)] };
  // The agent keeps its own knowledge base: the request it receives carries no reference set of Lab's.
  const requestKeys: string[][] = [];
  const target = await httpAgent(request => { requestKeys.push(Object.keys(request).sort()); return 'I cannot make that change.'; });
  const actor: Runtime = { ...legacyDemoRuntime(),
    async assess(input, ctx) {
      assert.deepEqual(input.sources, selected, 'judge sees the case references');
      return assessRepeated(input, { provider: 'offline', id: 'judge' }, ctx, async (_prompt, data) => {
        const parsed = JSON.parse(data), reply = parsed.trial.events.find((e: any) => e.type === 'assistant');
        return JSON.stringify({ assessments: parsed.scenario.metrics.map((m: any) => ({ metricId: m.id,
          passCondition: 'not_met', failCondition: 'met', rationale: 'The agent refused.', evidence: [reply.seq], citations: [{ seq: reply.seq, quote: reply.content }] })) });
      });
    },
  };
  const trial = await evaluateTrial({ runtime: actor, revision, scenario, sources: sources, judgeSources: selected,
    requirements: [], settings, repeat: 0, manifestHash: 'frozen', userMode: 'static', target, ctx: context() });
  assert.deepEqual(requestKeys, [['initialState', 'message', 'messages', 'scenarioId', 'sessionId']]);
  assert.equal(trial.assessmentError, undefined);
  assert.equal(hasCompleteJudgment({ scenario, sources: selected, trial }), true);
});

test('live evaluation seals a receipt, reports the final judgment once, and a rejected judgment keeps its raw replies and an incomplete receipt', async () => {
  const scenario = card('a_direct');
  scenario.checks = [];
  scenario.metrics = [structuredClone(testMetrics[0]!)];
  for (const mode of ['agreeing', 'malformed'] as const) {
    const reports: { audit: JudgeAudit; final: boolean }[] = [];
    const target = await httpAgent(() => 'I cannot make that change.');
    const actor: Runtime = { ...legacyDemoRuntime(),
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
    const trial = await evaluate(scenario, target, actor, ctx);
    const finals = reports.filter(report => report.final);
    assert.equal(finals.length, 1, `${mode}: the final judgment is reported exactly once`);
    assert.ok(reports.length > 1, `${mode}: partial reports are still forwarded`);
    assert.equal(trial.judgeAudit, undefined, `${mode}: the trial never carries the full audit`);
    if (mode === 'agreeing') {
      assert.equal(trial.assessmentError, undefined);
      assert.equal(trial.assessments?.[0]!.result, 'fail');
      assert.ok(trial.judgeReceipt);
      assert.equal(trial.judgeReceipt.auditHash, fingerprint(finals[0]!.audit));
      assert.equal(hasCompleteJudgment({ scenario, sources: observableSources(sources, []), trial }), true);
    } else {
      assert.match(trial.assessmentError ?? '', /Judge response rejected/);
      assert.ok(trial.judgeReceipt, 'a failed judgment still points to its sidecar');
      assert.equal(trial.judgeReceipt.complete, false);
      assert.equal(trial.judgeReceipt.auditHash, fingerprint(finals[0]!.audit));
      assert.equal(hasCompleteJudgment({ scenario, sources: observableSources(sources, []), trial }), false);
      assert.equal(hasCompleteJudgment({ scenario, sources: observableSources(sources, []), trial: { ...trial, assessmentError: undefined } }), false,
        'the sealed receipt is incomplete even without the error flag');
      assert.equal(trial.assessments, undefined);
      const raws = finals[0]!.audit.attempts.map(attempt => attempt.raw);
      assert.equal(raws.length, 4, 'each malformed vote was asked once more; all four replies stay on record');
      assert.ok(raws.every(raw => raw?.startsWith('not json')), 'every raw reply survives in the final audit');
    }
  }
});

test('a reply that carries a stand service marker leaves the situation unmeasured as «стенд ответил служебным текстом», never as an agent failure', async t => {
  const scenario = card('a_direct');
  scenario.checks = [];
  scenario.metrics = structuredClone(testMetrics);
  const actor: Runtime = { ...legacyDemoRuntime(), async assess() { throw new Error('the judge must not grade a stand failure'); } };
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-evaluation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stand = join(directory, 'stand.mjs');
  await writeFile(stand, 'export function createSession() { return { async respond() { return "К сожалению, от смежной системы IDP.VALIDATION не получен ответ. Попробуйте позже."; } }; }\n');
  const target = { kind: 'module' as const, path: stand, exportName: 'createSession', serviceReplies: ['не получен ответ', 'Некорректная маршрутизация'] };
  const trial = await evaluateTrial({ requirements: [], runtime: actor, revision, scenario, repeat: 0, manifestHash: 'frozen', sources: sources, settings, ctx: context(), userMode: 'static', target });
  assert.equal(trial.outcome, 'invalid');
  assert.match(trial.reason, /^Стенд ответил служебным текстом «не получен ответ»/);
  assert.equal(trial.assessments, undefined, 'nothing was judged');
  assert.equal(trial.events.filter(e => e.type === 'assistant').length, 1, 'the reply itself stays on record');
});
