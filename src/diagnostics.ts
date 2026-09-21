import { z } from 'zod';
import { experimentSchema, fingerprint, type Experiment, type Trial, type Target } from './contracts.js';
import { measurementUsable } from './outcomes.js';
import { interventionSchema, SANDBOX_DIAGNOSTIC_CAPABILITIES, type Intervention, type DiagnosticRequest } from './diagnostic-contracts.js';
import type { Issue } from './issues.js';
export { interventionSchema, type Intervention } from './diagnostic-contracts.js';

export const diagnosticPreparationSchema = z.strictObject({ issueId: z.string(), sourceRunId: z.string(), intervention: interventionSchema, repeats: z.number().int().min(1).max(5) });
export const diagnosticPlanSchema = z.strictObject({ formatVersion: z.literal('1'), id: z.string().regex(/^diag_[a-f0-9]{40}$/), issueId: z.string(), scenarioId: z.string(), criterionId: z.string(), criterionHash: z.string(), source: experimentSchema, sourceRevisionId: z.string().min(1).optional(), sourceHash: z.string(), intervention: interventionSchema, factorHash: z.string(), repeats: z.number().int().min(1).max(5), budget: z.strictObject({ maxCalls: z.number().int().positive(), maxDurationMs: z.number().positive() }) });
export type DiagnosticPlan = z.infer<typeof diagnosticPlanSchema>;
export const diagnosticResultSchema = z.strictObject({ formatVersion: z.literal('1'), planId: z.string(), conclusion: z.enum(['supports', 'refutes', 'inconclusive']), reasons: z.array(z.string()), pairs: z.array(z.strictObject({ scenarioId: z.string(), userMode: z.string(), repeat: z.number(), baselineTrialId: z.string().optional(), interventionTrialId: z.string().optional(), baseline: z.enum(['pass', 'fail', 'unknown']), intervention: z.enum(['pass', 'fail', 'unknown']) })) });
export type DiagnosticResult = z.infer<typeof diagnosticResultSchema>;
export const diagnosticFileSchema = z.strictObject({ formatVersion: z.literal('1'), plan: diagnosticPlanSchema, runId: z.string().optional(), result: diagnosticResultSchema.optional() });
export type DiagnosticFile = z.infer<typeof diagnosticFileSchema>;
export function diagnosticCapability(target: Target, intervention: Intervention): { supported: boolean; reason: string } {
  const capabilities = target.kind === 'sandbox' ? SANDBOX_DIAGNOSTIC_CAPABILITIES : target.diagnosticCapabilities;
  const supported = capabilities?.protocol === 'paired-intervention-v1' && (intervention.kind === 'tool-response' ? capabilities.toolResponse : capabilities.ragFragment) === true;
  return { supported, reason: supported ? 'Возможность вмешательства объявлена; применение будет подтверждено в трассе.' : 'Адаптер не объявил поддержку этого вмешательства (paired-intervention-v1). Вызовов агента не будет.' };
}
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }
export function prepareDiagnostic(issue: Issue, source: Experiment, raw: Intervention, repeats: number): DiagnosticPlan {
  const intervention = interventionSchema.parse(raw), capability = diagnosticCapability(source.target, intervention);
  if (!capability.supported) throw new Error(capability.reason);
  if (source.runKind === 'diagnostic' || source.runKind === 'generator' || !['results_review', 'complete', 'cancelled', 'interrupted'].includes(source.phase)) throw new Error('Нужен исходный завершённый обычный прогон.');
  const evidence = issue.evidence.find(e => e.runId === source.id && e.criterionHash === issue.identity.criterionHash);
  if (!evidence) throw new Error('У проблемы нет доказательства из этого прогона.');
  const revision = source.revisions.find(r => r.id === evidence.assessment.trial.revisionId);
  if (!revision || source.revisions.filter(r => r.id === revision.id).length !== 1) throw new Error('Исходная ревизия из точной оценки отсутствует или неоднозначна.');
  const scenario = source.scenarios.find(s => s.id === evidence.assessment.scenario.id);
  if (!scenario || fingerprint(scenario) !== fingerprint(evidence.assessment.scenario)) throw new Error('Критерий или сценарий изменился после наблюдения.');
  if (intervention.kind === 'rag-fragment') {
    const material = source.sources.find(s => s.id === intervention.sourceId);
    if (!material || material.kind === 'prompt' || fingerprint(material.content) !== intervention.sourceHash || !material.content.includes(intervention.content)) throw new Error('Проверенный фрагмент должен дословно принадлежать сохранённому источнику с указанным хешем.');
  }
  if (source.target.kind === 'sandbox' && intervention.kind === 'tool-response' && !revision.spec.tools.includes(intervention.tool)) throw new Error('Инструмент вмешательства недоступен в исходном fixture.');
  const snapshot = structuredClone(source);
  const content = { formatVersion: '1' as const, issueId: issue.id, scenarioId: scenario.id, criterionId: evidence.criterionId, criterionHash: evidence.criterionHash, source: snapshot, sourceRevisionId: revision.id, sourceHash: fingerprint(snapshot), intervention, factorHash: fingerprint(intervention), repeats, budget: { maxCalls: source.settings.maxCalls, maxDurationMs: source.settings.maxDurationMs } };
  return freeze(diagnosticPlanSchema.parse({ ...content, id: `diag_${fingerprint(content).slice(0, 40)}` }));
}
export function verifyDiagnosticPlan(plan: DiagnosticPlan): void {
  const { id, ...content } = diagnosticPlanSchema.parse(plan);
  if (id !== `diag_${fingerprint(content).slice(0, 40)}` || plan.sourceHash !== fingerprint(plan.source) || plan.factorHash !== fingerprint(plan.intervention)) throw new Error('Снимок диагностического плана изменён.');
}
/** Old single-revision plans are unambiguous; old comparison plans need a newly prepared evidence binding. */
export function diagnosticRevision(plan: DiagnosticPlan): Experiment['revisions'][number] {
  const id = plan.sourceRevisionId ?? (plan.source.revisions.length === 1 ? plan.source.revisions[0]!.id : undefined);
  const matches = plan.source.revisions.filter(r => r.id === id);
  if (matches.length !== 1) throw new Error('Исходная ревизия диагностики не определена однозначно. Подготовьте новый план из точной оценки.');
  return matches[0]!;
}
export function diagnosticRequest(plan: DiagnosticPlan, arm: DiagnosticRequest['arm']): DiagnosticRequest {
  const content = { protocol: 'paired-intervention-v1' as const, planId: plan.id, arm, factorHash: plan.factorHash, intervention: plan.intervention };
  return { ...content, requestHash: fingerprint(content) };
}
function criterionResult(plan: DiagnosticPlan, trial: Trial | undefined, request: DiagnosticRequest): 'pass' | 'fail' | 'unknown' {
  if (!trial) return 'unknown';
  const scenario = plan.source.scenarios.find(s => s.id === trial.scenarioId), receipt = trial.diagnosticReceipt;
  if (!scenario || fingerprint(trial.initialState) !== fingerprint(scenario.initialState) || trial.revisionId !== diagnosticRevision(plan).id || !measurementUsable(scenario, trial) || !receipt || receipt.requestHash !== request.requestHash || receipt.factorHash !== plan.factorHash || receipt.arm !== request.arm || receipt.appliedCount !== (request.arm === 'baseline' ? 0 : 1)) return 'unknown';
  if (plan.source.target.kind !== 'sandbox' && (trial.observation?.resetConfirmed !== true || !trial.observation.version)) return 'unknown';
  const cp = trial.checkpoints?.find(c => c.checkpointId === plan.criterionId);
  if (cp) return cp.result === 'pass' || cp.result === 'fail' ? cp.result : 'unknown';
  const check = trial.checks.find(c => c.id === plan.criterionId);
  if (check) return check.passed ? 'pass' : 'fail';
  return trial.assessments?.find(a => a.metricId === plan.criterionId)?.result ?? 'unknown';
}
/** Scheduling delegates each arm to the existing runSuite; this module only pairs and interprets its persisted trials. */
export async function runDiagnostic(plan: DiagnosticPlan, runner: (arm: DiagnosticRequest['arm'], request: DiagnosticRequest) => Promise<Trial[] | { trials: Trial[]; error?: string }>): Promise<DiagnosticResult> {
  verifyDiagnosticPlan(plan);
  diagnosticRevision(plan);
  const reasons: string[] = [], arms: { baseline: Trial[]; intervention: Trial[] } = { baseline: [], intervention: [] };
  for (const arm of ['baseline', 'intervention'] as const) {
    try { const output = await runner(arm, diagnosticRequest(plan, arm)); arms[arm] = Array.isArray(output) ? output : output.trials; if (!Array.isArray(output) && output.error) { reasons.push(output.error); break; } }
    catch (error) { reasons.push(error instanceof Error ? error.message : String(error)); break; }
  }
  const pairs: DiagnosticResult['pairs'] = [];
  for (const scenario of plan.source.scenarios.filter(s => s.id === plan.scenarioId)) for (const userMode of plan.source.settings.userModes) for (let repeat = 0; repeat < plan.repeats; repeat++) {
    const select = (trials: Trial[]) => trials.filter(t => t.scenarioId === scenario.id && t.userMode === userMode && t.repeat === repeat);
    const before = select(arms.baseline), after = select(arms.intervention), b = before.length === 1 ? before[0] : undefined, a = after.length === 1 ? after[0] : undefined;
    const comparable = b?.manifestHash === a?.manifestHash && b?.id !== a?.id && (plan.source.target.kind === 'sandbox' || !!b?.observation?.version && b.observation.version === a?.observation?.version && (!plan.source.targetRelease || b.observation.version === plan.source.targetRelease));
    pairs.push({ scenarioId: scenario.id, userMode, repeat, ...(b ? { baselineTrialId: b.id } : {}), ...(a ? { interventionTrialId: a.id } : {}), baseline: comparable ? criterionResult(plan, b, diagnosticRequest(plan, 'baseline')) : 'unknown', intervention: comparable ? criterionResult(plan, a, diagnosticRequest(plan, 'intervention')) : 'unknown' });
  }
  const conclusive = pairs.length > 0 && !reasons.length && pairs.every(p => p.baseline === 'fail' && p.intervention !== 'unknown');
  const conclusion = conclusive && pairs.every(p => p.intervention === 'pass') ? 'supports' : conclusive && pairs.every(p => p.intervention === 'fail') ? 'refutes' : 'inconclusive';
  reasons.push(conclusion === 'supports' ? 'Исчезновение дефекта поддерживает гипотезу на этих парных попытках; единственная причина и исправление продукта не доказаны.' : conclusion === 'refutes' ? 'При подтверждённом вмешательстве дефект сохранился во всех парах.' : 'Недостаточно полных сопоставимых пар с воспроизведённым исходным дефектом и подтверждённым вмешательством.');
  return { formatVersion: '1', planId: plan.id, conclusion, reasons, pairs };
}
