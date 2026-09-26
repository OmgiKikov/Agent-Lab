import { isCardExecution, type Experiment } from '../contracts.js';
import { compareRuns } from '../comparison.js';
import type { Verdict } from '../run.js';
import { carriesCriterion, controlsOf, linkedCriterion } from './verify.js';

/*
 * A run of situations made from a problem of a log analysis (VERIFY after DISCOVER): three facts kept apart, never one
 * «исправлено» read off a passing synthetic conversation — and each read off the one expectation that is the problem's
 * criterion (criterion.ts), never off the whole situation.
 *
 *   criterion  the draft's link carries the problem's criterion; each situation of a linked conversation is read by its
 *              expectation with that criterion's hash — a situation none of whose expectations has it states nothing,
 *              and a check where no situation has it states no fact at all
 *   found      the analysis saw the violation in the logged conversations (`fromAnalysis.broken`)
 *   reproduced that expectation fails again on this version in a situation made from a broken conversation — or it
 *              passes in all of them, or it could not be measured
 *   fixed      against the run it repeats: the problem reproduced there, it does not here, the two runs are comparable
 *              (same cards, judge and customer protocol — comparison.ts) — and nothing broke beside it: a control
 *              (a conversation where the same criterion held with evidence in the logs) whose expectation passed there
 *              and fails here stops the fix
 *
 * Pure: from the stored records and the per-expectation outcomes the result view already counted (run.ts parts).
 */

export interface CheckSituation { scenarioId: string; number: number; title: string; dialogueId: string; expectationId: string; outcome: Verdict }
export type Reproduced = 'yes' | 'no' | 'unknown';
export interface ProblemCheck {
  title: string; analysisId: string;
  /**
   * Why the check states no fact: its link carries no criterion (made before the criterion was shared), or no situation
   * of it has an expectation with the criterion's hash. Absent when it states them.
   */
  unbound?: 'no_criterion' | 'not_carried';
  criterionHash?: string;
  /** Conversations of the logs the problem was found in. */
  found: number;
  /** The agent's version this run tested; null when no reply named it and the draft declared none. */
  version: string | null;
  /** Situations of the broken conversations, each read by its expectation with the criterion. */
  broken: CheckSituation[];
  /** Situations of the controls — conversations where the same criterion held with evidence —, read the same way. */
  controls: CheckSituation[];
  /** Controls the analysis had, whatever the preparation made of them: none — nothing beside the problem is checked. */
  controlConversations: number;
  /** Situations of linked conversations none of whose expectations is the criterion: they state nothing. */
  uncarried: number;
  reproduced: Reproduced;
  /** Against the run this one repeats; absent for a first run. */
  before?: { runId: string; createdAt: string; version: string | null; reproduced: Reproduced; comparable: boolean;
    verdict: 'fixed' | 'not_fixed' | 'regressed' | 'unproven'; regressed: string[]; why?: 'not_reproduced_before' | 'incomparable' | 'unmeasured' };
}

/** The agent's version a run tested: the one its replies named, else the one its draft declared. */
export function testedVersionOf(record: Pick<Experiment, 'trials' | 'targetVersion'>): string | null {
  return record.trials.find(trial => trial.observation?.version)?.observation?.version ?? record.targetVersion ?? null;
}

/** A situation of a run as the result counted it: its verdict and each expectation's (run.ts CardPart). */
type Outcomes = readonly { scenarioId: string; number: number; title: string; outcome: Verdict; parts: readonly { id: string; outcome: Verdict }[] }[];

/**
 * The situations of a check made from its linked conversations, each read by its expectation with the criterion's hash
 * in the definition the run sealed (its compiled expectations and rules), split by whether the problem was found in its
 * conversation; `uncarried`: those none of whose expectations is the criterion.
 */
