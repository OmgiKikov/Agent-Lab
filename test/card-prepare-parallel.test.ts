import test from 'node:test';
import assert from 'node:assert/strict';
import { experimentSchema, type Experiment } from '../src/contracts.js';
import { Stopped } from '../src/errors.js';
import type { CallContext, Runtime } from '../src/runtime.js';
import { prepareCards, resumeCards, type CardPlan, type DraftPublisher } from '../src/card/prepare.js';
import { preparationProgressSchema, type CardPreparation, type LibraryV2 } from '../src/card/schema.js';
import { newRecord } from '../src/lab/record.js';
import { importBatch, libraryHash } from '../src/scenario-library.js';
import type { ImportBatch } from '../src/scenario-contracts.js';
import { cardInput, cardRuntime, dialogues, proposals, type Received } from './helpers/card-prep.js';

/*
 * A preparation works on several dialogues at once: the draft is the same whichever finishes first (cards numbered in
 * plan order), the shared ceiling holds, saves never overlap, and every call in flight at a crash is settled on the
 * resume without being sent again. Invented dialogues, a scripted runtime with delays; no model is called.
 */

/** Copies of the two fixture dialogues, `d1`…`dN`, alternating: the careful proposal of each is known. */
const copies = (count: number) => Array.from({ length: count }, (_, index) => ({ ...dialogues[index % 2]!, id: `d${index + 1}` }));
const kindOf = (id: string): 'late' | 'known' => Number(id.slice(1)) % 2 === 1 ? 'late' : 'known';

function plan(batch: ImportBatch, picked: number, topics: boolean): CardPlan {
  const ids = batch.dialogues.map(dialogue => dialogue.id);
  const traffic = { importId: batch.id, contentHash: batch.contentHash, model: 'fixture/mapper', promptVersion: 'a'.repeat(64),
    topics: [{ id: 't1' as const, title: 'Возврат оплаты', dialogues: ids.length }], labeled: ids.length, logged: ids.length };
  return { kind: 'dialogues', batch, sample: { count: picked, picked: ids.slice(0, picked), excluded: [],
    strata: [{ ...(topics ? { topicId: 't1' as const } : {}), dialogueIds: ids }], ...(topics ? { traffic } : {}) } };
}

