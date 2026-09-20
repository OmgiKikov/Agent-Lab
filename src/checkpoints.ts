import { z } from 'zod';
import { checkpointDecisionSchema, checkpointRawDecisionsSchema, type CheckpointResult, checkSchema, fingerprint, type CheckResult, type Scenario, type Trial, type TraceEvent } from './contracts.js';
import type { Checkpoint } from './scenario-contracts.js';

export const CHECKPOINT_PROTOCOL = 'checkpoints-v1';
export { checkpointDecisionSchema, checkpointResultSchema, checkpointReceiptSchema } from './contracts.js';
export type { CheckpointDecision, CheckpointResult } from './contracts.js';

const channelEvents = (cp: Checkpoint, trial: Trial): TraceEvent[] => trial.events.filter(e => cp.observation === 'reply' ? e.type === 'assistant'
  : cp.observation === 'tool' ? e.type === 'tool_call' || e.type === 'tool_result' || e.type === 'observation' : e.state !== undefined || e.type === 'tool_result');
function missingObservation(cp: Checkpoint, trial: Trial): string | undefined {
  if (cp.observation === 'tool' && (!trial.observation || trial.observation.tools === 'partial')) return 'Полнота событий инструментов не подтверждена';
  if (cp.observation === 'state' && (!trial.observation || trial.observation.state === 'missing')) return 'Итоговое состояние не наблюдалось';
  if (cp.observation === 'state' && trial.observation?.state !== 'sandbox' && trial.observation?.resetConfirmed !== true) return 'Сброс состояния не подтверждён';
}
/** No prior verdicts, simulator decisions or hidden state outside the declared channel. */
export function checkpointInput(scenario: Scenario, trial: Trial) {
  const view = scenario.execution!.evaluatorView;
  return {
    protocol: CHECKPOINT_PROTOCOL,
    checkpoints: view.checkpoints.map(checkpoint => ({ checkpoint, requirement: view.requirements.find(r => r.id === checkpoint.requirementId),
      dialogue: trial.events.filter(e => e.type === 'user' || e.type === 'assistant').map(({ seq, type, text }) => ({ seq, type, text })),
      evidence: channelEvents(checkpoint, trial).map(({ seq, type, text, tool, args, result, state }) => ({ seq, type, text, tool, args, result, ...(checkpoint.observation === 'state' && state ? { state } : {}) })),
      allowedEvidence: channelEvents(checkpoint, trial).map(e => e.seq),
      applicabilityEvidence: trial.events.filter(e => ['user', 'assistant'].includes(e.type)).map(e => e.seq),
      observation: trial.observation ?? { state: 'missing', tools: 'partial' },
      ...(checkpoint.observation === 'state' && !missingObservation(checkpoint, trial) ? { state: trial.finalState } : {}),
    })),
  };
}
export type CheckpointInput = ReturnType<typeof checkpointInput>;

export function checkpointResponseSchema(checkpoints: Checkpoint[]) {
  const diagnosticIds = checkpoints.filter(cp => cp.role === 'diagnostic').map(cp => cp.id);
  const candidate = diagnosticIds.length ? z.union([checkpointDecisionSchema,
    z.object({ checkpointId: z.enum(diagnosticIds) }).catchall(z.json()),
  ]) : checkpointDecisionSchema;
  return z.strictObject({ results: z.array(candidate).max(48) })
    .refine(value => JSON.stringify(value.results).length <= 128000, 'Checkpoint response exceeds 128000 characters');
}


