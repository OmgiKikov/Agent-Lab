/*
 * The phases of a record and the moves of its normal course: the one table the lab checks every transition
 * against.
 *
 *   preparing ⇄ review            a draft is prepared; a check of changed situations prepares it again
 *   review → evaluating           the owner's confirmation starts the run; every dialogue is a checkpoint
 *   evaluating → results_review   the dialogues and their verdicts are in
 *   results_review ⇄ complete     a person's review completes it; a later verdict reopens it
 *   interrupted → preparing       a preparation continues from its saved place
 *
 * Work cut short leaves its record where stoppedPhase says, from whatever phase it was in — even while its last
 * checkpoint was being written. A restart marks every record left in a running phase interrupted. baseline,
 * improving and control belong to the retired compare workflow: their records still open, and one caught mid-run is
 * marked interrupted like any other.
 */

export const PHASES = ['preparing', 'review', 'evaluating', 'results_review', 'baseline', 'improving', 'control', 'complete', 'cancelled', 'error', 'interrupted'] as const;
export type Phase = typeof PHASES[number];

interface PhaseRule {
  /** A process owns the record and it still changes: never a result, never a draft to edit. */
  readonly running: boolean;
  /** Where the normal course may move the record from here. */
  readonly next: readonly Phase[];
}

export const PHASE_TABLE: { readonly [P in Phase]: PhaseRule } = {
  preparing: { running: true, next: ['review', 'interrupted'] },
  review: { running: false, next: ['review', 'preparing', 'evaluating'] },
  evaluating: { running: true, next: ['evaluating', 'results_review', 'interrupted'] },
  results_review: { running: false, next: ['results_review', 'complete'] },
  complete: { running: false, next: ['results_review'] },
  cancelled: { running: false, next: [] },
  error: { running: false, next: [] },
  interrupted: { running: false, next: ['preparing'] },
  baseline: { running: true, next: ['interrupted'] },
  improving: { running: true, next: ['interrupted'] },
  control: { running: true, next: ['interrupted'] },
};

export const isRunning = (phase: Phase): boolean => PHASE_TABLE[phase].running;

/** Moves a record along its normal course; a move the table does not hold is a defect of the lab, never a state to save. */
export function moveTo(record: { phase: Phase }, next: Phase): void {
  if (!PHASE_TABLE[record.phase].next.includes(next)) throw new Error(`Переход записи из фазы «${record.phase}» в «${next}» не предусмотрен — это ошибка Agent Lab.`);
  record.phase = next;
}

/**
 * Where work cut short leaves its record: a preparation that already saved a draft goes back to review with what it
 * made; a stop the owner or the closing application asked for is a cancel; anything else is an error.
 */
export function stoppedPhase(record: { phase: Phase; librarySnapshot?: unknown }, stop: 'cancelled' | 'failed'): Phase {
  return record.phase === 'preparing' && record.librarySnapshot ? 'review' : stop === 'cancelled' ? 'cancelled' : 'error';
}
