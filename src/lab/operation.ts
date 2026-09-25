import { addUsage, type Experiment } from '../contracts.js';
import type { CallContext } from '../runtime.js';
import type { ScenarioLibrary } from '../card/schema.js';
import { BudgetExhausted, Stopped } from '../errors.js';
import type { ExperimentStore } from '../store.js';
import { isRunning, moveTo, stopAt, type Phase } from '../phases.js';

/*
 * The lab's one long operation at a time — a preparation, a check of a draft's situations, a fill of masked values, a
 * run, a re-assessment, a judge check beside a run — and the short changes between them. Every operation has its own
 * budget of model calls and its own time, both counted from its start; one that owns a record owns its checkpoints and
 * everyone who follows it. Followers are told of each change as it happens — a checkpoint, a saved step of a
 * preparation, a progress line — so nobody has to ask again and again how far the work got.
 *
 *   launch ─► first checkpoint saved (the caller returns) ─► work: checkpoint · publish · say … ─► last save
 *                                                              └─ every change ─► followers
 *
 * How work is cut short:
 *   the budget   a new call past it is refused before it is sent (BudgetExhausted); the calls already under way finish;
 *                the operation ends as a budget stop once its work returns
 *   the time, a cancel, the closing application   the operation's signal is aborted: everything under way stops
 * Either way the record goes where its phase's stop rule says (phases.ts stopAt) — only while it is still running.
 */

/**
 * Told of every change of the running operation's record, at once: the record is the live one, so a follower reads
 * what it needs there and then, and never keeps or changes it.
 */
export type Follower = (record: Experiment) => void;

/** What an operation may spend, counted from its start. */
export interface Budget {
  /** Model calls. */
  calls: number;
  /** Time, in milliseconds. */
  timeMs: number;
}

/** What the work of an operation reads of its budget as it goes. */
export interface Operation {
  /** The model calls this operation may make from its start. */
  readonly callLimit: number;
  /** The calls it has made so far. */
  readonly spent: number;
  /** The budget refused a call: no new call starts, and the operation ends as a budget stop once its work returns. */
  readonly exhausted: boolean;
}

/**
 * What a preparation's earlier launches — its creation and every resume before this one — spent: carried into its
 * checkpoint with this launch's own, so the ceiling the owner agreed to and the spending cover all of them together.
 */
export interface Carried { calls: number; elapsedMs: number }

export interface LaunchOptions {
  /** The caller is the change that starts the operation. */
  ownsMutation?: boolean;
  budget: Budget;
  /** A preparation's accounts from its earlier launches; only a preparation carries any. */
  carried?: Carried;
}

