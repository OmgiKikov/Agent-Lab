import { randomUUID } from 'node:crypto';
import { materialSources, type CreateInput, type Settings } from '../contracts.js';
import { Stopped } from '../errors.js';
import { roleChoices } from '../llm/models.js';
import type { BuilderModel } from '../miner/topic-map.js';
import type { Runtime } from '../runtime.js';
import type { ImportBatch } from '../scenario-contracts.js';
import { clip } from '../text.js';
import { analysisConsent, analysisTime, type AnalysisConsent } from '../discover/consent.js';
import { analysisId, runAnalysis } from '../discover/analyze.js';
import { ANALYSIS_LIMIT, ANALYSIS_PROTOCOL, DEFAULT_ANALYSED, PER_TOPIC_LIMIT, analysisSchema, findingReviewSchema, type LogAnalysis } from '../discover/schema.js';
import type { Lab } from './context.js';

/*
 * The log analysis as an operation of the lab (DISCOVER): the consent, the analysis itself, the owner's word on a
 * finding. It runs as the lab's one operation beside the runs (operation.ts beside): its own budget — the ceiling the
 * owner agreed to — its own time, the same cancel; it writes its own record and never a run's. A stop, the budget, the
 * time or a failure leave the findings made so far, and the record says what was not reached and why.
 */

/** What an analysis is asked for: the logs as read, the owner's materials, the models, how many conversations. */
export interface AnalyzeInput {
  task: string;
  mode: 'demo' | 'live';
  materials: CreateInput['materials'];
  logs: ImportBatch;
  /** The log's file name, as the owner knows it. */
  file: string;
  requested?: number;
  settings: Settings;
}

/** What the analysis context needs beyond the lab: its runtime, and who follows its record. */
export interface DiscoverHost {
  runtime(mode: 'demo' | 'live', settings: Settings, id: string): Promise<Runtime>;
  builder(mode: 'demo' | 'live', settings: Settings): BuilderModel;
  announce(analysis: LogAnalysis): void;
  /** The running analysis, while it runs. */
  live: { current?: LogAnalysis };
}

const requestedOf = (input: Pick<AnalyzeInput, 'requested'>): number => {
  const count = input.requested ?? DEFAULT_ANALYSED;
  if (!Number.isInteger(count) || count < 1 || count > ANALYSIS_LIMIT) throw new Error(`Число разговоров для разбора — целое от 1 до ${ANALYSIS_LIMIT}.`);
  return count;
};
const judgeOf = (settings: Settings) => { const { judge } = roleChoices(settings); return { provider: judge.provider, model: judge.model }; };

/** The consent of an analysis before anything is spent: what is read and left out, how many are judged, the ceiling. */
export async function consentOf(lab: Lab, host: DiscoverHost, input: AnalyzeInput): Promise<AnalysisConsent> {
  const sources = materialSources(input.materials);
  return analysisConsent(lab.store, { batch: input.logs, task: input.task, sources, requested: requestedOf(input),
    builder: host.builder(input.mode, input.settings), judge: judgeOf(input.settings), demo: input.mode === 'demo' });
}

/** Why the analysis ended short, by what stopped it. */
function unfinishedOf(error: unknown, signal: AbortSignal): NonNullable<LogAnalysis['unfinished']> {
  const stop = error instanceof Stopped ? error.reason : signal.aborted && signal.reason instanceof Stopped ? signal.reason.reason : undefined;
  if (stop === 'budget') return 'budget';
  if (stop === 'time') return 'time';
  if (stop === 'closing') return 'closing';
  if (stop === 'cancelled') return 'stopped';
  return 'failed';
}

/**
 * Starts the analysis the owner agreed to, within `callCeiling`, and returns once its record is saved as started; the
 * work goes on beside the runs, in the background.
 */
