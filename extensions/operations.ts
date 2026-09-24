import { randomUUID } from 'node:crypto';
import type { Experiment } from '../src/contracts.js';
import { ExperimentLab } from '../src/experiment.js';

type OperationKind = 'run' | 'preparation' | 'assessment';
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
interface Presentation {
  kind: OperationKind;
  id: string;
  origin: SessionOperation['origin'];
  /** Draws how far the work got, from its live record: at once, then at every change. */
  progress(record: Experiment): void;
  complete(job: SessionOperation): Promise<void>;
  clear(): void;
  error(error: unknown): void;
}

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

/** Owns the session's writer lease and presentation, never experimental state or execution. */
export class SessionOperations {
  private lease?: LabLease;
  private job?: SessionOperation;
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
    this.job = job;
    const unfollow = followRecord(owned.lab, job.id, record => { if (this.job === job) presentation.progress(record); });
    job.done = (async () => {
      try { await owned.lab.waitForIdle(); await presentation.complete(job); }
      catch (error) { presentation.error(error); }
      finally {
        unfollow();
        try { presentation.clear(); }
        finally { try { await owned.close(); } finally { if (this.job === job) this.job = undefined; } }
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

  async shutdown(): Promise<void> {
    const job = this.job;
    await this.lease?.close();
    await job?.done;
  }
}
