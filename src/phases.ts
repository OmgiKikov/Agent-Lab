/*
 * The phases of a record, the moves of its normal course, where work cut short leaves it and where a restart puts
 * it: the one table the lab checks every transition against.
 *
 *   preparing → review            a draft is prepared (create, or a resume of its preparation)
 *   review ⇄ checking             Lab checks the draft's situations or proposes values for one of them; the draft comes
 *                                 back to review with whatever the work saved, however it ended
 *   review → evaluating           the owner's confirmation starts the run; every dialogue is a checkpoint
 *   evaluating → results_review   the dialogues and their verdicts are in
 *   results_review ⇄ complete     a person's review completes it; a later verdict reopens it
 *   interrupted → preparing       a preparation continues from its saved place
 *   interrupted → review          a preparation that had nothing left to prepare goes back to its draft
 *
 * Work cut short leaves its record where the phase's stop rule says (stopAt) — only while the record is still in a
 * running phase: once the work's last checkpoint moved it on, a late stop changes nothing. A restart puts every record
 * left in a running phase where that phase's restart rule says (restartAt). baseline, improving and control belong to
 * the retired compare workflow: their records still open, and one caught mid-run is marked interrupted like any other.
 */

export const PHASES = ['preparing', 'review', 'checking', 'evaluating', 'results_review', 'baseline', 'improving', 'control', 'complete', 'cancelled', 'error', 'interrupted'] as const;
export type Phase = typeof PHASES[number];

/** How work was cut short: a stop the owner or the closing application asked for, or anything else (the time, the budget, a failure). */
export type Cut = 'cancelled' | 'failed';

interface PhaseRule {
  /** A process owns the record and it still changes: never a result, never a draft to edit. */
  readonly running: boolean;
  /** Where the normal course may move the record from here. */
  readonly next: readonly Phase[];
  /**
   * Where work cut short in this phase leaves the record, by how it was cut; `saved`: where it goes instead once the
   * work saved a draft of situations. Only running phases have one.
   */
  readonly stopped?: { readonly [C in Cut]: Phase } & { readonly saved?: Phase };
  /** Where a restart puts a record a process left in this phase. Only running phases have one. */
  readonly restart?: Phase;
}

const cut = { cancelled: 'cancelled', failed: 'error' } as const;

export const PHASE_TABLE: { readonly [P in Phase]: PhaseRule } = {
  preparing: { running: true, next: ['review', 'interrupted'], stopped: { ...cut, saved: 'review' }, restart: 'interrupted' },
  review: { running: false, next: ['review', 'preparing', 'checking', 'evaluating'] },
  // The draft was the owner's before the work began: whatever cuts a check short, the draft stays theirs to work on.
  checking: { running: true, next: ['review'], stopped: { cancelled: 'review', failed: 'review' }, restart: 'review' },
  evaluating: { running: true, next: ['evaluating', 'results_review', 'interrupted'], stopped: cut, restart: 'interrupted' },
  results_review: { running: false, next: ['results_review', 'complete'] },
  complete: { running: false, next: ['results_review'] },
  cancelled: { running: false, next: [] },
  error: { running: false, next: [] },
  interrupted: { running: false, next: ['preparing', 'review'] },
  baseline: { running: true, next: ['interrupted'], stopped: cut, restart: 'interrupted' },
  improving: { running: true, next: ['interrupted'], stopped: cut, restart: 'interrupted' },
  control: { running: true, next: ['interrupted'], stopped: cut, restart: 'interrupted' },
};

export const isRunning = (phase: Phase): boolean => PHASE_TABLE[phase].running;

const defect = (from: Phase, to: string): Error => new Error(`Переход записи из фазы «${from}» в «${to}» не предусмотрен — это ошибка Agent Lab.`);

/** Moves a record along its normal course; a move the table does not hold is a defect of the lab, never a state to save. */
export function moveTo(record: { phase: Phase }, next: Phase): void {
  if (!PHASE_TABLE[record.phase].next.includes(next)) throw defect(record.phase, next);
  record.phase = next;
}

/** Where work cut short in the record's phase would leave it; undefined for a phase no work runs in. */
export function stoppedPhase(record: { phase: Phase; librarySnapshot?: unknown }, how: Cut): Phase | undefined {
  const rule = PHASE_TABLE[record.phase].stopped;
  return rule && (rule.saved && record.librarySnapshot ? rule.saved : rule[how]);
}

/**
 * The one way work cut short moves its record: to where its phase's stop rule says. A record that is no longer in a
 * running phase — its work reached its last checkpoint — has no stop to take, and asking for one is a defect.
 */
export function stopAt(record: { phase: Phase; librarySnapshot?: unknown }, how: Cut): void {
  const next = stoppedPhase(record, how);
  if (!next) throw defect(record.phase, how === 'cancelled' ? 'остановлено' : 'прервано');
  record.phase = next;
}

/** Where a restart puts a record a process left in a running phase; a record in any other phase stays where it is. */
export function restartAt(record: { phase: Phase }): Phase {
  return PHASE_TABLE[record.phase].restart ?? record.phase;
}
