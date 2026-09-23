import { fingerprint, type Experiment, type HumanReview, type Scenario, type Trial } from './contracts.js';
import { isRunning } from './contracts.js';
import { headlineTrialResult, latestHumanReviews, markTargets, markUnderCurrentRule, measurementUsable, observedRecord, recordedResult } from './outcomes.js';

/*
 * How often the owner agreed with the judge, counted on what the judge actually recorded.
 * Pure: no I/O, no escaping (each surface escapes at its own boundary). It imports only
 * contracts.js and outcomes.js — never experiment.ts, quality.ts, comparison.ts or
 * result-view.ts — so result-view.ts can use it without a cycle.
 *
 * The count never reads the human-overridden result: agreeing with a verdict must not be able to
 * change the verdict it is measured against, or agreement would always be 100%.
 *
 * The unit is one situation decided by the headline rule (outcomes.ts markTargets): a situation
 * is checked only when every metric that decided it carries a current quick mark, and its marks
 * combine into one answer — disagree over unsure over agree. One mark on a double failure leaves
 * the situation unmarked and uncounted.
 *
 * Known limitation: the unit is one trial. Stored runs use `repeats = 1`, so one trial is one
 * situation. With repeats above 1 the same card would contribute several marks, and the word
 * «проверенных» would have to become «диалогов»; the approved UI wording fixes only «проверенных»,
 * so that case is out of scope here.
 */

/** Passed situations to double-check: all of them when there are at most this many, else this many drawn by run id. */
export const PASS_SAMPLE = 3;

interface AgreementGroup { agreed: number; checked: number }
interface AgreementMark {
  trialId: string; scenarioId: string; title: string;
  answer: 'agree' | 'disagree' | 'unsure';
  /** The judge verdict of the situation the marks refer to. */
  judge: 'pass' | 'fail';
  note: string;
  /** The judgment moved under the mark, so it no longer counts. */
  stale: boolean;
  /** The marks were given under the previous counting rule, so they answer a question the count no longer asks. */
  staleRule?: true;
  /** One answer per metric that decided the situation, in headline order. */
  targets: { metricId: string; answer: 'agree' | 'disagree' | 'unsure' }[];
}
export interface JudgeAgreement {
  /** Current quick marks that answered «согласен» (agreed) out of «согласен» + «не согласен» (checked). */
  agreed: number; checked: number;
  failures: AgreementGroup; passes: AgreementGroup;
  unsure: number; stale: number;
  /** Situations whose marks were given under the previous counting rule; never in N or M. */
  staleRule: number;
  /** Usable non-control situations the judge failed by the headline rule, in record order; the review queue. */
  queueFailures: string[];
  /** Passed trials drawn for a double-check. */
  sampledPasses: string[];
  /** Decided marks that landed on a sampled pass. */
  sampleChecked: number;
  /** Queue entries (failures first, then sampled passes) still without a current mark on every target. */
  unmarked: string[];
  marks: AgreementMark[];
  disagreements: {
    trialId: string; scenarioId: string; title: string; judge: 'pass' | 'fail'; human: 'pass' | 'fail'; note: string;
    /** Present only when the owner overturned some but not all of the situation's two metrics. */
    overturned?: string[];
  }[];
}

const EMPTY: JudgeAgreement = {
  agreed: 0, checked: 0, failures: { agreed: 0, checked: 0 }, passes: { agreed: 0, checked: 0 },
  unsure: 0, stale: 0, staleRule: 0, queueFailures: [], sampledPasses: [], sampleChecked: 0, unmarked: [], marks: [], disagreements: [],
};
const empty = (): JudgeAgreement => structuredClone(EMPTY);

interface Situation { trial: Trial; scenario: Scenario; metricIds: string[]; base: 'pass' | 'fail' }

/**
 * Usable non-control situations the judge decided by the headline rule, in record order; `base`
 * is the recorded verdict and `metricIds` the metrics a mark answers. A situation the headline
 * shows as «не измерено» is not a situation here either (CR-01): the queue, the sample and the
 * count hold exactly what the number counts.
 */
function situations(record: Experiment): Situation[] {
  const controls = new Set(record.positiveControlScenarioIds ?? []);
  return record.trials.flatMap(trial => {
    const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
    if (!scenario || controls.has(scenario.id) || !measurementUsable(scenario, trial, record.humanReviews)) return [];
    const targets = markTargets(scenario, trial);
    if (!targets) return [];
    return [{ trial, scenario, metricIds: targets.metricIds, base: targets.verdict }];
  });
}

/**
 * Passed situations to double-check: every one when there are at most `PASS_SAMPLE`, else
 * `PASS_SAMPLE` chosen by a hash of the run id and the trial id. The draw depends only on the run
 * id, the trial ids and the recorded judge results, so it is identical after a reopen and after a
 * person flips a verdict; a repeat or a reassessment has a new id and gets a new draw.
 */
