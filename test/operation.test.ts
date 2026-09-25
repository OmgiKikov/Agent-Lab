import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Experiment } from '../src/contracts.js';
import { createDemoRuntime, demoInput } from '../src/demo.js';
import { ExperimentLab } from '../src/experiment.js';
import { isRunning, moveTo, PHASE_TABLE, PHASES, restartAt, stopAt, stoppedPhase, type Phase } from '../src/phases.js';
import { draftHash } from '../src/lab/record.js';
import { ExperimentStore } from '../src/store.js';
import { acceptedDemoDraft } from './helpers/demo-record.js';

/*
 * The lab's one operation at a time (lab/operation.ts) tells whoever follows it of every change as it happens, a
 * reader hears another writer's records as they are written (store.ts), and every move of a record's phase is one the
 * phase table holds (phases.ts).
 */

async function withLab(work: (lab: ExperimentLab, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-operation-'));
  const lab = new ExperimentLab(directory, createDemoRuntime());
  try { await lab.init(); await work(lab, directory); } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
}

test('a run is followed, not polled: its start, every dialogue and progress line as it happens, and its end', async () => {
  await withLab(async lab => {
    const draft = await acceptedDemoDraft(lab);
    const heard: { phase: Phase; trials: number; message: string }[] = [];
    const stop = lab.follow(record => heard.push({ phase: record.phase, trials: record.trials.length, message: record.message }));
    await lab.start(draft.id, { approved: true, reviewer: 'automated', expectedHash: draftHash(draft) });
    await lab.waitForIdle();
    stop();
    const finished = await lab.get(draft.id);
    assert.equal(finished.phase, 'results_review', finished.error ?? '');
    assert.deepEqual(heard[0], { phase: 'evaluating', trials: 0, message: 'Выполняю согласованный план проверки.' }, 'the start, as it was saved');
    assert.deepEqual(heard.at(-1), { phase: 'results_review', trials: finished.trials.length, message: finished.message }, 'the end, as it was saved');
    const counts = heard.map(item => item.trials);
    assert.deepEqual(counts, [...counts].sort((a, b) => a - b), 'in the order it happened');
    assert.deepEqual([...new Set(counts)], Array.from({ length: finished.trials.length + 1 }, (_, n) => n), 'every dialogue as it was recorded');
    assert.ok(heard.some(item => item.message.includes('ждём ответ агента')), 'a progress line that is not saved on its own is heard too');
  });
});

test('a preparation is followed step by step, and a follower that fails or stopped never touches the work', async () => {
  await withLab(async lab => {
    const heard: { processed: number; message: string }[] = [];
    let failing = 0, stopped = 0;
    lab.follow(record => heard.push({ processed: record.preparationProgress?.processed.length ?? 0, message: record.message }));
    lab.follow(() => { failing++; throw new Error('the row could not be drawn'); });
    lab.follow(() => { stopped++; })();
    const draft = await lab.create(demoInput());
    await lab.waitForIdle();
    const prepared = await lab.get(draft.id);
    assert.equal(prepared.phase, 'review', prepared.error ?? '');
    assert.ok(heard.some(item => item.message.startsWith('Размечаю темы разговоров: шаг 1 из')), 'the topic map\'s steps are announced');
    assert.deepEqual([...new Set(heard.map(item => item.processed))], [0, 1, 2], 'each conversation as its situation was saved');
    assert.deepEqual([failing, stopped], [heard.length, 0]);
  });
});

test('a separate reader sees topic preparation before the first card exists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-topic-progress-'));
  const runtime = createDemoRuntime();
  const build = runtime.topicMap!.build;
  const reader = new ExperimentStore(directory);
  let checked = 0;
  runtime.topicMap!.build = async (plan, ctx, onProgress) => {
    const [before] = await reader.list();
    assert.ok(before?.originalImport, 'the import is already saved when mapping begins');
    assert.match(before.message, /Размечаю темы разговоров/);
    assert.equal(before.librarySnapshot, undefined);
    return build(plan, ctx, async value => {
      await onProgress?.(value);
      const [record] = await reader.list();
      assert.match(record!.message, /Размечаю темы разговоров/);
      assert.ok(await reader.readTopicMap(plan.key));
      checked++;
    });
  };
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init();
    const draft = await lab.create(demoInput());
    await lab.waitForIdle();
    assert.equal((await lab.get(draft.id)).phase, 'review');
    assert.ok(checked > 0);
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a reader hears a record the writer saves without asking the disk again', { timeout: 20000 }, async () => {
  await withLab(async (lab, directory) => {
    const heard = new Set<string>();
    let first!: () => void;
    const arrived = new Promise<void>(resolve => { first = resolve; });
    const stop = new ExperimentStore(directory).watch(id => { heard.add(id); first(); });
    try {
      const draft = await lab.create(demoInput());
      await lab.waitForIdle();
      await arrived;
      assert.ok(heard.has(draft.id), [...heard].join(', '));
      assert.ok([...heard].every(id => !id.includes('.')), 'only records are heard: no temporary file, journal or sidecar');
    } finally { stop(); }
  });
});

test('every phase has its rule; a move the table does not hold is refused and the record stays where it was', () => {
  assert.deepEqual(Object.keys(PHASE_TABLE).sort(), [...PHASES].sort());
  assert.deepEqual(PHASES.filter(isRunning), ['preparing', 'checking', 'evaluating', 'baseline', 'improving', 'control']);
  assert.deepEqual(PHASES.filter(phase => !PHASE_TABLE[phase].next.length), ['cancelled', 'error'], 'a stopped or failed record is final: a repeat is a new record');
  assert.deepEqual(PHASES.filter(phase => !!PHASE_TABLE[phase].stopped || !!PHASE_TABLE[phase].restart), PHASES.filter(isRunning), 'only work that is running is cut short or restarted');
  const record: { phase: Phase } = { phase: 'review' };
  moveTo(record, 'evaluating');
  assert.throws(() => moveTo(record, 'complete'), /не предусмотрен/);
  assert.equal(record.phase, 'evaluating');
  moveTo(record, 'results_review'); moveTo(record, 'complete'); moveTo(record, 'results_review');
  assert.equal(record.phase, 'results_review', 'a person\'s verdict reopens a completed review');
  const cut = (phase: Phase, stop: 'cancelled' | 'failed', librarySnapshot?: Experiment['librarySnapshot']) => stoppedPhase({ phase, ...(librarySnapshot ? { librarySnapshot } : {}) }, stop);
  assert.deepEqual([cut('preparing', 'failed', {} as Experiment['librarySnapshot']), cut('preparing', 'cancelled'), cut('evaluating', 'failed'), cut('checking', 'cancelled'), cut('checking', 'failed')],
    ['review', 'cancelled', 'error', 'review', 'review'], 'a preparation keeps what it saved; a check always gives the draft back; a stop is a cancel; anything else an error');
  assert.equal(cut('results_review', 'failed'), undefined, 'a finished record has no stop to take');
  const finished: { phase: Phase } = { phase: 'review' };
  assert.throws(() => stopAt(finished, 'cancelled'), /не предусмотрен/, 'a stop that arrives after the work moved its record on is a defect, never a saved state');
  assert.equal(finished.phase, 'review');
  assert.deepEqual((['preparing', 'checking', 'evaluating', 'review', 'complete'] as const).map(phase => restartAt({ phase })), ['interrupted', 'review', 'interrupted', 'review', 'complete'],
    'a restart gives a draft cut short in its check back to the owner, marks other running work interrupted, and leaves the rest as it was');
});
