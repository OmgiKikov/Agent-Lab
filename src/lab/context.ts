import type { Experiment } from '../contracts.js';
import type { Runtime } from '../runtime.js';
import type { ExperimentStore } from '../store.js';
import type { OperationRunner } from './operation.js';

/** What every part of the lab works with: its one store, its one operation at a time, and how a record reaches the models. */
export interface Lab {
  readonly store: ExperimentStore;
  readonly operations: OperationRunner;
  /**
   * A record as it is now: the running operation's live state as a copy, otherwise the stored file, otherwise a fresh
   * draft this lab only previews (`preview`).
   */
  get(id: string): Promise<Experiment>;
  /**
   * Keeps an unwritten fresh draft in this lab, for the owner to see before anything is written: `get` reads it, and the
   * first change of it — an owner command, its connection, its acceptance, its start — writes it. It is never listed,
   * and it is gone when the lab closes.
   */
  preview(record: Experiment): void;
  list(): Promise<Experiment[]>;
  /** The runtime a record's model calls go through, every builder call journaled with the record. */
  runtime(record: Experiment): Promise<Runtime>;
}