export async function analyze(lab: Lab, host: DiscoverHost, input: AnalyzeInput, options: { callCeiling: number }): Promise<LogAnalysis> {
  const requested = requestedOf(input);
  const sources = materialSources(input.materials);
  const builder = host.builder(input.mode, input.settings);
  const now = new Date().toISOString();
  const analysis: LogAnalysis = analysisSchema.parse({
    formatVersion: 1, protocol: ANALYSIS_PROTOCOL, id: analysisId(), createdAt: now, updatedAt: now, status: 'running', message: 'Читаю логи.', mode: input.mode,
    task: input.task, logs: { importId: input.logs.id, contentHash: input.logs.contentHash, file: clip(input.file, 300), conversations: input.logs.sample?.dialogues ?? input.logs.dialogues.length + input.logs.rejected.length, readable: input.logs.dialogues.length },
    selection: { requested, perTopic: PER_TOPIC_LIMIT, method: 'topics', picked: [], unjudgeable: [] }, sources,
    models: { builder: { provider: builder.provider, model: builder.id }, judge: judgeOf(input.settings) },
    budget: { ceiling: options.callCeiling, spent: 0 }, topics: [], requirements: [], scenarios: [], assignments: [], findings: [], reviews: [],
  });
  let ready!: () => void;
  let failed!: (error: unknown) => void;
  const started = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
  const save = async (message?: string) => {
    if (message !== undefined) analysis.message = message;
    analysis.updatedAt = new Date().toISOString();
    await lab.store.writeAnalysis(analysis);
    host.announce(analysis);
  };
  const done = lab.operations.beside(analysis.id, async (ctx, operation) => {
    host.live.current = analysis;
    const account = () => { analysis.budget.spent = operation.spent; };
    try {
      try {
        const batch = await lab.store.writeImport(input.logs);
        analysis.logs.importId = batch.id; analysis.logs.contentHash = batch.contentHash;
        await save();
        ready();
      } catch (error) { failed(error); throw error; }
      const runtime = await host.runtime(input.mode, input.settings, analysis.id);
      const batch = await lab.store.readImport(analysis.logs.importId);
      await runAnalysis(analysis, batch, { runtime, ctx, operation, store: lab.store,
        checkpoint: message => { account(); return save(message); },
        say: message => { analysis.message = message; host.announce(analysis); } });
      account();
      analysis.status = 'done';
      await save('Разбор завершён.');
    } catch (error) {
      account();
      const unfinished = unfinishedOf(error, ctx.signal);
      analysis.status = unfinished === 'failed' ? 'failed' : 'stopped';
      analysis.unfinished = unfinished;
      analysis.error = clip(error instanceof Error ? error.message : String(error), 4000);
      for (const group of analysis.topics) if (!group.scenarioId && !group.planFailure) group.planFailure = 'not_reached';
      await save(analysis.status === 'failed' ? `Разбор прервался: ${analysis.error}` : 'Разбор остановлен; найденное сохранено.').catch(() => {});
    } finally { if (host.live.current === analysis) delete host.live.current; }
  }, { budget: { calls: options.callCeiling, timeMs: analysisTime(requested) }, timeoutMs: input.settings.timeoutMs });
  // Refused before it started (another operation is going on): the caller hears why. What the work did not survive
  // after it started is written on its record above, and a settled start ignores it.
  void done.catch(error => failed(error));
  await started;
  return structuredClone(analysis);
}

/** The owner's word on one finding: kept beside the judge's verdict, never over it; the latest word per finding holds. */
export async function reviewFinding(lab: Lab, host: DiscoverHost, id: string, input: { key: string; verdict: 'confirmed' | 'disputed' | 'unsure'; note: string; via: 'pi-confirm' | 'cli-yes' }): Promise<LogAnalysis> {
  return lab.operations.change(async () => {
    const analysis = await lab.store.readAnalysis(id);
    const finding = analysis.findings.find(item => item.key === input.key);
    if (!finding) throw new Error('Такой находки в этом разборе нет.');
    if (input.verdict === 'disputed' && !input.note.trim()) throw new Error('Оспорить находку можно только с причиной: почему это не нарушение.');
    analysis.reviews.push(findingReviewSchema.parse({ id: randomUUID(), createdAt: new Date().toISOString(), key: finding.key, verdict: input.verdict,
      note: clip(input.note, 3000), judgeVerdict: finding.result, via: input.via }));
    analysis.updatedAt = new Date().toISOString();
    await lab.store.writeAnalysis(analysis);
    host.announce(analysis);
    return analysis;
  });
}

/** An analysis a process that is gone left running: it ends as interrupted, with what it made kept. */
export async function settleInterrupted(lab: Lab): Promise<void> {
  for (const analysis of await lab.store.listAnalyses()) {
    if (analysis.status !== 'running') continue;
    analysis.status = 'interrupted';
    analysis.message = 'Разбор прервался: процесс Lab завершился раньше. Найденное сохранено.';
    for (const group of analysis.topics) if (!group.scenarioId && !group.planFailure) group.planFailure = 'not_reached';
    analysis.updatedAt = new Date().toISOString();
    await lab.store.writeAnalysis(analysis);
  }
}

