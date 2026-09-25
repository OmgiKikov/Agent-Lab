import { addUsage, emptyUsage, isCardExecution, type Experiment, type Trial } from '../contracts.js';
import { judgeModel } from '../comparison.js';
import { assessTrial } from '../evaluation.js';
import { scenarioSources } from '../judge.js';
import { agentReplies, JUDGE_CHECK_PROTOCOL, judgeCheckCounts, judgeCheckPlan, judgeCheckSchema, type JudgeCheck, type JudgeCheckCandidate, type JudgeCheckItem, type JudgeCheckPlan } from '../judge-check.js';
import type { ErrorPlanter } from '../judge-check-task.js';
import type { CallContext, Runtime } from '../runtime.js';
import type { Lab } from './context.js';

/*
 * A judge check of a finished run (judge-check.ts): the builder plants one error into a copy of each sampled
 * dialogue, and the run's own judge — the same assessTrial path, prompt and receipts — judges every copy and every
 * untouched control on that one expectation. Only copies are judged: the run and its trials never change. The
 * result is written as the run's sidecar; the audits of the copies go to {runId}.judge-check/. The check is the lab's
 * one operation while it lasts, beside the run (lab/operation.ts): its own ceiling and time, stopped by a cancel or the
 * closing lab like any other paid work.
 *
 *   plan (ceiling) ──► per item: [builder: one reply rewritten] ──► copy judged ──► verdict ──► {runId}.judge-check.json
 */

export interface JudgeCheckOptions { planted?: number; controls?: number }

/** Items judged at once: each asks for two votes, so four keep eight requests in flight, as one attempt's judgment does. */
const CONCURRENCY = 4;

/** The ceiling a check of `id` would have, and what it would sample; spends nothing. */
export async function planJudgeCheck(lab: Lab, id: string, options: JudgeCheckOptions = {}): Promise<JudgeCheckPlan> {
  return judgeCheckPlan(await lab.get(id), options);
}

interface Work { record: Experiment; runtime: Runtime & { assess: NonNullable<Runtime['assess']>; plantError: ErrorPlanter }; ctx: (name: string) => CallContext; spent: () => boolean }

/** The dialogue as the judge will read it again: the same facts, none of the earlier judgment. */
function freshCopy(trial: Trial): Trial {
  const copy = structuredClone(trial);
  delete copy.assessments; delete copy.assessmentError; delete copy.assessmentFailure; delete copy.judgeAudit; delete copy.judgeReceipt; delete copy.checkpoints; delete copy.checkpointReceipt;
  copy.usage = emptyUsage();
  return copy;
}

/** The run's judge on one copy, for one expectation: the verdict, and the receipt sealed as a run's is. */
async function judgeCopy(work: Work, candidate: JudgeCheckCandidate, copy: Trial, name: string): Promise<Pick<JudgeCheckItem, 'result' | 'failure' | 'receipt'>> {
  const { record } = work;
  const scenario = { ...candidate.scenario, metrics: (candidate.scenario.metrics ?? []).filter(metric => metric.id === candidate.expectationId) };
  try {
    const assessments = await assessTrial(work.runtime, scenario, scenarioSources(record, candidate.scenario), copy, work.ctx(name), record.requirements);
    return { result: assessments.find(assessment => assessment.metricId === candidate.expectationId)?.result ?? 'unknown', ...(copy.judgeReceipt ? { receipt: copy.judgeReceipt } : {}) };
  } catch {
    return { result: null, failure: work.spent() ? 'stopped' : 'judge', ...(copy.judgeReceipt ? { receipt: copy.judgeReceipt } : {}) };
  }
}

