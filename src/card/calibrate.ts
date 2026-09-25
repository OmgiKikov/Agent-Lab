import { fingerprint, type Experiment } from '../contracts.js';
import type { CallContext, Runtime } from '../runtime.js';
import { BudgetExhausted, Stopped } from '../errors.js';
import { observableSources, scenarioSources } from '../judge.js';
import { pluralForm } from '../plural.js';
import type { ImportBatch } from '../scenario-contracts.js';
import type { ExperimentStore } from '../store.js';
import { CALIBRATION_PROTOCOL, LOGGED_MODE, logJudgmentReceiptSchema, type Calibration, type LogJudge, type LogJudgeRequest, type LogJudgmentReceipt } from './calibration.js';
import { calibrationCalls, cardLogSituation, logSkip, runLogSituations, testedVersion, type LogSituation } from './calibration-scope.js';
import { calibrationKey, logJudgeInputV1, logJudgmentComplete } from './log-judge.js';

/*
 * The calibration step of a run (docs/design/card-v2-spec.md §10.3–10.6): after the synthetic attempts are judged, every expectation
 * of every situation from a log is judged once more on the recorded conversation — judge calls only; no agent,
 * simulator or stand is started.
 *
 *   situations ──read imports + declared versions──► keys ──skip / reuse by key──► judge the rest ──► receipts
 *
 * A key is judged once: a repeat or a reassessment with the same cards, logs and judge copies the receipt and
 * its sidecar from the run it came from and pays nothing. The calls come out of the run's own limit: when that
 * cannot cover them the calibration is skipped whole, before any call, with the reason. Whatever happens here
 * — a stop, a failed request, a broken import — the synthetic result stands: this step never throws, and the
 * calibration records why it did not finish as a typed cause (`unfinished`), never as a sentence to decode.
 */

type CalibrationStore = Pick<ExperimentStore, 'get' | 'readImport' | 'readLogVersions' | 'readCalibrationAudit' | 'writeCalibrationAudit'>;

/** Expectations judged at once: two votes each, so four keep eight requests in flight, as one attempt's judgment does. */
const CALIBRATION_CONCURRENCY = 4;

/** The logs could not be read, or are no longer the ones the situations were made from: nothing of them is judged. */
class LogsUnavailable extends Error {}

/** The imports of the situations that have a log, read once and checked against the content the cards were made from. */
async function logBatches(store: Pick<ExperimentStore, 'readImport'>, situations: readonly LogSituation[]): Promise<Map<string, ImportBatch>> {
  const batches = new Map<string, ImportBatch>();
  for (const log of situations.flatMap(situation => situation.exclusion || !situation.log ? [] : [situation.log])) {
    if (batches.has(log.importId)) continue;
    let batch: ImportBatch;
    try { batch = await store.readImport(log.importId); } catch (error) { throw new LogsUnavailable(error instanceof Error ? error.message : String(error)); }
    if (batch.contentHash !== log.importContentHash) throw new LogsUnavailable('Импорт логов не совпадает с тем, из которого сделаны ситуации.');
    batches.set(log.importId, batch);
  }
  return batches;
}

/** Why a calibration stopped on `error`: the run's stop or its budget, the logs, or a failure of the calibration itself. */
function unfinishedCause(error: unknown, signal: AbortSignal): NonNullable<Calibration['unfinished']> {
  if (error instanceof Stopped) return error.reason === 'budget' ? 'budget' : 'stopped';
  if (signal.aborted) return 'stopped';
  return error instanceof LogsUnavailable ? 'logs' : 'failed';
}

interface Job { key: string; request: LogJudgeRequest; skipped?: LogJudgmentReceipt['skipped']; identity: Omit<LogJudgmentReceipt, 'mode' | 'key' | 'protocolHash' | 'inputHash' | 'auditHash' | 'provider' | 'model' | 'skipped' | 'votes' | 'result' | 'complete'> }

