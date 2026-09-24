import test from 'node:test';
import assert from 'node:assert/strict';
import { standFailed } from '../src/lab/run.js';
import type { Trial } from '../src/contracts.js';

/*
 * A stand that failed once (a 500 from the agent's service, a dropped adapter) is not the agent's answer: the
 * conversation is run again once. An empty reply is the agent's own answer and is never rerun.
 */
const trial = (overrides: Partial<Trial>): Trial => ({ outcome: 'invalid', invalidCause: 'agent', events: [], ...overrides }) as Trial;

test('a thrown stand error is rerun; an empty reply, a simulator failure or a finished dialogue is not', () => {
  assert.equal(standFailed(trial({ events: [{ seq: 3, type: 'error', text: 'ответ испытуемого: HTTP 500' }] as Trial['events'] })), true);
  assert.equal(standFailed(trial({ events: [{ seq: 1, type: 'assistant', text: '' }] as Trial['events'] })), false, 'an empty reply is the agent’s answer');
  assert.equal(standFailed(trial({ invalidCause: 'simulator', events: [{ seq: 3, type: 'error', text: 'x' }] as Trial['events'] })), false);
  assert.equal(standFailed(trial({ outcome: 'ungraded', invalidCause: undefined, events: [{ seq: 3, type: 'error', text: 'x' }] as Trial['events'] })), false);
});
