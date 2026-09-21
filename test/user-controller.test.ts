import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserState, allowedUserActions, advanceUser, requiredUserTurns } from '../src/user-controller.js';
import { behaviorPolicySchema } from '../src/scenario-contracts.js';
import { acceptLibrary, compileLibrary, libraryHash } from '../src/scenario-library.js';
import { libraryFixture, sources, requirements } from './helpers/scenario-library.js';
import { evaluateTrial } from '../src/evaluation.js';
import { settingsSchema, type Runtime, type Scenario } from '../src/contracts.js';

const policy = () => behaviorPolicySchema.parse({ version: 1, initialState: 'start', states: ['start', 'answered', 'done'], terminalStates: ['done'], maxFollowUps: 3, repetitionLimit: 1,
  actions: [{ id: 'answer', kind: 'answer', factIds: ['number'], payload: 'Номер терминала: 1234', ifAsked: 'номер терминала' }, { id: 'change', kind: 'change_intent', factIds: [], payload: 'Теперь хочу отменить возврат' }, { id: 'finish', kind: 'finish', factIds: [] }],
  transitions: [{ from: 'start', to: 'answered', actionId: 'answer', when: 'Нужен номер терминала' }, { from: 'start', to: 'done', actionId: 'finish', when: 'Достаточный ответ' }, { from: 'answered', to: 'done', actionId: 'change', when: 'После уточнения' }] });
const facts = [{ id: 'number', statement: 'Номер терминала: 1234', value: '1234' }];

test('controller rejects hidden fact references and undeclared transitions before rendering', () => {
  const state = createUserState(policy(), facts);
  assert.throws(() => advanceUser(state, { actionId: 'answer', factIds: ['hidden'] }), /факт|разреш/i);
  assert.throws(() => advanceUser(state, { actionId: 'change', factIds: [] }), /переход|действие/i);
  assert.throws(() => advanceUser(state, { actionId: 'answer', factIds: ['number'], message: 'secret-value' }), /пол|ключ|Unrecognized/i);
  assert.equal(state.position, 'start');
  assert.deepEqual(allowedUserActions(state, 'Назовите номер терминала').map(a => a.id), ['answer']);
  assert.throws(() => advanceUser(state, { actionId: 'finish', factIds: [] }), /действие|намерени/i);
  const next = advanceUser(state, { actionId: 'answer', factIds: ['number'] });
  assert.equal(next.message, 'Номер терминала: 1234');
  const end = advanceUser(next.state, { actionId: 'change', factIds: [] });
  assert.equal(end.message, 'Теперь хочу отменить возврат');
  assert.equal(end.done, true);
  assert.equal(requiredUserTurns(policy(), facts), 3);
});

test('repetition and finite follow-up bounds cannot be evaded with repeated clarification', () => {
  const p = policy(); p.actions = [{ id: 'ask', kind: 'clarify', factIds: [], payload: 'Что нужно уточнить?' }, { id: 'finish', kind: 'finish', factIds: [] }];
  p.transitions = [{ from: 'start', to: 'start', actionId: 'ask', when: 'Неясный ответ' }, { from: 'start', to: 'done', actionId: 'finish', when: 'Достаточный ответ' }];
  const next = advanceUser(createUserState(p, []), { actionId: 'ask', factIds: [] });
  assert.throws(() => advanceUser(next.state, { actionId: 'ask', factIds: [] }), /действие|повтор/i);
  assert.equal(advanceUser(next.state, { actionId: 'finish', factIds: [] }).message, '');
  assert.equal(requiredUserTurns(p, []), 1, 'empty finish consumes no target turn');
});

function compiled(): Scenario {
  const l = libraryFixture();
  return compileLibrary(acceptLibrary(l, libraryHash(l), ['variant_1']))[0]!;
}
async function evaluate(scenario: Scenario, decisions: unknown[], options: { mode?: 'reactive' | 'static' | 'scripted'; maxTurns?: number; abort?: boolean } = {}) {
  const sent: string[] = [], inputs: unknown[] = []; let calls = 0, closed = false;
  const controller = new AbortController();
  const runtime = { async openTarget() { return { async respond(message: string) { sent.push(message); return 'Назовите номер терминала'; }, async close() { closed = true; } }; },
    async selectUserAction(input: unknown, ctx: { beforeCall(): void }) { inputs.push(input); ctx.beforeCall(); if (options.abort) controller.abort(); return decisions.shift(); },
    async userTurn() { throw new Error('Legacy simulator must not receive controlled cards'); },
    async assess() { return []; },
  } as unknown as Runtime;
  const result = await evaluateTrial({ scenario, runtime, revision: { id: 'base', parentId: null, spec: { name: 'Агент', instructions: 'Помогать', tools: [] }, hypothesis: '', createdAt: '' }, repeat: 0, manifestHash: 'frozen', sources, requirements,
    settings: settingsSchema.parse({ maxTurns: options.maxTurns ?? 3 }), userMode: options.mode ?? 'reactive', target: { kind: 'sandbox' },
    ctx: { signal: controller.signal, timeoutMs: 1000, beforeCall() { calls++; }, addUsage() {} } });
  return { result, sent, inputs, calls, closed };
}

