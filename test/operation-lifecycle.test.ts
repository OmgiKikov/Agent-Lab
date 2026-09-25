import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostGrant } from '../src/card/commands.js';
import type { Experiment } from '../src/contracts.js';
import { createDemoRuntime, demoInput } from '../src/demo.js';
import { BudgetExhausted, LibraryConflict, NotADraft, STOP_LABEL } from '../src/errors.js';
import { ExperimentLab } from '../src/experiment.js';
import { OperationRunner } from '../src/lab/operation.js';
import { draftHash, newRecord } from '../src/lab/record.js';
import { runPlan } from '../src/lab/run.js';
import type { Phase } from '../src/phases.js';
import { accuracyParts } from '../src/result-text.js';
import { buildResultView } from '../src/result-view.js';
import type { Runtime } from '../src/runtime.js';
import { libraryHash } from '../src/scenario-library.js';
import { ExperimentStore } from '../src/store.js';
import { settle, type DecisionSurface, type Writing } from '../extensions/decisions.ts';
import { cardInput, cardRuntime } from './helpers/card-prep.js';

/*
 * The life of an operation (lab/operation.ts, phases.ts): every operation has its own budget and time from its start;
 * a check has a phase of its own and always gives the draft back; a stop moves a record only while its work is still
 * running, and only as its phase's stop rule says; the budget refuses a new call without cutting short the calls
 * under way. Scripted runtimes, invented data; no model is called.
 */