export function evaluateCheckpoints(scenario: Scenario, trial: Trial, raw: unknown, grade: (scenario: Scenario, trial: Trial) => CheckResult[]): CheckpointResult[] {
  const decisions = checkpointRawDecisionsSchema.parse(raw);
  const view = scenario.execution!.evaluatorView;
  const idOf = (decision: typeof decisions[number]) => decision && typeof decision === 'object' && !Array.isArray(decision) ? decision.checkpointId : undefined;
  if (decisions.some(d => !view.checkpoints.some(cp => cp.id === idOf(d)))) throw new Error('Неизвестная контрольная точка');
  return view.checkpoints.map(cp => {
    const candidates = decisions.filter(d => idOf(d) === cp.id);
    const parsed = candidates.length === 1 ? checkpointDecisionSchema.safeParse(candidates[0]) : undefined;
    if (cp.role === 'required' && !parsed?.success) throw new Error('Нужен один корректный результат для каждой обязательной контрольной точки');
    const d = parsed?.success ? parsed.data : { checkpointId: cp.id, result: 'unknown' as const, evidence: [],
      rationale: candidates.length === 0 ? 'Диагностическая точка не оценена' : candidates.length > 1 ? 'Повторный результат диагностической точки' : 'Некорректный результат диагностической точки' };
    const base: CheckpointResult = { ...d, requirementId: cp.requirementId, role: cp.role, observation: cp.observation };
    const unknown = (reason: string): CheckpointResult => ({ ...base, result: 'unknown', evidence: [], rationale: reason });
    const requirement = view.requirements.find(r => r.id === cp.requirementId);
    if (!requirement || !requirement.quote.includes(cp.quote)) return unknown('Требование или цитата не подтверждены принятым снимком');
    if (d.evidence.some(seq => !trial.events.some(e => e.seq === seq))) {
      if (cp.role === 'diagnostic') return unknown('Диагностика ссылается на неизвестное событие');
      throw new Error('Контрольная точка ссылается на неизвестное событие доказательства');
    }
    if (d.result === 'unknown') return base;
    if (!d.evidence.length) return unknown('Нет конкретных событий, подтверждающих решение');
    if (d.result === 'not_applicable') {
      return d.evidence.every(seq => trial.events.some(e => e.seq === seq && ['user', 'assistant'].includes(e.type))) ? base : unknown('Неприменимость не подтверждена условиями диалога');
    }
    const unavailable = missingObservation(cp, trial);
    if (unavailable) return unknown(unavailable);
    const events = channelEvents(cp, trial);
    const evidence = d.evidence.filter(seq => events.some(e => e.seq === seq));
    const contextEvidence = d.evidence.filter(seq => !evidence.includes(seq));
    if (!evidence.length || contextEvidence.some(seq => !trial.events.some(e => e.seq === seq && ['user', 'assistant'].includes(e.type)))) return unknown('Доказательство не относится к объявленному каналу наблюдения');
    base.evidence = evidence;
    if (contextEvidence.length) base.contextEvidence = contextEvidence;
    if (cp.check !== undefined) {
      const parsed = checkSchema.safeParse(cp.check);
      if (!parsed.success) return unknown('Некорректная точная проверка');
      const check = parsed.data;
      const channel = check.kind === 'state_equals' ? 'state' : check.kind.startsWith('answer_') ? 'reply' : 'tool';
      if (channel !== cp.observation) return unknown('Точная проверка использует другой канал наблюдения');
      try {
        const [result] = grade({ ...scenario, execution: undefined, checks: [check] }, trial);
        return { ...base, result: result!.passed ? 'pass' : 'fail', rationale: result!.evidence };
      } catch (error) { return unknown(error instanceof Error ? error.message : 'Проверка не измерена'); }
    }
    return base;
  });
}
export function checkpointReceipt(scenario: Scenario, trial: Trial, results: CheckpointResult[], decisions: unknown[]) {
  const normalized = checkpointRawDecisionsSchema.parse(decisions).map(value => {
    const parsed = checkpointDecisionSchema.safeParse(value);
    return parsed.success ? parsed.data : value;
  });
  return { protocolHash: scenario.execution!.checkpointHash, inputHash: fingerprint(checkpointInput(scenario, trial)), resultHash: fingerprint(results), decisionHash: fingerprint(normalized), decisions: normalized };
}
export function requiredCheckpointResult(scenario: Scenario | undefined, trial: Trial): 'pass' | 'fail' | 'unknown' | undefined {
  if (!scenario?.execution) return undefined;
  if (trial.checkpointReceipt && !checkpointReceiptValid(scenario, trial)) return 'unknown';
  const required = scenario.execution.evaluatorView.checkpoints.filter(c => c.role === 'required');
  const results = required.map(c => trial.checkpoints?.find(r => r.checkpointId === c.id && r.requirementId === c.requirementId)?.result ?? 'unknown');
  return results.includes('fail') ? 'fail' : results.every(r => r === 'pass' || r === 'not_applicable') ? 'pass' : 'unknown';
}

/** Compiler-visible checkpoint checks wait for applicability; only these checks run directly. */
export function directChecks(scenario: Scenario) {
  if (!scenario.execution) return scenario.checks;
  const ids = scenario.execution.evaluatorView.checkpoints.flatMap(cp => { const check = checkSchema.safeParse(cp.check); return check.success ? [check.data.id] : []; });
  return scenario.checks.filter(check => !ids.includes(check.id));
}
export function checkpointReceiptValid(scenario: Scenario, trial: Trial): boolean {
  if (!scenario.execution) return true;
  const receipt = trial.checkpointReceipt;
  return !!receipt && !!trial.checkpoints && receipt.protocolHash === scenario.execution.checkpointHash
    && receipt.inputHash === fingerprint(checkpointInput(scenario, trial))
    && receipt.resultHash === fingerprint(trial.checkpoints) && receipt.decisionHash === fingerprint(receipt.decisions);
}
