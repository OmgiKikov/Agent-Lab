import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { compileCard, compilePolicy } from '../src/card/compile.js';
import { cardSchema } from '../src/card/schema.js';
import { settingsSchema, targetSchema, type Scenario, type Trial } from '../src/contracts.js';
import { customerMoves } from '../src/customer-moves.js';
import { evaluateTrial } from '../src/evaluation.js';
import { buildResultView } from '../src/result-view.js';
import { deriveRun } from '../src/run.js';
import type { Runtime } from '../src/runtime.js';
import { allowedUserActions, advanceUser, createUserState } from '../src/user-controller.js';
import { briefCard, cardRun, compiledCard, requirements } from './helpers/cards.js';

/*
 * The run's limit on the customer's messages is part of the conversation, not a fault of the customer Lab plays: the
 * controlled customer never plans a message past it, and an agent that keeps asking until the messages run out is
 * judged on the conversation it had — «не справился» when it broke a duty, «не измерено — разговор не уложился в
 * лимит реплик» only for what the judge could not decide.
 */

/** An agent over HTTP that asks for the terminal number whatever it is told: its questions never end. */
async function askingAgent() {
  const sent: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      sent.push((JSON.parse(body) as { message: string }).message);
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify('Назовите, пожалуйста, номер терминала.'));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  return { sent, target: targetSchema.parse({ kind: 'http', url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` }),
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

type Judged = Partial<Record<'e1' | 'e2' | 'e3', 'pass' | 'fail' | 'unknown'>>;

/**
 * One conversation with the asking agent. The customer takes the first move of `preference` it is allowed — by
 * default it names the number while it can, turns when it must and leaves when nothing else is allowed. The judge
 * gives `judged` per expectation and «не могу решить» for the rest.
 */
async function talk(scenario: Scenario, maxTurns: number, judged: Judged, preference = ['tell_f2', 'dunno_other', 'turn', 'leave']) {
  const agent = await askingAgent();
  const offered: string[][] = [];
  const runtime: Runtime = {
    async selectUserAction(input) {
      const ids = input.actions.map(action => action.id);
      offered.push(ids);
      return { actionId: preference.find(id => ids.includes(id)) ?? ids[0]! };
    },
    async assess({ scenario: card, trial }) {
      const replies = trial.events.filter(event => event.type === 'assistant');
      return (card.metrics ?? []).map(metric => {
        const result = judged[metric.id as keyof Judged] ?? 'unknown';
        return { metricId: metric.id, result, rationale: result === 'fail' ? 'Агент снова спросил номер, который клиент уже назвал.' : 'Судья не может решить.',
          evidence: result === 'unknown' ? [] : [replies.at(-1)!.seq] };
      });
    },
  };
  try {
    const trial = await evaluateTrial({ runtime, scenario, revision: { id: 'r', parentId: null, spec: { name: 'Агент', instructions: 'Помогать', tools: [] }, hypothesis: '', createdAt: '' },
      repeat: 0, manifestHash: 'h', sources: [], requirements, settings: settingsSchema.parse({ maxTurns }), userMode: 'reactive', target: agent.target,
      ctx: { signal: new AbortController().signal, timeoutMs: 5000, beforeCall() {}, addUsage() {} } });
    return { trial, sent: agent.sent, offered };
  } finally { await agent.close(); }
}

/** A trial as a run records it now: counted by the current edition of the rules. */
const recorded = (trial: Trial): Trial => ({ ...trial, countingVersion: 2 });

test('a compiled customer never plans more messages than the run allows after the opening', () => {
  const card = briefCard();
  const event = (eventIndex: number) => ({ batchId: 'batch_1', dialogueId: 'late', eventIndex });
  // A long logged conversation: nine later customer messages the card accounts for.
  const long = cardSchema.parse({ ...card, coverage: [...card.coverage, ...[6, 8, 10, 12, 14, 16, 18].map(index => ({ event: event(index), as: 'ignored', reason: 'уточнение' }))] });
  for (const maxTurns of [2, 3, 4, 6, 16]) for (const brief of [card, long, briefCard({ turn: null })]) {
    const { policy } = compilePolicy(brief, maxTurns);
    assert.ok(policy.maxFollowUps <= maxTurns - 1, `${maxTurns}: ${policy.maxFollowUps}`);
    assert.equal(compileCard(brief, { requirements, maxTurns }).user.maxFollowUps, policy.maxFollowUps);
  }
  assert.equal(compilePolicy(card, 4).policy.maxFollowUps, 3, 'four facts, the turn and two to spare do not fit in four messages');
  assert.equal(compilePolicy(card).policy.maxFollowUps, 7, 'without the run\'s limit the brief keeps its own need');
});

test('a customer compiled for more messages than the run allows is held to the run: after the last one only the way out is left', () => {
  const { policy, facts } = compilePolicy(briefCard());
  assert.equal(policy.maxFollowUps, 7);
  let state = createUserState(policy, facts, 4);
  for (const actionId of ['tell_f2', 'tell_f2']) state = advanceUser(state, { actionId }).state;
  assert.deepEqual(allowedUserActions(state, '').map(action => action.id), ['turn'], 'the change of intent is the last message that fits');
  state = advanceUser(state, { actionId: 'turn' }).state;
  assert.deepEqual(allowedUserActions(state, '').map(action => action.id), ['leave']);
  const own = ['tell_f2', 'tell_f2', 'turn'].reduce((current, actionId) => advanceUser(current, { actionId }).state, createUserState(policy, facts));
  assert.ok(allowedUserActions(own, '').some(action => action.id === 'tell_f3'), 'without the run\'s limit the card\'s own budget still allows more');
});

test('an agent that asks again until the customer\'s messages run out is judged, not a failure of the customer Lab plays', async () => {
  // Compiled before the run's limit bounded it: seven follow-ups allowed by the card, four messages by the run.
  const scenario = compiledCard();
  assert.equal(scenario.execution?.userView.policy.maxFollowUps, 7);
  const { trial, sent, offered } = await talk(scenario, 4, { e1: 'fail' });
  assert.equal(trial.outcome, 'ungraded', trial.reason);
  assert.equal(trial.invalidCause, undefined, 'never «сбой клиента, которого играет Lab»');
  assert.equal(trial.turnLimit, true);
  assert.match(trial.reason, /Клиенту не хватило реплик/);
  assert.deepEqual(sent, ['Помогите с возвратом, я Анна.', 'Номер терминала: 5678', 'Номер терминала: 5678', 'Тогда лучше отмените покупку.']);
  assert.deepEqual(offered.at(-1), ['leave'], 'after the last message the run allows, the customer can only leave');
  assert.deepEqual(trial.assessments?.map(assessment => [assessment.metricId, assessment.result]), [['e1', 'fail'], ['e2', 'unknown'], ['e3', 'unknown']], 'the judge saw the conversation');
  const view = buildResultView(cardRun([scenario], [recorded(trial)]));
  assert.deepEqual([view.cards[0]!.outcome, view.headline.passed, view.headline.decided], ['fail', 0, 1], 'asking for the number again is the agent\'s failure');
  assert.deepEqual(view.failures.map(failure => failure.trialId), [trial.id]);
  // The customer ran out of messages; it did not give up after «не знаю».
  assert.deepEqual(customerMoves(deriveRun(cardRun([scenario], [recorded(trial)])))?.blocked, []);
});

test('what the judge cannot decide in a conversation cut by the limit is «не измерено» because of the limit', async () => {
  const scenario = compileCard(briefCard(), { requirements, maxTurns: 6 });
  const { trial, sent } = await talk(scenario, 6, {});
  assert.equal(sent.length, 6);
  assert.equal(trial.turnLimit, true, 'the customer wrote every message the run allows');
  const view = buildResultView(cardRun([scenario], [recorded(trial)]));
  assert.deepEqual([view.cards[0]!.outcome, view.cards[0]!.reason], ['unknown', 'turn_limit']);
  assert.deepEqual(view.notMeasured.reasons.map(reason => [reason.code, reason.count]), [['turn_limit', 1]]);
  // A customer that leaves on its own ends the conversation before the limit: an undecided judge stays the judge's.
  const { trial: left, sent: early } = await talk(scenario, 6, {}, ['turn', 'leave']);
  assert.deepEqual(early, ['Помогите с возвратом, я Анна.', 'Тогда лучше отмените покупку.']);
  assert.equal(left.turnLimit, undefined);
  assert.deepEqual(buildResultView(cardRun([scenario], [recorded(left)])).cards[0]!.reason, 'judge_unclear');
});
