import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { experimentSchema, type Experiment } from '../src/contracts.js';
import { Stopped } from '../src/errors.js';
import { ProviderFailure } from '../src/llm/model-call.js';
import { StructuredTaskError } from '../src/llm/structured.js';
import type { CallContext, Runtime } from '../src/runtime.js';
import { prepareCards, resumeCards, type CardPlan, type DraftPublisher } from '../src/card/prepare.js';
import { libraryV2Schema, preparationProgressSchema, type CardPreparation, type LibraryV2 } from '../src/card/schema.js';
import { newRecord } from '../src/lab/record.js';
import { importBatch, libraryHash } from '../src/scenario-library.js';
import type { ImportBatch } from '../src/scenario-contracts.js';
import { ScenarioFiles } from '../src/scenario-store.js';
import { ExperimentStore } from '../src/store.js';
import { cardInput, cardRuntime, dialogues, proposals, type Received } from './helpers/card-prep.js';

/*
 * A preparation works on several dialogues at once: the draft is the same whichever finishes first (cards numbered in
 * plan order), the shared ceiling holds, saves never overlap, and every call in flight at a crash is settled on the
 * resume without being sent again. A request turned away before any answer began — by the budget or by the provider —
 * loses no conversation. Invented dialogues, a scripted runtime with delays; no model is called.
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

/** The run's budget as the operation kept it (lab/operation.ts): check and count in one synchronous step; running out aborts the work. */
function budget(record: Experiment, limit = 200): CallContext {
  const controller = new AbortController();
  return { signal: controller.signal, timeoutMs: 60_000, addUsage: () => undefined, beforeCall: () => {
    controller.signal.throwIfAborted();
    if (record.usage.calls >= limit) { controller.abort(new Stopped('budget', 'Model call budget exhausted.')); controller.signal.throwIfAborted(); }
    record.usage.calls++;
  } };
}

