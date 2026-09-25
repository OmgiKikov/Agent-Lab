import { z } from 'zod';
import { assessmentRubrics, judgeReceiptSchema } from './assessment.js';
import { recordedExpectationResult } from './card/expectations.js';
import { measurementUsable } from './outcomes.js';
import { fingerprint, isCardExecution, usageSchema, type Experiment, type Scenario, type Trial } from './contracts.js';
import { identifierSchema as identifier, text } from './ids.js';

/*
 * The judge checked without a person: errors planted into copies of recorded dialogues, and untouched controls. This
 * module is the pure part — the stored shape of a check, which verdicts it samples, how many model calls that may
 * take, and what the result says. The work itself (lab/judge-check.ts) and the builder's task (judge-check-task.ts)
 * live elsewhere; this file does no I/O and no model calls.
 *
 *   passed verdicts of a run ──hash order──► planted: copy + one reply altered by the builder ──► the run's judge ──► fail = caught
 *                             └─hash order──► controls: copy unaltered ─────────────────────────► the run's judge ──► fail = false alarm
 *
 * A check is a sidecar of its run ({runId}.judge-check.json): the run itself never changes, and a run without a
 * check shows nothing about it.
 */

export const JUDGE_CHECK_PROTOCOL = 'planted-errors-v1';
export const DEFAULT_PLANTED = 10;
export const DEFAULT_CONTROLS = 10;
/** Most of each kind one check may ask for: the ceiling stays a number the owner can read at once. */
export const MAX_SAMPLE = 50;
/** Diagnostic threshold for the model-generated copies; independent human labels are still needed to validate the judge. */
export const TRUSTED_SHARE = 0.8;
/** The builder writes one planted error in one request: its ceiling is exact. */
export const BUILDER_CALLS = 1;

/** Why an item has no verdict: the builder gave no usable error, the judge failed, or the check stopped (its ceiling, time or the owner). */
const failureSchema = z.enum(['builder', 'judge', 'stopped']);
const itemSchema = z.strictObject({
  kind: z.enum(['planted', 'control']),
  trialId: identifier, expectationId: identifier,
  /** The judge's verdict on the copy; null when it has none (`failure` says why). */
  result: z.enum(['pass', 'fail', 'unknown']).nullable(),
  failure: failureSchema.optional(),
  /** Planted only: the agent reply replaced (its trace seq), the reply written in its place and what it breaks. */
  replySeq: z.number().int().nonnegative().optional(),
  newReply: text(6000).optional(),
  whatWasBroken: text(160).optional(),
  /** The copy's judgment, sealed as a run's is; its full audit is in {runId}.judge-check/{kind}-{n}.json. */
  receipt: judgeReceiptSchema.optional(),
});
export type JudgeCheckItem = z.infer<typeof itemSchema>;
export const judgeCheckSchema = z.strictObject({
  protocol: z.literal(JUDGE_CHECK_PROTOCOL),
  runId: identifier,
  planted: z.number().int().nonnegative(), detected: z.number().int().nonnegative(),
  controls: z.number().int().nonnegative(), falseAlarms: z.number().int().nonnegative(),
  items: z.array(itemSchema).max(2 * MAX_SAMPLE),
  judgeModel: text(200), builderModel: text(200),
  usage: usageSchema,
  at: z.iso.datetime(),
});
export type JudgeCheck = z.infer<typeof judgeCheckSchema>;

/** One passed verdict a check may plant an error into or keep as a control. */
export interface JudgeCheckCandidate { trial: Trial; scenario: Scenario; expectationId: string; judgeCalls: number }

/** The agent replies of a dialogue, in order: only these may be altered. */
export const agentReplies = (trial: Pick<Trial, 'events'>) => trial.events.filter(event => event.type === 'assistant' && !!event.text?.trim());

/**
 * Every verdict of the run a check can use: an expectation of a card-format situation that the judge passed — as the
 * number reads it, through its channel (card/expectations.ts recordedExpectationResult) — on a dialogue the number
 * counts (outcomes.ts measurementUsable) with at least one agent reply, judged on the reply itself: altering a reply
 * cannot break a duty observed in a tool call or in the agent's state. Positive controls are left out: they measure the
 * connection.
 */
export function judgeCheckCandidates(record: Experiment): JudgeCheckCandidate[] {
  const controls = new Set(record.positiveControlScenarioIds ?? []);
  return record.trials.flatMap(trial => {
    const scenario = record.scenarios.find(item => item.id === trial.scenarioId);
    const execution = scenario?.execution;
    if (!scenario || !isCardExecution(execution) || controls.has(scenario.id) || !measurementUsable(scenario, trial, record.humanReviews) || !agentReplies(trial).length) return [];
    const passed = execution.evaluatorView.expectations.filter(expectation => expectation.observation === 'reply' && recordedExpectationResult(trial, expectation) === 'pass');
    return passed.flatMap(expectation => {
      const metric = scenario.metrics?.find(item => item.id === expectation.id);
      // Two votes on every rubric the judge reads for this one expectation (a retrieval trace adds its own).
      return metric ? [{ trial, scenario, expectationId: metric.id, judgeCalls: 2 * assessmentRubrics({ metrics: [metric] }, trial).length }] : [];
    });
  });
}

