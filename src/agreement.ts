import { fingerprint, type Experiment, type HumanReview, type Scenario, type Trial } from './contracts.js';
import { latestHumanReviews, observedRecord, primaryMetricId, runningPhases } from './outcomes.js';

/*
 * How often the owner agreed with the judge, counted on what the judge actually recorded.
 * Pure: no I/O, no escaping (each surface escapes at its own boundary). It imports only
 * contracts.js and outcomes.js — never experiment.ts, quality.ts, comparison.ts or
 * result-view.ts — so result-view.ts can use it without a cycle.
 *
 * The count never reads the human-overridden result: agreeing with a verdict must not be able to
 * change the verdict it is measured against, or agreement would always be 100%.
 *
 * Known limitation: the unit is one trial. Stored runs use `repeats = 1`, so one trial is one
 * situation. With repeats above 1 the same card would contribute several marks, and the word
 * «проверенных» would have to become «диалогов»; the approved UI wording fixes only «проверенных»,
 * so that case is out of scope here.
 */

/** Passed situations to double-check: all of them when there are at most this many, else this many drawn by run id. */
export const PASS_SAMPLE = 3;

export interface AgreementGroup { agreed: number; checked: number }
export interface AgreementMark {
  trialId: string; scenarioId: string; title: string;
  answer: 'agree' | 'disagree' | 'unsure';
  /** The judge verdict the mark refers to. */
  judge: 'pass' | 'fail';
  note: string;
  /** The judgment moved under the mark, so it no longer counts. */
  stale: boolean;
}
export interface JudgeAgreement {
  /** Current quick marks that answered «согласен» (agreed) out of «согласен» + «не согласен» (checked). */
  agreed: number; checked: number;
  failures: AgreementGroup; passes: AgreementGroup;
  unsure: number; stale: number;
  /** Non-control trials the judge failed, in record order; the review queue. */
  queueFailures: string[];
  /** Passed trials drawn for a double-check. */
  sampledPasses: string[];
  /** Decided marks that landed on a sampled pass. */
  sampleChecked: number;
  /** Queue entries (failures first, then sampled passes) still without a current mark. */
  unmarked: string[];
  marks: AgreementMark[];
  disagreements: { trialId: string; scenarioId: string; title: string; judge: 'pass' | 'fail'; human: 'pass' | 'fail'; note: string }[];
}

const EMPTY: JudgeAgreement = {
  agreed: 0, checked: 0, failures: { agreed: 0, checked: 0 }, passes: { agreed: 0, checked: 0 },
  unsure: 0, stale: 0, queueFailures: [], sampledPasses: [], sampleChecked: 0, unmarked: [], marks: [], disagreements: [],
};
const empty = (): JudgeAgreement => structuredClone(EMPTY);

/** The judge's own result for a metric. Never `agentMetricResult`: a human verdict must not move the baseline it is compared with. */
function recordedResult(trial: Trial, metricId: string | undefined): 'pass' | 'fail' | 'unknown' | undefined {
  return metricId ? trial.assessments?.find(a => a.metricId === metricId)?.result : undefined;
}

/** Non-control trials with a primary metric the judge decided, paired with that decision. */
function decided(record: Experiment): { trial: Trial; scenario: Scenario; metricId: string; base: 'pass' | 'fail' }[] {
  const controls = new Set(record.positiveControlScenarioIds ?? []);
  return record.trials.flatMap(trial => {
    const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
    if (!scenario || controls.has(scenario.id)) return [];
    const metricId = primaryMetricId(scenario, trial);
    const base = recordedResult(trial, metricId);
    if (!metricId || (base !== 'pass' && base !== 'fail')) return [];
    return [{ trial, scenario, metricId, base }];
  });
}

/**
 * Passed situations to double-check: every one when there are at most `PASS_SAMPLE`, else
 * `PASS_SAMPLE` chosen by a hash of the run id and the trial id. The draw depends only on the run
 * id, the trial ids and the recorded judge results, so it is identical after a reopen and after a
 * person flips a verdict; a repeat or a reassessment has a new id and gets a new draw.
 */
export function agreementSample(record: Experiment): string[] {
  if (runningPhases.has(record.phase)) return [];
  const observed = observedRecord(record);
  const passed = decided(observed).filter(item => item.base === 'pass').map(item => item.trial.id);
  if (passed.length <= PASS_SAMPLE) return passed;
  return passed.map(id => ({ id, key: fingerprint({ run: record.id, trial: id }) }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    .slice(0, PASS_SAMPLE).map(item => item.id);
}

/** How the stored verdict reads against the judgment the person saw. */
function answerOf(verdict: HumanReview['verdict'], judged: 'pass' | 'fail'): AgreementMark['answer'] | undefined {
  if (verdict === 'unknown') return 'unsure';
  if (verdict === 'pass' || verdict === 'fail') return verdict === judged ? 'agree' : 'disagree';
  return undefined;
}

/** The share of the judge's decisions the owner confirmed, split by failures and passes. */
export function judgeAgreement(input: Experiment): JudgeAgreement {
  if (input.workflow !== 'evaluate' || runningPhases.has(input.phase)) return empty();
  const record = observedRecord(input);
  const rows = decided(record);
  const latest = latestHumanReviews(record);
  const sampledPasses = agreementSample(input);
  const sampled = new Set(sampledPasses);
  const result = empty();
  result.queueFailures = rows.filter(row => row.base === 'fail').map(row => row.trial.id);
  result.sampledPasses = sampledPasses;
  const current = new Set<string>();
  for (const { trial, scenario, metricId, base } of rows) {
    const review = latest.get(`${trial.id}|metric:${metricId}`);
    if (review?.source !== 'quick') continue;
    const answer = answerOf(review.verdict, review.judgeVerdict === 'pass' || review.judgeVerdict === 'fail' ? review.judgeVerdict : base);
    if (!answer) continue;
    const stale = review.judgeVerdict !== base;
    result.marks.push({ trialId: trial.id, scenarioId: scenario.id, title: scenario.title, answer, judge: base, note: review.note, stale });
    if (stale) { result.stale++; continue; }
    current.add(trial.id);
    if (answer === 'unsure') { result.unsure++; continue; }
    const group = base === 'fail' ? result.failures : result.passes;
    group.checked++; result.checked++;
    if (answer === 'agree') { group.agreed++; result.agreed++; }
    if (sampled.has(trial.id)) result.sampleChecked++;
    if (answer === 'disagree') {
      result.disagreements.push({ trialId: trial.id, scenarioId: scenario.id, title: scenario.title,
        judge: base, human: base === 'fail' ? 'pass' : 'fail', note: review.note });
    }
  }
  result.unmarked = [...result.queueFailures, ...sampledPasses].filter(id => !current.has(id));
  // Disagreements are read as a list of situations, so they follow the card order of the record.
  const order = new Map(record.scenarios.map((scenario, i) => [scenario.id, i]));
  result.disagreements.sort((a, b) => (order.get(a.scenarioId) ?? 0) - (order.get(b.scenarioId) ?? 0));
  return result;
}