test('compiled accepted card freezes separated execution views and rejects illegal output without target delivery', async () => {
  const scenario = compiled();
  assert.ok(scenario.execution);
  scenario.execution!.userView.policy = policy(); scenario.execution!.userView.facts = facts;
  const result = await evaluate(scenario, [{ actionId: 'answer', factIds: ['hidden'] }, { actionId: 'answer', factIds: ['hidden'] }]);
  assert.equal(result.result.outcome, 'invalid'); assert.match(result.result.reason, /симулятор/i);
  assert.deepEqual(result.sent, ['Помогите с возвратом']); assert.equal(result.calls, 2); assert.equal(result.closed, true);
  assert.equal(result.result.events.filter(e => e.type === 'simulator').length, 2);
  assert.doesNotMatch(JSON.stringify(result.inputs), /evaluatorView|requirementId|environmentView|checkpoint/);
});

test('repair delivers exact authorized payload and terminal change intent still obtains target response', async () => {
  const s = compiled(); s.execution!.userView.policy = policy(); s.execution!.userView.facts = facts;
  const got = await evaluate(s, [{ actionId: 'change', factIds: [] }, { actionId: 'answer', factIds: ['number'] }, { actionId: 'change', factIds: [] }]);
  assert.deepEqual(got.sent, ['Помогите с возвратом', 'Номер терминала: 1234', 'Теперь хочу отменить возврат']);
  assert.equal(got.result.events.filter(e => e.type === 'assistant').length, 3);
  assert.equal(got.calls, 3);
  assert.notEqual(got.result.outcome, 'invalid');
});

test('controlled execution preflights finite path and rejects bypass modes without opening target', async () => {
  const s = compiled(); s.execution!.userView.policy = policy(); s.execution!.userView.facts = facts;
  for (const options of [{ maxTurns: 2 }, { mode: 'static' as const }, { mode: 'scripted' as const }]) {
    const got = await evaluate(s, [], options); assert.equal(got.result.outcome, 'invalid'); assert.deepEqual(got.sent, []);
  }
  const cancelled = await evaluate(s, [{ actionId: 'answer', factIds: ['number'] }], { abort: true });
  assert.equal(cancelled.result.outcome, 'cancelled'); assert.deepEqual(cancelled.sent, ['Помогите с возвратом']); assert.equal(cancelled.closed, true);
});

test('trusted observation event supports correct refusal without tool calls and state snapshots without prose proof', async () => {
  const s = compiled(); delete s.metrics;
  s.execution!.environmentView = { mode: 'managed', contract: { reset: true, confirmed: true, operations: ['update_record'], observations: ['reply', 'tool', 'state'] } };
  s.initialState = { records: { item: { status: 'pending' } }, writableFields: ['status'], transientFailures: 0 };
  s.execution!.evaluatorView.checkpoints = [
    { ...s.execution!.evaluatorView.checkpoints[0]!, observation: 'tool', check: { id: 'no_mutation', kind: 'tool_not_called', tool: 'update_record', description: 'При корректном отказе изменений нет' } },
    { ...s.execution!.evaluatorView.checkpoints[0]!, id: 'state_unchanged', observation: 'state', check: { id: 'same_state', kind: 'state_equals', recordId: 'item', field: 'status', value: 'pending', description: 'Состояние не изменилось' } },
  ];
  const runtime = { async openTarget() { return { async respond() { return 'Нет данных для изменения'; }, async close() {} }; }, async selectUserAction() { return { actionId: 'finish', factIds: [] }; },
    async assessCheckpoints(input: any) { return input.checkpoints.map((c: any) => ({ checkpointId: c.checkpoint.id, result: 'pass', evidence: c.allowedEvidence, rationale: 'Полные наблюдения подтверждают отсутствие изменений' })); } } as Runtime;
  const trial = await evaluateTrial({ scenario: s, runtime, revision: { id: 'base', parentId: null, spec: { name: 'Агент', instructions: 'Помогать', tools: [] }, hypothesis: '', createdAt: '' }, repeat: 0, manifestHash: 'frozen', sources, requirements, settings: settingsSchema.parse({}), userMode: 'reactive', target: { kind: 'sandbox' }, ctx: { signal: new AbortController().signal, timeoutMs: 1000, beforeCall() {}, addUsage() {} } });
  assert.deepEqual(trial.checkpoints?.map(c => c.result), ['pass', 'pass']);
  assert.ok(trial.events.some(e => e.type === 'observation'));
});