/** One key per expectation of every situation whose conversation is in its import, in the run's order. */
function plannedJobs(record: Experiment, situations: ReturnType<typeof runLogSituations>, batches: ReadonlyMap<string, ImportBatch>, judge: LogJudge): Job[] {
  return situations.flatMap(situation => {
    const batch = !situation.exclusion && situation.log ? batches.get(situation.log.importId) : undefined;
    const dialogue = batch?.dialogues.find(item => item.id === situation.log!.dialogueId);
    if (!batch || !dialogue || !situation.scenario.execution) return [];
    const { scenario } = situation;
    const sources = observableSources(scenarioSources(record, scenario), record.requirements);
    return situation.expectations.map(({ expectation, letter }): Job => {
      const identity = { cardId: scenario.id, expectationId: expectation.id, definitionHash: fingerprint(scenario), importId: batch.id, importContentHash: batch.contentHash, dialogueId: dialogue.id };
      const key = calibrationKey({ ...identity, protocolHash: judge.protocolHash });
      const skipped = logSkip(expectation, dialogue, situation.log!.opening);
      return { key, identity, ...(skipped ? { skipped } : {}), request: { key, expectation, letter, card: situation.card, requirements: scenario.execution!.evaluatorView.requirements,
        sources, importContentHash: batch.contentHash, dialogue: { observation: dialogue.observation, events: dialogue.events } } };
    });
  });
}

/** A key the log cannot show: its receipt without a call. */
const skippedReceipt = (job: Job, judge: LogJudge): LogJudgmentReceipt => logJudgmentReceiptSchema.parse({
  mode: LOGGED_MODE, key: job.key, ...job.identity, protocolHash: judge.protocolHash, inputHash: fingerprint(logJudgeInputV1(job.request)),
  provider: judge.provider, model: judge.model, skipped: job.skipped, votes: [], result: 'unknown', complete: true });

/**
 * The receipts of the run this one came from (a repeat or a reassessment) that answer these keys under the same
 * judge, each with its sidecar copied into this run. A receipt is reused only if it still stands: its own key,
 * this run's accepted definition, and the audit on disk that it seals.
 */
async function reusedReceipts(record: Experiment, jobs: readonly Job[], judge: LogJudge, store: CalibrationStore): Promise<Map<string, LogJudgmentReceipt>> {
  const reused = new Map<string, LogJudgmentReceipt>();
  const source = record.parentRunId ? await store.get(record.parentRunId).catch(() => undefined) : undefined;
  const earlier = new Map((source?.calibration?.entries ?? []).map(entry => [entry.key, entry]));
  for (const job of jobs) {
    const entry = earlier.get(job.key);
    if (!source || !entry || job.skipped || entry.provider !== judge.provider || entry.model !== judge.model) continue;
    const audit = await store.readCalibrationAudit(source.id, entry.key).catch(() => null);
    if (!audit || !logJudgmentComplete(entry, record, { audit })) continue;
    store.writeCalibrationAudit(record.id, entry.key, audit);
    reused.set(job.key, entry);
  }
  return reused;
}

/** The declared version of each import compared, as it stands now: the run keeps this snapshot. An import nobody declared has no row. */
async function declaredVersions(store: CalibrationStore, batches: ReadonlyMap<string, ImportBatch>): Promise<Calibration['logVersions']> {
  const rows: Calibration['logVersions'] = [];
  for (const batch of batches.values()) {
    const last = (await store.readLogVersions(batch.id))?.declarations.at(-1);
    if (last) rows.push({ importId: batch.id, contentHash: batch.contentHash, version: last.command.version, receiptId: last.id });
  }
  return rows;
}

export interface CalibrationWork {
  runtime: Runtime;
  ctx: CallContext;
  store: CalibrationStore;
  /** Saves the record with a progress line; the run's own checkpoint. */
  checkpoint(message: string): Promise<void>;
  /** The calls the run's own budget has left (lab/operation.ts); without it, what the draft's limit leaves of the record's calls. */
  callsLeft?(): number;
}

/** What the run leaves for the calibration: its own budget's rest, or — for a caller without one — the draft's limit less the record's calls. */
const callsLeft = (record: Experiment, work: CalibrationWork): number => work.callsLeft?.() ?? record.settings.maxCalls - record.usage.calls;

/**
 * Calibrates a run whose synthetic attempts are judged. Nothing happens when the owner turned calibration off,
 * the runtime has no judge of recorded conversations, or no situation of the run was taken from a log.
 */
