import { isCardExecution, type Experiment } from '../contracts.js';
import { compareRuns } from '../comparison.js';
import { expectationCriterionHash } from '../criterion.js';
import type { Verdict } from '../run.js';
import { carriesCriterion, controlsOf, criterionConversations, linkedCriterion } from './verify.js';

/*
 * A run of situations made from a problem of a log analysis (VERIFY after DISCOVER): two answers kept apart, never one
 * «исправлено» read off a passing synthetic conversation.
 *
 *   the problem   read off the one expectation that is the problem's criterion (criterion.ts) in the situations of the
 *                 conversations chosen for it — never off the whole situation:
 *     found       the analysis saw the violation in the logged conversations (`fromAnalysis.broken`)
 *     reproduced  that expectation fails again on this version in a situation of a broken conversation — or it passes in
 *                 all of them, or it could not be measured; chosen conversations the run checks nothing on are counted
 *     fixed       against the run it repeats: the problem reproduced there, it does not here in every chosen case, the two
 *                 runs compare (same cards, judge and customer — comparison.ts), the agent's replies changed (the same
 *                 replies judged otherwise are the judge's difference, comparison.ts judgeOnly), and no control — a
 *                 conversation where the same criterion held with evidence in the logs — broke
 *   the rest      every other expectation of the run's counted situations — the other duties of the chosen ones, the
 *                 neighbours' (conversations where another rule held) —, against the run it repeats: an expectation that
 *                 passed there is a regression test here; one that failed or was not measured there is none. A local fix
 *                 never hides what broke beside it, and an unmeasured test never reads as «ничего не сломалось».
 *
 * Incomparable runs state neither a proven fix nor a proven regression. Pure: from the stored records and the
 * per-expectation outcomes the result view already counted (run.ts parts).
 */

export interface CheckSituation { scenarioId: string; number: number; title: string; dialogueId: string; expectationId: string; outcome: Verdict }
export type Reproduced = 'yes' | 'no' | 'unknown';

/** One expectation of the rest of a check: its situation, its words, and how it came out here. */
export interface RestExpectation { scenarioId: string; number: number; title: string; expectationId: string; text: string; outcome: Verdict }

/** The rest of the mandatory set: every expectation of the run's counted situations but the problem's own. */
export interface RestCheck {
  total: number; passed: number; failed: number; unknown: number;
  /** Expectations with the problem's own criterion on conversations not chosen for it: no control of the problem, and left out. */
  sameCriterion: number;
  /** Against the run this one repeats; absent for a first run. */
  against?: {
    comparable: boolean;
    /** Expectations that passed there — confirmed on that run —: the regression tests of this one. */
    tests: number;
    held: RestExpectation[];
    /** Tests that passed there and fail here, the agent answering otherwise: a regression of another rule. */
    broken: RestExpectation[];
    /** Tests not measured here: that they still hold is not confirmed. */
    unknown: RestExpectation[];
    /** Tests that flipped with the agent's replies the same: the judge's difference, neither a regression nor a fix. */
    judgeOnly: RestExpectation[];
    /** Expectations that failed or were not measured there: no regression test. */
    unconfirmed: number;
    /** Expectations whose definition changed between the runs, or that one of them lacks. */
    changed: number;
  };
}

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
  /** Situations of the problem's conversations none of whose expectations is the criterion: they state nothing. */
  uncarried: number;
  /** Conversations with the problem the run checks nothing on: no situation of them (`missing`), or none carrying the criterion (`changed`). */
  unchecked: { missing: number; changed: number };
  reproduced: Reproduced;
  /** Against the run this one repeats; absent for a first run. */
  before?: { runId: string; createdAt: string; version: string | null; reproduced: Reproduced; comparable: boolean;
    verdict: 'fixed' | 'not_fixed' | 'regressed' | 'unproven'; regressed: string[];
    why?: 'not_reproduced_before' | 'incomparable' | 'unmeasured' | 'judge_only' | 'partial';
    /** Situations of the problem whose change is the judge's alone: the agent answered the same in both runs. */
    judgeOnly: string[];
    /** Controls whose criterion was not measured here: that nothing broke beside the problem is not confirmed. */
    besideUnknown: string[] };
  /** The rest of the mandatory set, apart from the problem. */
  rest: RestCheck;
}

/** The agent's version a run tested: the one its replies named, else the one its draft declared. */
export function testedVersionOf(record: Pick<Experiment, 'trials' | 'targetVersion'>): string | null {
  return record.trials.find(trial => trial.observation?.version)?.observation?.version ?? record.targetVersion ?? null;
}

/** A situation of a run as the result counted it: its verdict and each expectation's (run.ts CardPart); a positive control is none of the check's. */
type Outcomes = readonly { scenarioId: string; number: number; title: string; outcome: Verdict; control?: boolean; parts: readonly { id: string; outcome: Verdict }[] }[];