/** One planted error: the builder rewrites one reply of a copy, and the judge reads the copy. */
async function plantedItem(work: Work, candidate: JudgeCheckCandidate, name: string): Promise<JudgeCheckItem> {
  const base = { kind: 'planted' as const, trialId: candidate.trial.id, expectationId: candidate.expectationId };
  const execution = candidate.scenario.execution;
  const expectation = isCardExecution(execution) ? execution.evaluatorView.expectations.find(item => item.id === candidate.expectationId) : undefined;
  if (!isCardExecution(execution) || !expectation) return { ...base, result: null, failure: 'builder' };
  const rules = execution.evaluatorView.requirements.filter(requirement => expectation.requirementIds.includes(requirement.id)).map(requirement => requirement.quote);
  const replies = agentReplies(candidate.trial).map((event, index) => ({ index, text: event.text! }));
  // The builder reads the expectation whole, as the judge's rubric does: a duty it must not do is broken by doing it, never by its acceptable path.
  const { text, strength, appliesWhen, acceptable, violation } = expectation;
  const request = { text, ...(strength ? { strength } : {}), ...(appliesWhen ? { appliesWhen } : {}), ...(acceptable ? { acceptable } : {}), ...(violation ? { violation } : {}) };
  let planted;
  try { planted = await work.runtime.plantError.plant({ expectation: request, rules, replies }, work.ctx(name)); }
  catch { return { ...base, result: null, failure: work.spent() ? 'stopped' : 'builder' }; }
  const copy = freshCopy(candidate.trial);
  const reply = agentReplies(copy)[planted.replyIndex];
  const newReply = planted.newReply.trim();
  if (!reply || !newReply || newReply === reply.text?.trim()) return { ...base, result: null, failure: 'builder' };
  reply.text = newReply;
  const altered = { replySeq: reply.seq, newReply: newReply.slice(0, 6000), whatWasBroken: planted.whatWasBroken.trim().slice(0, 160) };
  return { ...base, ...altered, ...await judgeCopy(work, candidate, copy, name) };
}

/**
 * Runs a judge check of `id` as the lab's one operation beside the run (lab/operation.ts), and writes it beside the run.
 * Its ceiling is the plan's and its time the draft's, both from its start: a call past the ceiling is refused, and the
 * items it would have judged stay without a verdict («stopped»), never guessed. A cancel — Ctrl+C, the owner's stop, the
 * closing lab — stops the calls under way the same way; what was judged by then is written.
 */
export function checkJudge(lab: Lab, id: string, options: JudgeCheckOptions = {}): Promise<JudgeCheck> {
  return lab.operations.change(async () => {
    const record = await lab.store.get(id);
    const plan = judgeCheckPlan(record, options);
    const runtime = await lab.runtime(record);
    const { assess, plantError } = runtime;
    if (!assess || !plantError) throw new Error('Проверка судьи недоступна для этого прогона: нужны судья и модель задачи (учебный пример их не даёт).');
    return lab.operations.beside(record.id, async (calls, operation) => {
      const usage = emptyUsage();
      const work: Work = {
        record, runtime: { ...runtime, assess, plantError },
        spent: () => operation.exhausted || calls.signal.aborted,
        ctx: name => ({ ...calls,
          beforeCall() { calls.beforeCall(); usage.calls++; },
          addUsage: delta => addUsage(usage, delta),
          onJudgment: (_trialId, audit) => lab.store.writeJudgeCheckAudit(record.id, name, audit),
        }),
      };
      const jobs = [
        ...plan.planted.map((candidate, index) => () => plantedItem(work, candidate, `planted-${index + 1}`)),
        ...plan.controls.map((candidate, index) => async (): Promise<JudgeCheckItem> => ({ kind: 'control', trialId: candidate.trial.id, expectationId: candidate.expectationId,
          ...await judgeCopy(work, candidate, freshCopy(candidate.trial), `control-${index + 1}`) })),
      ];
      const items: JudgeCheckItem[] = new Array(jobs.length);
      let next = 0;
      const worker = async (): Promise<void> => { while (next < jobs.length) { const index = next++; items[index] = await jobs[index]!(); } };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
      const judged = items.flatMap(item => item.receipt ? [`${item.receipt.provider}/${item.receipt.model}`] : []);
      const check = judgeCheckSchema.parse({ protocol: JUDGE_CHECK_PROTOCOL, runId: record.id, ...judgeCheckCounts(items), items,
        judgeModel: judged[0] ?? judgeModel(record) ?? 'неизвестен', builderModel: `${plantError.builder.provider}/${plantError.builder.id}`, usage, at: new Date().toISOString() });
      await lab.store.writeJudgeCheck(check);
      return check;
    }, { budget: { calls: plan.calls, timeMs: record.settings.maxDurationMs }, timeoutMs: record.settings.timeoutMs, ownsMutation: true });
  });
}
