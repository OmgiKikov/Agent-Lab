import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fingerprint, type Experiment } from './contracts.js';
import { isRunning } from './phases.js';
import type { ExperimentStore } from './store.js';
import { compareRuns, markReconstructedSource, type RunComparison } from './comparison.js';
import { htmlReport, jsonReport, markdownReport } from './report.js';
import { buildResultView, type ResultView } from './result-view.js';
import { countText } from './plural.js';
import { dialogueNumbers, type DialogueNumbers } from './card/view.js';
import type { ImportBatch } from './scenario-contracts.js';
import { ScenarioFiles } from './scenario-store.js';

export interface EvidenceBundle {
  record: Experiment;
  /** The one result every surface shows, stability checked against the resolved source run. */
  view: ResultView;
  before?: Experiment;
  comparison?: RunComparison;
  comparisonSource?: { kind: 'parent' | 'selected' | 'embedded'; beforeId: string; afterId: string };
  warnings: string[];
  traceJournal: string;
  /** The numbers the owner knows imported dialogues by («из диалога №17»): a card library only references its imports, so an export reads them. */
  dialogueNumbers?: DialogueNumbers;
}
/**
 * Why a stored run could not be read, in words a reader of any surface may see: never the file path or
 * the run id an I/O error carries (the owner reaches the file from the run itself).
 */
const failureText = (error: unknown) => error instanceof Error && error.name === 'ZodError' ? 'Запись не соответствует формату Agent Lab.'
  : (error as NodeJS.ErrnoException).code === 'EACCES' ? 'Нет прав на чтение файла.' : 'Файл повреждён или слишком большой.';

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
  before.phase = 'results_review'; before.message = 'Исходный прогон восстановлен из сохранённого набора.';
  before.trials = structuredClone(source.trials); before.humanReviews = structuredClone(source.humanReviews);
  before.manifestHash = source.identity?.manifestHash ?? before.trials[0]?.manifestHash ?? null;
  before.reviewedAt ??= before.createdAt; before.reviewMode ??= 'automated';
  before.usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: null };
  before.error = null;
  before.limitations = [...before.limitations, 'Восстановленный прогон содержит сохранённые попытки и определения ситуаций из набора, но не остальные данные исходного прогона.'];
  delete before.sourceEvidence; delete before.failureModes; delete before.releaseLog;
  delete before.assessmentOf; delete before.assessmentTrialIds; delete before.evidenceHash;
  return markReconstructedSource(before);
}

/** The source run a derived record is read against, and what the reader must be told about it. */
interface ResolvedSource { before?: Experiment; embedded: boolean; warning?: string }

/**
 * Reads the source run once, the same way on every surface. Only a missing file falls back to the
 * evidence the record embedded; a corrupt, oversized, unreadable or mismatched record is reported
 * as it is and never replaced by the embedded copy.
 */
async function resolveSource(record: Experiment, store: Pick<ExperimentStore, 'get'>, sourceId: string): Promise<ResolvedSource> {
  try { return { before: await store.get(sourceId), embedded: false }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { embedded: false, warning: `Исходный прогон не удалось прочитать: ${failureText(error)} Сравнение и стабильность не проверены; встроенная копия не подставлялась, чтобы не скрыть повреждение.` };
    }
    const before = embeddedBefore(record, sourceId);
    return before
      ? { before, embedded: true, warning: 'Исходный прогон не найден. Сравнение восстановлено из сохранённых в наборе ситуаций и разговоров: это сравнение по парам, не полная копия исходного прогона.' }
      : { embedded: false, warning: 'Исходный прогон не найден. Сравнение не выполнено; этот прогон сохранён полностью.' };
  }
}

type BundleStore = Pick<ExperimentStore, 'get' | 'traceJournal'> & Partial<Pick<ExperimentStore, 'readJudgeAudit' | 'readImport'>>;

/**
 * A receipt is sealed with the hash of the full audit in `{runId}.judge/{trialId}.json`. When that
 * file can be read it must match; otherwise the receipt is marked incomplete in this in-memory copy,
 * so no comparison trusts it. A missing file keeps the record-only check and is said in words.
 */