/** The logged conversation a situation of a card library was made from, and its compiled definition. */
function definitionOf(record: Experiment, scenarioId: string) {
  const library = record.librarySnapshot;
  const card = library?.formatVersion === 2 ? library.cards.find(entry => entry.id === scenarioId) : undefined;
  const execution = record.scenarios.find(scenario => scenario.id === scenarioId)?.execution;
  const view = execution && isCardExecution(execution) ? execution.evaluatorView : undefined;
  return { dialogueId: card?.origin.kind === 'dialogue' ? card.origin.dialogueId : undefined, view };
}

/**
 * The situations of a check made from the conversations chosen for the problem, each read by its expectation with the
 * criterion's hash in the definition the run sealed, split by whether the problem was found in its conversation; what
 * of the chosen the run checks nothing on.
 */
function situations(record: Experiment, outcomes: Outcomes, hash: string) {
  const link = record.fromAnalysis!;
  const chosen = new Set(criterionConversations(link));
  const controls = new Set(controlsOf(link));
  const seen = new Set<string>();
  const uncarriedOf = new Set<string>();
  let uncarried = 0;
  const made = outcomes.flatMap((item): CheckSituation[] => {
    if (item.control) return [];
    const { dialogueId, view } = definitionOf(record, item.scenarioId);
    if (!dialogueId || !chosen.has(dialogueId)) return [];
    seen.add(dialogueId);
    const expectation = view?.expectations.find(duty => carriesCriterion(duty, view.requirements, hash));
    if (!expectation) { uncarried++; uncarriedOf.add(dialogueId); return []; }
    const outcome = item.parts.find(part => part.id === expectation.id)?.outcome ?? 'unknown';
    return [{ scenarioId: item.scenarioId, number: item.number, title: item.title, dialogueId, expectationId: expectation.id, outcome }];
  });
  const carried = new Set(made.map(item => item.dialogueId));
  return { broken: made.filter(item => link.broken.includes(item.dialogueId)), controls: made.filter(item => controls.has(item.dialogueId)), uncarried,
    unchecked: { missing: link.broken.filter(id => !seen.has(id)).length, changed: link.broken.filter(id => uncarriedOf.has(id) && !carried.has(id)).length } };
}

/** Whether the problem came back: its expectation failed in a situation of a broken conversation; passed in all of them; or neither is known. */
function reproducedOf(broken: readonly CheckSituation[]): Reproduced {
  if (broken.some(item => item.outcome === 'fail')) return 'yes';
  return broken.length && broken.every(item => item.outcome === 'pass') ? 'no' : 'unknown';
}

/** Every expectation of the run's counted situations but the problem's own: the rest of the mandatory set, by situation. */
function restOf(record: Experiment, outcomes: Outcomes, hash: string): { items: (RestExpectation & { identity: string | undefined; appliesWhen: string | undefined })[]; sameCriterion: number } {
  const chosen = new Set(criterionConversations(record.fromAnalysis!));
  let sameCriterion = 0;
  const items = outcomes.flatMap(item => {
    if (item.control) return [];
    const { dialogueId, view } = definitionOf(record, item.scenarioId);
    if (!view) return [];
    return view.expectations.flatMap(duty => {
      if (carriesCriterion(duty, view.requirements, hash)) {
        // The problem's own criterion: on a chosen conversation it is the problem's answer; elsewhere it is no control of it.
        if (!dialogueId || !chosen.has(dialogueId)) sameCriterion++;
        return [];
      }
      return [{ scenarioId: item.scenarioId, number: item.number, title: item.title, expectationId: duty.id, text: duty.text,
        outcome: item.parts.find(part => part.id === duty.id)?.outcome ?? 'unknown', identity: expectationCriterionHash(duty, view.requirements), appliesWhen: duty.appliesWhen }];
    });
  });
  return { items, sameCriterion };
}

const plain = ({ scenarioId, number, title, expectationId, text, outcome }: RestExpectation): RestExpectation => ({ scenarioId, number, title, expectationId, text, outcome });

/** The rest of a check, and against the run it repeats: which of its expectations are regression tests, and what became of them. */
function restCheck(record: Experiment, outcomes: Outcomes, hash: string, earlier?: { record: Experiment; outcomes: Outcomes }, comparison?: ReturnType<typeof compareRuns>): RestCheck {
  const { items, sameCriterion } = restOf(record, outcomes, hash);
  const rest: RestCheck = { total: items.length, passed: items.filter(item => item.outcome === 'pass').length, failed: items.filter(item => item.outcome === 'fail').length,
    unknown: items.filter(item => item.outcome === 'unknown').length, sameCriterion };
  if (!earlier || !comparison) return rest;
  const previous = restOf(earlier.record, earlier.outcomes, hash).items;
  const judged = new Set(comparison.pairs.filter(pair => pair.judgeOnly).map(pair => pair.scenarioId));
  const against: NonNullable<RestCheck['against']> = { comparable: comparison.comparable, tests: 0, held: [], broken: [], unknown: [], judgeOnly: [], unconfirmed: 0, changed: 0 };
  // Runs that do not compare prove neither a regression nor that none happened: nothing is read off them.
  if (!comparison.comparable) return { ...rest, against };
  for (const item of items) {
    const old = previous.find(entry => entry.scenarioId === item.scenarioId && entry.expectationId === item.expectationId);
    if (!old || !old.identity || old.identity !== item.identity || old.appliesWhen !== item.appliesWhen) { against.changed++; continue; }
    if (old.outcome !== 'pass') { against.unconfirmed++; continue; }
    against.tests++;
    if (item.outcome === 'pass') against.held.push(plain(item));
    else if (item.outcome === 'unknown') against.unknown.push(plain(item));
    else if (judged.has(item.scenarioId)) against.judgeOnly.push(plain(item));
    else against.broken.push(plain(item));
  }
  return { ...rest, against };
}

