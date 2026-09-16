import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_GOAL_OBSERVATION } from '../src/contracts.js';
import { goalObservationDefault, withDefaultGoalObservation } from '../src/normalize.js';

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
