import test from 'node:test';
import assert from 'node:assert/strict';
import { compileCard, compilePolicy, expectationRubric } from '../src/card/compile.js';
import { fingerprint, isCardExecution, scenarioSchema } from '../src/contracts.js';
import { advanceUser, allowedUserActions, createUserState, requiredUserTurns, userDecisionSchema } from '../src/user-controller.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { evaluateTrial } from '../src/evaluation.js';
import { headlineTrialResult } from '../src/outcomes.js';
import { settingsSchema, targetSchema, type Runtime } from '../src/contracts.js';
import { briefCard, compiledCard, requirements } from './helpers/cards.js';

/*
 * C4: the brief compiles into the controller's policy once, at acceptance. Every customer message is
 * harness text, the controller only picks an allowed move, and nothing the customer does not know can
 * reach the agent.
 */

test('each kind of fact compiles to its own move: told when asked, told together, or «не знаю»', () => {
  const { policy, facts, missing } = compilePolicy(briefCard());
  const action = (id: string) => policy.actions.find(item => item.id === id);
  assert.deepEqual(facts, [{ id: 'f1', statement: 'Имя: Анна', value: 'Анна' }, { id: 'f2', statement: 'Номер терминала: 5678', value: '5678' }, { id: 'f3', statement: 'Сумма: 1200', value: 1200 }],
    'a known fact is said exactly as the harness renders it');
  assert.deepEqual(action('tell_f1'), { id: 'tell_f1', kind: 'answer', factIds: ['f1'], ifAsked: 'Имя' }, 'an initial fact is repeated only if the agent asks again');
  assert.deepEqual(action('tell_f2'), { id: 'tell_f2', kind: 'answer', factIds: ['f2'], ifAsked: 'номер терминала' }, 'askedAs names the question');
  assert.deepEqual(action('tell_all'), { id: 'tell_all', kind: 'answer', factIds: ['f2', 'f3'], ifAsked: 'агент просит сразу несколько данных' });
  assert.deepEqual(action('dunno_f4'), { id: 'dunno_f4', kind: 'missing', factIds: [], ifAsked: 'Дата покупки', payload: 'Дата покупки — не знаю.' });
  assert.deepEqual(action('dunno_other'), { id: 'dunno_other', kind: 'missing', factIds: [], ifAsked: 'вопрос, на который в карточке нет ответа', payload: 'Этого я не знаю.' });
  assert.deepEqual(action('leave'), { id: 'leave', kind: 'finish', factIds: [] });
  assert.deepEqual(missing, ['Дата покупки']);
  assert.doesNotMatch(JSON.stringify({ policy, facts }), /12\.03\.2026/, 'an unknown value is in no message at all');
  assert.equal(policy.maxFollowUps, 4 + 1 + 2, 'every fact, the turn and two spare moves');
});

test('a change of intent must happen before the customer leaves; a report may be skipped', () => {
  const walk = (turn?: Parameters<typeof briefCard>[0]['turn']) => {
    const { policy, facts } = compilePolicy(briefCard({ turn }));
    return createUserState(policy, facts);
  };
  const changing = walk();
  assert.deepEqual(allowedUserActions(changing, '').map(action => action.id), ['tell_f1', 'tell_f2', 'tell_f3', 'tell_all', 'dunno_f4', 'dunno_other', 'turn'],
    'no way out before the change of intent');
  const turned = advanceUser(changing, { actionId: 'turn' });
  assert.equal(turned.message, 'Тогда лучше отмените покупку.', 'the turn is the recorded words');
  assert.ok(allowedUserActions(turned.state, '').some(action => action.id === 'leave'));
  const left = advanceUser(turned.state, { actionId: 'leave' });
  assert.equal(left.message, '', 'leaving says nothing'); assert.equal(left.done, true);
  const reporting = walk({ kind: 'report', after: 'агент объяснил, как оформить возврат', says: 'Я не вижу такой кнопки.', source: { kind: 'owner', receiptId: 'r1' } });
  assert.ok(allowedUserActions(reporting, '').some(action => action.id === 'leave'), 'a report is not required: the agent may solve the task another way');
  assert.equal(reporting.policy.actions.find(action => action.id === 'turn')?.kind, 'observe');
  const plain = walk(null);
  assert.deepEqual(plain.policy.states, ['talk', 'done']);
  assert.equal(requiredUserTurns(plain.policy, plain.facts), 1, 'the customer may leave after the first reply');
  assert.equal(requiredUserTurns(changing.policy, changing.facts), 2, 'one more message for the change of intent');
});

test('the largest brief — eight facts and a change of intent — still has a finite path the controller checks at once', () => {
  const card = briefCard();
  const knows = Array.from({ length: 8 }, (_, i) => ({ id: `f${i + 1}`, label: `Данные ${i + 1}`, value: `${1000 + i}`, disclosure: i % 3 === 0 ? 'unknown' as const : 'on_request' as const, source: { kind: 'unconfirmed' as const } }));
  const { policy, facts } = compilePolicy({ ...card, client: { ...card.client, knows } });
  assert.equal(policy.maxFollowUps, 11);
  assert.equal(requiredUserTurns(policy, facts), 2);
  const state = createUserState(policy, facts);
  assert.equal(allowedUserActions(state, '').length, policy.actions.length - 1, 'every move but leaving before the turn');
});