interface Active {
  id: string;
  /** The record the operation owns; none for work beside a record, which never changes it. */
  record?: Experiment;
  controller: AbortController;
  done: Promise<unknown>;
  startedAtMs: number;
  budget: Budget;
  spent: number;
  carried?: Carried;
}

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
    this.active?.controller.abort(new Stopped('closing'));
  }
  /** Resolves when the last operation has ended; its failure to save stays observable here. */
  async idle(): Promise<void> { await this.lastTask; }
  /** Resolves when the last operation and the last change have ended. */
  async settled(): Promise<void> { await this.lastTask; await this.mutation; }

  /** A detached copy of the running record, when `id` is the one running now. */
  snapshot(id: string): Experiment | undefined { return this.active?.id === id && this.active.record ? structuredClone(this.active.record) : undefined; }

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
   * The context of the active operation's calls and the budget it reads. Every call is counted on the operation and,
   * when it owns a record, on the record's usage; a call past the budget is refused before it is sent.
   */
  private contextOf(active: Active, timeoutMs: number, usage?: Experiment['usage']): { ctx: CallContext; operation: Operation } {
    let exhausted = false;
    const { controller } = active;
    const operation: Operation = { callLimit: active.budget.calls, get spent() { return active.spent; }, get exhausted() { return exhausted; } };
    const ctx: CallContext = {
      signal: controller.signal, timeoutMs,
      // The check and the count are one synchronous step: calls made at once never pass the budget together.
      beforeCall: () => {
        controller.signal.throwIfAborted();
        if (active.spent >= active.budget.calls) { exhausted = true; throw new BudgetExhausted(); }
        active.spent++;
        if (usage) usage.calls++;
      },
      addUsage: delta => { if (usage) addUsage(usage, delta); },
    };
    return { ctx, operation };
  }

  /** Starts the clock of the active operation: when its time is up, its signal is aborted. */
  private timer(active: Active): () => void {
    const outOfTime = () => active.controller.abort(new Stopped('time'));
    if (active.budget.timeMs <= 0) { outOfTime(); return () => undefined; }
    const timer = setTimeout(outOfTime, active.budget.timeMs);
    return () => clearTimeout(timer);
  }

  /**
   * Starts `work` on `record` as the lab's one operation and returns once the record is saved as started; the work
   * goes on in the background, within `options.budget`. The record ends where the work's last checkpoint put it, or —
   * work cut short by a stop, the time, the budget or an error while the record was still running — where its phase's
   * stop rule puts it (phases.ts stopAt), with why in `error` and a stop's kind in `stop`.
   */
  async launch(record: Experiment, work: (ctx: CallContext, operation: Operation) => Promise<void>, options: LaunchOptions): Promise<void> {
    this.ensureIdle(options.ownsMutation);
    const active: Active = { id: record.id, record, controller: new AbortController(), done: Promise.resolve(), startedAtMs: performance.now(), budget: options.budget, spent: 0,
      ...(options.carried ? { carried: options.carried } : {}) };
    this.active = active; // Reserve before the first await, including the initial checkpoint.
    // A stop explains the operation that it cut short; this one starts without any.
    delete record.stop;
    const { controller } = active;
    const { ctx: calls, operation } = this.contextOf(active, record.settings.timeoutMs, record.usage);
    const ctx: CallContext = { ...calls,
      onTrace: (trialId, event) => this.store.appendTrace(record.id, trialId, event),
      // Every judgment report replaces the sidecar; only the finished one goes to the journal.
      onJudgment: (trialId, audit, final) => {
        this.store.writeJudgeAudit(record.id, trialId, audit);
        if (final) this.store.appendJudgment(record.id, trialId, audit);
      },
    };
    let saved = false;
    let ready!: () => void;
    let failed!: (error: unknown) => void;
    const initialCheckpoint = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    const stopClock = this.timer(active);
    const done = (async () => {
      try {
        await this.store.save(record); saved = true; ready();
        this.announce(record);
        controller.signal.throwIfAborted();
        await work(ctx, operation);
        // Only work still running is cut short: once its last checkpoint moved the record on, a late stop changes nothing.
        if (isRunning(record.phase)) {
          controller.signal.throwIfAborted();
          if (operation.exhausted) throw new BudgetExhausted();
        }
      } catch (error) {
        if (!saved) { failed(error); throw error; }
        this.cut(record, controller.signal, operation, error);
      } finally {
        stopClock(); this.account(record); record.updatedAt = new Date().toISOString();
        try { if (saved) { await this.store.save(record); this.announce(record); } }
        finally { if (this.active === active) this.active = null; }
      }
    })();
    active.done = done;
    this.lastTask = done;
    // Errors saving the final checkpoint remain observable through idle() and diagnostics.
    void done.catch(error => { process.stderr.write(`Agent Lab checkpoint failed: ${error instanceof Error ? error.message : String(error)}\n`); });
    await initialCheckpoint;
  }

  /**
   * Why work cut short ended, written on its record: the stop that cut it short while it was still running — its signal's
   * reason, or its budget's refusal however the work reported it — otherwise the error it failed with. A record its work
   * already moved on keeps its phase: only a running one takes its stop.
   */
  private cut(record: Experiment, signal: AbortSignal, operation: Operation, error: unknown): void {
    const running = isRunning(record.phase);
    const reason = running && signal.aborted ? signal.reason as unknown
      : running && operation.exhausted && !(error instanceof Stopped) ? new BudgetExhausted() : error;
    record.error = reason instanceof Error ? reason.message : String(reason);
    record.message = record.error;
    const stop = reason instanceof Stopped ? reason.reason : undefined;
    if (stop) record.stop = stop;
    if (running) stopAt(record, stop === 'cancelled' || stop === 'closing' ? 'cancelled' : 'failed');
  }

  /**
   * Runs `work` as the lab's one operation beside the record `id`, which it never saves or changes — a judge check
   * writes only its own sidecar. It has its own budget and time, stops at cancel(id) or when the lab closes, and resolves
   * with what the work returns once it ends. `ownsMutation`: the caller is the change that starts it.
   */
  async beside<T>(id: string, work: (ctx: CallContext, operation: Operation) => Promise<T>, options: { budget: Budget; timeoutMs: number; ownsMutation?: boolean }): Promise<T> {
    this.ensureIdle(options.ownsMutation);
    const active: Active = { id, controller: new AbortController(), done: Promise.resolve(), startedAtMs: performance.now(), budget: options.budget, spent: 0 };
    this.active = active;
    const { ctx, operation } = this.contextOf(active, options.timeoutMs);
    const stopClock = this.timer(active);
    const done = (async () => {
      try { return await work(ctx, operation); }
      finally { stopClock(); if (this.active === active) this.active = null; }
    })();
    active.done = done;
    this.lastTask = done.then(() => undefined, () => undefined);
    return done;
  }

  /** Saves a record at `phase` with its progress line; the followers of a running record hear of it. */
  async checkpoint(record: Experiment, phase: Phase, message: string): Promise<void> {
    this.account(record);
    moveTo(record, phase); record.message = message; record.updatedAt = new Date().toISOString();
    // ponytail: full JSON checkpoints keep one canonical record; split trial storage when runs exceed local-scale sizes.
    await this.store.save(record);
    this.announce(record);
  }

  /** Saves a step of a preparation — the draft with its library — as the store publishes it (card/prepare.ts). */
  async publishLibrary(record: Experiment, library: ScenarioLibrary, expectedHash?: string): Promise<void> {
    this.account(record);
    await this.store.publishLibrary(record, library, expectedHash);
    this.announce(record);
  }

  /** A progress line of the running record that is not saved on its own: the next checkpoint carries it. */
  say(record: Experiment, message: string): void {
    record.message = message;
    this.announce(record);
  }

  /** Stops the operation running `id`; what it recorded is kept. The running record as it is now, when the operation owns one. */
  cancel(id: string): Experiment | undefined {
    const active = this.active;
    if (active?.id !== id) throw new Error('Этот эксперимент сейчас не идёт.');
    active.controller.abort(new Stopped('cancelled'));
    if (!active.record) return undefined;
    // Work that already reached its last checkpoint is not stopped: its record keeps the line it ended with.
    if (isRunning(active.record.phase)) this.say(active.record, 'Останавливаю — записанное сохраняется.');
    return structuredClone(active.record);
  }

  private announce(record: Experiment): void {
    if (this.active?.record !== record) return;
    // A follower draws the work; one that fails must not stop it.
    for (const follower of this.followers) try { follower(record); } catch { /* the work goes on */ }
  }

  /**
   * A preparation keeps its accounts in its checkpoint over all its launches: the time it took, the calls it made and
   * the ceiling it may reach — what the owner agreed to, or raised it to on a resume.
   */
  private account(record: Experiment): void {
    const active = this.active;
    const progress = record.preparationProgress;
    if (active?.record !== record || !active.carried || !progress) return;
    progress.elapsedMs = active.carried.elapsedMs + Math.max(0, Math.round(performance.now() - active.startedAtMs));
    if (progress.protocol === 'chronological-scenarios-v1') return;
    progress.spentCalls = active.carried.calls + active.spent;
    progress.callCeiling = active.carried.calls + active.budget.calls;
  }
}
