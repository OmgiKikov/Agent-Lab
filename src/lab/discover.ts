import { randomUUID } from 'node:crypto';
import { DEFAULT_JUDGE, materialSources, settingsSchema, type CreateInput, type Settings } from '../contracts.js';
import { Stopped } from '../errors.js';
import { roleChoices } from '../llm/models.js';
import { ProviderFailure } from '../llm/model-call.js';
import { knowledgeOnly } from '../discover/facts.js';
import type { BuilderModel } from '../miner/topic-map.js';
import type { Runtime } from '../runtime.js';
import type { ImportBatch } from '../scenario-contracts.js';
import { clip } from '../text.js';
import { analysisConsent, analysisTime, continuationConsent, type AnalysisConsent, type ContinuationConsent } from '../discover/consent.js';
import { analysisId, analysisJobs, continueFrom, runAnalysis, selectMore, unfittedCount } from '../discover/analyze.js';
import { ANALYSIS_LIMIT, ANALYSIS_PROTOCOL, FACT_ANALYSIS_PROTOCOL, DEFAULT_ANALYSED, PER_TOPIC_LIMIT, analysisSchema, findingReviewSchema, logContractSchema, type LogAnalysis } from '../discover/schema.js';
import type { Lab } from './context.js';

/*
 * The log analysis as an operation of the lab (DISCOVER): the consent, the analysis itself, its continuation, the owner's
 * word on a finding. It runs as the lab's one operation beside the runs (operation.ts beside): its own budget — the
 * ceiling the owner agreed to — its own time, the same cancel; it writes its own record and never a run's. A stop, the
 * budget, the time or a failure leave the findings made so far, and the record says what was not reached and why.
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
  /**
   * The owner's word on what the log records beside the messages: the tools whose every call it writes into each
   * conversation it marks complete (discover/schema.ts logContractSchema). Absent — the owner said nothing.
   */
  logContract?: { tools: string[]; via: 'pi-confirm' | 'cli-yes' };
}

/** A continuation: the analysis it continues, how many more conversations, and the models of this session. */
export interface ContinueInput { analysisId: string; more?: number; settings?: Settings }

/** What the analysis context needs beyond the lab: its runtime, and who follows its record. */
export interface DiscoverHost {
  runtime(mode: 'demo' | 'live', settings: Settings, id: string): Promise<Runtime>;
  builder(mode: 'demo' | 'live', settings: Settings): BuilderModel;
  announce(analysis: LogAnalysis): void;
  /** The running analysis, while it runs. */
  live: { current?: LogAnalysis };
}

const requestedOf = (input: { requested?: number | undefined }): number => {
  const count = input.requested ?? DEFAULT_ANALYSED;
  if (!Number.isInteger(count) || count < 1 || count > ANALYSIS_LIMIT) throw new Error(`Число разговоров для разбора — целое от 1 до ${ANALYSIS_LIMIT}.`);
  return count;
};
const judgeOf = (settings: Settings) => { const { judge } = roleChoices(settings); return { provider: judge.provider, model: judge.model }; };

