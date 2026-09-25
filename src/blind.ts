import { fingerprint, type Experiment, type HumanReview, type Trial } from './contracts.js';
import { headlineRule, recordedExpectationResult } from './card/expectations.js';
import { isRunning } from './phases.js';
import { deriveRun } from './run.js';

/*
 * The judge's blind check — the owner's calibration of the judge: up to BLIND_SIZE expectations of a finished run, drawn
 * from every kind of the judge's decision (it passed them, failed them, could not decide) and shown to the owner WITHOUT
 * the judge's verdict, and without anything that gives it away: no situation, no letter — only the conversation and the
 * expectation's words, conversation after conversation in an order a hash sets. The owner says what they see: the agent
 * did it, did not, it cannot be told from the conversation, or the expectation itself is wrong. The labels stay apart
 * (Experiment.blindLabels) until the last one is given: until then nothing — neither the check nor the number — tells the
 * owner how their labels compare with the judge. Then they join the owner's verdicts and the two are compared: where they
 * agree, the judge's false «справился» — the dangerous kind, an error of the agent the number hides —, its false «не
 * справился», and the expectations the owner found wrong: the card's error, never the agent's.
 *
 *   finished run ──situations the number decides: their first usable attempt, each expectation by the judge's verdict as
 *        the number reads it (through its channel)──► strata: fail · pass · unknown ──in turn, up to BLIND_SIZE──► the draw
 *        ──conversations in an order a hash sets, the expectations of each in turn──► the queue («Разговор 3 из 12»)
 *        ──the owner, one expectation at a time──► blindLabels ──the last label──► humanReviews (source 'blind')
 *        ──► blindAgreement: agreed · false passes · false fails · the judge undecided · the owner unsure · wrong expectations
 *
 * The draw reads the judge's verdicts and the owner's other verdicts, never a blind label, so labelling never changes what
 * is drawn. Once the check is done, a label decides its expectation in the count like any full review of the owner
 * (outcomes.ts humanOverride): the owner's word is what the judge is measured against. Pure: no I/O and no model call.
 */

/** Expectations one blind check draws: about twenty, the size a person labels in one sitting. */
export const BLIND_SIZE = 20;

export interface BlindItem { trialId: string; scenarioId: string; metricId: string; letter: string; text: string; judge: 'pass' | 'fail' | 'unknown' }

/** The judged expectations of one attempt of a card counted by its expectations, each with the judge's verdict as the number reads it. */
function judgedItems(record: Experiment, trial: Trial): BlindItem[] {
  const scenario = record.scenarios.find(item => item.id === trial.scenarioId);
  const rule = headlineRule(scenario, [trial]);
  if (rule.kind !== 'expectations' || !trial.assessments?.length) return [];
  return rule.expectations.flatMap(expectation => {
    const judge = recordedExpectationResult(trial, expectation);
    return judge ? [{ trialId: trial.id, scenarioId: trial.scenarioId, metricId: expectation.id, letter: expectation.letter, text: expectation.text, judge }] : [];
  });
}

const byKey = (key: (item: BlindItem) => string) => (a: BlindItem, b: BlindItem): number => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;

/**
 * What a blind check of a finished run shows, in the order shown: of every situation the number decides, its first usable
 * attempt; its expectations drawn in turn from the judge's failures, passes and undecided ones, BLIND_SIZE at most; then
 * conversation by conversation in an order a hash of the run sets, the expectations of one conversation together, so a
 * place never tells the verdict. A situation the number leaves «не измерено» is not drawn: its verdict counts nowhere.
 * Stable for a run: the owner's labels never change what is drawn, only what is left (blindQueue).
 */
export function blindSample(record: Experiment): BlindItem[] {
  if (record.workflow !== 'evaluate' || isRunning(record.phase) || !['results_review', 'complete'].includes(record.phase)) return [];
  const run = deriveRun({ ...record, humanReviews: record.humanReviews.filter(review => review.source !== 'blind') });
  const items = run.situations.filter(situation => !situation.control && situation.outcome !== 'unknown').flatMap(situation => {
    const attempt = situation.attempts.filter(item => item.usable).map(item => item.trial).sort((a, b) => a.repeat - b.repeat)
      .find(trial => judgedItems(record, trial).length);
    return attempt ? judgedItems(record, attempt) : [];
  });
  const drawOrder = byKey(item => fingerprint({ run: record.id, trialId: item.trialId, metricId: item.metricId }));
  const strata = (['fail', 'pass', 'unknown'] as const).map(judge => items.filter(item => item.judge === judge).sort(drawOrder));
  const drawn: BlindItem[] = [];
  for (let round = 0; drawn.length < BLIND_SIZE && strata.some(stratum => stratum.length > round); round++) {
    for (const stratum of strata) if (stratum[round] && drawn.length < BLIND_SIZE) drawn.push(stratum[round]!);
  }
  const conversation = byKey(item => fingerprint({ shown: record.id, trialId: item.trialId }));
  const question = byKey(item => fingerprint({ shown: record.id, trialId: item.trialId, metricId: item.metricId }));
  return drawn.sort((a, b) => a.trialId === b.trialId ? question(a, b) : conversation(a, b));
}