function situations(record: Experiment, outcomes: Outcomes, hash: string): { broken: CheckSituation[]; controls: CheckSituation[]; uncarried: number } | undefined {
  const link = record.fromAnalysis;
  const library = record.librarySnapshot;
  if (!link || library?.formatVersion !== 2) return undefined;
  const controls = new Set(controlsOf(link));
  let uncarried = 0;
  const made = outcomes.flatMap((item): CheckSituation[] => {
    const card = library.cards.find(entry => entry.id === item.scenarioId);
    const dialogueId = card?.origin.kind === 'dialogue' ? card.origin.dialogueId : undefined;
    if (!dialogueId || !link.broken.includes(dialogueId) && !controls.has(dialogueId)) return [];
    const execution = record.scenarios.find(scenario => scenario.id === item.scenarioId)?.execution;
    const view = execution && isCardExecution(execution) ? execution.evaluatorView : undefined;
    const expectation = view?.expectations.find(duty => carriesCriterion(duty, view.requirements, hash));
    if (!expectation) { uncarried++; return []; }
    const outcome = item.parts.find(part => part.id === expectation.id)?.outcome ?? 'unknown';
    return [{ scenarioId: item.scenarioId, number: item.number, title: item.title, dialogueId, expectationId: expectation.id, outcome }];
  });
  return { broken: made.filter(item => link.broken.includes(item.dialogueId)), controls: made.filter(item => controls.has(item.dialogueId)), uncarried };
}

/** Whether the problem came back: its expectation failed in a situation of a broken conversation; passed in all of them; or neither is known. */
function reproducedOf(broken: readonly CheckSituation[]): Reproduced {
  if (broken.some(item => item.outcome === 'fail')) return 'yes';
  return broken.length && broken.every(item => item.outcome === 'pass') ? 'no' : 'unknown';
}

/**
 * The three facts of a run of a check, when its draft was made from a problem of a log analysis; `before`: the run it
 * repeats with its outcomes, for «исправлено» and what broke. A check whose situations do not carry the criterion states
 * none of them (`unbound`).
 */
export function problemCheck(record: Experiment, outcomes: Outcomes, before?: { record: Experiment; outcomes: Outcomes }): ProblemCheck | undefined {
  const link = record.fromAnalysis;
  // No situation compiled yet: there is nothing to read, and nothing to refuse.
  if (!link || !outcomes.length) return undefined;
  const base ={ title: link.title, analysisId: link.analysisId, found: link.broken.length, version: testedVersionOf(record), broken: [], controls: [],
    controlConversations: controlsOf(link).length, uncarried: 0, reproduced: 'unknown' as const };
  const linked = linkedCriterion(link);
  if (!linked) return { ...base, unbound: 'no_criterion' };
  const split = situations(record, outcomes, linked.hash);
  if (!split) return undefined;
  if (!split.broken.length && !split.controls.length) return { ...base, criterionHash: linked.hash, uncarried: split.uncarried, unbound: 'not_carried' };
  const reproduced = reproducedOf(split.broken);
  const check: ProblemCheck = { ...base, criterionHash: linked.hash, ...split, reproduced };
  // The run it repeats must check the same criterion: another problem's check is no «before».
  const earlier = before && linkedCriterion(before.record.fromAnalysis)?.hash === linked.hash ? situations(before.record, before.outcomes, linked.hash) : undefined;
  if (!before || !earlier) return check;
  const comparison = compareRuns(before.record, record);
  const previously = reproducedOf(earlier.broken);
  // The criterion's expectation passed before and fails now: beside the problem (a control), or the problem's own.
  const regressed = [...split.controls, ...split.broken].filter(item => item.outcome === 'fail'
    && [...earlier.controls, ...earlier.broken].some(old => old.scenarioId === item.scenarioId && old.outcome === 'pass')).map(item => item.title);
  const verdict = regressed.length ? 'regressed' : !comparison.comparable ? 'unproven' : previously !== 'yes' ? 'unproven'
    : reproduced === 'no' ? 'fixed' : reproduced === 'yes' ? 'not_fixed' : 'unproven';
  const why = verdict !== 'unproven' ? undefined : !comparison.comparable ? 'incomparable' as const : previously !== 'yes' ? 'not_reproduced_before' as const : 'unmeasured' as const;
  return { ...check, before: { runId: before.record.id, createdAt: before.record.createdAt, version: testedVersionOf(before.record), reproduced: previously,
    comparable: comparison.comparable, verdict, regressed, ...(why ? { why } : {}) } };
}