/** The consent of an analysis before anything is spent: what is read and left out, how many are judged, the ceiling. */
export async function consentOf(lab: Lab, host: DiscoverHost, input: AnalyzeInput): Promise<AnalysisConsent> {
  const sources = materialSources(input.materials);
  const contract = input.logContract && logContractSchema.parse({ ...input.logContract, confirmedAt: new Date().toISOString() });
  return analysisConsent(lab.store, { batch: input.logs, task: input.task, sources, requested: requestedOf(input),
    builder: host.builder(input.mode, input.settings), judge: judgeOf(input.settings), demo: input.mode === 'demo', ...(contract ? { recorded: contract.tools } : {}) });
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
 * Runs `analysis` as the lab's one operation within `callCeiling`, and returns once its record is saved as started; the
 * work goes on beside the runs, in the background. `start` stores what the work reads and returns its import; `before`
 * is the continuation's own selection, made inside the operation, under its ceiling.
 */
async function launch(lab: Lab, host: DiscoverHost, analysis: LogAnalysis, run: { mode: 'demo' | 'live'; settings: Settings; callCeiling: number; conversations: number;
  start: () => Promise<ImportBatch>; before?: (batch: ImportBatch, runtime: Runtime, work: Parameters<typeof runAnalysis>[2]) => Promise<void> }): Promise<LogAnalysis> {
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
      let batch: ImportBatch;
      try {
        batch = await run.start();
        await save();
        ready();
      } catch (error) { failed(error); throw error; }
      const runtime = await host.runtime(run.mode, run.settings, analysis.id);
      const work = { runtime, ctx, operation, store: lab.store,
        checkpoint: (message: string) => { account(); return save(message); },
        say: (message: string) => { analysis.message = message; host.announce(analysis); } };
      await run.before?.(batch, runtime, work);
      await runAnalysis(analysis, batch, work);
      account();
      analysis.status = 'done';
      await save('Разбор завершён.');
    } catch (error) {
      account();
      const unfinished = unfinishedOf(error, ctx.signal);
      analysis.status = unfinished === 'failed' ? 'failed' : 'stopped';
      analysis.unfinished = unfinished;
      analysis.error = clip(error instanceof Error ? error.message : String(error), 4000);
      // What failed, by its class: the owner is told by the kind, the words of the error stay in `error`.
      if (unfinished === 'failed') analysis.failure = error instanceof ProviderFailure ? error.retryable ? 'provider' : 'provider_refused' : 'other';
      for (const group of analysis.topics) if (!group.scenarioId && !group.planFailure) group.planFailure = 'not_reached';
      await save(analysis.status === 'failed' ? `Разбор прервался: ${analysis.failure === 'provider' ? 'связь с провайдером модели оборвалась' : analysis.failure === 'provider_refused' ? 'провайдер модели отказал' : 'произошла ошибка'}; найденное сохранено.`
        : 'Разбор остановлен; найденное сохранено.').catch(() => {});
    } finally { if (host.live.current === analysis) delete host.live.current; }
  }, { budget: { calls: run.callCeiling, timeMs: analysisTime(run.conversations) }, timeoutMs: run.settings.timeoutMs });
  // Refused before it started (another operation is going on): the caller hears why. What the work did not survive
  // after it started is written on its record above, and a settled start ignores it.
  void done.catch(error => failed(error));
  await started;
  return structuredClone(analysis);
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
  const contract = input.logContract && logContractSchema.parse({ ...input.logContract, confirmedAt: now });
  const analysis: LogAnalysis = analysisSchema.parse({
    formatVersion: 1, protocol: knowledgeOnly(sources) ? FACT_ANALYSIS_PROTOCOL : ANALYSIS_PROTOCOL, id: analysisId(), createdAt: now, updatedAt: now, status: 'running', message: 'Читаю логи.', mode: input.mode,
    task: input.task, logs: { importId: input.logs.id, contentHash: input.logs.contentHash, file: clip(input.file, 300), conversations: input.logs.sample?.dialogues ?? input.logs.dialogues.length + input.logs.rejected.length, readable: input.logs.dialogues.length,
      ...(contract ? { contract } : {}) },
    selection: { requested, perTopic: PER_TOPIC_LIMIT, method: 'topics', picked: [], unjudgeable: [], beyond: 'fitted' }, sources,
    ...(knowledgeOnly(sources) ? { checking: 'facts', factChecks: [] } : {}),
    models: { builder: { provider: builder.provider, model: builder.id }, judge: judgeOf(input.settings) },
    budget: { ceiling: options.callCeiling, spent: 0 }, topics: [], requirements: [], scenarios: [], assignments: [], findings: [], reviews: [],
  });
  return launch(lab, host, analysis, { mode: input.mode, settings: input.settings, callCeiling: options.callCeiling, conversations: requested,
    start: async () => {
      const batch = await lab.store.writeImport(input.logs);
      analysis.logs.importId = batch.id; analysis.logs.contentHash = batch.contentHash;
      return lab.store.readImport(batch.id);
    } });
}

/**
 * The models a continuation judges with: this session's, or — from the command line — those the continued analysis
 * recorded, the default judge with its pinned upstream when it was that one, so the same judge keeps its findings.
 */
