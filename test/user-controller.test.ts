import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserState, allowedUserActions, advanceUser, requiredUserTurns, userDecisionSchema } from '../src/user-controller.js';
import { behaviorPolicySchema } from '../src/scenario-contracts.js';
import { storedRunV1 } from './helpers/library-v1.js';
import { evaluateTrial } from '../src/evaluation.js';
import { headlineTrialResult } from '../src/outcomes.js';
import { settingsSchema, targetSchema, type Scenario } from '../src/contracts.js';
import type { Runtime } from '../src/runtime.js';

/** An external agent over HTTP inside the test process: `reply` answers each delivered message; `sent` is what reached the agent. */
async function httpAgent(reply: (body: { message: string; initialState: unknown }) => unknown) {
  const { createServer } = await import('node:http');
  const sent: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const parsed = JSON.parse(body) as { message: string; initialState: unknown };
      sent.push(parsed.message);
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify(reply(parsed)));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as import('node:net').AddressInfo;
  return { sent, target: targetSchema.parse({ kind: 'http', url: `http://127.0.0.1:${port}/` }),
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

const policy = () => behaviorPolicySchema.parse({ version: 1, initialState: 'start', states: ['start', 'answered', 'done'], terminalStates: ['done'], maxFollowUps: 3, repetitionLimit: 1,
  actions: [{ id: 'answer', kind: 'answer', factIds: ['number'], payload: 'Номер терминала: 1234', ifAsked: 'номер терминала' }, { id: 'change', kind: 'change_intent', factIds: [], payload: 'Теперь хочу отменить возврат' }, { id: 'finish', kind: 'finish', factIds: [] }],
  transitions: [{ from: 'start', to: 'answered', actionId: 'answer', when: 'Нужен номер терминала' }, { from: 'start', to: 'done', actionId: 'finish', when: 'Достаточный ответ' }, { from: 'answered', to: 'done', actionId: 'change', when: 'После уточнения' }] });
const facts = [{ id: 'number', statement: 'Номер терминала: 1234', value: '1234' }];

test('the controller answers with one allowed action id; the harness renders the message from the action', () => {
  const state = createUserState(policy(), facts);
  const choice = userDecisionSchema(allowedUserActions(state, ''));
  assert.throws(() => choice.parse({ actionId: 'change' }), 'a move not allowed now is outside the enum');
  assert.throws(() => choice.parse({ actionId: 'answer', factIds: ['hidden'] }), /Unrecognized/, 'fact references come from the action, never from the answer');
  assert.throws(() => choice.parse({ actionId: 'answer', message: 'secret-value' }), /Unrecognized/, 'the answer carries no text');
  assert.throws(() => userDecisionSchema([]), /допустимых действий/);
  assert.throws(() => advanceUser(state, { actionId: 'change' }), /переход|действие/i);
  assert.equal(state.position, 'start');
  assert.deepEqual(allowedUserActions(state, 'Назовите номер терминала').map(a => a.id), ['answer']);
  assert.throws(() => advanceUser(state, { actionId: 'finish' }), /действие|намерени/i);
  const next = advanceUser(state, choice.parse({ actionId: 'answer' }));
  assert.equal(next.message, 'Номер терминала: 1234');
  const end = advanceUser(next.state, { actionId: 'change' });
  assert.equal(end.message, 'Теперь хочу отменить возврат');
  assert.equal(end.done, true);
  assert.equal(requiredUserTurns(policy(), facts), 3);
});

test('repetition and finite follow-up bounds cannot be evaded with repeated clarification', () => {
  const p = policy(); p.actions = [{ id: 'ask', kind: 'clarify', factIds: [], payload: 'Что нужно уточнить?' }, { id: 'finish', kind: 'finish', factIds: [] }];
  p.transitions = [{ from: 'start', to: 'start', actionId: 'ask', when: 'Неясный ответ' }, { from: 'start', to: 'done', actionId: 'finish', when: 'Достаточный ответ' }];
  const next = advanceUser(createUserState(p, []), { actionId: 'ask' });
  assert.throws(() => advanceUser(next.state, { actionId: 'ask' }), /действие|повтор/i);
  assert.equal(advanceUser(next.state, { actionId: 'finish' }).message, '');
  assert.equal(requiredUserTurns(p, []), 1, 'empty finish consumes no target turn');
});

const { sources, requirements } = storedRunV1();
/** A stored first-format card, compiled when it was accepted; its customer opens the way these tests expect. */
function compiled(): Scenario {
  const scenario = structuredClone(storedRunV1().scenarios.find(item => item.id === 'known_number')!);
  scenario.user.opening = 'Помогите с возвратом';
  scenario.execution!.userView.opening = 'Помогите с возвратом';
  return scenario;
}
async function evaluate(scenario: Scenario, decisions: unknown[], options: { mode?: 'reactive' | 'static' | 'scripted'; maxTurns?: number; abort?: boolean } = {}) {
  const inputs: unknown[] = []; let calls = 0;
  const controller = new AbortController();
  const agent = await httpAgent(() => 'Назовите номер терминала');
  const runtime = {
    async selectUserAction(input: unknown, ctx: { beforeCall(): void }) { inputs.push(input); ctx.beforeCall(); if (options.abort) controller.abort(); return decisions.shift(); },
    async userTurn() { throw new Error('Legacy simulator must not receive controlled cards'); },
    async assess() { return []; },
  } as unknown as Runtime;
  const result = await evaluateTrial({ scenario, runtime, revision: { id: 'base', parentId: null, spec: { name: 'Агент', instructions: 'Помогать', tools: [] }, hypothesis: '', createdAt: '' }, repeat: 0, manifestHash: 'frozen', sources, requirements,
    settings: settingsSchema.parse({ maxTurns: options.maxTurns ?? 3 }), userMode: options.mode ?? 'reactive', target: agent.target,
    ctx: { signal: controller.signal, timeoutMs: 1000, beforeCall() { calls++; }, addUsage() {} } }).finally(agent.close);
  return { result, sent: agent.sent, inputs, calls };
}

test('compiled accepted card freezes separated execution views and rejects illegal output without target delivery', async () => {
  const scenario = compiled();
  assert.ok(scenario.execution);
  scenario.execution!.userView.policy = policy(); scenario.execution!.userView.facts = facts;
  const result = await evaluate(scenario, [{ actionId: 'answer', factIds: ['hidden'] }]);
  assert.equal(result.result.outcome, 'invalid'); assert.match(result.result.reason, /Симулятор выбрал действие, которого нет среди допустимых/);
  assert.deepEqual(result.sent, ['Помогите с возвратом'], 'nothing the controller got wrong reaches the agent'); assert.equal(result.calls, 1);
  assert.equal(result.result.events.filter(e => e.type === 'simulator').length, 0);
  assert.doesNotMatch(JSON.stringify(result.inputs), /evaluatorView|requirementId|environmentView|checkpoint/);
});

test('the exact authorized payload is delivered and a terminal change of intent still obtains the agent\'s response', async () => {
  const s = compiled(); s.execution!.userView.policy = policy(); s.execution!.userView.facts = facts;
  const got = await evaluate(s, [{ actionId: 'answer' }, { actionId: 'change' }]);
  assert.deepEqual(got.sent, ['Помогите с возвратом', 'Номер терминала: 1234', 'Теперь хочу отменить возврат']);
  assert.equal(got.result.events.filter(e => e.type === 'assistant').length, 3);
  assert.deepEqual(got.result.events.filter(e => e.type === 'simulator').map(e => (e.result as { decision: unknown }).decision), [{ actionId: 'answer' }, { actionId: 'change' }]);
  assert.equal(got.calls, 2);
  assert.notEqual(got.result.outcome, 'invalid');
});

test('controlled execution preflights finite path and rejects bypass modes without opening target', async () => {
  const s = compiled(); s.execution!.userView.policy = policy(); s.execution!.userView.facts = facts;
  for (const options of [{ maxTurns: 2 }, { mode: 'static' as const }, { mode: 'scripted' as const }]) {
    const got = await evaluate(s, [], options); assert.equal(got.result.outcome, 'invalid'); assert.deepEqual(got.sent, []);
  }
  const cancelled = await evaluate(s, [{ actionId: 'answer' }], { abort: true });
  assert.equal(cancelled.result.outcome, 'cancelled'); assert.deepEqual(cancelled.sent, ['Помогите с возвратом']);
});

test('trusted observation events let exact checks of a first-format card prove a correct refusal without prose', async () => {
  const s = compiled(); delete s.metrics;
  s.execution!.environmentView = { mode: 'managed', contract: { reset: true, confirmed: true, operations: ['update_record'], observations: ['reply', 'tool', 'state'] } };
  s.initialState = { records: { item: { status: 'pending' } }, writableFields: ['status'], transientFailures: 0 };
  const view = s.execution!.evaluatorView;
  if (!('checkpoints' in view)) throw new Error('a first-format card');
  const checks = [{ id: 'no_mutation', kind: 'tool_not_called', tool: 'update_record', description: 'При корректном отказе изменений нет' } as const,
    { id: 'same_state', kind: 'state_equals', recordId: 'item', field: 'status', value: 'pending', description: 'Состояние не изменилось' } as const];
  view.checkpoints = [{ ...view.checkpoints[0]!, observation: 'tool', check: checks[0] }, { ...view.checkpoints[0]!, id: 'state_unchanged', observation: 'state', check: checks[1] }];
  // As the first-format compiler wrote them: a required checkpoint's exact check is also a check of the card.
  s.checks = [...checks];
  // The agent reports its records, a confirmed reset and complete tool events: the trusted observation the checkpoints need.
  const agent = await httpAgent(body => ({ reply: 'Нет данных для изменения', records: (body.initialState as { records: unknown }).records, resetConfirmed: true, eventsComplete: true }));
  const runtime = { async selectUserAction() { return { actionId: 'finish' }; },
    async assess() { throw new Error('Exact checks decide this card: nothing is left to judge.'); } } as Runtime;
  const trial = await evaluateTrial({ scenario: s, runtime, revision: { id: 'base', parentId: null, spec: { name: 'Агент', instructions: 'Помогать', tools: [] }, hypothesis: '', createdAt: '' }, repeat: 0, manifestHash: 'frozen', sources, requirements, settings: settingsSchema.parse({}), userMode: 'reactive', target: agent.target, ctx: { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} } }).finally(agent.close);
  assert.deepEqual(trial.checks.map(check => [check.id, check.passed]), [['no_mutation', true], ['same_state', true]]);
  assert.equal(trial.checkpoints, undefined);
  assert.equal(headlineTrialResult(s, trial), 'pass');
  assert.ok(trial.events.some(e => e.type === 'observation'));
});
