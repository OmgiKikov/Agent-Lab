import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Experiment } from './contracts.js';
import type { ExperimentStore } from './store.js';
import { compareRuns, evidenceSummary, markReconstructedSource, type EvidenceSummary, type RunComparison } from './comparison.js';
import { qualitySummary, type QualitySummary } from './quality.js';
import { htmlReport, jsonReport, markdownReport } from './report.js';
import { buildResultView, type ResultView } from './result-view.js';

export interface EvidenceBundle {
  record: Experiment;
  evidence: EvidenceSummary;
  /** The first-screen answer, derived from the same helpers as `evidence`; never a separate count. */
  quality: QualitySummary;
  /** The headline block every surface shows; never a separate count. Readers fall back to `buildResultView(record)`. */
  view?: ResultView;
  before?: Experiment;
  comparison?: RunComparison;
  comparisonSource?: { kind: 'parent' | 'selected' | 'embedded'; beforeId: string; afterId: string };
  warnings: string[];
  traceJournal: string;
}
const failureText = (error: unknown) => (error instanceof Error ? error.name === 'ZodError' ? 'Запись не соответствует формату Agent Lab.' : error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);

/** The source run rebuilt from the evidence a derived record carries; undefined when it carries none for this id. */
export function embeddedBefore(record: Experiment, parentId: string): Experiment | undefined {
  const source = record.sourceEvidence;
  if (!source?.trials.length || source.runId !== parentId) return;
  const before = structuredClone(record);
  before.id = source.runId;
  // Only the embedded identity describes the source run; without it these fields stay the current ones
  // and stability refuses to compare (see markReconstructedSource).
  if (source.identity) {
    for (const key of ['targetFingerprint', 'targetVersion', 'evaluatorVersion'] as const) {
      if (source.identity[key] === undefined) delete before[key]; else before[key] = source.identity[key];
    }
  }
  before.parentRunId = source.parentRunId;
  before.phase = 'results_review'; before.message = 'Portable baseline reconstructed from the saved suite evidence.';
  before.trials = structuredClone(source.trials); before.humanReviews = structuredClone(source.humanReviews);
  before.manifestHash = before.trials[0]?.manifestHash ?? null;
  before.reviewedAt ??= before.createdAt; before.reviewMode ??= 'automated';
  before.usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: null };
  before.error = null;
  before.limitations = [...before.limitations, 'Portable baseline contains the saved attempts and current frozen definition, not the unavailable original run metadata.'];
  delete before.sourceEvidence; delete before.failureModes; delete before.releaseLog;
  delete before.assessmentOf; delete before.assessmentTrialIds; delete before.evidenceHash;
  return markReconstructedSource(before);
}

/** The source run a derived record is read against, and what the reader must be told about it. */
export interface ResolvedSource { before?: Experiment; embedded: boolean; warning?: string }

/**
 * Reads the source run once, the same way on every surface. Only a missing file falls back to the
 * evidence the record embedded; a corrupt, oversized, unreadable or mismatched record is reported
 * as it is and never replaced by the embedded copy.
 */
export async function resolveSource(record: Experiment, store: Pick<ExperimentStore, 'get'>, sourceId: string): Promise<ResolvedSource> {
  try { return { before: await store.get(sourceId), embedded: false }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { embedded: false, warning: `Исходный прогон ${sourceId} не удалось прочитать. Сравнение и стабильность не проверены; встроенная копия не подставлялась, чтобы не скрыть повреждение. ${failureText(error)}` };
    }
    const before = embeddedBefore(record, sourceId);
    return before
      ? { before, embedded: true, warning: `Базовый прогон ${sourceId} не найден. Сравнение восстановлено из frozen-определения и встроенных попыток набора; это парный diff, не статистическая оценка и не полная копия исходного прогона. ${failureText(error)}` }
      : { embedded: false, warning: `Базовый прогон ${sourceId} не найден. Сравнение не выполнено; текущие доказательства сохранены. ${failureText(error)}` };
  }
}

/** Resolve the persisted relationship once, independently of navigation and export format. */
export async function evidenceBundle(record: Experiment, store: Pick<ExperimentStore, 'get' | 'traceJournal'>, beforeId?: string): Promise<EvidenceBundle> {
  const snapshot = structuredClone(record);
  const bundle: EvidenceBundle = { record: snapshot, evidence: evidenceSummary(snapshot), quality: qualitySummary(snapshot), warnings: [], traceJournal: '' };
  const parent = beforeId ?? snapshot.parentRunId;
  if (parent) {
    const source = await resolveSource(snapshot, store, parent);
    bundle.comparisonSource = { kind: source.embedded ? 'embedded' : beforeId && beforeId !== snapshot.parentRunId ? 'selected' : 'parent', beforeId: parent, afterId: snapshot.id };
    if (source.before) { bundle.before = source.before; bundle.comparison = compareRuns(source.before, snapshot); }
    if (source.warning) bundle.warnings.push(source.warning);
  }
  // Stability is checked against the resolved source run; the headline itself never depends on it.
  bundle.view = buildResultView(snapshot, { before: bundle.before });
  try { bundle.traceJournal = await store.traceJournal(snapshot.id); }
  catch (error) { bundle.warnings.push(`Журнал трасс недоступен; реплики из записи включены в отчёт. ${failureText(error)}`); }
  if (['preparing', 'evaluating', 'baseline', 'improving', 'control'].includes(snapshot.phase)) {
    bundle.warnings.push('Прогон ещё идёт. Этот снимок содержит доступные сейчас доказательства; после завершения экспортируйте итог заново.');
  }
  return bundle;
}

/** Each format consumes the same snapshot; canonical raw evidence paths stay compatible with Pi tools. */
export async function exportArtifacts(bundle: EvidenceBundle, directory: string) {
  const exportDir = resolve(directory, 'exports');
  await mkdir(exportDir, { recursive: true, mode: 0o700 });
  const record = bundle.record;
  const stem = `${record.id}.${randomUUID().slice(0, 8)}`;
  const selected = record.target.kind === 'sandbox' ? record.revisions.find(r => r.id === record.selectedRevisionId)?.spec : undefined;
  const paths = {
    evidence: resolve(directory, `${record.id}.json`),
    traceJournal: resolve(directory, `${record.id}.trace.jsonl`),
    report: resolve(exportDir, `${stem}.report.md`),
    htmlReport: resolve(exportDir, `${stem}.report.html`),
    snapshot: resolve(exportDir, `${stem}.snapshot.json`),
    ...(selected ? { agent: resolve(exportDir, `${stem}.agent.json`) } : {}),
  };
  const files: [string, string][] = [
    [paths.report, markdownReport(bundle)], [paths.htmlReport, htmlReport(bundle)], [paths.snapshot, jsonReport(bundle)],
    ...(selected && paths.agent ? [[paths.agent, JSON.stringify(selected, null, 2)] as [string, string]] : []),
  ];
  const created: string[] = [];
  try {
    for (const [path, content] of files) { await writeFile(path, content, { mode: 0o600, flag: 'wx' }); created.push(path); }
  } catch (error) { await Promise.allSettled(created.map(path => unlink(path))); throw error; }
  return paths;
}