test('a walk against a fake agent: the question decides the move, and the message is the harness text of that move', () => {
  const { policy, facts } = compilePolicy(briefCard());
  let state = createUserState(policy, facts);
  const said: string[] = [];
  // The fake agent's questions and the move a controller answers each with; every answer passes the per-call enum.
  for (const actionId of ['tell_f2', 'dunno_f4', 'dunno_other', 'turn', 'leave']) {
    const decision = userDecisionSchema(allowedUserActions(state, '')).parse({ actionId });
    const step = advanceUser(state, decision);
    said.push(step.message);
    state = step.state;
  }
  assert.deepEqual(said, ['Номер терминала: 5678', 'Дата покупки — не знаю.', 'Этого я не знаю.', 'Тогда лучше отмените покупку.', '']);
  assert.throws(() => userDecisionSchema(allowedUserActions(createUserState(policy, facts), '')).parse({ actionId: 'leave' }), 'leaving before the turn is not an allowed move');
  const repeated = ['dunno_other', 'dunno_other'].reduce((current, actionId) => advanceUser(current, { actionId }).state, createUserState(policy, facts));
  assert.ok(!allowedUserActions(repeated, '').some(action => action.id === 'dunno_other'), '«не знаю» on unknown questions at most twice');
});

test('the compiled card is a strict definition: the brief for the customer, the expectations for the judge, no controller prompt', () => {
  const card = briefCard();
  const scenario = compiledCard(card);
  const { split: _, ...stored } = scenario;
  assert.deepEqual(scenarioSchema.parse(stored), stored, 'the stored definition parses to itself');
  assert.ok(isCardExecution(scenario.execution));
  const execution = scenario.execution!;
  assert.ok(!('controllerHash' in execution) && !('checkpointHash' in execution), 'the controller prompt belongs to the evaluator version');
  assert.equal(scenario.id, card.id); assert.equal(scenario.provenance, 'production');
  assert.deepEqual(scenario.requirementIds, ['refund_rule', 'receipt_rule']);
  assert.deepEqual(scenario.checks, []); assert.equal(scenario.successCriteria, undefined, 'one expectation never colours another');
  assert.deepEqual(scenario.metrics?.map(metric => metric.id), ['e1', 'e2', 'e3']);
  assert.deepEqual(scenario.metrics?.[1], expectationRubric(card.agentMust[1]!, 'Б', 'карточки №3'));
  assert.equal(scenario.metrics?.[1]?.passCriteria, 'Если клиент назвал номер терминала: выполнено — объяснить, как оформить возврат. Если этого в диалоге не было, ожидание не нарушено.');
  assert.equal(scenario.metrics?.[0]?.failCriteria, 'Не выполнено: запросить номер терминала не больше одного раза.');
  assert.deepEqual(execution.evaluatorView, { expectations: card.agentMust, requirements });
  assert.equal(execution.userView.opening, card.client.writes);
  assert.doesNotMatch(JSON.stringify(execution.userView), /12\.03\.2026|refund_rule|receipt_rule/, 'the customer sees no hidden value and no rule');
  assert.equal(fingerprint(compiledCard(card)), fingerprint(scenario), 'compiling is deterministic: the definition hash is fixed at acceptance');
  assert.throws(() => compileCard(card, { requirements: [requirements[0]!] }), /ссылается на правило, которого нет/);
});

test('a compiled card runs end to end: the controller answers the agent\'s questions with harness text and each expectation gets its own verdict', async () => {
  const scenario = compiledCard();
  const replies = ['Назовите номер терминала.', 'Спасибо. Возврат оформляется по выписке в поддержке.', 'Покупку отменили.'];
  const sent: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      sent.push((JSON.parse(body) as { message: string }).message);
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify(replies[sent.length - 1] ?? 'Готово.'));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const runtime: Runtime = {
    // A stand-in controller: the number when asked for it, then the turn, then leave.
    async selectUserAction(input) {
      const last = input.messages.at(-1)?.content ?? '';
      const ids = input.actions.map(action => action.id);
      return { actionId: last.includes('номер терминала') ? 'tell_f2' : ids.includes('turn') ? 'turn' : 'leave' };
    },
    async assess({ scenario: judged, trial }) {
      const reply = trial.events.filter(event => event.type === 'assistant').at(-1)!.seq;
      return (judged.metrics ?? []).map(metric => ({ metricId: metric.id, result: 'pass' as const, rationale: 'Выполнено', evidence: [reply] }));
    },
  };
  try {
    const trial = await evaluateTrial({ runtime, scenario, revision: { id: 'r', parentId: null, spec: { name: 'Агент', instructions: 'Помогать', tools: [] }, hypothesis: '', createdAt: '' },
      repeat: 0, manifestHash: 'h', sources: [], requirements, settings: settingsSchema.parse({ maxTurns: 4 }), userMode: 'reactive',
      target: targetSchema.parse({ kind: 'http', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` }),
      ctx: { signal: new AbortController().signal, timeoutMs: 5000, beforeCall() {}, addUsage() {} } });
    assert.deepEqual(sent, ['Помогите с возвратом, я Анна.', 'Номер терминала: 5678', 'Тогда лучше отмените покупку.']);
    assert.deepEqual(trial.assessments?.map(assessment => assessment.metricId), ['e1', 'e2', 'e3'], 'one verdict per expectation');
    assert.deepEqual(trial.simulatorChecks, [], 'no heuristics over harness text');
    assert.equal(headlineTrialResult(scenario, trial), 'pass');
  } finally { await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }); }
});
