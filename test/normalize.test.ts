import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_GOAL_OBSERVATION, DEFAULT_JUDGE } from '../src/contracts.js';
import { goalObservationDefault, scoreSettings, withDefaultGoalObservation } from '../src/normalize.js';

test('the default evidence channel fills only external cards that did not choose one', () => {
  const legacy = { id: 'card' };
  assert.equal(withDefaultGoalObservation({ id: 'card', goalObservation: 'tool' as const }, 'command').goalObservation, 'tool');
  for (const kind of ['command', 'http', 'module'] as const) assert.equal(withDefaultGoalObservation<{ goalObservation?: 'reply' | 'tool' | 'state' }>(legacy, kind).goalObservation, 'reply');
  assert.equal(withDefaultGoalObservation(legacy, 'sandbox'), legacy);
  assert.deepEqual(legacy, { id: 'card' }, 'the input is never mutated');
});

test('the sandbox has no default channel; external agents default to the one constant', () => {
  assert.equal(goalObservationDefault('sandbox'), undefined);
  assert.equal(goalObservationDefault('command'), DEFAULT_GOAL_OBSERVATION);
});

test('score settings scale the budget with the number of recorded dialogues and use the default judge live', () => {
  const fifteen = scoreSettings(15, {}, 'live');
  assert.equal(fifteen.maxCalls, 120);
  assert.equal(fifteen.maxDurationMs, 1_800_000);
  assert.equal(fifteen.timeoutMs, 600_000);
  assert.deepEqual(fifteen.judge, DEFAULT_JUDGE);
  assert.notEqual(fifteen.judge, DEFAULT_JUDGE, 'the constant is copied, never shared');
  assert.equal(fifteen.repeats, 1);
  assert.deepEqual(fifteen.userModes, ['scripted']);
  const one = scoreSettings(1, {}, 'live');
  assert.equal(one.maxCalls, 20);
  assert.equal(one.maxDurationMs, 180_000);
  const many = scoreSettings(500, {}, 'live');
  assert.equal(many.maxCalls, 3000);
  assert.equal(many.maxDurationMs, 14_400_000);
  assert.equal('judge' in scoreSettings(15, {}, 'demo'), false);
});

test('owner values win over score defaults, except how imported recordings were made', () => {
  const judge = { provider: 'openai', model: 'gpt-x' };
  const settings = scoreSettings(15, { maxCalls: 7, timeoutMs: 1000, judge, userModes: ['reactive'], repeats: 3 }, 'live');
  assert.equal(settings.maxCalls, 7);
  assert.equal(settings.timeoutMs, 1000);
  assert.deepEqual(settings.judge, judge);
  assert.equal(settings.maxDurationMs, 1_800_000);
  assert.equal(settings.repeats, 1);
  assert.deepEqual(settings.userModes, ['scripted']);
});
