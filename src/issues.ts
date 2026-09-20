import { resolutionFileSchema } from './resolution-contracts.js';
import { resolutionTargetIdentity } from './normalize.js';
import { requiredCheckpointResult } from './checkpoints.js';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fingerprint, trialSchema, scenarioSchema, humanReviewSchema, type Experiment, type Trial } from './contracts.js';
import { measurementUsable, observedRecord } from './outcomes.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const issueEvidenceSchema = z.strictObject({
  runId: id, trialId: id, executionRunId: id, executionId: hash, eventSeq: z.array(z.number().int().nonnegative()), assessmentId: hash,
  criterionId: z.string(), criterionHash: hash, targetIdentity: hash.optional(), executionCreatedAt: z.string().optional(),
  assessment: z.strictObject({ trial: trialSchema, scenario: scenarioSchema.extend({ split: z.enum(['dev', 'control']) }), humanReviews: z.array(humanReviewSchema), evaluatorVersion: z.string().optional() }),
});
export const issueSchema = z.strictObject({
  formatVersion: z.literal('1'), id, kind: z.enum(['defect', 'opportunity']), observation: z.string(),
  identity: z.strictObject({ scenarioKey: z.string(), criterionId: z.string(), criterionHash: hash, mechanism: z.string(), mechanismHash: hash }),
  businessScenarios: z.array(z.string()), evidence: z.array(issueEvidenceSchema), occurrences: z.array(hash),
  hypotheses: z.array(z.string()), experiments: z.array(id),
  status: z.enum(['detected', 'reproduced', 'checking', 'resolved']),
  history: z.array(z.strictObject({ at: z.string(), status: z.enum(['detected', 'reproduced', 'checking', 'resolved']), reason: z.string(), evidenceIds: z.array(hash) })),
  mergedInto: id.optional(),
  resolution: z.strictObject({ policyId: id, candidateIdentity: hash, closedAt: z.string() }).optional(),
});
export type Issue = z.infer<typeof issueSchema>;
export type IssueEvidence = z.infer<typeof issueEvidenceSchema>;
export interface IssueSuggestion { issueId: string; candidateId: string; reason: string }
export const issueDecisionSchema = z.strictObject({ id, fromIssueId: id, intoIssueId: id, reason: z.string().trim().min(1).max(2000), at: z.string() });
export type IssueDecision = z.infer<typeof issueDecisionSchema>;
const normalized = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();

