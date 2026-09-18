import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hiddenLiterals, simulatorChecks } from '../src/simulator.js';
import { emptyUsage, type Scenario, type TraceEvent, type Trial } from '../src/contracts.js';

const world = { records: { card_1: { last4: '4321', status: 'active', reason: 'FRAUD_HOLD_77' } }, writableFields: ['status'], transientFailures: 0, external: { sbe: { tools: { cards: { tid: '12345678' } } } } };
function scenario(user: Partial<Scenario['user']> = {}): Scenario {
  return { id: 's', familyId: 's', title: 's', requirementIds: [], provenance: 'curated', split: 'dev', initialState: world, checks: [],
    user: { goal: 'Block the lost card', facts: 'The card ends with 4321.', behavior: 'Answer once', opening: 'I lost my card, please block it', maxFollowUps: 2,
      knows: ['Last four digits 4321'], cannotKnow: ['Why the backend holds the card'], answers: [{ ifAsked: 'last four digits', reply: 'It ends with 4321.' }], ...user } };
}
/** opening → assistant → (simulator decision → user → assistant)* ; texts alternate exactly as evaluation.ts records them. */
function trial(turns: string[], userMode: Trial['userMode'] = 'reactive'): Trial {
  const events: TraceEvent[] = [];
  turns.forEach((text, i) => {
    if (i % 2 === 0) { if (i > 0) events.push({ seq: events.length, type: 'simulator', result: { message: text, done: false } }); events.push({ seq: events.length, type: 'user', text }); }
    else events.push({ seq: events.length, type: 'assistant', text });
  });
  return { id: 't', revisionId: 'r', scenarioId: 's', familyId: 's', repeat: 0, userMode, split: 'dev', manifestHash: 'h', outcome: 'ungraded', reason: '', checks: [], events,
    initialState: world, finalState: world, usage: emptyUsage(), elapsedMs: 1 };
}
const check = (checks: ReturnType<typeof simulatorChecks>, id: string) => checks.find(c => c.id === id);

test('hidden literals are initial-state leaves the user was not told', () => {
  assert.deepEqual(hiddenLiterals(scenario()).sort(), ['12345678', 'active', 'fraud_hold_77']);
  assert.deepEqual(hiddenLiterals(scenario({ knows: ['Last four digits 4321', 'Card status active'] })).sort(), ['12345678', 'fraud_hold_77']);
});

test('a leak is the user saying a hidden value before the agent did; saying it after the agent is fine', () => {
  const leaked = simulatorChecks(scenario(), trial(['I lost my card, please block it', 'Which card?', 'The one on hold FRAUD_HOLD_77', 'Done']));
  assert.equal(check(leaked, 'simulator_leak')?.passed, false);
  assert.equal(check(leaked, 'simulator_leak')?.seq, 3);
  assert.match(check(leaked, 'simulator_leak')!.evidence, /fraud_hold_77/i);
  const revealed = simulatorChecks(scenario(), trial(['I lost my card, please block it', 'It is on hold: FRAUD_HOLD_77. Confirm?', 'Yes, FRAUD_HOLD_77, block it', 'Done']));
  assert.equal(check(revealed, 'simulator_leak')?.passed, true);
  assert.equal(check(revealed, 'simulator_leak')?.heuristic, true);
  const nothingHidden = simulatorChecks({ ...scenario(), initialState: { records: {}, writableFields: [], transientFailures: 0 } }, trial(['hi', 'Which card?', '4321', 'ok']));
  assert.equal(check(nothingHidden, 'simulator_leak'), undefined, 'no hidden literals means no leak check');
});

test('fabrication flags values absent from the card and prior replies, as a heuristic', () => {
  const invented = simulatorChecks(scenario(), trial(['I lost my card, please block it', 'Which card?', 'Card 9999, expiry 12/28', 'Done']));
  assert.equal(check(invented, 'simulator_fabrication')?.passed, false);
  assert.equal(check(invented, 'simulator_fabrication')?.heuristic, true);
  assert.match(check(invented, 'simulator_fabrication')!.evidence, /9999/);
  assert.match(check(invented, 'simulator_fabrication')!.description, /эвристика/i);
  const known = simulatorChecks(scenario(), trial(['I lost my card, please block it', 'Which card?', 'It ends with 4321.', 'Done']));
  assert.equal(check(known, 'simulator_fabrication')?.passed, true);
  const echoed = simulatorChecks(scenario(), trial(['I lost my card, please block it', 'Is it request 555123?', 'Yes, 555123', 'Done']));
  assert.equal(check(echoed, 'simulator_fabrication')?.passed, true, 'values the agent said first are not fabricated');
});

test('a loop is a repeated user message; the opening itself never counts', () => {
  const looped = simulatorChecks(scenario(), trial(['I lost my card, please block it', 'Which card?', 'Please block it!', 'Which card?', 'please block it', 'Which card?']));
  assert.equal(check(looped, 'simulator_loop')?.passed, false);
  assert.equal(check(looped, 'simulator_loop')?.seq, 6, 'events: #0 user, #1 assistant, #2 simulator, #3 user, #4 assistant, #5 simulator, #6 user');
  assert.match(check(looped, 'simulator_loop')!.evidence, /#3/);
  const fine = simulatorChecks(scenario(), trial(['I lost my card, please block it', 'Which card?', 'It ends with 4321.', 'Done']));
  assert.equal(check(fine, 'simulator_loop')?.passed, true);
});

test('static, scripted and opening-only dialogues get no simulator checks', () => {
  assert.deepEqual(simulatorChecks(scenario(), trial(['I lost my card, please block it', 'Which card?', 'It ends with 4321.', 'Done'], 'scripted')), []);
  assert.deepEqual(simulatorChecks(scenario(), trial(['I lost my card, please block it', 'Done'])), []);
  const stoppedAtOnce = trial(['I lost my card, please block it', 'Done']);
  stoppedAtOnce.events.push({ seq: 2, type: 'simulator', result: { message: '', done: true } });
  assert.deepEqual(simulatorChecks(scenario(), stoppedAtOnce), []);
});

test('literal boundaries and requested repetition do not invent leaks or loops', () => {
  const result = simulatorChecks(scenario(), trial(['hello', 'Which card?', 'proactive card 4321', 'Please repeat the digits', '4321']));
  assert.equal(check(result, 'simulator_leak')?.passed, true);
  assert.equal(check(result, 'simulator_loop')?.passed, true);
});
