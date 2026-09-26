import { randomUUID } from 'node:crypto';
import type { Experiment } from '../src/contracts.js';
import type { LogAnalysis } from '../src/discover/schema.js';
import { ExperimentLab } from '../src/experiment.js';

type OperationKind = 'run' | 'preparation' | 'assessment' | 'analysis';
/** What long work is followed by: a run's or a preparation's record, or a log analysis (a record of its own). */
export type Followed = Experiment | LogAnalysis;
/** Whether the followed record is a run's or a draft's, not a log analysis. */
export const isExperiment = (record: Followed): record is Experiment => 'phase' in record;
export interface LabLease { directory: string; lab: ExperimentLab; close(): Promise<void> }
export interface SessionOperation {
  operationId: string;
  kind: OperationKind;
  directory: string;
  id: string;
  lab: ExperimentLab;
  origin: 'board' | 'chat';
  quiet: boolean;
  done: Promise<void>;
}
/** How a Pi session shows long work: its row while it goes, its result when it ends. */
export interface Presentation {
  kind: OperationKind;
  id: string;
  origin: SessionOperation['origin'];
  /** Draws how far the work got, from its live record: at once, then at every change. */
  progress(record: Followed): void;
  complete(job: SessionOperation): Promise<void>;
  clear(): void;
  error(error: unknown): void;
}

/*
 * Pi replaces a session — /new, /resume, /fork, /reload — with a fresh copy of the extension in the same process. Long
 * work does not belong to the copy that started it: the process and the work go on. The session that ends parks its
 * work here with its row cleared; the next session takes it over at its start, draws its row and gets its result.
 *
 *   session A ──shutdown (replaced)──► parked: the lease, the job, its stage ──session_start of B──► B shows it
 *   the work ends while parked ──► its result waits for B (PARKED_MS at most; the records keep it either way)
 *
 * Quitting Pi still ends the work the session owns: what it recorded is kept, as at every stop.
 */

/** Where a job reports: the presentation of the session that holds it now, and how that session learns it has ended. */
interface Stage {
  presentation: Presentation | undefined;
  /** The holding session forgets the job and, when it held that lease, the lease. */
  release(job: SessionOperation, lease: LabLease): void;
  /** Resolves when a session holds the job, at once unless it is parked. */
  held: Promise<void>;
  /** Called by the session that takes a parked job over. */
  hold(): void;
  ended: boolean;
}
interface Parked { lease: LabLease; job: SessionOperation; stage: Stage }

/** Process-wide, because Pi loads a fresh copy of this module for the next session. */
const PARKED = Symbol.for('agent-lab.parked-work');
type Shelf = typeof globalThis & { [PARKED]?: Parked };
const shelf = globalThis as Shelf;
/** How long finished work waits for the next session before its result is left to the records alone. */
const PARKED_MS = 30_000;

/**
 * Draws the record `id` as it is now and again at every change of the work running it (lab/operation.ts), until the
 * returned stop is called. A change that arrives before the first read is newer than it, so that read is dropped.
 */
export function followRecord(lab: ExperimentLab, id: string, draw: (record: Experiment) => void): () => void {
  let changed = false, stopped = false;
  const unfollow = lab.follow(record => { if (record.id === id && !stopped) { changed = true; draw(record); } });
  void lab.get(id).then(record => { if (!changed && !stopped) draw(record); }, () => { /* the next change draws it */ });
  return () => { stopped = true; unfollow(); };
}

/** The same for a log analysis, which has a record and followers of its own (lab/discover.ts). */
export function followAnalysis(lab: ExperimentLab, id: string, draw: (analysis: LogAnalysis) => void): () => void {
  let changed = false, stopped = false;
  const unfollow = lab.followAnalysis(analysis => { if (analysis.id === id && !stopped) { changed = true; draw(analysis); } });
  void lab.getAnalysis(id).then(analysis => { if (!changed && !stopped) draw(analysis); }, () => { /* the next change draws it */ });
  return () => { stopped = true; unfollow(); };
}

/** Owns the session's writer lease and presentation, never experimental state or execution. */
export class SessionOperations {
  private lease?: LabLease;
  private job?: SessionOperation;
  private stage?: Stage;
  constructor(private readonly createLab = (directory: string) => new ExperimentLab(directory)) {}

  current(directory: string): SessionOperation | undefined { return this.job?.directory === directory ? this.job : undefined; }
  /**
   * Why no new work can start on `directory` in this session now, in the owner's words; undefined when the writer's
   * lease is free or held only by a check of that folder's changed situations, which new work cancels (acquire).
   */
  busy(directory: string): string | undefined {
    const active = this.job;
    if (!this.lease || active?.kind === 'assessment' && active.directory === directory) return undefined;
    return active?.kind === 'preparation'
      ? 'Сейчас идёт подготовка ситуаций. Готовые ситуации, разговоры и результаты можно смотреть; правки и новый запуск — после её завершения или остановки.'
      : active?.kind === 'run'
        ? 'Сейчас идёт прогон. Ситуации, разговоры и результаты можно смотреть; правки и новый запуск — после его завершения или остановки.'
      : active?.kind === 'analysis'
        ? 'Сейчас идёт разбор логов. Готовые результаты можно смотреть; новый запуск — после его завершения или остановки.'
        : 'Уже идёт другая работа Agent Lab. Готовые результаты можно смотреть; новый запуск — после её завершения.';
  }
  reader(directory: string): ExperimentLab { return this.lease?.directory === directory ? this.lease.lab : this.createLab(directory); }

