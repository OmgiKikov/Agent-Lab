import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withDefaultGoalObservation } from '../src/normalize.js';

test('the default evidence channel fills only external cards that did not choose one', () => {
  const legacy = { id: 'card' };
  assert.equal(withDefaultGoalObservation({ id: 'card', goalObservation: 'tool' as const }, 'command').goalObservation, 'tool');
  for (const kind of ['command', 'http', 'module'] as const) assert.equal(withDefaultGoalObservation<{ goalObservation?: 'reply' | 'tool' | 'state' }>(legacy, kind).goalObservation, 'reply');
  assert.equal(withDefaultGoalObservation(legacy, 'sandbox'), legacy);
  assert.deepEqual(legacy, { id: 'card' }, 'the input is never mutated');
});