/**
 * The two answers of a run of a check, when its draft was made from a problem of a log analysis; `before`: the run it
 * repeats with its outcomes, for «исправлено» and what broke. A check whose situations do not carry the criterion states
 * none of the problem's facts (`unbound`).
 */
export function problemCheck(record: Experiment, outcomes: Outcomes, before?: { record: Experiment; outcomes: Outcomes }): ProblemCheck | undefined {
  const link = record.fromAnalysis;
  // No situation compiled yet: there is nothing to read, and nothing to refuse.
  if (!link || !outcomes.length) return undefined;
  const base = { title: link.title, analysisId: link.analysisId, found: link.broken.length, version: testedVersionOf(record), broken: [], controls: [],
    controlConversations: controlsOf(link).length, uncarried: 0, unchecked: { missing: 0, changed: 0 }, reproduced: 'unknown' as const,
    rest: { total: 0, passed: 0, failed: 0, unknown: 0, sameCriterion: 0 } };
  const linked = linkedCriterion(link);
  if (!linked) return { ...base, unbound: 'no_criterion' };
  if (record.librarySnapshot?.formatVersion !== 2) return undefined;
  const split = situations(record, outcomes, linked.hash);
  // The run it repeats must check the same criterion: another problem's check is no «before».
  const earlier = before && linkedCriterion(before.record.fromAnalysis)?.hash === linked.hash && before.record.librarySnapshot?.formatVersion === 2 ? before : undefined;
  const comparison = earlier && compareRuns(earlier.record, record);
  const rest = restCheck(record, outcomes, linked.hash, earlier, comparison);
  if (!split.broken.length && !split.controls.length) return { ...base, criterionHash: linked.hash, uncarried: split.uncarried, unchecked: split.unchecked, unbound: 'not_carried', rest };
  const reproduced = reproducedOf(split.broken);
  const check: ProblemCheck = { ...base, criterionHash: linked.hash, ...split, reproduced, rest };
  if (!earlier || !comparison) return check;
  const old = situations(earlier.record, earlier.outcomes, linked.hash);
  const previously = reproducedOf(old.broken);
  const judged = new Set(comparison.pairs.filter(pair => pair.judgeOnly).map(pair => pair.scenarioId));
  const wasPass = (item: CheckSituation) => [...old.controls, ...old.broken].some(entry => entry.scenarioId === item.scenarioId && entry.outcome === 'pass');
  const wasFail = (item: CheckSituation) => old.broken.some(entry => entry.scenarioId === item.scenarioId && entry.outcome === 'fail');
  // The criterion's expectation passed before and fails now — beside the problem (a control), or the problem's own —,
  // with the agent answering otherwise: proven only when the runs compare.
  const regressed = comparison.comparable ? [...split.controls, ...split.broken].filter(item => item.outcome === 'fail' && wasPass(item) && !judged.has(item.scenarioId)).map(item => item.title) : [];
  const judgeOnly = [...split.broken, ...split.controls].filter(item => judged.has(item.scenarioId) && (wasFail(item) || wasPass(item)) && item.outcome !== 'unknown').map(item => item.title);
  const besideUnknown = split.controls.filter(item => item.outcome === 'unknown').map(item => item.title);
  const partial = split.unchecked.missing + split.unchecked.changed > 0;
  const verdict = !comparison.comparable ? 'unproven' : regressed.length ? 'regressed' : previously !== 'yes' ? 'unproven'
    : reproduced === 'yes' ? 'not_fixed' : reproduced !== 'no' ? 'unproven' : split.broken.some(item => judged.has(item.scenarioId)) || partial ? 'unproven' : 'fixed';
  const why = verdict !== 'unproven' ? undefined : !comparison.comparable ? 'incomparable' as const : previously !== 'yes' ? 'not_reproduced_before' as const
    : reproduced !== 'no' ? 'unmeasured' as const : split.broken.some(item => judged.has(item.scenarioId)) ? 'judge_only' as const : 'partial' as const;
  return { ...check, before: { runId: earlier.record.id, createdAt: earlier.record.createdAt, version: testedVersionOf(earlier.record), reproduced: previously,
    comparable: comparison.comparable, verdict, regressed, ...(why ? { why } : {}), judgeOnly, besideUnknown } };
}
