import { recheckDecision } from './scenario-draft.js';
import { semanticWorkStatus } from './scenario-work.js';
import { captureGeneratorEvidence } from './generator-evidence.js';
import { importBatch, acceptLibrary as acceptScenarioLibrary, editLibrary as editScenarioLibrary, libraryHash, verifyAcceptedRun } from './scenario-library.js';
import type { LibraryPatch, LibraryV1 } from './scenario-contracts.js';
import { judgedScenario, requireLibraryV1 } from './card/legacy-v1.js';
import { acceptLibraryV2, requireLibraryV2 } from './card/library.js';
import { prepareCards, resumeCards, reviewCards, storedEvidence } from './card/prepare.js';
import type { LibraryV2 } from './card/schema.js';
import { assessScenarioLibrary, compiledLibraryScenarios, prepareScenarioLibrary, resumeScenarioLibrary } from './scenario-preparation.js';
import { proposeVariant as proposeScenarioVariant, type VariantProposalResult, type VariantRequest } from './scenario-variants.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  SANDBOX_RETIRED, VERSION, addUsage, assessmentRubrics, createInputSchema, draftPatchSchema, emptyUsage, experimentSchema, fingerprint, humanReviewInputSchema, isRunning, runnableTarget, scriptIssue, settingsSchema, validateFailureModes, validatePreparation,
  reassessmentSchema, type ReassessmentInput, type CallContext, type CreateInput, type DraftPatch, type Experiment, type HumanReviewInput, type Revision, type Runtime, type Scenario, type UserMode } from './contracts.js';
import { ExperimentStore } from './store.js';
import { LibraryConflict, Stopped } from './errors.js';
import { assessTrial, evaluateTrial, grade } from './evaluation.js';
import { scenarioSources } from './judge.js';
import { awaitingVerdict } from './comparison.js';
import { CODE_ONLY_ASSESSMENT, deriveRun, judgeFailure, plannedTrials } from './run.js';
import { sameTargetVersion, targetFingerprint } from './target-version.js';
import { portableTarget, rememberConnection, resolveTarget, suiteEvidence, type Connection } from './connection.js';
import { preflightTarget, readPrompt, runRelease } from './targets.js';
import { countingRuleFor, markTargets, measurementUsable } from './outcomes.js';
import { simulatorChecks } from './simulator.js';
import { withDefaultGoalObservation } from './normalize.js';
import { createDemoRuntime } from './demo.js';
import { createPiRuntime, evaluatorVersion } from './pi.js';

/** Dialogues a run may hold open against the target at once. */
const MAX_PARALLEL = 16;

/*
 * Phase machine owned by ExperimentLab. Every transition is an atomic checkpoint.
 *
 *   preparing ─► review ─► evaluating ─► results_review ─► complete
 *   any running phase ─► cancelled | error | interrupted
 *
 * baseline, improving and control belong to the retired compare workflow: its records still
 * open, and one caught mid-run by a restart is marked interrupted like any other.
 */
export function draftHash(record: Experiment): string {
  return fingerprint({ task: record.task, workflow: record.workflow, mode: record.mode, sources: record.sources,
    settings: record.settings, target: record.target, requirements: record.requirements, questions: record.questions,
    goldenCases: record.goldenCases, dialogues: record.dialogues, profiles: record.profiles, notes: record.notes,
    scenarios: record.scenarios, agent: record.revisions[0]?.spec, positiveControlScenarioIds: record.positiveControlScenarioIds,
    ownerExpectationScenarioIds: record.ownerExpectationScenarioIds,
    librarySnapshot: record.librarySnapshot, originalImport: record.originalImport, generatorConfig:record.generatorConfig,generatorIdentity:record.generatorIdentity,
    targetVersion: record.targetVersion, targetFingerprint: record.targetFingerprint, evaluatorVersion: record.evaluatorVersion });
}
export function resultHash(record: Experiment): string {
  return fingerprint({ draft: draftHash(record), trials: record.trials, humanReviews: record.humanReviews ?? [] });
}
/**
 * What the record claims two runs measured the same way. The control set belongs in it: a control
 * card is excluded from the headline denominator, so two runs marking different controls measure
 * different things even when every scenario is byte-identical. `ownerExpectationScenarioIds` does
 * not: an owner edit rewrites `successCriteria` and the goal rubric, so the card fingerprint — and
 * with it `scenarios` — already moves; the marker itself is only a label on that change.
 * `undefined` drops out of `JSON.stringify`, so a record written before the field existed keeps its
 * old hash.
 */
export function measurementHash(record: Experiment): string {
  return fingerprint({ version: VERSION, workflow: record.workflow, task: record.task, baseline: record.revisions[0], mode: record.mode, sources: record.sources, requirements: record.requirements, scenarios: record.scenarios, settings: record.settings,
    target: record.target, goldenCases: record.goldenCases, dialogues: record.dialogues, profiles: record.profiles, notes: record.notes,
    positiveControlScenarioIds: record.positiveControlScenarioIds,
    librarySnapshot: record.librarySnapshot, originalImport: record.originalImport, generatorConfig:record.generatorConfig,generatorIdentity:record.generatorIdentity,
    targetVersion: record.targetVersion, targetFingerprint: record.targetFingerprint, evaluatorVersion: record.evaluatorVersion });
}
function revision(spec: Revision['spec'], parentId: string | null, hypothesis: string): Revision {
  return { id: fingerprint(spec), parentId, spec: structuredClone(spec), hypothesis, createdAt: new Date().toISOString() };
}

function retainAcceptedTests(record: Experiment): void {
  const scenarios = new Map(record.scenarios.map(scenario => [scenario.id, scenario]));
  record.acceptedTests = (record.acceptedTests ?? []).filter(test => {
    const scenario = scenarios.get(test.scenarioId);
    return scenario !== undefined && fingerprint(scenario) === test.definitionHash;
  });
}

function freshDraft(previous: Experiment, scenarioIds?: string[]): Experiment {
  const record = structuredClone(previous);
  if (scenarioIds) {
    if (!scenarioIds.length || new Set(scenarioIds).size !== scenarioIds.length
      || scenarioIds.some(id => !record.scenarios.some(s => s.id === id))) throw new Error('Выберите существующие тесты без повторов.');
    record.scenarios = record.scenarios.filter(s => scenarioIds.includes(s.id));
    record.selectedScenarioIds = [...scenarioIds];
  }
  const keptControls = (record.positiveControlScenarioIds ?? []).filter(id => record.scenarios.some(s => s.id === id));
  if (keptControls.length) record.positiveControlScenarioIds = keptControls;
  else delete record.positiveControlScenarioIds;
  const keptOwnerExpectations = (record.ownerExpectationScenarioIds ?? []).filter(id => record.scenarios.some(s => s.id === id));
  if (keptOwnerExpectations.length) record.ownerExpectationScenarioIds = keptOwnerExpectations;
  else delete record.ownerExpectationScenarioIds;
  record.scenarios = record.scenarios.map(scenario => withDefaultGoalObservation(scenario, record.target.kind));
  Object.assign(record, { id: randomUUID(), parentRunId: previous.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    phase: 'review', message: 'Тесты готовы. Проверьте подключение и запустите проверку.',
    trials: [], comparisons: [], iterations: [], humanReviews: [], usage: emptyUsage(),
    reviewedAt: null, reviewMode: null, manifestHash: null, controlConsumedAt: null, error: null });
  delete record.executionRunId;
  delete record.resultsReviewedAt; delete record.resultsReviewHash; delete record.failureModes;
  delete record.acceptedDraftHash;
  delete record.targetRelease; delete record.assessmentOf; delete record.assessmentTrialIds; delete record.evidenceHash; delete record.releaseLog;
  retainAcceptedTests(record);
  record.evaluatorVersion = evaluatorVersion(record.settings);
  record.limitations = previous.limitations.filter(note => !note.startsWith('Scripted mode skipped') && !note.startsWith('Не удалось назвать типы провалов:')
    && !note.startsWith('Внешнее состояние карточек не подтверждено'));
  return record;
}