async function verifyReceipts(run: Experiment, store: Partial<Pick<ExperimentStore, 'readJudgeAudit'>>, label: string): Promise<string[]> {
  if (!store.readJudgeAudit) return [];
  const mismatched: string[] = [], unreadable: string[] = [], missing: string[] = [];
  for (const trial of run.trials) {
    const receipt = trial.judgeReceipt;
    if (!receipt || trial.judgeAudit) continue;
    try {
      const audit = await store.readJudgeAudit(run.id, trial.id);
      if (!audit) { missing.push(trial.id); continue; }
      if (fingerprint(audit) === receipt.auditHash) continue;
      mismatched.push(trial.id);
    } catch { unreadable.push(trial.id); }
    receipt.complete = false;
  }
  const talks = (n: number) => countText(n, ['разговора', 'разговоров', 'разговоров']);
  return [
    ...(mismatched.length ? [`${label}: запись оценки судьи не совпала с полной оценкой у ${talks(mismatched.length)}. Эти оценки не считаются завершёнными и не входят в сравнение.`] : []),
    ...(unreadable.length ? [`${label}: полную оценку судьи не удалось прочитать у ${talks(unreadable.length)}. Эти оценки не считаются завершёнными и не входят в сравнение.`] : []),
    ...(missing.length ? [`${label}: полная оценка судьи не найдена у ${talks(missing.length)}. Оценки проверены только по самой записи.`] : []),
  ];
}

/** A record and its source run as every surface must read them: receipts checked against sidecars, warnings in words. */
interface VerifiedRuns { record: Experiment; before?: Experiment; embedded: boolean; warnings: string[] }

/**
 * The one path from stored files to a comparison: a copy of `record` with its receipts checked,
 * the source run resolved by `resolveSource` and, when it is a stored run, its receipts checked too.
 * Used by `evidenceBundle` (Pi, exports) and by the CLI, so they never disagree.
 */
export async function resolveVerified(record: Experiment, store: Pick<ExperimentStore, 'get'> & Partial<Pick<ExperimentStore, 'readJudgeAudit'>>, sourceId?: string): Promise<VerifiedRuns> {
  const copy = structuredClone(record);
  const result: VerifiedRuns = { record: copy, embedded: false, warnings: await verifyReceipts(copy, store, 'Этот прогон') };
  if (!sourceId) return result;
  const source = await resolveSource(copy, store, sourceId);
  result.embedded = source.embedded;
  if (source.warning) result.warnings.push(source.warning);
  if (source.before) {
    // The embedded copy has no sidecar of its own; its receipts were checked when they were embedded.
    if (!source.embedded) result.warnings.push(...await verifyReceipts(source.before, store, 'Исходный прогон'));
    result.before = source.before;
  }
  return result;
}

/** Resolve the persisted relationship once, independently of navigation and export format. */
export async function evidenceBundle(record: Experiment, store: BundleStore, beforeId?: string): Promise<EvidenceBundle> {
  const parent = beforeId ?? record.parentRunId;
  const verified = await resolveVerified(record, store, parent);
  const snapshot = verified.record;
  // Only a calibration's disagreements need the dialogues' places in their imports: other bundles read no import.
  const numbers = store.readImport && snapshot.calibration?.entries.length ? await importNumbers(snapshot, store.readImport.bind(store)) : undefined;
  // Stability is checked against the resolved source run; the headline itself never depends on it.
  const bundle: EvidenceBundle = { record: snapshot, view: buildResultView(snapshot, { before: verified.before, ...(numbers ? { numbers } : {}) }), warnings: [...verified.warnings], traceJournal: '',
    ...(numbers ? { dialogueNumbers: numbers } : {}) };
  if (parent) {
    bundle.comparisonSource = { kind: verified.embedded ? 'embedded' : beforeId && beforeId !== snapshot.parentRunId ? 'selected' : 'parent', beforeId: parent, afterId: snapshot.id };
    if (verified.before) { bundle.before = verified.before; bundle.comparison = compareRuns(verified.before, snapshot); }
  }
  try { bundle.traceJournal = await store.traceJournal(snapshot.id); }
  catch { bundle.warnings.push('Журнал событий прогона недоступен; реплики взяты из самой записи прогона.'); }
  if (isRunning(snapshot.phase)) {
    bundle.warnings.push('Прогон ещё идёт. Этот снимок содержит доступные сейчас доказательства; после завершения экспортируйте итог заново.');
  }
  return bundle;
}

/**
 * The dialogue numbers of a card run's imports («из диалога №17», «диалог №17 из логов»). They only name where a
 * situation came from, so an import that cannot be read leaves the number out instead of failing the reader.
 */
export async function importNumbers(record: Experiment, readImport: (id: string) => Promise<ImportBatch>): Promise<DialogueNumbers | undefined> {
  const library = record.librarySnapshot;
  if (library?.formatVersion !== 2 || !library.imports.length) return undefined;
  return Promise.all(library.imports.map(item => readImport(item.id))).then(dialogueNumbers, () => undefined);
}

/** Each format consumes the same snapshot; canonical raw evidence paths stay compatible with Pi tools. */
export async function exportArtifacts(input: EvidenceBundle, directory: string) {
  const exportDir = resolve(directory, 'exports');
  await mkdir(exportDir, { recursive: true, mode: 0o700 });
  const store = new ScenarioFiles(directory);
  const bundle = { ...input, dialogueNumbers: input.dialogueNumbers ?? await importNumbers(input.record, id => store.readImport(id)) };
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