  async acquire(directory: string, pendingAssessment: 'cancel' | 'wait' = 'cancel'): Promise<LabLease> {
    const check = this.current(directory);
    if (check?.kind === 'assessment') {
      if (pendingAssessment === 'cancel') { check.quiet = true; await check.lab.cancel(check.id).catch(() => {}); }
      await check.done;
    }
    const busy = this.busy(directory);
    if (busy) throw new Error(busy);
    const lab = this.createLab(directory);
    let closing: Promise<void> | undefined;
    const lease: LabLease = { directory, lab, close: () => closing ??= lab.close().finally(() => { if (this.lease === lease) this.lease = undefined; }) };
    this.lease = lease;
    return lease;
  }

  /** Register synchronously; all three operation kinds share completion, progress and release ownership. */
  present(owned: LabLease, presentation: Presentation): SessionOperation {
    if (this.lease !== owned || this.job) throw new Error('Операция не владеет сессией Agent Lab.');
    const job: SessionOperation = { operationId: randomUUID(), kind: presentation.kind, directory: owned.directory,
      id: presentation.id, lab: owned.lab, origin: presentation.origin, quiet: false, done: Promise.resolve() };
    const stage: Stage = { presentation, held: Promise.resolve(), hold() {}, ended: false,
      release: ended => { if (this.job === ended) { this.job = undefined; this.stage = undefined; } } };
    this.job = job; this.stage = stage;
    const draw = (record: Followed) => { if (!stage.ended) stage.presentation?.progress(record); };
    const unfollow = job.kind === 'analysis' ? followAnalysis(owned.lab, job.id, draw) : followRecord(owned.lab, job.id, draw);
    job.done = (async () => {
      try { await owned.lab.waitForIdle(); await stage.held; await stage.presentation?.complete(job); }
      catch (error) { stage.presentation?.error(error); }
      finally {
        stage.ended = true;
        unfollow();
        if (shelf[PARKED]?.job === job) delete shelf[PARKED];
        try { stage.presentation?.clear(); }
        finally { try { await owned.close(); } finally { stage.release(job, owned); } }
      }
    })();
    void job.done.catch(error => console.error(`Agent Lab: ${String(error)}`));
    return job;
  }

  async stop(job: SessionOperation): Promise<void> {
    if (this.job !== job) throw new Error('Эта операция уже завершена или принадлежит другой сессии.');
    job.quiet = true;
    // The executor may have finished between the displayed progress and this request.
    // cancel only fails when there is no active execution; still await presentation/release.
    await job.lab.cancel(job.id).catch(() => {});
    await job.done;
  }

  /**
   * The session ends. `replaced`: Pi goes on with another session in this process (/new, /resume, /fork, /reload), so
   * work that is going is parked for it, its row cleared while this session can still draw; otherwise — Pi quits — the
   * lease closes, which stops the work with what it recorded kept.
   */
  async shutdown(replaced = false): Promise<void> {
    const job = this.job, stage = this.stage, lease = this.lease;
    if (replaced && job && stage && lease && !stage.ended) {
      try { stage.presentation?.clear(); } finally { stage.presentation = undefined; }
      let hold!: () => void;
      stage.held = new Promise<void>(resolve => { hold = resolve; setTimeout(resolve, PARKED_MS).unref(); });
      stage.hold = () => hold();
      shelf[PARKED] = { lease, job, stage };
      this.job = undefined; this.stage = undefined; this.lease = undefined;
      return;
    }
    await this.lease?.close();
    await job?.done;
  }

  /**
   * Takes over work a replaced session of this process parked: this session holds its lease from now on, `show` draws
   * it and gets its result. Undefined when nothing is parked, or when this session already holds a lease of its own.
   */
  adopt(show: (job: SessionOperation, lease: LabLease) => Presentation): SessionOperation | undefined {
    const parked = shelf[PARKED];
    if (!parked || this.lease) return undefined;
    delete shelf[PARKED];
    const { job, lease, stage } = parked;
    this.lease = lease; this.job = job; this.stage = stage;
    stage.release = (ended, closed) => {
      if (this.job === ended) { this.job = undefined; this.stage = undefined; }
      if (this.lease === closed) this.lease = undefined;
    };
    const presentation = show(job, lease);
    stage.presentation = presentation;
    stage.hold();
    // The row is drawn at once from the live record; the work's next change redraws it.
    void (job.kind === 'analysis' ? job.lab.getAnalysis(job.id) : job.lab.get(job.id))
      .then((record: Followed) => { if (!stage.ended && stage.presentation === presentation) presentation.progress(record); }, () => { /* the next change draws it */ });
    return job;
  }
}