async function withLab(runtime: Runtime, work: (lab: ExperimentLab, directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-lifecycle-'));
  const lab = new ExperimentLab(directory, runtime);
  try { await lab.init(); await work(lab, directory); } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
}

/** The fixture's two situations prepared from their logs: two proposals and two reviews, four calls. */
async function prepared(lab: ExperimentLab, input = cardInput()): Promise<Experiment> {
  const draft = await lab.create(input);
  await lab.waitForIdle();
  const record = await lab.get(draft.id);
  assert.equal(record.phase, 'review', record.error ?? '');
  return record;
}

/** The card runtime with a customer and a judge that charge their calls as models do. */
function chargedRuntime(): Runtime {
  const base = cardRuntime();
  return { ...base,
    selectUserAction: async (input, ctx) => { ctx.beforeCall(); return base.selectUserAction!(input, ctx); },
    assess: async (input, ctx) => { for (const _vote of (input.scenario.metrics ?? []).flatMap(metric => [metric, metric])) ctx.beforeCall(); return base.assess!(input, ctx); } };
}

test('a stop that arrives while the last checkpoint is written changes nothing: the prepared draft stays the owner\'s', async () => {
  await withLab(createDemoRuntime(), async lab => {
    const save = lab.store.save.bind(lab.store);
    let stopped = false;
    lab.store.save = async record => {
      // The owner's stop lands while the preparation writes its last checkpoint.
      if (record.phase === 'review' && !stopped) { stopped = true; await lab.cancel(record.id); }
      await save(record);
    };
    const draft = await lab.create(demoInput());
    await lab.waitForIdle();
    const after = await lab.get(draft.id);
    assert.ok(stopped, 'the stop arrived during the last save');
    assert.deepEqual([after.phase, after.error, after.stop, after.message], ['review', null, undefined, 'Ситуации готовы. Проверьте их и утвердите для прогона.']);
    assert.equal(after.librarySnapshot?.formatVersion === 2 ? after.librarySnapshot.cards.length : 0, 2, 'both situations are kept');
  });
});

test('a check runs in a phase of its own and gives the draft back: stopped, it is the draft with what it saved; left by a dead process, the draft again', async () => {
  const runtime = cardRuntime();
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-lifecycle-'));
  const lab = new ExperimentLab(directory, runtime);
  try {
    await lab.init();
    const draft = await prepared(lab);
    const { library } = await lab.readCards(draft.id);
    // The owner's change opens the claims of the first situation again.
    const card = library.cards.find(item => item.number === 1)!;
    const command = await lab.prepareCardCommand(draft.id, { kind: 'set_fact_disclosure', cardId: card.id, factId: 'f1', disclosure: 'unknown' }, { via: 'cli-yes' });
    const changed = (await lab.applyCardCommand(draft.id, command, hostGrant(command, 'confirmed'))).library;
    // The reviewer is sent the request and answers only when the check is stopped.
    runtime.reviewCard = (_request, ctx) => new Promise((_resolve, reject) => { ctx.beforeCall(); ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true }); });
    const phases = new Set<Phase>();
    lab.follow(record => phases.add(record.phase));
    await lab.checkCards(draft.id, libraryHash(changed));
    const checking = await lab.get(draft.id);
    assert.equal(checking.phase, 'checking');
    assert.equal(accuracyParts(buildResultView(checking)).tail, 'прогон ещё не запускался', 'a draft under its check is a draft, not a run going on');
    await lab.cancel(draft.id);
    await lab.waitForIdle();
    const stopped = await lab.get(draft.id);
    assert.deepEqual([stopped.phase, stopped.stop, stopped.error], ['review', 'cancelled', STOP_LABEL.cancelled], 'a stopped check gives the draft back, and says why');
    assert.deepEqual(stopped.librarySnapshot, changed, 'the situations are as the owner left them');
    assert.ok(!phases.has('preparing'), 'a check never passes for a preparation');

    // A process that dies during a check leaves the draft in the check's phase; the next start gives it back.
    await lab.store.save({ ...stopped, phase: 'checking', error: null });
    await lab.close();
    const reopened = new ExperimentLab(directory, runtime);
    await reopened.init();
    try {
      const restarted = await reopened.get(draft.id);
      assert.equal(restarted.phase, 'review', 'never interrupted: the paid preparation stays the owner\'s draft');
      runtime.reviewCard = cardRuntime().reviewCard;
      await reopened.checkCards(draft.id, libraryHash(changed));
      await reopened.waitForIdle();
      const checked = await reopened.get(draft.id);
      assert.deepEqual([checked.phase, checked.error], ['review', null], 'and it is checked again');
      const { library: ready } = await reopened.readCards(draft.id);
      assert.equal((await reopened.acceptCards(draft.id, libraryHash(ready), ready.cards.map(item => item.id))).experiment.scenarios.length, 2);
    } finally { await reopened.close(); }
  } finally { await lab.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a check never spends the preparation\'s time: a draft whose preparation used all of it is still checked', async () => {
  await withLab(cardRuntime(), async lab => {
    const draft = await prepared(lab, cardInput({ settings: { ...cardInput().settings, maxDurationMs: 5_000 } }));
    // The preparation took far longer than one operation on the draft may.
    const record = await lab.get(draft.id);
    record.preparationProgress!.elapsedMs = 60_000;
    await lab.store.save(record);
    const { library } = await lab.readCards(draft.id);
    await lab.checkCards(draft.id, libraryHash(library));
    await lab.waitForIdle();
    const checked = await lab.get(draft.id);
    assert.deepEqual([checked.phase, checked.error, checked.stop], ['review', null, undefined], 'the check has its own time');
    assert.equal(checked.preparationProgress!.elapsedMs, 60_000, 'and is never charged to the preparation');
  });
});

test('«поднять лимит» raises what stopped the draft\'s last work: its calls, and its time too when the time cut it short', async () => {
  await withLab(cardRuntime(), async lab => {
    const draft = await prepared(lab);
    // The surface hands the owner's pick to the lab: no background work is started here.
    const surface = { ctx: {}, origin: 'chat', writing: async (work: Parameters<Writing>[0]) => work(lab, () => undefined), background: {} } as unknown as DecisionSurface;
    const stoppedBy = async (stop: 'budget' | 'time') => lab.store.save({ ...(await lab.get(draft.id)), stop, error: STOP_LABEL[stop], message: STOP_LABEL[stop] });

    await stoppedBy('budget');
    assert.equal(await settle(surface, { kind: 'raise_limit', runId: draft.id, to: 90 }, []), 'Решено: лимит поднят до 90 вызовов. Проверяю ситуации — итог придёт сюда отдельным сообщением.');
    const calls = await lab.get(draft.id);
    assert.deepEqual([calls.settings.maxCalls, calls.settings.maxDurationMs], [90, draft.settings.maxDurationMs], 'the budget stopped it: the calls are raised');

    await stoppedBy('time');
    assert.equal(await settle(surface, { kind: 'raise_limit', runId: draft.id, to: 120 }, []), 'Решено: лимит поднят до 120 вызовов и время — до 20 мин. Проверяю ситуации — итог придёт сюда отдельным сообщением.');
    const time = await lab.get(draft.id);
    assert.deepEqual([time.settings.maxCalls, time.settings.maxDurationMs], [120, 2 * draft.settings.maxDurationMs], 'the time stopped it: the time is raised with the calls');
  });
});

test('a draft an older check left interrupted, with nothing left to prepare, is the draft again on the owner\'s resume — no call is made', async () => {
  await withLab(cardRuntime(), async lab => {
    const draft = await prepared(lab);
    // What a restart made of a check before checks had a phase of their own.
    await lab.store.save({ ...draft, phase: 'interrupted', error: 'Предыдущий процесс остановился. Собранные данные сохранены.' });
    const { library } = await lab.readCards(draft.id);
    const resumed = await lab.resumePreparation(draft.id, libraryHash(library));
    assert.deepEqual([resumed.phase, resumed.error, resumed.usage.calls], ['review', null, draft.usage.calls]);
    assert.equal((await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id))).experiment.scenarios.length, 2, 'the paid preparation is not lost');
  });
});

