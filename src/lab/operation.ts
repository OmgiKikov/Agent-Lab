import { addUsage, type Experiment } from '../contracts.js';
import type { CallContext } from '../runtime.js';
import type { ScenarioLibrary } from '../card/schema.js';
import { Stopped } from '../errors.js';
import type { ExperimentStore } from '../store.js';
import { moveTo, stoppedPhase, type Phase } from '../phases.js';

/*
 * The lab's one long operation at a time — a preparation, a check of changed situations, a run, a re-assessment —
 * and the short changes between them. A running operation owns its record: its budget of model calls and time,
 * its checkpoints, and everyone who follows it. Followers are told of each change as it happens — a checkpoint, a
 * saved step of a preparation, a progress line — so nobody has to ask again and again how far the work got.
 *
 *   launch ─► first checkpoint saved (the caller returns) ─► work: checkpoint · publish · say … ─► last save
 *                                                              └─ every change ─► followers
 */

/**
 * Told of every change of the running operation's record, at once: the record is the live one, so a follower reads
 * what it needs there and then, and never keeps or changes it.
 */
export type Follower = (record: Experiment) => void;

/** What the work of an operation may set before its first call. */
export interface Operation {
  /**
   * The model calls the operation may make, counted on the record: the draft's limit, which is the run's budget,
   * unless the work sets its own — a preparation stops at the ceiling its consent stated.
   */
  callLimit: number;
}

interface Active { record: Experiment; controller: AbortController; done: Promise<void>; startedAtMs: number; preparationElapsedBeforeMs?: number }

export class OperationRunner {
  private active: Active | null = null;
  private lastTask: Promise<void> = Promise.resolve();
  private mutation: Promise<unknown> | undefined;
  private state: 'closed' | 'open' | 'closing' = 'closed';
  private readonly followers = new Set<Follower>();
  constructor(private readonly store: ExperimentStore) {}

  /** Accepts work from now on; a runner that began closing never opens again. */
  open(): void { if (this.state === 'closed') this.state = 'open'; }
  get closing(): boolean { return this.state === 'closing'; }
  /** Refuses new work and stops the running operation, whose evidence is saved as it ends. */
  shutdown(): void {
    this.state = 'closing';
    this.active?.controller.abort(new Stopped('closing', 'Application is closing.'));
  }
  /** Resolves when the last operation has ended; its failure to save stays observable here. */
  async idle(): Promise<void> { await this.lastTask; }
  /** Resolves when the last operation and the last change have ended. */
  async settled(): Promise<void> { await this.lastTask; await this.mutation; }

  /** A detached copy of the running record, when `id` is the one running now. */
  snapshot(id: string): Experiment | undefined { return this.active?.record.id === id ? structuredClone(this.active.record) : undefined; }

  follow(follower: Follower): () => void {
    this.followers.add(follower);
    return () => { this.followers.delete(follower); };
  }

  /** Refuses work while the lab is closed, an operation runs or — unless the caller is that change — another change is going on. */
  ensureIdle(ownsMutation = false): void {
    if (this.state !== 'open') throw new Error('Лаборатория не открыта.');
    // ponytail: one active local experiment; use per-experiment workers when concurrent runs are needed.
    if (this.active || (!ownsMutation && this.mutation)) throw new Error('Уже идёт другая операция над экспериментом. Дождитесь её или остановите.');
  }

  /** A short change of one record: no other change or operation starts until it ends. */
  async change<T>(work: () => Promise<T>): Promise<T> {
    this.ensureIdle();
    const pending = Promise.resolve().then(work);
    this.mutation = pending;
    try { return await pending; } finally { if (this.mutation === pending) this.mutation = undefined; }
  }

