import type { Experiment } from '../contracts.js';
import { compareRuns } from '../comparison.js';
import type { Verdict } from '../run.js';

/*
 * A run of situations made from a problem of a log analysis (VERIFY after DISCOVER): three facts kept apart, never one
 * «исправлено» read off a passing synthetic conversation.
 *
 *   found      the analysis saw the violation in the logged conversations (`fromAnalysis.broken`)
 *   reproduced this run's situations made from those conversations fail again on this version — or they pass, or they
 *              could not be measured
 *   fixed      against the run it repeats: the problem reproduced there, it does not here, the two runs are comparable
 *              (same cards, judge and customer protocol — comparison.ts) — and nothing broke beside it: a situation of
 *              the same topics without the violation that passed there and fails here stops the fix
 *
 * Pure: from the stored records and the per-situation outcomes the result view already decided.
 */

export interface CheckSituation { scenarioId: string; number: number; title: string; dialogueId: string; outcome: Verdict }
export type Reproduced = 'yes' | 'no' | 'unknown';
export interface ProblemCheck {
  title: string; analysisId: string;
  /** Conversations of the logs the problem was found in. */
  found: number;
  /** The agent's version this run tested; null when no reply named it and the draft declared none. */
  version: string | null;
  broken: CheckSituation[];
  /** Situations of the same topics made from conversations without the violation: what a fix must not break. */
  opposite: CheckSituation[];
  reproduced: Reproduced;
  /** Against the run this one repeats; absent for a first run. */
  before?: { runId: string; createdAt: string; version: string | null; reproduced: Reproduced; comparable: boolean;
    verdict: 'fixed' | 'not_fixed' | 'regressed' | 'unproven'; regressed: string[]; why?: 'not_reproduced_before' | 'incomparable' | 'unmeasured' };
}

/** The agent's version a run tested: the one its replies named, else the one its draft declared. */
export function testedVersionOf(record: Pick<Experiment, 'trials' | 'targetVersion'>): string | null {
  return record.trials.find(trial => trial.observation?.version)?.observation?.version ?? record.targetVersion ?? null;
}

type Outcomes = readonly { scenarioId: string; number: number; title: string; outcome: Verdict }[];

/** The situations of a check with the conversation each was made from, split by whether the problem was found in it. */
function situations(record: Experiment, outcomes: Outcomes): { broken: CheckSituation[]; opposite: CheckSituation[] } | undefined {
  const link = record.fromAnalysis;
  const library = record.librarySnapshot;
  if (!link || library?.formatVersion !== 2) return undefined;
  const made = outcomes.flatMap((item): CheckSituation[] => {
    const card = library.cards.find(entry => entry.id === item.scenarioId);
    const dialogueId = card?.origin.kind === 'dialogue' ? card.origin.dialogueId : undefined;
    return dialogueId && link.dialogueIds.includes(dialogueId) ? [{ scenarioId: item.scenarioId, number: item.number, title: item.title, dialogueId, outcome: item.outcome }] : [];
  });
  return { broken: made.filter(item => link.broken.includes(item.dialogueId)), opposite: made.filter(item => !link.broken.includes(item.dialogueId)) };
}

/** Whether the problem came back: any situation made from a conversation it was found in failed; all of them passed; or neither is known. */
function reproducedOf(broken: readonly CheckSituation[]): Reproduced {
  if (broken.some(item => item.outcome === 'fail')) return 'yes';
  return broken.length && broken.every(item => item.outcome === 'pass') ? 'no' : 'unknown';
}

/**
 * The three facts of a run of a check, when its draft was made from a problem of a log analysis; `before`: the run it
 * repeats with its outcomes, for «исправлено» and what broke.
 */
export function problemCheck(record: Experiment, outcomes: Outcomes, before?: { record: Experiment; outcomes: Outcomes }): ProblemCheck | undefined {
  const link = record.fromAnalysis;
  const split = situations(record, outcomes);
  if (!link || !split) return undefined;
  const reproduced = reproducedOf(split.broken);
  const check: ProblemCheck = { title: link.title, analysisId: link.analysisId, found: link.broken.length, version: testedVersionOf(record), ...split, reproduced };
  const earlier = before && situations(before.record, before.outcomes);
  if (!before || !earlier) return check;
  const comparison = compareRuns(before.record, record);
  const previously = reproducedOf(earlier.broken);
  // A situation of the check that passed before and fails now broke: beside the problem, or the problem's own.
  const regressed = [...split.opposite, ...split.broken].filter(item => item.outcome === 'fail'
    && [...earlier.opposite, ...earlier.broken].some(old => old.scenarioId === item.scenarioId && old.outcome === 'pass')).map(item => item.title);
  const verdict = regressed.length ? 'regressed' : !comparison.comparable ? 'unproven' : previously !== 'yes' ? 'unproven'
    : reproduced === 'no' ? 'fixed' : reproduced === 'yes' ? 'not_fixed' : 'unproven';
  const why = verdict !== 'unproven' ? undefined : !comparison.comparable ? 'incomparable' as const : previously !== 'yes' ? 'not_reproduced_before' as const : 'unmeasured' as const;
  return { ...check, before: { runId: before.record.id, createdAt: before.record.createdAt, version: testedVersionOf(before.record), reproduced: previously,
    comparable: comparison.comparable, verdict, regressed, ...(why ? { why } : {}) } };
}