test('a check of a record that is not a draft is refused as such, never as a draft that changed while the owner looked', async () => {
  await withLab(cardRuntime(), async lab => {
    const draft = await prepared(lab);
    const { library } = await lab.readCards(draft.id);
    const accepted = await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id));
    await lab.start(draft.id, { approved: true, expectedHash: draftHash(accepted.experiment) });
    await lab.waitForIdle();
    await assert.rejects(lab.checkCards(draft.id, libraryHash(accepted.library)),
      (error: unknown) => error instanceof NotADraft && !(error instanceof LibraryConflict) && /только в черновике/.test((error as Error).message));
  });
});

test('the budget refuses only a new call: the calls under way finish, and the operation ends as a budget stop once its work returns', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-lifecycle-'));
  const store = new ExperimentStore(directory);
  await store.init();
  try {
    const runner = new OperationRunner(store);
    runner.open();
    const record = newRecord(demoInput());
    let answer!: () => void;
    const answered = new Promise<void>(resolve => { answer = resolve; });
    const heard: string[] = [];
    await runner.launch(record, async (ctx, operation) => {
      // Two calls are sent and wait for their answers, as two units of a preparation at work together do.
      const call = async (name: string) => { ctx.beforeCall(); await answered; ctx.signal.throwIfAborted(); heard.push(name); };
      const under = [call('first'), call('second')];
      assert.throws(() => ctx.beforeCall(), (error: unknown) => error instanceof BudgetExhausted && error.reason === 'budget', 'a third call is refused before it is sent, typed');
      assert.deepEqual([ctx.signal.aborted, operation.exhausted, operation.spent], [false, true, 2], 'the refusal cuts nothing short');
      assert.throws(() => ctx.beforeCall(), BudgetExhausted, 'every later call is refused the same way');
      answer();
      await Promise.all(under);
    }, { budget: { calls: 2, timeMs: 60_000 } });
    await runner.idle();
    assert.deepEqual(heard, ['first', 'second'], 'both calls under way were answered');
    const stored = await store.get(record.id);
    assert.deepEqual([stored.phase, stored.stop, stored.error, stored.usage.calls], ['error', 'budget', STOP_LABEL.budget, 2]);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a run spends its own limit from its start: the preparation\'s calls are not the run\'s, and a plan the limit cannot hold never starts', async () => {
  await withLab(chargedRuntime(), async lab => {
    // Two situations of two expectations, three turns: the run plans 2 × (3 + 2 × 2) + 1 = 15 calls, and its limit is 15.
    const draft = await prepared(lab, cardInput({ settings: { ...cardInput().settings, maxCalls: 15 } }));
    assert.equal(draft.usage.calls, 4, 'the preparation spent four calls of its own ceiling');
    const { library } = await lab.readCards(draft.id);
    const accepted = (await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id))).experiment;
    assert.equal(runPlan(accepted), 15);
    await lab.start(draft.id, { approved: true, expectedHash: draftHash(accepted) });
    await lab.waitForIdle();
    const finished = await lab.get(draft.id);
    assert.deepEqual([finished.phase, finished.error], ['results_review', null], 'the run has the number: its own 15 calls were enough');
    assert.ok(finished.usage.calls - draft.usage.calls <= 15);

    const repeat = await lab.repeat(draft.id);
    const tight = await lab.updateDraft(repeat.id, draftHash(repeat), { settings: { maxCalls: 14 } });
    await assert.rejects(lab.start(tight.id, { approved: true, expectedHash: draftHash(tight) }),
      /^Error: Прогону нужно до 15 вызовов модели, а лимит прогона — 14\. Поднимите лимит до 15 или запустите меньше ситуаций\. Ничего не запущено и не потрачено\.$/);
    assert.deepEqual([(await lab.get(tight.id)).phase, (await lab.get(tight.id)).usage.calls], ['review', 0], 'nothing ran');
    const started = await lab.start(tight.id, { approved: true, expectedHash: draftHash(tight), raiseLimit: true });
    assert.equal(started.settings.maxCalls, 15, 'the owner\'s confirmation raised the limit to the plan');
    await lab.waitForIdle();
    assert.equal((await lab.get(tight.id)).phase, 'results_review');
  });
});