export class ExperimentLab {
  readonly store: ExperimentStore;
  private active: { record: Experiment; controller: AbortController; done: Promise<void>; startedAtMs: number; preparationElapsedBeforeMs?: number } | null = null;
  private lastTask: Promise<void> = Promise.resolve();
  private closed = true;
  private closing = false;
  private initializing: Promise<void> | undefined;
  private mutation: Promise<unknown> | undefined;
  constructor(directory: string, private readonly injectedRuntime?: Runtime) { this.store = new ExperimentStore(directory); }
  init(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Experiment Lab is closing.'));
    return this.initializing ??= this.initialize();
  }
  private async initialize(): Promise<void> {
    await this.store.init();
    try {
      for (const record of await this.store.list()) if (isRunning(record.phase)) {
        record.phase = 'interrupted'; record.message = 'The previous process stopped. Partial evidence has been preserved.';
        record.usage.costUsd = null;
        record.limitations.push('The process stopped between checkpoints; observed call and token counts may be incomplete.');
        record.error = record.message; record.updatedAt = new Date().toISOString(); await this.store.save(record);
      }
      if (!this.closing) this.closed = false;
    } catch (error) { await this.store.close(); throw error; }
  }
  async get(id: string): Promise<Experiment> {
    return this.active?.record.id === id ? structuredClone(this.active.record) : this.store.get(id);
  }
  async list(): Promise<Experiment[]> {
    const records = await this.store.list();
    return records.map(r => this.active?.record.id === r.id ? structuredClone(this.active.record) : r);
  }
  private ensureIdle(ownsMutation = false): void {
    if (this.closed) throw new Error('Лаборатория не открыта.');
    // ponytail: one active local experiment; use per-experiment workers when concurrent runs are needed.
    if (this.active || (!ownsMutation && this.mutation)) throw new Error('Уже идёт другая операция над экспериментом. Дождитесь её или остановите.');
  }
  private async change<T>(work: () => Promise<T>): Promise<T> {
    this.ensureIdle();
    const pending = Promise.resolve().then(work);
    this.mutation = pending;
    try { return await pending; } finally { if (this.mutation === pending) this.mutation = undefined; }
  }
  private newRecord(input: CreateInput): Experiment {
    const now = new Date().toISOString();
    return {
      schemaVersion: '1', id: randomUUID(), task: input.task, mode: input.mode, createdAt: now, updatedAt: now,
      phase: 'preparing', message: 'Подключаю агента и готовлю требования и первый тест.',
      sources: input.materials.map((m, i) => ({ id: `source-${i + 1}`, name: m.name, content: m.content, hash: fingerprint(m.content), ...(m.kind ? { kind: m.kind } : {}) })),
      settings: input.settings, requirements: [], questions: [], scenarios: [], revisions: [], selectedRevisionId: null,
      manifestHash: null, reviewedAt: null, reviewMode: null, controlConsumedAt: null, acceptedTests: [], trials: [], comparisons: [], iterations: [],
      usage: emptyUsage(), error: null,
      workflow: input.workflow, humanReviews: [],
      target: input.target, goldenCases: [], dialogues: input.dialogues, profiles: [], notes: '',
      evaluatorVersion: evaluatorVersion(input.settings),
      ...(input.targetVersion ? { targetVersion: input.targetVersion } : {}),
      limitations: [
        'External agent state and tool events are reported by its adapter. Isolation and reset of external services are the responsibility of that adapter.',
        'Scenario expectations are grounded automatically and should be spot-checked; text matching checks measure literal content, not semantic correctness.',
        'Synthetic simulations do not establish performance with real users. Model rubric assessments are provisional; human review is reserved for disputes and calibration claims.',
        'Model costs are observed usage estimates; unknown costs remain unknown. Call limits are not hard provider billing caps.',
        ...(input.mode === 'demo' ? ['Учебный пример: пользователь, судья и подготовка — детерминированные заготовки без модели; это не измерение качества модели.'] : []),
      ],
    };
  }
  /**
   * A new draft is always a scenario library: requirements grounded in the owner's materials, situations proposed from
   * real dialogues or from the requirements alone. `cards` prepares them as cards (card/prepare.ts); otherwise they are
   * the first format's variants.
   */
  async create(raw: CreateInput, options: { cards?: boolean } = {}): Promise<Experiment> {
    this.ensureIdle();
    const originalImport = raw.originalImport ?? (raw.dialogues?.length ? importBatch(raw.dialogues) : undefined);
    const input = createInputSchema.parse({ ...raw, ...(originalImport ? { originalImport } : {}) });
    const record = this.newRecord(input);
    await this.launch(record, async ctx => {
      if (input.originalImport) {
        const batch = await this.store.writeImport(input.originalImport);
        record.originalImport = { id: batch.id, contentHash: batch.contentHash };
      }
      await preflightTarget(record.target);
      record.targetFingerprint = await targetFingerprint(record.target);
      const runtime = await this.runtime(record);
      const batch = record.originalImport ? await this.store.readImport(record.originalImport.id) : undefined;
      if (options.cards) {
        if (!runtime.proposeCard || !runtime.reviewCard) throw new Error('Эта среда не умеет готовить ситуации.');
        // Every dialogue of the import is prepared; this list is where a representative sample of the logs plugs in.
        await prepareCards(record, batch ? { kind: 'dialogues', batch, dialogueIds: batch.dialogues.map(dialogue => dialogue.id) } : { kind: 'rules', count: input.scenarioCount || 1 },
          input.existingAgent, runtime, ctx, this.store);
        await this.checkpoint(record, 'review', 'Ситуации готовы. Проверьте их и утвердите для прогона.');
        return;
      }
      if (!runtime.scenarioProposals) throw new Error('Эта среда не умеет готовить библиотеку сценариев.');
      await prepareScenarioLibrary(record, input, batch, runtime, ctx, this.store);
      await this.checkpoint(record, 'review', 'Библиотека подготовлена. Проверьте варианты и примите выбранные перед запуском.');
    });
    return structuredClone(record);
  }
  /** The draft's cards as a detached copy, with the draft itself. */
  async readCards(id: string): Promise<{ library: LibraryV2; experiment: Experiment }> {
    const experiment = await this.get(id);
    if (!experiment.librarySnapshot) throw new Error('У черновика нет ситуаций.');
    return { library: structuredClone(requireLibraryV2(experiment.librarySnapshot)), experiment };
  }
  /** Accepts ready cards for a run: each is compiled here, once, and its definition hash sealed with the library (card/library.ts). */
  async acceptCards(id: string, expectedHash: string, cardIds: string[]): Promise<{ library: LibraryV2; experiment: Experiment }> {
    return this.change(async () => {
      const { experiment, library } = await this.readCards(id);
      if (experiment.phase !== 'review') throw new Error('Утвердить ситуации можно только в черновике.');
      if (fingerprint(experiment.requirements) !== fingerprint(library.requirements) || fingerprint(experiment.sources) !== fingerprint(library.sources)) throw new Error('Правила изменились после подготовки ситуаций.');
      const accepted = acceptLibraryV2(library, expectedHash, cardIds, { evidence: await storedEvidence(this.store, library), maxTurns: experiment.settings.maxTurns });
      experiment.librarySnapshot = accepted.library; experiment.scenarios = accepted.scenarios;
      delete experiment.selectedScenarioIds;
      const acceptedAt = new Date().toISOString();
      experiment.acceptedTests = accepted.scenarios.map(scenario => ({ testId: randomUUID(), scenarioId: scenario.id, definitionHash: fingerprint(scenario), acceptedAt }));
      experiment.acceptedDraftHash = draftHash(experiment);
      await this.store.publishLibrary(experiment, accepted.library, expectedHash);
      return { library: accepted.library, experiment };
    });
  }
  /** The owner's explicit check of every claim of the draft's cards that no receipt answers yet, within the run's budget. */
  async checkCards(id: string, expectedHash: string): Promise<Experiment> {
    return this.change(async () => {
      const { experiment, library } = await this.readCards(id);
      if (experiment.phase !== 'review' || libraryHash(library) !== expectedHash) throw new LibraryConflict('Библиотека изменилась или уже запущена.');
      const batch = experiment.originalImport ? await this.store.readImport(experiment.originalImport.id) : undefined;
      experiment.phase = 'preparing'; experiment.error = null;
      await this.launch(experiment, async ctx => {
        await reviewCards(experiment, batch, await this.runtime(experiment), ctx, this.store);
        await this.checkpoint(experiment, 'review', 'Проверка ситуаций завершена.');
      }, true);
      return structuredClone(experiment);
    });
  }
  /** Detached variant library plus its current (empty until accepted) runnable draft: what the variant editor below works on. */
  async readLibrary(id: string): Promise<{ library: LibraryV1; experiment: Experiment }> {
    const experiment = await this.get(id);
    if (!experiment.librarySnapshot) throw new Error('У эксперимента нет библиотеки сценариев.');
    return { library: structuredClone(requireLibraryV1(experiment.librarySnapshot)), experiment };
  }
  /** `author` is always named by the caller: owner authority is never a default. */
  async editLibrary(id: string, expectedHash: string, patch: LibraryPatch, author: 'owner' | 'assistant'): Promise<{ library: LibraryV1; experiment: Experiment }> {
    return this.change(async () => {
      const { experiment, library } = await this.readLibrary(id);
      if (experiment.phase !== 'review') throw new Error('Править библиотеку можно только в черновике.');
      const next = editScenarioLibrary(library, expectedHash, patch, author);
      experiment.librarySnapshot = next; experiment.scenarios = []; experiment.acceptedTests = [];
      delete experiment.acceptedDraftHash; delete experiment.selectedScenarioIds;
      experiment.reviewedAt = null; experiment.reviewMode = null; experiment.manifestHash = null;
      await this.store.publishLibrary(experiment, next, expectedHash);
      return { library: next, experiment };
    });
  }
  async proposeVariant(id: string, expectedHash: string, request: VariantRequest): Promise<VariantProposalResult & { experiment: Experiment }> {
    return this.change(async () => {
      const { experiment, library } = await this.readLibrary(id);
      if (experiment.phase !== 'review') throw new Error('Добавить вариант можно только в черновике.');
      const result = proposeScenarioVariant(library, request, expectedHash);
      experiment.librarySnapshot = result.library; experiment.scenarios = []; experiment.acceptedTests = [];
      delete experiment.acceptedDraftHash; delete experiment.selectedScenarioIds;
      experiment.reviewedAt = null; experiment.reviewMode = null; experiment.manifestHash = null;
      await this.store.publishLibrary(experiment, result.library, expectedHash);
      return { ...result, experiment };
    });
  }
  async acceptLibrary(id: string, expectedHash: string, variantIds: string[]): Promise<{ library: LibraryV1; experiment: Experiment }> {
    return this.change(async () => {
      const { experiment, library } = await this.readLibrary(id);
      if (experiment.phase !== 'review') throw new Error('Принять библиотеку можно только в черновике.');
      if (fingerprint(experiment.requirements) !== fingerprint(library.requirements) || fingerprint(experiment.sources) !== fingerprint(library.sources)) throw new Error('Требования библиотеки изменились.');
      const next = acceptScenarioLibrary(library, expectedHash, variantIds);
      experiment.librarySnapshot = next; experiment.scenarios = compiledLibraryScenarios(experiment, next);
      delete experiment.selectedScenarioIds;
      const acceptedAt = new Date().toISOString();
      experiment.acceptedTests = experiment.scenarios.map(s => ({ testId: randomUUID(), scenarioId: s.id, definitionHash: fingerprint(s), acceptedAt }));
      experiment.acceptedDraftHash = draftHash(experiment);
      await this.store.publishLibrary(experiment, next, expectedHash);
      return { library: next, experiment };
    });
  }
  /** Continue a preparation from saved pending sources. A call that died in flight is not repeated. */
  async resumePreparation(id: string, expectedHash: string): Promise<Experiment> {
    return this.change(async () => {
      const experiment = await this.get(id);
      const progress = experiment.preparationProgress;
      if (!progress?.pending.length) throw new Error('Необработанных источников нет.');
      // A card preparation leaves the unit of a call that died in flight out and goes on; the first format stops there.
      const cards = progress.protocol === 'cards-v1';
      if (!cards && progress.activeDialogueId) throw new Error(`Подготовка остановилась во время разбора «${progress.activeDialogueId}». Его стоимость неизвестна; этот источник не повторяется молча.`);
      if (!experiment.librarySnapshot) throw new Error('Черновик библиотеки не сохранён; продолжить нельзя.');
      if (libraryHash(experiment.librarySnapshot) !== expectedHash || libraryHash(await this.store.readLibrary(experiment.librarySnapshot.id)) !== expectedHash) throw new LibraryConflict('Библиотека изменилась: хеш устарел.');
      if (experiment.phase !== 'review' && experiment.phase !== 'interrupted') throw new Error('Продолжить можно только незавершённую подготовку.');
      if (experiment.librarySnapshot.acceptance || experiment.trials.length || experiment.acceptedTests?.length) throw new Error('Принятый или выполненный набор не меняется. Создайте новый черновик.');
      if ((progress.elapsedMs ?? 0) >= experiment.settings.maxDurationMs) throw new Error('Общий лимит времени подготовки исчерпан; сохранённый результат не меняется.');
      const batch = experiment.originalImport ? await this.store.readImport(experiment.originalImport.id) : undefined;
      // The first format rebuilds its creation input; a card preparation reads everything from its saved plan.
      const input = cards ? undefined : createInputSchema.parse({
        task: experiment.task, mode: experiment.mode, materials: experiment.sources.map(source => ({ name: source.name, content: source.content, ...(source.kind ? { kind: source.kind } : {}) })),
        settings: experiment.settings, scenarioCount: batch ? 0 : progress.requestedCount ?? 1, target: experiment.target,
        ...(batch ? { originalImport: batch } : {}),
        dialogues: [],
        ...(experiment.revisions[0] ? { existingAgent: experiment.revisions[0].spec } : {}),
      });
      experiment.phase = 'preparing'; experiment.error = null;
      await this.launch(experiment, async ctx => {
        const runtime = await this.runtime(experiment);
        if (!input) {
          await resumeCards(experiment, batch, runtime, ctx, this.store);
          await this.checkpoint(experiment, 'review', 'Подготовка продолжена с сохранённого места. Проверьте ситуации и утвердите для прогона.');
          return;
        }
        await resumeScenarioLibrary(experiment, input, batch, runtime, ctx, this.store);
        await this.checkpoint(experiment, 'review', 'Подготовка продолжена с сохранённых источников. Проверьте варианты перед принятием.');
      }, true);
      return structuredClone(experiment);
    });
  }
  /** Shared edit follow-up: defer, require more budget, or start the exact remaining semantic work. */
  async recheckLibrary(id: string, options: { expectedHash?: string; defer?: boolean; explicit?: boolean } = {}) {
    const { library, experiment } = await this.readLibrary(id);
    const hash = libraryHash(library);
    if (options.expectedHash && options.expectedHash !== hash) throw new LibraryConflict('Библиотека изменилась: хеш устарел.');
    const work = semanticWorkStatus(library), remainingCalls = Math.max(0, experiment.settings.maxCalls - experiment.usage.calls);
    if (options.explicit && work.pendingJobs && !remainingCalls) throw new Error('Модельный бюджет исчерпан. Увеличьте общий лимит; использованные вызовы не сбрасываются.');
    const decision = recheckDecision({ ...work, remainingCalls, defer: !!options.defer,
      askedHash: options.explicit ? hash : undefined, libraryHash: hash });
    if (decision.action === 'run') await this.assessLibrary(id, decision.startHash);
    return { decision, before: experiment };
  }
  /** Reassess edited facts/expectations under the same usage, timeout and cancellation budget. */
  async assessLibrary(id: string, expectedHash: string): Promise<Experiment> {
    return this.change(async () => {
      const { experiment, library } = await this.readLibrary(id);
      if (experiment.phase !== 'review' || libraryHash(library) !== expectedHash) throw new LibraryConflict('Библиотека изменилась или уже запущена.');
      experiment.phase = 'preparing'; experiment.error = null;
      await this.launch(experiment, async ctx => {
        const runtime = await this.runtime(experiment);
        if (!runtime.assessScenarioProposals) throw new Error('Смысловая проверка недоступна.');
        experiment.scenarios = []; experiment.acceptedTests = []; delete experiment.acceptedDraftHash; delete experiment.selectedScenarioIds;
        let published = expectedHash;
        const next = await assessScenarioLibrary(library, runtime, ctx, async partial => {
          experiment.librarySnapshot = partial;
          await this.store.publishLibrary(experiment, partial, published); published = libraryHash(partial);
        });
        next.revision++; experiment.librarySnapshot = next;
        if (experiment.preparationProgress) experiment.preparationProgress.status = experiment.preparationProgress.pending.length ? 'partial' : 'complete';
        await this.store.publishLibrary(experiment, next, published);
        await this.checkpoint(experiment, 'review', 'Смысловая проверка завершена. Проверьте замечания и примите варианты.');
      }, true);
      return structuredClone(experiment);
    });
  }
  /** Run settings, the connection, its version and the agent label; the situations themselves change only through the library. */
  async updateDraft(id: string, expectedHash: string, raw: DraftPatch): Promise<Experiment> {
    return this.change(async () => {
      const record = await this.store.get(id);
      if (record.phase !== 'review') throw new Error('Править можно только незапущенный черновик. Готовые доказательства остаются как есть, для изменений создайте новый эксперимент.');
      if (draftHash(record) !== expectedHash) throw new Error('Черновик изменился. Откройте карточки заново, прежде чем править.');
      const patch = draftPatchSchema.parse(raw);
      if (record.librarySnapshot?.acceptance) verifyAcceptedRun(record);
      record.settings = settingsSchema.parse({ ...record.settings, ...patch.settings,
        roles: Object.fromEntries(Object.entries({ ...record.settings.roles, ...patch.settings?.roles }).filter(([, value]) => value !== null)) });
      if (patch.target) record.target = patch.target;
      if (patch.targetVersion) record.targetVersion = patch.targetVersion;
      if (patch.agent) { record.revisions = [revision(patch.agent, null, 'Конфигурация агента обновлена владельцем.')]; record.selectedRevisionId = record.revisions[0]!.id; }
      await preflightTarget(record.target); record.targetFingerprint = await targetFingerprint(record.target);
      record.evaluatorVersion = evaluatorVersion(record.settings);
      delete record.acceptedDraftHash;
      record.reviewedAt = null; record.reviewMode = null; record.manifestHash = null;
      await this.checkpoint(record, 'review', `${patch.agent ? 'Агент обновлён. ' : ''}Настройки прогона обновлены. Подтвердите новую версию перед запуском.`);
      return structuredClone(record);
    });
  }
  async acceptDraft(id: string, expectedHash: string): Promise<Experiment> {
    return this.change(async () => {
      const record = await this.store.get(id);
      verifyAcceptedRun(record);
      if (record.workflow !== 'evaluate') throw new Error('Принять тест можно только в workflow evaluate.');
      if (record.phase !== 'review') throw new Error('Принять можно только незапущенный черновик.');
      if (!record.scenarios.length) throw new Error('Подтверждать нечего: в черновике нет ситуаций.');
      const currentHash = draftHash(record);
      if (expectedHash !== currentHash) throw new Error('Черновик изменился, пока вы смотрели. Проверьте ожидания ещё раз.');
      // One confirmation covers every situation of the draft; an entry whose definition did not change keeps its identity and date.
      const previous = new Map((record.acceptedTests ?? []).map(test => [test.scenarioId, test]));
      const acceptedAt = new Date().toISOString();
      const accepted = record.scenarios.map(scenario => {
        const definitionHash = fingerprint(scenario);
        const kept = previous.get(scenario.id);
        return kept?.definitionHash === definitionHash ? kept : { testId: randomUUID(), scenarioId: scenario.id, definitionHash, acceptedAt };
      });
      if (record.acceptedDraftHash === currentHash && previous.size === accepted.length
        && accepted.every(test => previous.get(test.scenarioId) === test)) return structuredClone(record);
      record.acceptedTests = accepted;
      record.acceptedDraftHash = currentHash;
      await this.store.save(record);
      return structuredClone(record);
    });
  }
  /** Reuse the exact reviewed materials and cards; only evidence and approvals start afresh. */
  async repeat(id: string, scenarioIds?: string[], controlScenarioIds?: string[]): Promise<Experiment> {
    return this.change(async () => {
      const previous = await this.store.get(id);
      if (previous.workflow !== 'evaluate' || !previous.reviewedAt || isRunning(previous.phase)) {
        throw new Error('Повторить можно остановленный или завершённый прогон с утверждёнными карточками.');
      }
      if (previous.target.kind === 'sandbox') throw new Error(SANDBOX_RETIRED);
      const record = freshDraft(previous, scenarioIds);
      if (controlScenarioIds) {
        if (!controlScenarioIds.length || controlScenarioIds.length > 5 || new Set(controlScenarioIds).size !== controlScenarioIds.length) {
          throw new Error('Контрольных ситуаций может быть от 1 до 5, без повторов.');
        }
        const missing = controlScenarioIds.find(controlId => !record.scenarios.some(s => s.id === controlId));
        if (missing !== undefined) throw new Error(`Контрольная ситуация должна быть из этого набора: ${missing}.`);
        record.positiveControlScenarioIds = [...controlScenarioIds];
      }
      // A control keeps its accepted card: the one-turn rule is applied when it runs (evaluateTrial).
      record.targetFingerprint = await targetFingerprint(record.target);
      verifyAcceptedRun(record);
      await this.store.save(record);
      return structuredClone(record);
    });
  }
  /** A versionable local definition: provenance survives, run results and approvals do not. */
  async saveSuite(id: string, file: string, scenarioIds?: string[]): Promise<string> {
    const previous = await this.get(id);
    if (previous.workflow !== 'evaluate' || !previous.scenarios.length || isRunning(previous.phase)) throw new Error('Сначала дождитесь готовых тестов.');
    const definition = freshDraft(previous, scenarioIds);
    verifyAcceptedRun(definition);
    if (previous.trials.length) definition.sourceEvidence = suiteEvidence(previous, definition.scenarios.map(s => s.id));
    const path = resolve(file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ format: 'agent-lab-suite-1', definition: { ...definition, target: portableTarget(definition.target, dirname(path)) } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return path;
  }
  async loadSuite(file: string, scenarioIds?: string[], connection?: Connection): Promise<Experiment> {
    return this.change(async () => {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      if (raw.format !== 'agent-lab-suite-1') throw new Error('Нужен файл тестов Agent Lab, сохранённый через save-suite.');
      const previous = experimentSchema.parse({ ...raw.definition, target: connection?.target ?? resolveTarget(raw.definition.target, dirname(resolve(file))),
        ...(connection?.targetVersion ? { targetVersion: connection.targetVersion } : {}) });
      if (previous.workflow !== 'evaluate') throw new Error('Файл должен содержать обычные тесты evaluate.');
      const record = freshDraft(previous, scenarioIds);
      // Keep the original run as the comparison source, not the exported draft's temporary ID.
      record.parentRunId = previous.parentRunId;
      runnableTarget(record.target);
      const prepared = validatePreparation({ requirements: record.requirements, questions: record.questions,
        scenarios: record.scenarios.map(({ split: _split, ...s }) => s) }, record.sources);
      record.scenarios = prepared.scenarios;
      retainAcceptedTests(record);
      await preflightTarget(record.target);
      record.targetFingerprint = await targetFingerprint(record.target);
      verifyAcceptedRun(record);
      await this.store.save(record);
      return structuredClone(record);
    });
  }
  /** A separate result over the same facts. No target session or simulator is opened. */
  async reassess(id: string, raw: ReassessmentInput = {}, options: { carryUsage?: boolean } = {}): Promise<Experiment> {
    return this.change(async () => {
      const input = reassessmentSchema.parse(raw);
      const previous = await this.store.get(id);
      if (previous.workflow !== 'evaluate' || isRunning(previous.phase) || !previous.trials.length) throw new Error('Нужен завершённый прогон с сохранёнными трассами.');
      if (previous.questions.length) throw new Error('Сначала ответьте на открытые вопросы владельца; оценка по неуточнённым требованиям не запускается.');
      if (input.trialIds?.some(id => !previous.trials.some(t => t.id === id))) throw new Error('Неизвестный исходный диалог.');
      const record = freshDraft(previous);
      if (options.carryUsage) record.usage = structuredClone(previous.usage);
      for (const criteria of input.criteria) {
        const scenario = record.scenarios.find(s => s.id === criteria.scenarioId);
        if (!scenario) throw new Error(`Нет карточки ${criteria.scenarioId}`);
        const { scenarioId: _, ...patch } = criteria;
        Object.assign(scenario, patch);
      }
      const prepared = validatePreparation({ requirements: record.requirements, questions: record.questions,
        scenarios: record.scenarios.map(({ split: _, ...s }) => s) }, record.sources);
      record.scenarios = prepared.scenarios;
      verifyAcceptedRun(record);
      retainAcceptedTests(record);
      if (input.judge) { record.settings.judge = input.judge; delete record.settings.roles.judge; }
      record.evaluatorVersion = evaluatorVersion(record.settings);
      record.assessmentOf = previous.id;
      let execution = previous;
      const ancestry = new Set<string>();
      while (execution.assessmentOf && !execution.executionRunId) {
        if (ancestry.has(execution.id)) throw new Error('Цикл переоценок.'); ancestry.add(execution.id);
        execution = await this.store.get(execution.assessmentOf);
      }
      record.executionRunId = execution.executionRunId ?? execution.id;
      const trials = previous.trials.filter(t => !input.trialIds || input.trialIds.includes(t.id));
      record.assessmentTrialIds = trials.map(t => t.id);
      record.evidenceHash = fingerprint(trials.map(t => ({ id: t.id, events: t.events, initialState: t.initialState, finalState: t.finalState, observation: t.observation })));
      record.sourceEvidence = suiteEvidence(previous, record.scenarios.map(s => s.id));
      record.targetRelease = previous.targetRelease;
      record.reviewedAt = new Date().toISOString(); record.reviewMode = 'automated';
      record.manifestHash = measurementHash(record);
      record.limitations.push('Переоценка сохранённых фактов: агент и симулятор не запускались. Смена критериев или судьи не доказывает улучшение агента.');
      if (input.codeOnly) record.limitations.push('Режим code-only пересчитал только точные проверки; модельные рубрики и кластеры не оценивались.');
      record.phase = 'evaluating';
      await this.launch(record, async ctx => {
        const runtime = input.codeOnly ? undefined : await this.runtime(record);
        for (const original of trials) {
          ctx.signal.throwIfAborted();
          const trial = structuredClone(original);
          const scenario = record.scenarios.find(s => s.id === trial.scenarioId)!;
          trial.usage = emptyUsage(); delete trial.externalUsage; delete trial.assessments; delete trial.assessmentError; delete trial.assessmentFailure; delete trial.judgeAudit; delete trial.judgeReceipt; delete trial.checkpoints; delete trial.checkpointReceipt;
          trial.manifestHash = record.manifestHash!;
          if (record.target.kind !== 'sandbox' && !trial.observation) trial.observation = { state: 'missing', tools: 'partial' };
          const started = performance.now();
          for (const event of trial.events) this.store.appendTrace(record.id, trial.id, event);
          if (!['invalid', 'cancelled'].includes(original.outcome)) {
            try {
              trial.checks = [];
              trial.checks = grade(scenario, trial);
              trial.simulatorChecks = simulatorChecks(scenario, trial);
              // Preserve execution failures (empty answer / turn budget), independent of new criteria.
              const executionFailed = original.outcome === 'fail' && original.checks.every(c => c.passed);
              trial.outcome = executionFailed || trial.checks.some(c => !c.passed) ? 'fail' : trial.checks.length ? 'pass' : 'ungraded';
              trial.reason = executionFailed ? original.reason : 'Точные проверки пересчитаны по сохранённым фактам.';
              // The checkpoint verdicts are gone from the copy: a first-format card is judged through its projection.
              const judged = judgedScenario(scenario, trial);
              if (assessmentRubrics(judged, trial).length && runtime) trial.assessments = await assessTrial(runtime, scenario, scenarioSources(record, scenario), trial, { ...ctx,
                beforeCall() { ctx.beforeCall(); trial.usage.calls++; },
                addUsage(usage) { ctx.addUsage(usage); addUsage(trial.usage, usage); } }, record.requirements);
              else if (judged.metrics?.length) { trial.assessmentError = CODE_ONLY_ASSESSMENT; trial.assessmentFailure = 'code_only'; }
            } catch (error) {
              trial.assessmentError = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
              trial.assessmentFailure = judgeFailure(error, ctx.signal);
              if (!trial.checks.length || ctx.signal.aborted) trial.outcome = ctx.signal.aborted ? 'cancelled' : 'invalid';
              // The saved facts could not be graded again (a reset or a state the agent never confirmed): the agent's side, not the judge's.
              if (trial.outcome === 'invalid') trial.invalidCause = 'agent';
            }
          }
          trial.elapsedMs = Math.round(performance.now() - started);
          record.trials.push(trial);
          await this.checkpoint(record, 'evaluating', `Переоценено ${record.trials.length}/${trials.length}. Агент не запускался.`);
        }
        if (runtime) await this.nameFailureModes(record, runtime, ctx);
        await this.checkpoint(record, 'results_review', 'Переоценка готова. Исходные трассы, оценки и ручные решения сохранены в исходном прогоне.');
      }, true);
      return structuredClone(record);
    });
  }
  async addHumanReview(id: string, raw: HumanReviewInput): Promise<Experiment> {
    return this.change(async () => {
      const record = await this.store.get(id);
      if (record.workflow !== 'evaluate' || !['results_review', 'complete'].includes(record.phase)) throw new Error('Вердикты человека можно ставить только по завершённым диалогам.');
      const input = humanReviewInputSchema.parse(raw);
      const trial = record.trials.find(t => t.id === input.trialId);
      if (!trial) throw new Error('Такого диалога в этом эксперименте нет.');
      if (input.reviewedDialogue && ![...input.note.matchAll(/#(\d+)\b/g)].some(match => trial.events.some(event => event.seq === Number(match[1])))) {
        throw new Error('Полный разбор должен ссылаться на событие текущего диалога.');
      }
      const objectiveCheck = input.checkId && trial.checks.some(c => c.id === input.checkId);
      const simulatorCheck = input.checkId && trial.simulatorChecks?.some(c => c.id === input.checkId);
      if (objectiveCheck && simulatorCheck) throw new Error('ID проверки неоднозначен: он занят объективной проверкой и проверкой симулятора.');
      if (input.checkId && !objectiveCheck && !simulatorCheck) throw new Error('Такой объективной проверки или проверки симулятора в этом диалоге нет.');
      const scenario = record.scenarios.find(s => s.id === trial.scenarioId);
      if (input.metricId && (!scenario || !assessmentRubrics(judgedScenario(scenario, trial), trial).some(m => m.id === input.metricId))) throw new Error('Такой рубрики в этой карточке нет.');
      // The counting rule is stamped by the lab on quick marks only; a caller value is never kept.
      if (input.source !== 'quick') delete input.countingRules;
      if (input.metricId) {
        const recorded = trial.assessments?.find(a => a.metricId === input.metricId)?.result;
        const judged = trial.judgeReceipt ?? trial.judgeAudit;
        // A one-key mark is an answer to one judgment, so it is refused where the number cannot
        // move (a control, an unmeasured situation), when there is no recorded decision to answer,
        // on a metric that did not decide the situation, and when the judgment moved while the
        // person was looking at it.
        if (input.source === 'quick') {
          if (record.positiveControlScenarioIds?.includes(trial.scenarioId)) throw new Error('Контрольная ситуация — в согласие с судьёй не входит.');
          if (!scenario || !measurementUsable(scenario, trial, record.humanReviews)) throw new Error('Эта ситуация не измерена — отметка согласия не нужна.');
          const targets = markTargets(scenario, trial);
          if (!targets) throw new Error('Судья не вынес решения по этой ситуации — соглашаться не с чем.');
          if (!targets.metricIds.includes(input.metricId)) throw new Error('Отметку согласия можно поставить только на оценку, из-за которой ситуация решена.');
          if (recorded !== 'pass' && recorded !== 'fail') throw new Error('Судья не вынес решения по этой ситуации — соглашаться не с чем.');
          if (input.judgeVerdict !== undefined && input.judgeVerdict !== recorded) throw new Error('Оценка судьи изменилась, пока вы смотрели. Проверьте ситуацию ещё раз.');
          input.countingRules = countingRuleFor(scenario, trial);
        }
        // What the verdict argues with is read from the trial; a caller value is never kept.
        if (recorded) input.judgeVerdict = recorded; else delete input.judgeVerdict;
        if (judged) input.judge = { protocolHash: judged.protocolHash, inputHash: judged.inputHash }; else delete input.judge;
      }
      (record.humanReviews ??= []).push({ ...input, id: randomUUID(), createdAt: new Date().toISOString() });
      delete record.resultsReviewedAt; delete record.resultsReviewHash;
      await this.checkpoint(record, 'results_review', 'Human annotation saved separately from the original assessment.');
      return structuredClone(record);
    });
  }
  async reviewResults(id: string, expectedHash: string): Promise<Experiment> {
    return this.change(async () => {
      const record = await this.store.get(id);
      if (record.workflow !== 'evaluate' || record.phase !== 'results_review') throw new Error('Нет завершённого набора диалогов, ожидающего аудита.');
      if (resultHash(record) !== expectedHash) throw new Error('Результаты изменились. Откройте их заново, прежде чем подтверждать аудит.');
      const pending = awaitingVerdict(record).size;
      if (pending) throw new Error(`Нельзя завершить разбор: ${pending} диалогов без решения. Оцените проваленные критерии или весь диалог. Если ошибочен сам тест, отметьте весь диалог «Невалидный тест» с причиной; «неясно» оставляет вопрос открытым.`);
      record.resultsReviewedAt = new Date().toISOString(); record.resultsReviewHash = expectedHash;
      await this.checkpoint(record, 'complete', 'Human review complete. Original checks, model estimates and human annotations remain separate.');
      return structuredClone(record);
    });
  }
  /** `parallel` is an execution knob, not a measurement setting: dialogues are independent, so several may run at once without changing what is measured. */
  async start(id: string, options: { approved: boolean; reviewer?: 'human' | 'expectations' | 'automated'; expectedHash?: string; parallel?: number; requireAccepted?: boolean }): Promise<Experiment> {
    const parallel = options.parallel ?? 1;
    if (!Number.isInteger(parallel) || parallel < 1 || parallel > MAX_PARALLEL) throw new Error(`Параллельных диалогов может быть от 1 до ${MAX_PARALLEL}.`);
    return this.change(async () => {
      const record = await this.store.get(id);
      verifyAcceptedRun(record);
      if (record.phase !== 'review') throw new Error('Запустить можно только эксперимент, ожидающий проверки. Чтобы поменять набор карточек, создайте новый.');
      if (record.workflow !== 'evaluate') throw new Error('Сравнение с автоматическим улучшением агента больше не запускается: такой прогон можно только открыть. Для новой проверки подготовьте библиотеку сценариев.');
      runnableTarget(record.target);
      if (!options.approved) throw new Error('Набор карточек замораживается только после вашего подтверждения.');
      if (options.expectedHash !== draftHash(record)) {
        throw new Error('Нужно подтверждение именно этой версии черновика. Откройте свежие тесты и план запуска.');
      }
      // The Pi path asks for confirmed expectations; CLI `run` and `evaluate` keep today's behaviour (CTX-22).
      if (options.requireAccepted && record.acceptedDraftHash !== draftHash(record)) {
        throw new Error('Сначала подтвердите ожидания ситуаций: они изменились или ещё не подтверждены.');
      }
      if (record.questions.length) throw new Error('Сначала ответьте на бизнес-вопросы из черновика: добавьте ответы в материалы и подготовьте новый эксперимент.');
      // A control delivers only its opening, so its script never has to fit.
      if (record.settings.userModes.includes('scripted')) for (const scenario of record.scenarios.filter(s => !record.positiveControlScenarioIds?.includes(s.id))) {
        const issue = scriptIssue(scenario.user, record.settings.maxTurns);
        if (issue) throw new Error(`${scenario.title}: ${issue}`);
      }
      await preflightTarget(record.target);
      if (record.evaluatorVersion && record.evaluatorVersion !== evaluatorVersion(record.settings)) throw new Error('Версия оценщика изменилась. Обновите черновик и проверьте условия запуска.');
      if (record.targetFingerprint && !sameTargetVersion(record.targetFingerprint, await targetFingerprint(record.target))) {
        throw new Error('Код агента изменился после подготовки карточек. Обновите подключение в настройках и подтвердите новую версию.');
      }
      record.reviewedAt = new Date().toISOString();
      record.reviewMode = options.reviewer ?? 'human';
      if (record.reviewMode === 'automated') record.limitations.push('Generated scenario expectations were checked automatically, without human validation. Spot-check disputes; decisive automatic results remain usable as provisional evidence.');
      // The owner confirmed the expectations, and nothing else. The verdicts are produced after this
      // point, so no confirmation here can mean a person checked them: say so instead of going quiet.
      if (record.reviewMode === 'expectations') record.limitations.push('Владелец подтвердил ожидания ситуаций перед запуском. Определения карточек и оценки судьи человеком не проверялись.');
      record.manifestHash = measurementHash(record);
      record.phase = 'evaluating';
      record.message = 'Выполняю согласованный план проверки.';
      await this.launch(record, ctx => this.evaluateReviewed(record, ctx, parallel), true);
      return structuredClone(record);
    });
  }
  async cancel(id: string): Promise<Experiment> {
    if (this.active?.record.id !== id) throw new Error('Этот эксперимент сейчас не идёт.');
    this.active.controller.abort(new Stopped('cancelled', 'Cancelled by the user.'));
    this.active.record.message = 'Cancelling; preserving recorded evidence.';
    return structuredClone(this.active.record);
  }
  async waitForIdle(): Promise<void> { await this.lastTask; }
  async close(): Promise<void> {
    this.closed = true; this.closing = true;
    this.active?.controller.abort(new Stopped('closing', 'Application is closing.'));
    try { await this.initializing; await this.waitForIdle(); await this.mutation; } finally { await this.store.close(); }
  }
  private async runtime(record: Experiment): Promise<Runtime> {
    const runtime = this.injectedRuntime ?? (record.mode === 'demo' ? createDemoRuntime() : await createPiRuntime(record.settings));
    return captureGeneratorEvidence(runtime, event => this.store.appendGeneratorEvidence(record.id, event));
  }
  private async launch(record: Experiment, work: (ctx: CallContext) => Promise<void>, ownsMutation = false): Promise<void> {
    this.ensureIdle(ownsMutation);
    const controller = new AbortController();
    const preparationElapsedBeforeMs = record.phase === 'preparing' ? record.preparationProgress?.elapsedMs ?? 0 : undefined;
    const active = { record, controller, done: Promise.resolve(), startedAtMs: performance.now(), preparationElapsedBeforeMs };
    this.active = active; // Reserve before the first await, including the initial checkpoint.
    let saved = false;
    let ready!: () => void;
    let failed!: (error: unknown) => void;
    const initialCheckpoint = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    const remainingDurationMs = Math.max(0, record.settings.maxDurationMs - (preparationElapsedBeforeMs ?? 0));
    const outOfTime = () => controller.abort(new Stopped('time', 'Experiment time limit reached.'));
    if (!remainingDurationMs) outOfTime();
    const timer = setTimeout(outOfTime, remainingDurationMs);
    const ctx: CallContext = {
      signal: controller.signal, timeoutMs: record.settings.timeoutMs,
      beforeCall: () => {
        controller.signal.throwIfAborted();
        if (record.usage.calls >= record.settings.maxCalls) {
          controller.abort(new Stopped('budget', 'Model call budget exhausted.')); controller.signal.throwIfAborted();
        }
        record.usage.calls++;
      },
      addUsage: usage => addUsage(record.usage, usage),
      onTrace: (trialId, event) => this.store.appendTrace(record.id, trialId, event),
      // Every judgment report replaces the sidecar; only the finished one goes to the journal.
      onJudgment: (trialId, audit, final) => {
        this.store.writeJudgeAudit(record.id, trialId, audit);
        if (final) this.store.appendJudgment(record.id, trialId, audit);
      },
    };
    active.done = (async () => {
      try {
        await this.store.save(record); saved = true; ready();
        controller.signal.throwIfAborted();
        await work(ctx);
        if (record.phase !== 'results_review') controller.signal.throwIfAborted();
      }
      catch (error) {
        if (!saved) { failed(error); throw error; }
        const reason = controller.signal.aborted ? controller.signal.reason : error;
        record.error = reason instanceof Error ? reason.message : String(reason);
        record.phase = record.phase === 'preparing' && record.librarySnapshot ? 'review'
          : reason instanceof Stopped && (reason.reason === 'cancelled' || reason.reason === 'closing') ? 'cancelled' : 'error';
        record.message = record.error;
      } finally {
        clearTimeout(timer); this.updateElapsed(record); record.updatedAt = new Date().toISOString();
        try { if (saved) await this.store.save(record); }
        finally { if (this.active === active) this.active = null; }
      }
    })();
    this.lastTask = active.done;
    // Errors saving the final checkpoint remain observable through waitForIdle and diagnostics.
    void active.done.catch(error => { process.stderr.write(`Agent Lab checkpoint failed: ${error instanceof Error ? error.message : String(error)}\n`); });
    await initialCheckpoint;
  }
  private async checkpoint(record: Experiment, phase: Experiment['phase'], message: string): Promise<void> {
    this.updateElapsed(record);
    record.phase = phase; record.message = message; record.updatedAt = new Date().toISOString();
    // ponytail: full JSON checkpoints keep one canonical record; split trial storage when runs exceed local-scale sizes.
    await this.store.save(record);
  }
  /** A preparation carries its elapsed time across resumes, so the owner's time limit covers all of them together. */
  private updateElapsed(record: Experiment): void {
    if (record.preparationProgress && this.active?.record === record && this.active.preparationElapsedBeforeMs !== undefined) {
      record.preparationProgress.elapsedMs = this.active.preparationElapsedBeforeMs + Math.max(0, Math.round(performance.now() - this.active.startedAtMs));
    }
  }
  /** Re-checks the frozen manifest before and after every trial; a drifted suite stops the run instead of grading it. */
  private frozenGuard(record: Experiment, hash: string, ctx: CallContext): () => void {
    return () => {
      ctx.signal.throwIfAborted();
      if (measurementHash(record) !== hash) throw new Error('The approved evaluation conditions changed. Create a fresh reviewed run.');
    };
  }
  /** The single trial loop: every user mode, every scenario, every repeat, one checkpoint per trial. */
  private async runSuite(record: Experiment, runtime: Runtime, revision: Revision, ctx: CallContext, parallel = 1): Promise<void> {
    const hash = record.manifestHash;
    if (!hash) throw new Error('Missing measurement manifest.');
    const guard = this.frozenGuard(record, hash, ctx);
    const scenarios = record.scenarios;
    const controls = new Set(record.positiveControlScenarioIds ?? []);
    const planned = plannedTrials({ ...record, scenarios });
    // Every attempt in the order it would run one at a time; a pool of `parallel` workers takes them from the front,
    // so a finished dialogue is recorded as soon as it ends and the trial order is the completion order.
    const firstTrial = record.trials.length;
    const attempts: Array<{ userMode: UserMode; scenario: Scenario; repeat: number }> = [];
    for (const userMode of record.settings.userModes) {
      const skipped: string[] = [];
      for (const scenario of scenarios) {
        if (userMode === 'scripted' && scenario.user.script === undefined) { skipped.push(scenario.id); continue; }
        for (let repeat = 0; repeat < record.settings.repeats; repeat++) attempts.push({ userMode, scenario, repeat });
      }
      if (skipped.length) {
        const note = `Scripted mode skipped ${skipped.length} card(s) without a script: ${skipped.join(', ')}.`;
        if (!record.limitations.includes(note)) record.limitations.push(note);
      }
    }
    const fingerprintCheck = async (message: string) => {
      if (record.targetFingerprint && !sameTargetVersion(record.targetFingerprint, await targetFingerprint(record.target))) throw new Error(message);
    };
    let completed = 0, next = 0;
    let failed = false;
    const worker = async () => {
      while (next < attempts.length && !failed) {
        const { userMode, scenario, repeat } = attempts[next++]!;
        const prefix = record.settings.userModes.length > 1 ? `[${userMode}] ` : '';
        const running = () => parallel > 1 ? ` · параллельно ${Math.min(parallel, attempts.length - completed)}` : '';
        guard();
        await fingerprintCheck('Код внешнего агента изменился во время прогона. Создайте повтор с новой версией.');
        const progress = () => `${prefix}${scenario.title} · диалог ${completed + 1}/${planned}${running()}`;
        record.message = `${progress()} · открываем сессию`;
        const trial = await evaluateTrial({ runtime, revision, scenario, repeat, manifestHash: hash, sources: record.sources, judgeSources: scenarioSources(record, scenario), requirements: record.requirements, settings: record.settings,
          control: controls.has(scenario.id), onStage: stage => { record.message = `${progress()} · ${{ target: 'ответ агента', user: 'реплика пользователя', assessment: 'оценка критериев' }[stage]}`; },
          ctx: { ...ctx, onTrace: (trialId, event) => {
            ctx.onTrace?.(trialId, event);
            const stage = event.type === 'user' ? 'ждём ответ агента' : event.type === 'assistant' ? 'ответ получен · готовим следующий шаг'
              : event.type === 'simulator' ? 'реплика симулятора готова' : event.type === 'tool_call' ? `инструмент ${event.tool ?? ''}`
              : event.type === 'tool_result' ? 'инструмент завершён' : event.type === 'retrieval' ? 'RAG-контекст получен' : 'сбой диалога';
            record.message = `${progress()} · ${stage}`;
          } }, userMode, target: record.target });
        record.trials.push(trial);
        if (scenario.initialState.external && trial.observation?.resetConfirmed !== true) {
          const note = 'Внешнее состояние карточек не подтверждено адаптером (resetConfirmed): проверки состояния не измерены.';
          if (!record.limitations.includes(note)) record.limitations.push(note);
        }
        if (trial.observation?.version) {
          if (record.targetRelease && record.targetRelease !== trial.observation.version) throw new Error('Внешний агент сообщил разные версии в одном прогоне. Сравнение недоступно.');
          record.targetRelease = trial.observation.version;
        }
        completed++;
        await this.checkpoint(record, record.phase, `${prefix}${scenario.title} · ${repeat + 1}/${record.settings.repeats}`);
        await fingerprintCheck('Код внешнего агента изменился во время диалога. Результат сохранён, но сравнение недоступно.');
        guard();
      }
    };
    // One failure stops the pool: the other workers finish the dialogue they are in and take no more; the first error is the run's error.
    const results = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(parallel, attempts.length)) }, () => worker().catch(error => { failed = true; throw error; })));
    // Dialogues finish in any order when run together; the record keeps them in card order so reports and reviews read the same every time.
    const cardOrder = new Map(attempts.map((attempt, index) => [`${attempt.scenario.id}|${attempt.userMode}|${attempt.repeat}`, index]));
    const position = (trial: Experiment['trials'][number]) => cardOrder.get(`${trial.scenarioId}|${trial.userMode}|${trial.repeat}`) ?? attempts.length;
    record.trials.push(...record.trials.splice(firstTrial).sort((a, b) => position(a) - position(b)));
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (rejected) throw rejected.reason;
  }
  /** The rollout of the version under test. The adapter's reported `version` remains the identity; this only performs the deployment. */
  private async release(record: Experiment, ctx: CallContext): Promise<void> {
    const target = runnableTarget(record.target);
    if (!target.release) return;
    const env: NodeJS.ProcessEnv = { ...process.env, AGENT_LAB_RUN_ID: record.id,
      ...(record.targetVersion ? { AGENT_LAB_TARGET_VERSION: record.targetVersion } : {}),
      ...(target.promptFile ? { AGENT_LAB_PROMPT_FILE: target.promptFile, AGENT_LAB_PROMPT_HASH: fingerprint(await readPrompt(target.promptFile)) } : {}) };
    await this.checkpoint(record, record.phase, 'Разворачиваю проверяемую версию агента (хук выпуска).');
    record.releaseLog = await runRelease(target.release, env, ctx.signal);
    ctx.signal.throwIfAborted();
    if (record.releaseLog.exitCode !== 0) throw new Error(`Хук выпуска завершился с кодом ${record.releaseLog.exitCode ?? record.releaseLog.signal ?? 'unknown'}: ${record.releaseLog.stderr.trim().slice(-500) || 'без вывода'}`);
  }
  private async evaluateReviewed(record: Experiment, ctx: CallContext, parallel = 1): Promise<void> {
    const runtime = await this.runtime(record);
    const agent = record.revisions[0];
    if (!agent || !record.manifestHash) throw new Error('Missing reviewed agent or measurement manifest.');
    await this.release(record, ctx);
    await this.runSuite(record, runtime, agent, ctx, parallel);
    this.frozenGuard(record, record.manifestHash, ctx)();
    await this.nameFailureModes(record, runtime, ctx);
    if (record.trials.some(t => !['invalid', 'cancelled'].includes(t.outcome))) {
      await rememberConnection(this.store.directory, { format: 'agent-lab-connection-1', target: runnableTarget(record.target), targetVersion: record.targetVersion });
    }
    await this.checkpoint(record, 'results_review', 'Диалоги и оценки готовы. Разберите провалы и проверьте поведение симулятора, прежде чем принимать результат.');
  }
  /**
   * Naming the failure precisely is what turns an evaluation into an improvement loop, so the
   * failed dialogues of a finished run are clustered and named — a single failure gets a name
   * too, because one named failure is already a fix to try. When the prompt of the agent is
   * known (a promptFile, or the sandbox instructions), the cluster may quote the fragment that
   * governed the broken behaviour; quotes are checked verbatim. A failed clustering must not
   * lose a completed run: it is recorded as a limitation instead.
   */
  private async nameFailureModes(record: Experiment, runtime: Runtime, ctx: CallContext): Promise<void> {
    // Exactly the attempts the number calls failures: a cause must explain the headline, not a rubric it does not count.
    // Clustering runs just before the run turns to results_review, and a strict legacy card is decided only on a finished
    // run, so the failures are read from the record as it is about to be saved.
    const failed = deriveRun({ ...record, phase: 'results_review' }).failedAttempts;
    if (!runtime.failureModes || !failed.length) return;
    const failures = failed.map(trial => ({
      trialId: trial.id,
      card: record.scenarios.find(s => s.id === trial.scenarioId)?.title ?? trial.scenarioId,
      reason: trial.reason,
      failed: [
        ...trial.checks.filter(c => !c.passed).map(c => c.description),
        ...(trial.assessments ?? []).filter(a => a.result === 'fail').map(a => a.rationale),
      ],
      trace: trial.events.filter(e => e.type !== 'simulator')
        .map(e => `#${e.seq} ${e.type}${e.tool ? ` ${e.tool}` : ''}: ${e.text ?? JSON.stringify(e.result ?? e.args ?? '')}`).join('\n').slice(0, 12000),
    }));
    try {
      const suppliedPrompt = record.sources.filter(source => source.kind === 'prompt').map(source => source.content).join('\n\n') || undefined;
      const prompt = suppliedPrompt ?? (record.target.kind !== 'sandbox'
        ? (record.target.promptFile ? await readPrompt(record.target.promptFile) : undefined)
        : record.revisions.find(r => r.id === record.selectedRevisionId)?.spec.instructions);
      const modes = await runtime.failureModes({ task: record.task, failures, ...(prompt !== undefined ? { prompt } : {}) }, ctx);
      validateFailureModes(modes, failed, prompt);
      record.failureModes = modes;
    } catch (error) {
      record.limitations.push(`Не удалось назвать типы провалов: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