/** Exact finalized assessments are embedded, never resolved through mutable judge sidecars. */
export function syncIssues(record: Experiment, existing: Issue[]): { issues: Issue[]; suggestions: IssueSuggestion[] } {
  const issues = structuredClone(existing), suggestions: IssueSuggestion[] = [];
  if (record.runKind === 'diagnostic' || record.runKind === 'generator') return { issues, suggestions };
  const observed = observedRecord(record);
  for (const trial of observed.trials) {
    const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
    if (trial.diagnosticReceipt || !scenario || !measurementUsable(scenario, trial, record.humanReviews) || record.positiveControlScenarioIds?.includes(scenario.id)) continue;
    const criteria: { id: string; definition: unknown; kind: Issue['kind']; events: number[]; observation: string }[] = [];
    if (scenario.execution) for (const cp of trial.checkpoints ?? []) {
      if (cp.result !== 'fail' || cp.role === 'diagnostic' && (requiredCheckpointResult(scenario, trial) !== 'pass' || trial.outcome === 'fail')) continue;
      const definition = scenario.execution.evaluatorView.checkpoints.find(c => c.id === cp.checkpointId);
      if (!definition) continue;
      criteria.push({ id: cp.checkpointId, definition: { checkpoint: definition, requirement: scenario.execution.evaluatorView.requirements.find(r => r.id === cp.requirementId) }, kind: cp.role === 'required' ? 'defect' : 'opportunity', events: cp.evidence, observation: cp.rationale });
    } else {
      for (const check of trial.checks.filter(c => !c.passed)) {
        const definition = scenario.checks.find(c => c.id === check.id);
        if (definition) criteria.push({ id: check.id, definition, kind: 'defect', events: trial.events.filter(e => e.type !== 'simulator').map(e => e.seq), observation: check.description });
      }
      for (const metric of trial.assessments ?? []) {
        const definition = scenario.metrics?.find(m => m.id === metric.metricId && m.subject === 'agent');
        if (definition && metric.result === 'fail') criteria.push({ id: metric.metricId, definition, kind: 'defect', events: metric.evidence, observation: metric.rationale });
      }
    }
    for (const criterion of criteria) {
      const criterionHash = fingerprint({ criterion: criterion.definition, requirements: record.requirements.filter(r => scenario.requirementIds.includes(r.id)) });
      const mode = record.failureModes?.find(m => m.trialIds.includes(trial.id));
      const mechanism = normalized(mode ? `${mode.stage ?? ''}: ${mode.description}` : `criterion:${criterion.id}:${criterionHash}`);
      const identity = { scenarioKey: scenario.familyId, criterionId: criterion.id, criterionHash, mechanism, mechanismHash: fingerprint(mechanism) };
      const issueId = `issue_${fingerprint({ kind: criterion.kind, ...identity }).slice(0, 40)}`;
      let issue = issues.find(i => i.id === issueId);
      const seen = new Set<string>();
      while (issue?.mergedInto) { if (seen.has(issue.id)) throw new Error('Цикл решений владельца.'); seen.add(issue.id); issue = issues.find(i => i.id === issue!.mergedInto); }
      const previousEvidence = record.assessmentOf ? existing.flatMap(i => i.evidence).find(e => e.runId === record.assessmentOf && e.trialId === trial.id) : undefined;
      const executionRunId = record.executionRunId ?? previousEvidence?.executionRunId ?? record.assessmentOf ?? record.id;
      const executionId = fingerprint({ runId: executionRunId, trialId: trial.id });
      const assessment = { trial: structuredClone(trial), scenario: structuredClone(scenario), humanReviews: record.humanReviews.filter(r => r.trialId === trial.id), ...(record.evaluatorVersion ? { evaluatorVersion: record.evaluatorVersion } : {}) };
      const assessmentId = fingerprint({ runId: record.id, criterionHash, assessment });
      const evidence: IssueEvidence = { runId: record.id, trialId: trial.id, executionRunId, executionId, eventSeq: criterion.events, assessmentId, criterionId: criterion.id, criterionHash, assessment, targetIdentity: resolutionTargetIdentity(record, trial.revisionId), executionCreatedAt: record.assessmentOf ? previousEvidence?.executionCreatedAt : record.reviewedAt ?? record.createdAt };
      if (!issue) {
        issue = { formatVersion: '1', id: issueId, kind: criterion.kind, observation: mode?.name ?? criterion.observation, identity, businessScenarios: [scenario.familyId], evidence: [], occurrences: [], hypotheses: [], experiments: [], status: 'detected', history: [{ at: record.updatedAt, status: 'detected', reason: 'Сохранено исходное наблюдение.', evidenceIds: [assessmentId] }] };
        for (const candidate of issues.filter(i => !i.mergedInto && i.kind === issue!.kind && i.identity.scenarioKey === identity.scenarioKey && i.identity.criterionHash === criterionHash && i.identity.mechanismHash !== identity.mechanismHash)) suggestions.push({ issueId, candidateId: candidate.id, reason: 'Критерий совпадает, механизм отличается. Объединение требует решения владельца.' });
        issues.push(issue);
      }
      if (!issue.evidence.some(e => e.assessmentId === assessmentId)) issue.evidence.push(evidence);
      if (!issue.occurrences.includes(executionId)) {
        issue.occurrences.push(executionId);
        if (issue.kind === 'defect' && (issue.occurrences.length > 1 && issue.status === 'detected' || issue.status === 'resolved' && eligibleRecurrence(issue, evidence))) {
          issue.status = 'reproduced'; issue.history.push({ at: record.updatedAt, status: issue.status, reason: 'Новая независимая пригодная попытка воспроизвела дефект.', evidenceIds: [assessmentId] });
        }
      }
    }
  }
  return { issues, suggestions };
}

