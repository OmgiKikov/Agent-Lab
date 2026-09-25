import { fingerprint, type Experiment, type Trial } from './contracts.js';
import { headlineRule } from './card/expectations.js';
import { isRunning } from './phases.js';

/*
 * The judge's blind check — the owner's calibration of the judge: up to BLIND_SIZE expectations of a finished run, drawn
 * from every kind of the judge's decision (it passed them, failed them, could not decide) and shown to the owner WITHOUT
 * the judge's verdict. The owner says what they see: the agent did it, did not, it cannot be told from the conversation,
 * or the expectation itself is wrong. Then the two are compared: where they agree, the judge's false «справился» — the
 * dangerous kind, an error of the agent the number hides —, its false «не справился», and the expectations the owner
 * found wrong: the card's error, never the agent's.
 *
 *   finished run ──one attempt a situation, its expectations by the judge's recorded result──► strata: fail · pass · unknown
 *        ──in turn from each stratum, up to BLIND_SIZE, in an order a hash sets (a place never tells the verdict)──► queue
 *        ──the owner, one expectation at a time──► humanReviews (source 'blind'; the lab stamps the judge's verdict)
 *        ──► blindAgreement: agreed · false passes · false fails · the judge undecided · the owner unsure · wrong expectations
 *
 * A label decides its expectation in the count like any full review of the owner: the owner's word is what the judge is
 * measured against. Pure: no I/O and no model call.
 */

/** Expectations one blind check draws: about twenty, the size a person labels in one sitting. */
export const BLIND_SIZE = 20;

export interface BlindItem { trialId: string; scenarioId: string; metricId: string; letter: string; text: string; judge: 'pass' | 'fail' | 'unknown' }

/** The judged expectations of one attempt of a card counted by its expectations, with the judge's recorded result of each. */
function judgedItems(record: Experiment, trial: Trial): BlindItem[] {
  const scenario = record.scenarios.find(item => item.id === trial.scenarioId);
  const rule = headlineRule(scenario, [trial]);
  if (rule.kind !== 'expectations' || !trial.assessments?.length) return [];
  return rule.expectations.flatMap(expectation => {
    const judge = trial.assessments?.find(item => item.metricId === expectation.id)?.result;
    return judge ? [{ trialId: trial.id, scenarioId: trial.scenarioId, metricId: expectation.id, letter: expectation.letter, text: expectation.text, judge }] : [];
  });
}

/**
 * What a blind check of a finished run shows, in order: its first judged attempt of every counted situation, the
 * expectations drawn in turn from the judge's failures, passes and undecided ones, BLIND_SIZE at most. Stable for a run:
 * the owner's labels never change what is drawn, only what is left (blindQueue).
 */
export function blindSample(record: Experiment): BlindItem[] {
  if (record.workflow !== 'evaluate' || isRunning(record.phase) || !['results_review', 'complete'].includes(record.phase)) return [];
  const controls = new Set(record.positiveControlScenarioIds ?? []);
  const order = (item: BlindItem) => fingerprint({ run: record.id, trialId: item.trialId, metricId: item.metricId });
  const items = record.scenarios.filter(scenario => !controls.has(scenario.id)).flatMap(scenario => {
    const attempt = record.trials.filter(trial => trial.scenarioId === scenario.id).sort((a, b) => a.repeat - b.repeat).find(trial => judgedItems(record, trial).length);
    return attempt ? judgedItems(record, attempt) : [];
  });
  const strata = (['fail', 'pass', 'unknown'] as const).map(judge => items.filter(item => item.judge === judge).sort((a, b) => order(a) < order(b) ? -1 : 1));
  const drawn: BlindItem[] = [];
  for (let round = 0; drawn.length < BLIND_SIZE && strata.some(stratum => stratum.length > round); round++) {
    for (const stratum of strata) if (stratum[round] && drawn.length < BLIND_SIZE) drawn.push(stratum[round]!);
  }
  return drawn.sort((a, b) => fingerprint({ shown: record.id, trialId: a.trialId, metricId: a.metricId }) < fingerprint({ shown: record.id, trialId: b.trialId, metricId: b.metricId }) ? -1 : 1);
}

/** The owner's current blind label of one expectation: on the judgment still recorded, never one a re-assessment replaced. */
function labelOf(record: Experiment, item: Pick<BlindItem, 'trialId' | 'metricId'>) {
  const trial = record.trials.find(entry => entry.id === item.trialId);
  const judged = trial?.judgeReceipt ?? trial?.judgeAudit;
  const label = [...record.humanReviews].reverse().find(review => review.trialId === item.trialId && review.metricId === item.metricId && review.source === 'blind');
  // The teaching judge leaves neither a receipt nor an audit: its label stands on the recorded verdict alone.
  if (!label || (label.judge?.protocolHash ?? null) !== (judged?.protocolHash ?? null) || (label.judge?.inputHash ?? null) !== (judged?.inputHash ?? null)) return undefined;
  return label;
}

/** The expectations of the blind check the owner has not labelled yet, in the order they are shown. */
export const blindQueue = (record: Experiment): BlindItem[] => blindSample(record).filter(item => !labelOf(record, item));

/** Where the owner and the judge differ on one expectation: what the judge said and what the owner saw. */
export interface BlindDiff { trialId: string; scenarioId: string; letter: string; text: string; judge: 'pass' | 'fail'; owner: 'pass' | 'fail' }

export interface BlindAgreement {
  /** Expectations drawn, and those the owner labelled. */
  drawn: number; labelled: number;
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

/** The blind check of a run, compared: undefined for a run nothing can be drawn from. */
export function blindAgreement(record: Experiment): BlindAgreement | undefined {
  const drawn = blindSample(record);
  if (!drawn.length) return undefined;
  const result: BlindAgreement = { drawn: drawn.length, labelled: 0, agreed: 0, falsePasses: [], falseFails: [], judgeUndecided: 0, ownerUnsure: 0, wrongExpectations: 0 };
  for (const item of drawn) {
    const label = labelOf(record, item);
    if (!label) continue;
    result.labelled++;
    const judge = label.judgeVerdict ?? item.judge;
    if (label.verdict === 'invalid') result.wrongExpectations++;
    else if (label.verdict === 'unknown') result.ownerUnsure++;
    else if (judge === 'unknown') result.judgeUndecided++;
    else if (judge === label.verdict) result.agreed++;
    else (judge === 'pass' ? result.falsePasses : result.falseFails).push({ trialId: item.trialId, scenarioId: item.scenarioId, letter: item.letter, text: item.text, judge, owner: label.verdict });
  }
  return result;
}