  /**
   * Starts `work` on `record` as the lab's one operation and returns once the record is saved as started; the work
   * goes on in the background. `ownsMutation`: the caller is the change that starts it. The record ends where the
   * work's last checkpoint put it, or where stoppedPhase puts work cut short by a stop, the time limit, the call
   * budget or an error.
   */
  async launch(record: Experiment, work: (ctx: CallContext, operation: Operation) => Promise<void>, options: { ownsMutation?: boolean } = {}): Promise<void> {
    this.ensureIdle(options.ownsMutation);
    const controller = new AbortController();
    const preparationElapsedBeforeMs = record.phase === 'preparing' ? record.preparationProgress?.elapsedMs ?? 0 : undefined;
    const active: Active = { record, controller, done: Promise.resolve(), startedAtMs: performance.now(), preparationElapsedBeforeMs };
    this.active = active; // Reserve before the first await, including the initial checkpoint.
    const operation: Operation = { callLimit: record.settings.maxCalls };
    let saved = false;
    let ready!: () => void;
    let failed!: (error: unknown) => void;
    const initialCheckpoint = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    const remainingDurationMs = Math.max(0, record.settings.maxDurationMs - (preparationElapsedBeforeMs ?? 0));
    const outOfTime = () => controller.abort(new Stopped('time', 'Experiment time limit reached.'));
    if (!remainingDurationMs) outOfTime();
    const timer = setTimeout(outOfTime, remainingDurationMs);
    const ctx: CallContext = {
      signal: controller.signal, timeoutMs: record.settings.timeoutMs,
      beforeCall: () => {
        controller.signal.throwIfAborted();
        if (record.usage.calls >= operation.callLimit) {
          controller.abort(new Stopped('budget', 'Model call budget exhausted.')); controller.signal.throwIfAborted();
        }
        record.usage.calls++;
      },
      addUsage: usage => addUsage(record.usage, usage),
      onTrace: (trialId, event) => this.store.appendTrace(record.id, trialId, event),
      // Every judgment report replaces the sidecar; only the finished one goes to the journal.
      onJudgment: (trialId, audit, final) => {
        this.store.writeJudgeAudit(record.id, trialId, audit);
        if (final) this.store.appendJudgment(record.id, trialId, audit);
      },
    };
    active.done = (async () => {
      try {
        await this.store.save(record); saved = true; ready();
        this.announce(record);
        controller.signal.throwIfAborted();
        await work(ctx, operation);
        if (record.phase !== 'results_review') controller.signal.throwIfAborted();
      }
      catch (error) {
        if (!saved) { failed(error); throw error; }
        const reason = controller.signal.aborted ? controller.signal.reason : error;
        record.error = reason instanceof Error ? reason.message : String(reason);
        record.phase = stoppedPhase(record, reason instanceof Stopped && (reason.reason === 'cancelled' || reason.reason === 'closing') ? 'cancelled' : 'failed');
        record.message = record.error;
      } finally {
        clearTimeout(timer); this.updateElapsed(record); record.updatedAt = new Date().toISOString();
        try { if (saved) { await this.store.save(record); this.announce(record); } }
        finally { if (this.active === active) this.active = null; }
      }
    })();
    this.lastTask = active.done;
    // Errors saving the final checkpoint remain observable through idle() and diagnostics.
    void active.done.catch(error => { process.stderr.write(`Agent Lab checkpoint failed: ${error instanceof Error ? error.message : String(error)}\n`); });
    await initialCheckpoint;
  }

  /** Saves a record at `phase` with its progress line; the followers of a running record hear of it. */
  async checkpoint(record: Experiment, phase: Phase, message: string): Promise<void> {
    this.updateElapsed(record);
    moveTo(record, phase); record.message = message; record.updatedAt = new Date().toISOString();
    // ponytail: full JSON checkpoints keep one canonical record; split trial storage when runs exceed local-scale sizes.
    await this.store.save(record);
    this.announce(record);
  }

  /** Saves a step of a preparation — the draft with its library — as the store publishes it (card/prepare.ts). */
  async publishLibrary(record: Experiment, library: ScenarioLibrary, expectedHash?: string): Promise<void> {
    await this.store.publishLibrary(record, library, expectedHash);
    this.announce(record);
  }

  /** A progress line of the running record that is not saved on its own: the next checkpoint carries it. */
  say(record: Experiment, message: string): void {
    record.message = message;
    this.announce(record);
  }

  /** Stops the operation running `id`; what it recorded is kept. */
  cancel(id: string): Experiment {
    if (this.active?.record.id !== id) throw new Error('Этот эксперимент сейчас не идёт.');
    this.active.controller.abort(new Stopped('cancelled', 'Cancelled by the user.'));
    this.say(this.active.record, 'Cancelling; preserving recorded evidence.');
    return structuredClone(this.active.record);
  }

  private announce(record: Experiment): void {
    if (this.active?.record !== record) return;
    // A follower draws the work; one that fails must not stop it.
    for (const follower of this.followers) try { follower(record); } catch { /* the work goes on */ }
  }

  /** A preparation carries its elapsed time across resumes, so the owner's time limit covers all of them together. */
  private updateElapsed(record: Experiment): void {
    if (record.preparationProgress && this.active?.record === record && this.active.preparationElapsedBeforeMs !== undefined) {
      record.preparationProgress.elapsedMs = this.active.preparationElapsedBeforeMs + Math.max(0, Math.round(performance.now() - this.active.startedAtMs));
    }
  }
}
