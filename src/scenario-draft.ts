import { isRunning, type Experiment } from './contracts.js';
import { libraryHash } from './scenario-library.js';

export const draftIsBusy = (record: DraftRecord): boolean => isRunning(record.phase);

export interface DraftRecord {
  id: string;
  phase: Experiment['phase'];
  updatedAt: string;
  reviewedAt: string | null;
  trials: readonly unknown[];
  librarySnapshot?: Experiment['librarySnapshot'];
}

type DraftChoice =
  | { action: 'busy' }
  | { action: 'edit' }
  | { action: 'use'; id: string; newer: boolean }
  | { action: 'copy'; sourceId: string; newer: boolean };

/**
 * One library has one editable head. A running record is left alone. A finished record is not edited in place:
 * an existing review draft of the head is used, otherwise the head is copied.
 */
export function chooseEditableDraft(input: {
  settled: DraftRecord;
  holders: DraftRecord[];
  headHash: string;
  busy: (record: DraftRecord) => boolean;
}): DraftChoice {
  const snapshot = input.settled.librarySnapshot;
  if (input.busy(input.settled)) return { action: 'busy' };
  if (!snapshot || (input.settled.phase === 'review' && libraryHash(snapshot) === input.headHash)) return { action: 'edit' };
  const holders = input.holders
    .filter(item => item.librarySnapshot?.id === snapshot.id && libraryHash(item.librarySnapshot) === input.headHash)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const newer = libraryHash(snapshot) !== input.headHash;
  const draft = holders.find(item => item.phase === 'review' && !item.trials.length);
  if (draft) return { action: 'use', id: draft.id, newer };
  const source = holders.find(item => !input.busy(item) && !!item.reviewedAt) ?? input.settled;
  return { action: 'copy', sourceId: source.id, newer };
}

type Recheck =
  | { action: 'not_needed' }
  | { action: 'skipped'; pendingJobs: number; remainingCalls: number }
  | { action: 'needs_budget'; pendingJobs: number; remainingCalls: number }
  | { action: 'run'; startHash: string; pendingJobs: number; remainingCalls: number };

/** Whether a change is rechecked now. The caller starts the job; this only decides. */
export function recheckDecision(input: {
  pendingJobs: number;
  remainingCalls: number;
  defer: boolean;
  askedHash?: string;
  libraryHash: string;
  needsFinalization?: boolean;
}): Recheck {
  const debt = { pendingJobs: input.pendingJobs, remainingCalls: input.remainingCalls };
  if (!input.pendingJobs && !input.needsFinalization) return { action: 'not_needed' };
  if (input.defer && !input.askedHash) return { action: 'skipped', ...debt };
  if (!input.askedHash && input.pendingJobs > input.remainingCalls) return { action: 'needs_budget', ...debt };
  return { action: 'run', startHash: input.askedHash ?? input.libraryHash, ...debt };
}
