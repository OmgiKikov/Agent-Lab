import type { Experiment } from '../contracts.js';
import type { Runtime } from '../runtime.js';
import type { ExperimentStore } from '../store.js';
import type { OperationRunner } from './operation.js';

/** What every part of the lab works with: its one store, its one operation at a time, and how a record reaches the models. */
export interface Lab {
  readonly store: ExperimentStore;
  readonly operations: OperationRunner;
  /** A record as it is now: the running operation's live state as a copy, otherwise the stored file. */
  get(id: string): Promise<Experiment>;
  list(): Promise<Experiment[]>;
  /** The runtime a record's model calls go through, every builder call journaled with the record. */
  runtime(record: Experiment): Promise<Runtime>;
}
