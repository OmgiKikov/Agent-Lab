import { addCaveat } from '../caveats.js';
import type { Experiment } from '../contracts.js';
import { moveTo, restartAt } from '../phases.js';

/*
 * A record whose process died while its work was running, as it stands from then on: where its phase's restart rule puts
 * it (phases.ts), why, and what its accounts can no longer vouch for. The next writer saves it so when it opens the
 * folder (experiment.ts); a reader that finds the record's writer gone shows it so without writing anything (store.ts).
 * Both say the same words, and both count the calls the work sent after its last checkpoint.
 */

/** The calls an operation on a record had sent, as its journal holds them (store.ts appendCall): the most of each count. */
export interface SentCalls {
  /** The record's usage.calls after the last call journaled. */
  calls: number;
  /** A preparation's spentCalls after it, over all its launches. */
  spent?: number;
}

/** Moves `record`, left running by a process that is gone, to where a restart puts it; `sent`: its calls journal. */
export function markInterrupted(record: Experiment, sent?: SentCalls): void {
  const next = restartAt(record);
  record.message = next === 'review' ? 'Предыдущий процесс остановился во время проверки ситуаций. Черновик сохранён; проверку можно повторить.'
    : 'Предыдущий процесс остановился. Собранные данные сохранены.';
  moveTo(record, next);
  record.usage.costUsd = null;
  addCaveat(record, { code: 'usage_incomplete' });
  record.error = record.message;
  // A call counts as spent when it is sent: the journal holds the calls sent after the last checkpoint too.
  if (sent) {
    record.usage.calls = Math.max(record.usage.calls, sent.calls);
    const progress = record.preparationProgress;
    if (sent.spent !== undefined && progress && progress.protocol !== 'chronological-scenarios-v1') progress.spentCalls = Math.max(progress.spentCalls ?? 0, sent.spent);
  }
}