/** The verdicts a check samples: the first `count` in an order fixed by the run and the kind, so the same run gives the same sample. */
function sample(record: Experiment, candidates: JudgeCheckCandidate[], kind: JudgeCheckItem['kind'], count: number): JudgeCheckCandidate[] {
  const key = (item: JudgeCheckCandidate) => fingerprint({ protocol: JUDGE_CHECK_PROTOCOL, kind, runId: record.id, trialId: item.trial.id, expectationId: item.expectationId });
  return candidates.map(item => ({ item, key: key(item) })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).slice(0, count).map(({ item }) => item);
}

export interface JudgeCheckPlan {
  planted: JudgeCheckCandidate[];
  controls: JudgeCheckCandidate[];
  /** The most model calls the check may make: every planted error its builder request and its judge's votes, every control its votes. */
  calls: number;
}

/**
 * What a check of `record` will do and its call ceiling. A planted error and a control may come from the same
 * verdict: each is its own copy. Refuses a run that is not finished, or has no passed verdict to work with.
 */
export function judgeCheckPlan(record: Experiment, options: { planted?: number; controls?: number } = {}): JudgeCheckPlan {
  const planted = options.planted ?? DEFAULT_PLANTED, controls = options.controls ?? DEFAULT_CONTROLS;
  for (const [value, flag] of [[planted, '--planted'], [controls, '--controls']] as const) {
    if (!Number.isInteger(value) || value < 0 || value > MAX_SAMPLE) throw new Error(`${flag}: целое число от 0 до ${MAX_SAMPLE}.`);
  }
  if (!planted) throw new Error('Нужна хотя бы одна подброшенная ошибка: --planted от 1.');
  if (record.workflow !== 'evaluate' || !['results_review', 'complete'].includes(record.phase)) throw new Error('Судью проверяют на завершённом прогоне.');
  const candidates = judgeCheckCandidates(record);
  if (!candidates.length) throw new Error('В прогоне нет ожиданий, которые судья засчитал по ответу агента: подбросить ошибку некуда.');
  const chosen = { planted: sample(record, candidates, 'planted', planted), controls: sample(record, candidates, 'control', controls) };
  return { ...chosen, calls: chosen.planted.reduce((n, item) => n + BUILDER_CALLS + item.judgeCalls, 0) + chosen.controls.reduce((n, item) => n + item.judgeCalls, 0) };
}

/** What a check says, read from its items: only verdicts count, an item without one is named apart. */
export interface JudgeCheckSummary {
  planted: number; detected: number; controls: number; falseAlarms: number;
  /** Items without a pass/fail verdict (including an explicit unknown). */
  unjudged: number;
  /** Diagnostic concern; null means no concern was detected here, not calibrated correctness. */
  distrust: 'misses' | 'false_alarms' | 'incomplete' | null;
}

/** Counts of a check as stored: the same numbers every surface reads through `judgeCheckSummary`. */
export function judgeCheckCounts(items: readonly JudgeCheckItem[]): Pick<JudgeCheck, 'planted' | 'detected' | 'controls' | 'falseAlarms'> {
  const judged = (kind: JudgeCheckItem['kind']) => items.filter(item => item.kind === kind && (item.result === 'pass' || item.result === 'fail'));
  return { planted: judged('planted').length, detected: judged('planted').filter(item => item.result === 'fail').length,
    controls: judged('control').length, falseAlarms: judged('control').filter(item => item.result === 'fail').length };
}

/** The summary of `check` for `record`; null when there is no check of this very run. */
export function judgeCheckSummary(check: JudgeCheck | null | undefined, record: Pick<Experiment, 'id'>): JudgeCheckSummary | null {
  if (!check || check.runId !== record.id) return null;
  const counts = judgeCheckCounts(check.items);
  const misses = counts.planted > 0 && counts.detected < TRUSTED_SHARE * counts.planted;
  const falseAlarms = counts.controls > 0 && counts.falseAlarms > (1 - TRUSTED_SHARE) * counts.controls;
  const unjudged = check.items.filter(item => item.result === null || item.result === 'unknown').length;
  return { ...counts, unjudged, distrust: misses ? 'misses' : falseAlarms ? 'false_alarms' : (!counts.planted || !counts.controls || unjudged) ? 'incomplete' : null };
}