function continuationSettings(earlier: LogAnalysis, settings: Settings | undefined): Settings {
  if (settings) return settings;
  const { builder, judge } = earlier.models;
  const pinned = judge.provider === DEFAULT_JUDGE.provider && judge.model === DEFAULT_JUDGE.model;
  return settingsSchema.parse({ provider: builder.provider, model: builder.model, timeoutMs: 600_000,
    ...(judge.provider && judge.model ? { judge: pinned ? { ...DEFAULT_JUDGE } : { provider: judge.provider, model: judge.model } } : {}) });
}

/** The analysis a continuation continues, finished — none runs twice —, with its import. */
async function continued(lab: Lab, id: string): Promise<{ earlier: LogAnalysis; batch: ImportBatch }> {
  const earlier = await lab.store.readAnalysis(id);
  if (earlier.status === 'running') throw new Error('Этот разбор ещё идёт: продолжить можно, когда он закончится или будет остановлен.');
  return { earlier, batch: await lab.store.readImport(earlier.logs.importId) };
}

/**
 * The consent of a continuation before anything is spent: the next conversations, the findings reused with no call
 * because their keys still hold under this session's judge, the topics planned again, the ceiling.
 */
export async function continuationConsentOf(lab: Lab, host: DiscoverHost, input: ContinueInput): Promise<ContinuationConsent> {
  const { earlier, batch } = await continued(lab, input.analysisId);
  const settings = continuationSettings(earlier, input.settings);
  const runtime = await host.runtime(earlier.mode, settings, earlier.id);
  const judge = earlier.checking === 'facts' || knowledgeOnly(earlier.sources) ? runtime.factChecker : runtime.logJudge;
  if (!judge) throw new Error('Эта среда не умеет оценивать записанные разговоры.');
  const draft = continueFrom(earlier, batch, judge.protocolHash, { id: earlier.id, createdAt: earlier.createdAt, updatedAt: earlier.updatedAt, budget: earlier.budget, models: earlier.models, requested: requestedOf({ requested: input.more }) });
  return continuationConsent(lab.store, { earlier, draft, batch, more: requestedOf({ requested: input.more }), pendingJobs: analysisJobs(draft, batch, judge.protocolHash).length,
    unfitted: unfittedCount(draft), builder: host.builder(earlier.mode, settings), judge: judgeOf(settings) });
}

/**
 * Starts a continuation the owner agreed to: a new analysis carrying the earlier one's plans and every finding that still
 * holds, then the next conversations not selected before, within `callCeiling`. The earlier analysis is never changed.
 */
export async function continueAnalysis(lab: Lab, host: DiscoverHost, input: ContinueInput, options: { callCeiling: number }): Promise<LogAnalysis> {
  const { earlier, batch } = await continued(lab, input.analysisId);
  const settings = continuationSettings(earlier, input.settings);
  const more = requestedOf({ requested: input.more });
  const runtime = await host.runtime(earlier.mode, settings, earlier.id);
  const judge = earlier.checking === 'facts' || knowledgeOnly(earlier.sources) ? runtime.factChecker : runtime.logJudge;
  if (!judge) throw new Error('Эта среда не умеет оценивать записанные разговоры.');
  const now = new Date().toISOString();
  const builder = host.builder(earlier.mode, settings);
  const analysis = analysisSchema.parse(continueFrom(earlier, batch, judge.protocolHash, { id: analysisId(), createdAt: now, updatedAt: now, requested: more,
    budget: { ceiling: options.callCeiling, spent: 0 }, models: { builder: { provider: builder.provider, model: builder.id }, judge: judgeOf(settings) } }));
  return launch(lab, host, analysis, { mode: earlier.mode, settings, callCeiling: options.callCeiling, conversations: analysis.selection.picked.length + more,
    start: async () => batch,
    before: async (read, _runtime, work) => {
      const added = await selectMore(analysis, read, more, work);
      await work.checkpoint(`Продолжаю разбор: ещё ${added.length} из не выбранных раньше; уже сделанных оценок — ${analysis.continues?.reused ?? 0}, они не оплачиваются повторно.`);
    } });
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