function setup(count: number): { record: Experiment; batch: ImportBatch } {
  const input = cardInput({ dialogues: copies(count) });
  return { record: newRecord(input), batch: importBatch(input.dialogues) };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

/** The run's budget as the operation keeps it (lab/operation.ts): check and count in one synchronous step. */
function budget(record: Experiment, limit = 200): CallContext {
  const controller = new AbortController();
  return { signal: controller.signal, timeoutMs: 60_000, addUsage: () => undefined, beforeCall: () => {
    controller.signal.throwIfAborted();
    if (record.usage.calls >= limit) { controller.abort(new Stopped('budget', 'Model call budget exhausted.')); controller.signal.throwIfAborted(); }
    record.usage.calls++;
  } };
}

/** Saves that must never overlap and must each expect the library the previous one wrote. */
function publisher(written?: string): DraftPublisher & { saves: Experiment[] } {
  const saves: Experiment[] = [];
  let writing = false, last = written;
  return { saves, async publishLibrary(record, library, expected) {
    assert.equal(writing, false, 'two saves never write the draft at once');
    assert.equal(expected, last, 'each save expects the library the one before it wrote');
    writing = true;
    const snapshot = experimentSchema.parse(structuredClone({ ...record, librarySnapshot: library }));
    await new Promise(resolve => setTimeout(resolve, 1));
    saves.push(snapshot); last = libraryHash(library); writing = false;
  } };
}

/**
 * The careful proposal of each copy after `delays[id]` ms, and a reviewer that accepts every claim; `hang` proposals are
 * sent and never answered, as a crash leaves them. `peak` is the most calls in flight at once, `sent` the charged ones.
 */
function scripted(seen: Received, delays: Record<string, number> = {}, hang: string[] = []) {
  const base = cardRuntime(seen);
  const state = { now: 0, peak: 0, sent: 0, hanging: 0 };
  const charged = (ctx: CallContext) => { ctx.beforeCall(); state.sent++; };
  const timed = async <T>(ms: number, signal: AbortSignal, answer: () => T | Promise<T>): Promise<T> => {
    state.now++; state.peak = Math.max(state.peak, state.now);
    try { await sleep(ms, signal); return await answer(); } finally { state.now--; }
  };
  const runtime: Runtime = { ...base,
    async proposeCard(request, ctx) {
      const id = request.call.source.kind === 'dialogue' ? request.call.source.dialogueId : '';
      charged(ctx); seen.proposals.push(structuredClone(request));
      if (hang.includes(id)) { state.hanging++; return new Promise(() => undefined); }
      return timed(delays[id] ?? 0, ctx.signal, () => ({ ...proposals[kindOf(id)], title: `Ситуация ${id}` }));
    },
    async reviewCard(request, ctx) {
      charged(ctx); seen.reviews.push(structuredClone(request));
      return timed(5, ctx.signal, () => ({ verdicts: Object.fromEntries(request.aliases.map(alias => [alias, { status: 'ready' as const, reason: 'Подтверждено.' }])), model: 'fixture/reviewer' }));
    },
  };
  return { runtime, state };
}

const received = (): Received => ({ proposals: [], reviews: [] });
const progressOf = (record: Experiment) => record.preparationProgress as CardPreparation;
const origins = (library: LibraryV2) => [...library.cards].sort((a, b) => a.number - b.number)
  .map(card => [card.number, card.origin.kind === 'dialogue' ? card.origin.dialogueId : card.origin.kind]);
async function until(condition: () => boolean): Promise<void> {
  for (let tick = 0; !condition(); tick++) { assert.ok(tick < 1000, 'the scripted calls never started'); await new Promise(resolve => setTimeout(resolve, 2)); }
}

for (const topics of [true, false]) {
  test(`three dialogues at once, cards numbered in plan order whichever finishes first (${topics ? 'topics from the map' : 'no map: a proposal sees the cards before it'})`, async () => {
    const { record, batch } = setup(5);
    const seen = received();
    // The first dialogue answers last: completion order is the reverse of the plan.
    const { runtime, state } = scripted(seen, { d1: 60, d2: 45, d3: 30, d4: 15, d5: 1 });
    const saved = publisher();
    await prepareCards(record, plan(batch, 5, topics), undefined, runtime, budget(record), saved, 3);
    const progress = progressOf(record);
    assert.deepEqual([progress.status, progress.pending, progress.excluded, progress.active], ['complete', [], [], undefined]);
    assert.deepEqual(origins(record.librarySnapshot as LibraryV2), [[1, 'd1'], [2, 'd2'], [3, 'd3'], [4, 'd4'], [5, 'd5']]);
    assert.deepEqual((record.librarySnapshot as LibraryV2).cards.map(card => card.title), ['Ситуация d1', 'Ситуация d2', 'Ситуация d3', 'Ситуация d4', 'Ситуация d5']);
    // Without the map a proposal waits for the cards before it; the reviews of those cards still run beside it.
    if (topics) assert.equal(state.peak, 3, 'three calls in flight at once, never more'); else assert.ok(state.peak >= 2 && state.peak <= 3, `${state.peak} calls at once`);
    assert.equal(record.usage.calls, state.sent);
    if (!topics) assert.deepEqual(seen.proposals.map(request => request.topics), [[], ...Array.from({ length: 4 }, () => ['Возврат оплаты'])], 'each proposal is offered the topics of the cards before it');
    assert.ok(saved.saves.length > 10, 'every step is saved');
  });
}

test('one dialogue at a time is the preparation as it was: the same cards, one call in flight', async () => {
  const { record, batch } = setup(3);
  const { runtime, state } = scripted(received(), { d1: 10, d2: 5 });
  await prepareCards(record, plan(batch, 3, true), undefined, runtime, budget(record), publisher());
  assert.deepEqual([origins(record.librarySnapshot as LibraryV2), state.peak], [[[1, 'd1'], [2, 'd2'], [3, 'd3']], 1]);
});

test('units at work together never pass the shared ceiling', async () => {
  const { record, batch } = setup(6);
  const { runtime, state } = scripted(received(), { d1: 20, d2: 10, d3: 30, d4: 5, d5: 15, d6: 1 });
  await assert.rejects(prepareCards(record, plan(batch, 6, true), undefined, runtime, budget(record, 7), publisher(), 3), /budget exhausted/);
  assert.deepEqual([record.usage.calls, state.sent], [7, 7], 'every call the ceiling let through, and not one more');
});

test('a crash with two calls in flight: the resume settles both and never sends them again', async () => {
  const { record, batch } = setup(4);
  const seen = received();
  const { runtime, state } = scripted(seen, {}, ['d1', 'd2']);
  const saved = publisher();
  // The process "dies" here: the two proposals were sent and are never answered.
  void prepareCards(record, plan(batch, 2, true), undefined, runtime, budget(record), saved, 2);
  await until(() => state.hanging === 2);
  const crashed = saved.saves.at(-1)!;
  assert.deepEqual(progressOf(crashed).active, [{ dialogueId: 'd1', stage: 'propose' }, { dialogueId: 'd2', stage: 'propose' }], 'both calls are named before they are sent');

  const after = received();
  const resumed = scripted(after);
  await resumeCards(crashed, batch, resumed.runtime, budget(crashed), publisher(libraryHash(crashed.librarySnapshot!)), 2);
  const progress = progressOf(crashed);
  assert.deepEqual(after.proposals.map(request => request.call.source.kind === 'dialogue' && request.call.source.dialogueId), ['d3', 'd4'], 'neither dialogue is asked again');
  assert.deepEqual([progress.status, progress.active, progress.excluded.map(item => item.dialogueId)], ['complete', undefined, ['d1', 'd2']]);
  assert.ok(progress.excluded.every(item => item.reason.includes('стоимость неизвестна')));
  assert.deepEqual(origins(crashed.librarySnapshot as LibraryV2), [[1, 'd3'], [2, 'd4']], 'the replacements are numbered in the order they were called in');
});

test('a checkpoint written before units ran at once names its call in the single fields: it parses and is settled the same way', async () => {
  const { record, batch } = setup(3);
  const { runtime, state } = scripted(received(), {}, ['d1']);
  const saved = publisher();
  void prepareCards(record, plan(batch, 2, true), undefined, runtime, budget(record), saved, 1);
  await until(() => state.hanging === 1);
  const crashed = saved.saves.at(-1)!;
  const { active: _active, ...rest } = progressOf(crashed);
  const old = { ...rest, activeDialogueId: 'd1', activeStage: 'propose' as const };
  assert.deepEqual(preparationProgressSchema.parse(old), old);
  crashed.preparationProgress = old;

  const after = received();
  await resumeCards(crashed, batch, scripted(after).runtime, budget(crashed), publisher(libraryHash(crashed.librarySnapshot!)), 2);
  const progress = progressOf(crashed);
  assert.deepEqual(after.proposals.map(request => request.call.source.kind === 'dialogue' && request.call.source.dialogueId), ['d2', 'd3']);
  assert.deepEqual([progress.activeDialogueId, progress.activeStage, progress.active, progress.excluded.map(item => item.dialogueId)], [undefined, undefined, undefined, ['d1']]);
  assert.deepEqual(origins(crashed.librarySnapshot as LibraryV2), [[1, 'd2'], [2, 'd3']]);
});