/** The budget as the engine keeps it now: a new call over the limit is refused by a typed stop, and the calls under way go on. */
function ceiling(record: Experiment, limit = 200): CallContext {
  const controller = new AbortController();
  return { signal: controller.signal, timeoutMs: 60_000, addUsage: () => undefined, beforeCall: () => {
    controller.signal.throwIfAborted();
    if (record.usage.calls >= limit) throw new Stopped('budget', 'Model call budget exhausted.');
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
 * sent and never answered, as a crash leaves them; `fail` proposals end with that error once charged, as a provider's
 * failure reaches the step (llm/model-call.ts charges a request when it gets its place). `peak` is the most calls in
 * flight at once, `sent` the charged ones.
 */
function scripted(seen: Received, delays: Record<string, number> = {}, hang: string[] = [], fail: Record<string, Error> = {}) {
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
      if (fail[id]) throw fail[id];
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

const dialogueOf = (request: { call: { source: { kind: string; dialogueId?: string } } }) => request.call.source.dialogueId;

for (const [kind, words] of [['rate limit', /^Провайдер модели ограничил частоту запросов\. .*продолжите подготовку через несколько минут\.$/],
  ['insufficient credit', /^У провайдера модели закончились средства: пополните счёт\. .*продолжите подготовку, когда причина устранена\.$/]] as const) {
  test(`the provider turns a request away before any answer (${kind}): no new unit is taken, the units at work finish, no conversation is lost`, async () => {
    const { record, batch } = setup(6);
    // The second dialogue's proposal is refused once the budget counted it; the others answer later.
    const refusal = new ProviderFailure(kind, `Ситуация из диалога: Pi provider response incomplete: ${kind}`);
    const { runtime } = scripted(received(), { d1: 20, d3: 10, d4: 5 }, [], { d2: refusal });
    const saved = publisher();
    await assert.rejects(prepareCards(record, plan(batch, 6, true), undefined, runtime, ceiling(record), saved, 4), error => error instanceof Error && words.test(error.message));
    const progress = progressOf(record);
    assert.deepEqual([progress.status, progress.active, progress.excluded], ['partial', undefined, []], 'nothing is in doubt, nothing is left out');
    assert.deepEqual([[...progress.processed].sort(), progress.pending], [['d1', 'd3', 'd4'], ['d2', 'd5', 'd6']], 'the refused conversation waits in the queue; no new one was taken');
    assert.equal(progress.generationAttempts?.find(item => item.dialogueId === 'd2')?.calls, 0, 'a refusal uses up none of the conversation\'s attempts');
    assert.deepEqual(origins(record.librarySnapshot as LibraryV2), [[1, 'd1'], [2, 'd3'], [3, 'd4']], 'the units at work landed their cards');

    const after = received();
    const last = saved.saves.at(-1)!;
    await resumeCards(last, batch, scripted(after).runtime, ceiling(last), publisher(libraryHash(last.librarySnapshot!)), 4);
    assert.deepEqual(after.proposals.map(dialogueOf), ['d2', 'd5', 'd6'], 'the resume prepares the refused conversation; nothing made is asked again');
    assert.deepEqual([progressOf(last).status, progressOf(last).excluded, progressOf(last).pending], ['complete', [], []]);
    assert.deepEqual(origins(last.librarySnapshot as LibraryV2), [[1, 'd1'], [2, 'd3'], [3, 'd4'], [4, 'd2'], [5, 'd5'], [6, 'd6']]);
  });
}

test('a request over the model\'s window leaves only its conversation out, in the owner\'s words; its seat goes to the next one of its topic', async () => {
  const { record, batch } = setup(4);
  const { runtime } = scripted(received(), {}, [], { d2: new ProviderFailure('context limit', 'Ситуация из диалога: Pi provider response incomplete: context limit') });
  await prepareCards(record, plan(batch, 3, true), undefined, runtime, ceiling(record), publisher(), 2);
  const progress = progressOf(record);
  assert.deepEqual([progress.status, progress.active, progress.excluded], ['complete', undefined, [{ dialogueId: 'd2', reason: 'Разговор вместе с материалами не поместился в окно модели.' }]]);
  assert.deepEqual([...progress.processed].sort(), ['d1', 'd3', 'd4'], 'a conversation left out counts once, as left out');
  assert.deepEqual(origins(record.librarySnapshot as LibraryV2), [[1, 'd1'], [2, 'd3'], [3, 'd4']]);
});

test('an answer cut off after it began keeps its call named: only such a conversation is left out with its cost unknown', async () => {
  const { record, batch } = setup(3);
  const cut = new ProviderFailure('connection failure', 'Ситуация из диалога: Pi provider response incomplete: connection failure', { delivery: 'cut' });
  const saved = publisher();
  await assert.rejects(prepareCards(record, plan(batch, 2, true), undefined, scripted(received(), {}, [], { d1: cut }).runtime, ceiling(record), saved, 1),
    error => error instanceof Error && error.message.startsWith('Ответ модели оборвался на середине: стоимость этого вызова неизвестна'));
  const last = saved.saves.at(-1)!;
  assert.deepEqual(progressOf(last).active, [{ dialogueId: 'd1', stage: 'propose' }]);
  const after = received();
  await resumeCards(last, batch, scripted(after).runtime, ceiling(last), publisher(libraryHash(last.librarySnapshot!)), 1);
  assert.deepEqual(after.proposals.map(dialogueOf), ['d2', 'd3'], 'the cut conversation is not asked again; its seat goes to the next one');
  assert.deepEqual(progressOf(last).excluded.map(item => item.dialogueId), ['d1']);
  assert.match(progressOf(last).excluded[0]!.reason, /стоимость неизвестна/);
});

test('the budget refuses a new call: no new unit is taken, the calls under way finish and are saved, no conversation is lost', async () => {
  const { record, batch } = setup(6);
  // Four proposals are under way when the first dialogue's review takes the last call of the ceiling.
  const { runtime, state } = scripted(received(), { d1: 40, d2: 30, d3: 20, d4: 10 });
  const saved = publisher();
  await assert.rejects(prepareCards(record, plan(batch, 6, true), undefined, runtime, ceiling(record, 5), saved, 4),
    error => error instanceof Stopped && error.reason === 'budget' && error.message === 'Model call budget exhausted.');
  const progress = progressOf(record);
  assert.deepEqual([record.usage.calls, state.sent], [5, 5]);
  assert.deepEqual([progress.status, progress.active, progress.excluded, progress.processed, progress.pending], ['partial', undefined, [], ['d1'], ['d2', 'd3', 'd4', 'd5', 'd6']]);
  assert.deepEqual(origins(record.librarySnapshot as LibraryV2), [[1, 'd1'], [2, 'd2'], [3, 'd3'], [4, 'd4']], 'the proposals under way when the budget ran out are kept');

  const after = received();
  const last = saved.saves.at(-1)!;
  await resumeCards(last, batch, scripted(after).runtime, ceiling(last, 40), publisher(libraryHash(last.librarySnapshot!)), 4);
  assert.deepEqual([after.proposals.map(dialogueOf), after.reviews.length], [['d5', 'd6'], 5], 'the kept cards are only reviewed; the conversations never taken are prepared');
  assert.deepEqual([progressOf(last).status, progressOf(last).excluded], ['complete', []]);
  assert.deepEqual(origins(last.librarySnapshot as LibraryV2), [[1, 'd1'], [2, 'd2'], [3, 'd3'], [4, 'd4'], [5, 'd5'], [6, 'd6']]);
});

test('a checkpoint that names a card its library does not hold: the conversation is not taken as finished', async () => {
  const { record, batch } = setup(3);
  const saved = publisher();
  await prepareCards(record, plan(batch, 3, true), undefined, scripted(received()).runtime, ceiling(record), saved, 1);
  // An earlier Lab could save the progress of one moment with the library of an earlier one: here the third
  // conversation's card row is saved, and its card is not.
  const split = structuredClone(saved.saves.findLast(save => progressOf(save).cards?.length === 2 && !progressOf(save).active && progressOf(save).pending.includes('d3'))!);
  progressOf(split).cards!.push({ dialogueId: 'd3', cardId: 'card_lost' });
  const after = received();
  await resumeCards(split, batch, scripted(after).runtime, ceiling(split), publisher(libraryHash(split.librarySnapshot!)), 1);
  const library = split.librarySnapshot as LibraryV2;
  assert.deepEqual(after.proposals.map(dialogueOf), ['d3'], 'its card is made, not silently skipped');
  assert.deepEqual([origins(library), progressOf(split).cards?.map(row => library.cards.some(card => card.id === row.cardId))], [[[1, 'd1'], [2, 'd2'], [3, 'd3']], [true, true, true]]);

  // A card the draft still holds from that conversation is taken back, not made twice.
  const relinked = structuredClone(record);
  const progress = progressOf(relinked);
  progress.pending = ['d2']; progress.processed = ['d1', 'd3']; progress.status = 'partial';
  progress.cards = progress.cards!.map(row => row.dialogueId === 'd2' ? { ...row, cardId: 'card_lost' } : row);
  const again = received();
  await resumeCards(relinked, batch, scripted(again).runtime, ceiling(relinked), publisher(libraryHash(relinked.librarySnapshot!)), 1);
  const card = (relinked.librarySnapshot as LibraryV2).cards.find(item => item.origin.kind === 'dialogue' && item.origin.dialogueId === 'd2')!;
  assert.deepEqual([again.proposals.length, progressOf(relinked).cards?.find(row => row.dialogueId === 'd2')?.cardId, progressOf(relinked).processed],
    [0, card.id, ['d1', 'd3', 'd2']]);

  // A card the owner removed stays removed: its conversation is finished, as before.
  const removed = structuredClone(record);
  const draft = removed.librarySnapshot as LibraryV2;
  const gone = draft.cards.find(item => item.origin.kind === 'dialogue' && item.origin.dialogueId === 'd3')!;
  removed.librarySnapshot = libraryV2Schema.parse({ ...draft, revision: draft.revision + 1, cards: draft.cards.filter(item => item.id !== gone.id),
    readingManifest: draft.readingManifest.map(row => ({ ...row, cardIds: row.cardIds.filter(id => id !== gone.id) })),
    receipts: [...draft.receipts, { id: 'receipt_remove', at: '2026-09-24T00:00:00.000Z', via: 'pi-confirm', command: { kind: 'remove_card', cardId: gone.id } }] });
  Object.assign(progressOf(removed), { pending: ['d3'], processed: ['d1', 'd2'], status: 'partial' });
  const none = received();
  await resumeCards(removed, batch, scripted(none).runtime, ceiling(removed), publisher(libraryHash(removed.librarySnapshot)), 1);
  assert.deepEqual([none.proposals.length, progressOf(removed).processed, progressOf(removed).pending], [0, ['d1', 'd2', 'd3'], []]);
});

test('a checkpoint of an earlier Lab that counted a left-out conversation as processed too counts it once on the resume', async () => {
  const { record, batch } = setup(4);
  const unusable = new StructuredTaskError('Ситуация из диалога: модель 5 раз подряд вернула ответ, который не проходит проверку. Последняя причина: knows[0] is not in the dialogue');
  await prepareCards(record, plan(batch, 3, true), undefined, scripted(received(), {}, [], { d2: unusable }).runtime, ceiling(record), publisher(), 1);
  assert.deepEqual(progressOf(record).excluded, [{ dialogueId: 'd2', reason: 'Ни один ответ модели не прошёл проверку Lab: ситуация не составлена.' }], 'the reason is the owner\'s words, not the model\'s');
  const earlier = structuredClone(record);
  progressOf(earlier).processed.push('d2');
  await resumeCards(earlier, batch, scripted(received()).runtime, ceiling(earlier), publisher(libraryHash(earlier.librarySnapshot!)), 1);
  assert.deepEqual([progressOf(earlier).processed, progressOf(earlier).excluded.map(item => item.dialogueId)], [['d1', 'd3', 'd4'], ['d2']]);
});

test('a card step that lands while another save waits its turn never splits the saved draft (a real store)', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-parallel-store-'));
  const store = new ExperimentStore(directory);
  await store.init();
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const { record, batch } = setup(2);
  const saves: Experiment[] = [];
  const publishing: DraftPublisher = { async publishLibrary(live, library, expected) { await store.publishLibrary(live, library, expected); saves.push(await store.get(live.id)); } };
  // The first dialogue's review is saved while the second dialogue's card lands: the store's queue holds that save
  // until the second card is in the live record.
  let release!: () => void;
  const second = new Promise<void>(resolve => { release = resolve; });
  let held: Promise<void> | undefined;
  const pending = ScenarioFiles.prototype.pendingPublications;
  ScenarioFiles.prototype.pendingPublications = async function (this: ScenarioFiles) { await held; return pending.call(this); };
  t.after(() => { ScenarioFiles.prototype.pendingPublications = pending; });
  const runtime = cardRuntime();
  runtime.proposeCard = async (request, ctx) => {
    ctx.beforeCall();
    const id = dialogueOf(request)!;
    if (id === 'd2') await second;
    return { ...proposals[kindOf(id)], title: `Ситуация ${id}` };
  };
  const review = runtime.reviewCard!;
  runtime.reviewCard = async (request, ctx) => {
    if (request.payload.card.title === 'Ситуация d1') held ??= (async () => { release(); await until(() => !!progressOf(record).cards?.some(row => row.dialogueId === 'd2')); })();
    return review(request, ctx);
  };
  await prepareCards(record, plan(batch, 2, true), undefined, runtime, ceiling(record), publishing, 2);
  assert.ok(held, 'the second card landed while a save waited its turn');
  for (const save of saves) {
    const cards = new Set((save.librarySnapshot as LibraryV2).cards.map(card => card.id));
    assert.ok((progressOf(save).cards ?? []).every(row => cards.has(row.cardId)), `a saved record names only cards of its saved library: ${JSON.stringify(progressOf(save).cards)}`);
  }
  assert.deepEqual(origins((await store.get(record.id)).librarySnapshot as LibraryV2), [[1, 'd1'], [2, 'd2']]);
});
