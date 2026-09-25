import test from 'node:test';
import assert from 'node:assert/strict';
import { experimentSchema, fingerprint, type Experiment } from '../src/contracts.js';
import { Stopped } from '../src/errors.js';
import type { CallContext } from '../src/runtime.js';
import { prepareCards, resumeCards, type CardPlan, type DraftPublisher } from '../src/card/prepare.js';
import { preparationProgressSchema, type CardPreparation, type LibraryV2 } from '../src/card/schema.js';
import { newRecord } from '../src/lab/record.js';
import { importBatch } from '../src/scenario-library.js';
import type { ImportBatch } from '../src/scenario-contracts.js';
import { cardInput, cardRuntime } from './helpers/card-prep.js';

/*
 * A preparation's checkpoint no longer says in a word how a launch ended: what is left is `pending`, how the work ended
 * is the record's phase. The word was read by nothing, and a stop by the budget was written as «cancelled». Checkpoints
 * an earlier Lab wrote with it still parse, and it goes when this Lab continues one. Invented dialogues, a
 * deterministic runtime; no model is called.
 */

function setup(): { record: Experiment; batch: ImportBatch } {
  const input = cardInput();
  return { record: newRecord(input), batch: importBatch(input.dialogues) };
}
function plan(batch: ImportBatch): CardPlan {
  const ids = batch.dialogues.map(dialogue => dialogue.id);
  return { kind: 'dialogues', batch, sample: { count: ids.length, picked: ids, excluded: [], strata: [{ dialogueIds: ids }] } };
}
/** A budget that aborts the work when it runs out, as a stop reaches a preparation through its signal. */
function budget(record: Experiment, limit = 200): CallContext {
  const controller = new AbortController();
  return { signal: controller.signal, timeoutMs: 60_000, addUsage: () => undefined, beforeCall: () => {
    controller.signal.throwIfAborted();
    if (record.usage.calls >= limit) { controller.abort(new Stopped('budget', 'Model call budget exhausted.')); controller.signal.throwIfAborted(); }
    record.usage.calls++;
  } };
}
/** Every save as the store would read it back. */
function publisher(): DraftPublisher & { saves: Experiment[] } {
  const saves: Experiment[] = [];
  return { saves, async publishLibrary(record, library) { saves.push(experimentSchema.parse(structuredClone({ ...record, librarySnapshot: library }))); } };
}
const progressOf = (record: Experiment) => record.preparationProgress as CardPreparation;
const worded = (saves: readonly Experiment[]) => saves.filter(save => 'status' in progressOf(save)).length;

test('a finished preparation writes no word for how it ended: nothing is left pending', async () => {
  const { record, batch } = setup();
  const saved = publisher();
  await prepareCards(record, plan(batch), undefined, cardRuntime(), budget(record), saved);
  assert.deepEqual([progressOf(record).pending, 'status' in progressOf(record), worded(saved.saves)], [[], false, 0]);
});

test('a stop by the budget is not written as a cancel: the checkpoint keeps what is left, and an earlier Lab\'s word goes on the resume', async () => {
  const { record, batch } = setup();
  const saved = publisher();
  await assert.rejects(prepareCards(record, plan(batch), undefined, cardRuntime(), budget(record, 1), saved), error => error instanceof Stopped && error.reason === 'budget');
  const last = saved.saves.at(-1)!;
  assert.deepEqual([progressOf(last).pending, (last.librarySnapshot as LibraryV2).cards.length, worded(saved.saves)], [['late', 'known'], 1, 0],
    'the one card made is kept; both conversations wait for the resume');

  // The same checkpoint as an earlier Lab wrote it: parsed as stored, its word dropped once this Lab continues it.
  const earlier = { ...progressOf(last), status: 'cancelled' };
  assert.equal(fingerprint(preparationProgressSchema.parse(earlier)), fingerprint(earlier));
  last.preparationProgress = earlier;
  const resumed = publisher();
  await resumeCards(last, batch, cardRuntime(), budget(last), resumed);
  assert.deepEqual([progressOf(last).pending, 'status' in progressOf(last), worded(resumed.saves)], [[], false, 0]);
});