export function agreementSample(record: Experiment): string[] {
  if (isRunning(record.phase)) return [];
  const observed = observedRecord(record);
  const passed = situations(observed).filter(item => item.base === 'pass').map(item => item.trial.id);
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

/** The answers of a situation combine pessimistically: one disagreement is a disagreement, one doubt is doubt. */
function combine(answers: AgreementMark['answer'][]): AgreementMark['answer'] {
  return answers.includes('disagree') ? 'disagree' : answers.includes('unsure') ? 'unsure' : 'agree';
}

/** What one mark target holds: no mark, a current one, one whose judgment moved, or one given under the previous counting rule. */
interface Target { metricId: string; state: 'none' | 'current' | 'stale' | 'ruleStale'; answer?: AgreementMark['answer']; note: string }

/** The share of the judge's decisions the owner confirmed, split by failures and passes. */
export function judgeAgreement(input: Experiment): JudgeAgreement {
  if (input.workflow !== 'evaluate' || isRunning(input.phase)) return empty();
  const record = observedRecord(input);
  const rows = situations(record);
  const latest = latestHumanReviews(record);
  // A reassessment is a new judgment by definition, so a mark that only lives in the source run
  // refers to a verdict that has been replaced. It counts as stale, never as a check.
  const carried = new Map((input.sourceEvidence?.humanReviews ?? []).filter(item => item.source === 'quick').map(item => [`${item.trialId}|metric:${item.metricId}`, item]));
  const sampledPasses = agreementSample(input);
  const sampled = new Set(sampledPasses);
  const result = empty();
  result.queueFailures = rows.filter(row => row.base === 'fail').map(row => row.trial.id);
  result.sampledPasses = sampledPasses;
  const current = new Set<string>();
  for (const { trial, scenario, metricIds, base } of rows) {
    const judged = trial.judgeReceipt ?? trial.judgeAudit;
    const targets: Target[] = metricIds.map(metricId => {
      const key = `${trial.id}|metric:${metricId}`;
      const own = latest.get(key);
      // A later full review on the same rubric supersedes the quick mark: the pair stops counting.
      const review = own ? (own.source === 'quick' ? own : undefined) : carried.get(key);
      const saw = review?.judgeVerdict;
      const answer = review && (saw === 'pass' || saw === 'fail') ? answerOf(review.verdict, saw) : undefined;
      if (!review || !answer) return { metricId, state: 'none', note: '' };
      const ruleStale = !!own && !markUnderCurrentRule(scenario, trial, own, metricIds);
      const stale = !own || saw !== recordedResult(trial, metricId)
        || (review.judge?.protocolHash ?? null) !== (judged?.protocolHash ?? null)
        || (review.judge?.inputHash ?? null) !== (judged?.inputHash ?? null);
      return { metricId, state: ruleStale ? 'ruleStale' : stale ? 'stale' : 'current', answer, note: review.note };
    });
    const answered = targets.filter(target => target.answer !== undefined);
    if (!answered.length) continue;
    const answer = combine(answered.map(target => target.answer!));
    const note = (answered.find(target => target.answer === 'disagree') ?? answered[0]!).note;
    const mark: AgreementMark = { trialId: trial.id, scenarioId: scenario.id, title: scenario.title, answer, judge: base, note, stale: false,
      targets: answered.map(target => ({ metricId: target.metricId, answer: target.answer! })) };
    // A situation counts once, and only when every metric that decided it is answered under the current rule (CR-02).
    if (targets.some(target => target.state === 'ruleStale')) { result.staleRule++; result.marks.push({ ...mark, stale: true, staleRule: true }); continue; }
    if (targets.some(target => target.state === 'stale')) { result.stale++; result.marks.push({ ...mark, stale: true }); continue; }
    if (targets.some(target => target.state === 'none')) continue;
    result.marks.push(mark);
    current.add(trial.id);
    if (answer === 'unsure') { result.unsure++; continue; }
    const group = base === 'fail' ? result.failures : result.passes;
    group.checked++; result.checked++;
    if (answer === 'agree') { group.agreed++; result.agreed++; }
    if (sampled.has(trial.id)) result.sampleChecked++;
    if (answer === 'disagree') {
      const overturned = targets.filter(target => target.answer === 'disagree').map(target => target.metricId);
      const opposite = base === 'fail' ? 'pass' : 'fail';
      if (overturned.length === metricIds.length) {
        result.disagreements.push({ trialId: trial.id, scenarioId: scenario.id, title: scenario.title, judge: base, human: opposite, note });
      } else {
        // The owner overturned one of two metrics: the situation's verdict after the override is what the headline now shows.
        const after = headlineTrialResult(scenario, trial, record.humanReviews);
        result.disagreements.push({ trialId: trial.id, scenarioId: scenario.id, title: scenario.title, judge: base,
          human: after === 'pass' || after === 'fail' ? after : opposite, note, overturned });
      }
    }
  }
  result.unmarked = [...result.queueFailures, ...sampledPasses].filter(id => !current.has(id));
  // Disagreements are read as a list of situations, so they follow the card order of the record.
  const order = new Map(record.scenarios.map((scenario, i) => [scenario.id, i]));
  result.disagreements.sort((a, b) => (order.get(a.scenarioId) ?? 0) - (order.get(b.scenarioId) ?? 0));
  return result;
}