test('a run whose measurement drifts stops: a setting or a changed part at the next dialogue, a part edited in place once the suite ends', async () => {
  // A follower never changes the record it is shown: here one does, as a defect would, once the first dialogue is saved.
  const drifts: Array<[string, (record: Experiment) => void, Phase, number]> = [
    ['a setting', record => { record.settings.maxTurns = 2; }, 'error', 1],
    ['a situation put in place of another', record => { record.scenarios = record.scenarios.map((scenario, index) => index ? scenario : { ...scenario, title: 'Другая ситуация' }); }, 'error', 1],
    // Around a dialogue the materials and the situations are compared by identity; the whole check after the suite reads them.
    ['a situation edited in place', record => { record.scenarios[0]!.title = 'Другая ситуация'; }, 'error', 2],
    ['the same situations put in place of themselves', record => { record.scenarios = structuredClone(record.scenarios); }, 'results_review', 2],
  ];
  for (const [what, drift, phase, dialogues] of drifts) await withLab(chargedRuntime(), async lab => {
    const draft = await prepared(lab);
    const { library } = await lab.readCards(draft.id);
    const accepted = (await lab.acceptCards(draft.id, libraryHash(library), library.cards.map(card => card.id))).experiment;
    let drifted = false;
    const unfollow = lab.follow(record => { if (!drifted && record.trials.length === 1) { drifted = true; drift(record); } });
    await lab.start(draft.id, { approved: true, expectedHash: draftHash(accepted), parallel: 1 });
    await lab.waitForIdle();
    unfollow();
    const run = await lab.get(draft.id);
    assert.deepEqual([run.phase, run.error, run.trials.length], [phase, phase === 'error' ? 'Условия измерения изменились во время прогона. Запустите повтор заново.' : null, dialogues], what);
  });
});