/** Where one expectation stands in its check: its conversation among the check's, and its question among that conversation's. */
export function blindPlace(sample: readonly BlindItem[], item: Pick<BlindItem, 'trialId' | 'metricId'>): { conversation: number; conversations: number; question: number; questions: number } {
  const conversations = [...new Set(sample.map(entry => entry.trialId))];
  const own = sample.filter(entry => entry.trialId === item.trialId);
  return { conversation: conversations.indexOf(item.trialId) + 1, conversations: conversations.length, question: own.findIndex(entry => entry.metricId === item.metricId) + 1, questions: own.length };
}

/** Every blind label of a run in the order given: those that joined the owner's verdicts, then those of a check under way. */
const blindLabels = (record: Pick<Experiment, 'humanReviews' | 'blindLabels'>): HumanReview[] =>
  [...record.humanReviews, ...record.blindLabels ?? []].filter(review => review.source === 'blind');

/** The owner's current blind label of one expectation: on the judgment still recorded, never one a re-assessment replaced. */
function labelOf(record: Experiment, item: Pick<BlindItem, 'trialId' | 'metricId'>, labels = blindLabels(record)) {
  const trial = record.trials.find(entry => entry.id === item.trialId);
  const judged = trial?.judgeReceipt ?? trial?.judgeAudit;
  const label = [...labels].reverse().find(review => review.trialId === item.trialId && review.metricId === item.metricId);
  // The teaching judge leaves neither a receipt nor an audit: its label stands on the recorded verdict alone.
  if (!label || (label.judge?.protocolHash ?? null) !== (judged?.protocolHash ?? null) || (label.judge?.inputHash ?? null) !== (judged?.inputHash ?? null)) return undefined;
  return label;
}

/** The expectations of the blind check the owner has not labelled yet, in the order they are shown. */
export const blindQueue = (record: Experiment): BlindItem[] => {
  const labels = blindLabels(record);
  return blindSample(record).filter(item => !labelOf(record, item, labels));
};

/** Where the owner and the judge differ on one expectation: what the judge said and what the owner saw. */
export interface BlindDiff { trialId: string; scenarioId: string; letter: string; text: string; judge: 'pass' | 'fail'; owner: 'pass' | 'fail' }

export interface BlindAgreement {
  /** Expectations drawn, and those the owner labelled. */
  drawn: number; labelled: number;
  /** Every drawn expectation is labelled: only then is anything below compared, and the labels count in the number. */
  complete: boolean;
  /** The owner and the judge said the same: done, or not done. */
  agreed: number;
  /** The judge said «справился», the owner saw it not done: an error of the agent the number hides. */
  falsePasses: BlindDiff[];
  /** The judge said «не справился», the owner saw it done: an error the number invents. */
  falseFails: BlindDiff[];
  /** The judge could not decide, the owner could. */
  judgeUndecided: number;
  /** The owner could not tell from the conversation. */
  ownerUnsure: number;
  /** The owner found the expectation itself wrong: an error of the card, not of the agent. */
  wrongExpectations: number;
}

/**
 * The blind check of a run, compared once it is done: undefined for a run nothing can be drawn from. Before the last label
 * only how far it got is said — the owner would label the rest knowing how the judge compares.
 */
export function blindAgreement(record: Experiment): BlindAgreement | undefined {
  const drawn = blindSample(record);
  if (!drawn.length) return undefined;
  const labels = blindLabels(record);
  const labelled = drawn.map(item => ({ item, label: labelOf(record, item, labels) }));
  const result: BlindAgreement = { drawn: drawn.length, labelled: labelled.filter(entry => entry.label).length, complete: labelled.every(entry => entry.label),
    agreed: 0, falsePasses: [], falseFails: [], judgeUndecided: 0, ownerUnsure: 0, wrongExpectations: 0 };
  if (!result.complete) return result;
  for (const { item, label } of labelled) {
    // The judge's verdict as the number reads it (through its channel), never a raw vote the number does not count.
    const judge = item.judge;
    if (label!.verdict === 'invalid') result.wrongExpectations++;
    else if (label!.verdict === 'unknown') result.ownerUnsure++;
    else if (judge === 'unknown') result.judgeUndecided++;
    else if (judge === label!.verdict) result.agreed++;
    else (judge === 'pass' ? result.falsePasses : result.falseFails).push({ trialId: item.trialId, scenarioId: item.scenarioId, letter: item.letter, text: item.text, judge, owner: label!.verdict });
  }
  return result;
}