function eligibleRecurrence(issue: Issue, evidence: IssueEvidence): boolean {
  return !evidence.assessment.trial.diagnosticReceipt && !!issue.resolution && evidence.targetIdentity === issue.resolution.candidateIdentity && !!evidence.executionCreatedAt && Date.parse(evidence.executionCreatedAt) > Date.parse(issue.resolution.closedAt);
}

export function decideIssueMerge(existing: Issue[], decision: IssueDecision): Issue[] {
  const issues = structuredClone(existing), from = issues.find(i => i.id === decision.fromIssueId), into = issues.find(i => i.id === decision.intoIssueId);
  if (!from || !into || from.id === into.id || into.mergedInto || from.kind !== into.kind || from.identity.criterionHash !== into.identity.criterionHash) throw new Error('Объединение требует двух проблем одного вида и неизменного критерия.');
  if (from.mergedInto === into.id) return issues;
  if (from.mergedInto) throw new Error('Проблема уже связана с другой.');
  const recurrence = from.evidence.find(e => !into.occurrences.includes(e.executionId) && eligibleRecurrence(into, e));
  if (into.status === 'resolved' && recurrence) { into.status = 'reproduced'; into.history.push({ at: decision.at, status: 'reproduced', reason: 'При объединении обнаружена новая пригодная регрессия версии после закрытия.', evidenceIds: [recurrence.assessmentId] }); }
  into.evidence.push(...from.evidence.filter(e => !into.evidence.some(other => other.assessmentId === e.assessmentId)));
  // Older journals may already contain diagnostic evidence with no outer runKind.
  // Keep those immutable assessments for inspection, never count them as independent executions.
  const diagnosticExecutions = new Set(into.evidence.filter(e => e.assessment.trial.diagnosticReceipt).map(e => e.executionId));
  into.occurrences = [...new Set([...into.occurrences, ...from.occurrences])].filter(id => !diagnosticExecutions.has(id));
  into.businessScenarios = [...new Set([...into.businessScenarios, ...from.businessScenarios])];
  into.experiments = [...new Set([...into.experiments, ...from.experiments])];
  into.history.push({ at: decision.at, status: into.status, reason: `Решение владельца ${decision.id}: ${decision.reason}`, evidenceIds: from.evidence.map(e => e.assessmentId) });
  from.mergedInto = into.id;
  return issues;
}

const journalSchema = z.strictObject({ formatVersion: z.literal('1'), issues: z.array(issueSchema), suggestions: z.array(z.strictObject({ issueId: id, candidateId: id, reason: z.string() })), decisions: z.array(issueDecisionSchema), resolutions: z.array(resolutionFileSchema).default([]) });
export type IssueJournal = z.infer<typeof journalSchema>;
/** File operations are called only inside ExperimentStore's writer transaction. Journal is authoritative, index expendable. */
export class IssueFiles {
  constructor(private directory: string) {}
  async read(): Promise<IssueJournal> {
    const dir = join(this.directory, 'issues', 'journal');
    let names: string[];
    try { names = (await readdir(dir)).filter(n => /^\d{12}\.json$/.test(n)).sort(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { formatVersion: '1', issues: [], suggestions: [], decisions: [], resolutions: [] }; throw error; }
    const last = names.at(-1);
    return last ? journalSchema.parse(JSON.parse(await readFile(join(dir, last), 'utf8'))) : { formatVersion: '1', issues: [], suggestions: [], decisions: [], resolutions: [] };
  }
  async write(value: IssueJournal): Promise<void> {
    const validated = journalSchema.parse(value), dir = join(this.directory, 'issues'), journal = join(dir, 'journal');
    await mkdir(journal, { recursive: true, mode: 0o700 });
    const numbers = (await readdir(journal)).filter(n => /^\d{12}\.json$/.test(n)).map(n => Number(n.slice(0, 12)));
    await atomicPrivateJson(join(journal, `${String(Math.max(0, ...numbers) + 1).padStart(12, '0')}.json`), validated);
    await atomicPrivateJson(join(dir, 'index.json'), validated);
  }
}
export async function atomicPrivateJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { const file = await open(temp, 'wx', 0o600); try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); } finally { await file.close(); } await rename(temp, path); }
  finally { await unlink(temp).catch(() => {}); }
}
