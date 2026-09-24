import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_JUDGE, judgeFor } from '../src/contracts.js';
import { trustParts } from '../src/result-text.js';
import type { ResultView } from '../src/result-view.js';

test('the chat keeps the independent judge when Pi reaches it, and takes the session model on a network that reaches only its gateway', () => {
  const session = { provider: 'giga', id: 'GigaChat-3-Ultra' };
  assert.deepEqual(judgeFor([{ provider: 'openrouter', id: DEFAULT_JUDGE.model }, session], session), { ...DEFAULT_JUDGE });
  assert.deepEqual(judgeFor([session], session), { provider: 'giga', model: 'GigaChat-3-Ultra' });
  assert.deepEqual(judgeFor([], undefined), { ...DEFAULT_JUDGE }, 'no session model: the default, and the run says what is missing');
});

test('a result judged by the model that built its situations says so in the trust line', () => {
  const base = { headline: { smallSample: false }, notMeasured: { total: 0, reasons: [] }, reviewed: { situations: 0, contradicted: 0 },
    agreement: { checked: 0, agreed: 0, queueFailures: [], sampledPasses: [] }, cards: [] } as unknown as ResultView;
  // The first segment starts the sentence with a capital letter.
  const parts = (view: ResultView) => trustParts(view).map(part => part.toLowerCase());
  assert.ok(!parts(base).includes('судья — та же модель, что готовила ситуации'));
  assert.ok(parts({ ...base, sameModelJudge: true }).includes('судья — та же модель, что готовила ситуации'));
});