export async function calibrateRun(record: Experiment, work: CalibrationWork): Promise<void> {
  const judge = work.runtime.logJudge;
  const situations = runLogSituations(record);
  if (record.settings.calibration === 'off' || !judge || !situations.some(situation => situation.log)) return;
  const calibration: Calibration = { protocol: CALIBRATION_PROTOCOL, logVersions: [], testedVersion: testedVersion(record), entries: [] };
  record.calibration = calibration;
  try {
    const batches = await logBatches(work.store, situations);
    calibration.logVersions = await declaredVersions(work.store, batches);
    const jobs = plannedJobs(record, situations, batches, judge);
    const done = new Map<string, LogJudgmentReceipt>(await reusedReceipts(record, jobs, judge, work.store));
    for (const job of jobs) if (job.skipped) done.set(job.key, skippedReceipt(job, judge));
    const publish = () => { calibration.entries = jobs.flatMap(job => done.get(job.key) ?? []); };
    publish();
    const pending = jobs.filter(job => !done.has(job.key));
    if (2 * pending.length > callsLeft(record, work)) { calibration.unfinished = 'budget'; return; }
    await judgeAll(record, pending, judge, work, receipt => { done.set(receipt.key, receipt); publish(); }, done.size);
  } catch (error) {
    // A broken import or store stops only the calibration; the run's result is kept as it was.
    calibration.unfinished ??= unfinishedCause(error, work.ctx.signal);
    record.limitations.push(`Сверка с продом не завершена: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Judges the keys a few at a time, saving each receipt as it comes; a stop ends the calibration and says why. */
async function judgeAll(record: Experiment, pending: readonly Job[], judge: LogJudge, work: CalibrationWork, finish: (receipt: LogJudgmentReceipt) => void, already: number): Promise<void> {
  const calibration = record.calibration!;
  const total = already + pending.length;
  const ctx: CallContext = { ...work.ctx, onTargetEvent: undefined, onTrace: undefined,
    // The calibration never draws the run over its limit: a call past what the run left is refused, and the run's result stands.
    beforeCall() {
      if (callsLeft(record, work) <= 0) throw new BudgetExhausted('Лимит вызовов модели исчерпан: сверка с продом остановлена, результат прогона не изменился.');
      work.ctx.beforeCall();
    },
    onJudgment: (key, audit) => work.store.writeCalibrationAudit(record.id, key, audit) };
  let next = 0, finished = already;
  const worker = async (): Promise<void> => {
    while (next < pending.length && !calibration.unfinished) {
      const job = pending[next++]!;
      try {
        const judgment = await judge.assess(job.request, ctx);
        finish(logJudgmentReceiptSchema.parse({ mode: LOGGED_MODE, key: job.key, ...job.identity, ...judgment }));
        finished++;
        await work.checkpoint(`Сверяю с продом: ${finished} из ${total} · агент и клиент не запускаются`);
      } catch (error) {
        // The first cause holds: the workers that stop after it only follow it.
        calibration.unfinished ??= unfinishedCause(error, work.ctx.signal);
        if (!(error instanceof Stopped) && !work.ctx.signal.aborted) throw error;
      }
    }
  };
  // Every worker settles before the step returns: none may save the record once the run has moved on.
  const settled = await Promise.allSettled(Array.from({ length: Math.min(CALIBRATION_CONCURRENCY, pending.length) }, worker));
  const failed = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (failed) throw failed.reason;
}

/**
 * The launch dialog's line about calibration (docs/design/card-v2-spec.md §10.6): «Сверка с продом: до 60 вызовов судьи; агент и
 * симулятор не участвуют» — the most judge calls it may make before a re-ask, out of the run's own limit. Null
 * when the run will not calibrate: the owner turned it off, the teaching example (its judge reads no logs), or
 * nothing of a log to judge. `cardIds` are the cards of a draft accepted with the run; otherwise the run's situations.
 */
export async function calibrationConsent(store: Pick<ExperimentStore, 'readImport'>, record: Experiment, cardIds?: readonly string[]): Promise<{ calls: number; line: string } | null> {
  if (record.settings.calibration === 'off' || record.mode === 'demo') return null;
  const library = record.librarySnapshot;
  const situations: LogSituation[] = library?.formatVersion === 2 && cardIds
    ? cardIds.flatMap(id => library.cards.filter(card => card.id === id).map(card => cardLogSituation(library, card)))
    : runLogSituations(record);
  // A log that cannot be read will not be judged: the run spends nothing on it, so the line promises nothing.
  const batches = await logBatches(store, situations).catch(() => new Map<string, ImportBatch>());
  const calls = calibrationCalls(situations, (importId, dialogueId) => batches.get(importId)?.dialogues.find(dialogue => dialogue.id === dialogueId));
  return calls ? { calls, line: `Сверка с продом: до ${calls} ${pluralForm(calls, ['вызова', 'вызовов', 'вызовов'])} судьи; агент и симулятор не участвуют` } : null;
}
