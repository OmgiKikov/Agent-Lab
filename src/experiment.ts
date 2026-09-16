import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  DISCOVERY_PROTOCOL, VERSION, agentSchema, createInputSchema, dialogueToScenario, dialogueToTrial, discoverInputSchema, discoveryGroupSchema, discoveryObservationSchema, draftPatchSchema, emptyUsage, experimentSchema, fingerprint, goalToScenario, goldenToScenario, humanReviewInputSchema, promptCompliance, proposalSchema, requirementSchema, scriptIssue, settingsSchema, validateFailureModes, validateObservedGoals, validatePreparation, verbatimSpan,
  reassessmentSchema, type ReassessmentInput, type CallContext, type CreateInput, type Dialogue, type ValidationExclusion, type DiscoverInput, type DiscoveryDialogue, type DiscoveryGroup, type DiscoveryObservation, type DiscoveryPlan, type DiscoveryRecord, type DraftPatch, type Experiment, type HumanReviewInput, type ObservedGoal, type Requirement, type Revision, type Runtime, type Scenario, type UserMode } from './contracts.js';
import { ExperimentStore } from './store.js';
import { assessTrial, evaluateTrial, grade } from './evaluation.js';
import { automaticTrialResult, trialAssessmentComplete, awaitingVerdict, compareTrials, isAgentFailure, plannedTrials } from './comparison.js';
import { targetFingerprint } from './target-version.js';
import { portableTarget, rememberConnection, resolveTarget, suiteEvidence, type Connection } from './connection.js';
import { preflightTarget, readPrompt, runRelease } from './targets.js';
import { simulatorChecks } from './simulator.js';
import { validationDialogueIssue } from './imports.js';
import { assessmentRubrics, validationScenario } from './contracts.js';
import { createDemoRuntime } from './demo.js';
import { createPiRuntime, evaluatorVersion } from './pi.js';

/*
 * Phase machine owned by ExperimentLab. Every transition is an atomic checkpoint.
 *
 *   preparing ─► review ─┬─► evaluating ─► results_review ─► complete      (workflow: evaluate)
 *                        └─► baseline ─► improving* ─► control ─► complete (workflow: compare)
 *   any running phase ─► cancelled | error | interrupted
 *
 * runSuite is the only trial loop; both workflows call it.
 */
const runningPhases = new Set(['preparing', 'evaluating', 'baseline', 'improving', 'control']);
export function draftHash(record: Experiment): string {
  return fingerprint({ task: record.task, workflow: record.workflow, mode: record.mode, sources: record.sources,
    settings: record.settings, target: record.target, requirements: record.requirements, questions: record.questions,
    goldenCases: record.goldenCases, dialogues: record.dialogues, profiles: record.profiles, notes: record.notes,
    scenarios: record.scenarios, agent: record.revisions[0]?.spec,
    targetVersion: record.targetVersion, targetFingerprint: record.targetFingerprint, evaluatorVersion: record.evaluatorVersion });
}
export function resultHash(record: Experiment): string {
  return fingerprint({ draft: draftHash(record), trials: record.trials, humanReviews: record.humanReviews ?? [] });
}
export function measurementHash(record: Experiment): string {
  return fingerprint({ version: VERSION, workflow: record.workflow, task: record.task, baseline: record.revisions[0], mode: record.mode, sources: record.sources, requirements: record.requirements, scenarios: record.scenarios, settings: record.settings,
    target: record.target, goldenCases: record.goldenCases, dialogues: record.dialogues, profiles: record.profiles, notes: record.notes,
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
  if (record.target.kind !== 'sandbox') record.scenarios = record.scenarios.map(scenario =>
    scenario.goalObservation ? scenario : { ...scenario, goalObservation: 'reply' });
  Object.assign(record, { id: randomUUID(), parentRunId: previous.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    phase: 'review', message: 'Тесты готовы. Проверьте подключение и запустите проверку.',
    trials: [], comparisons: [], iterations: [], humanReviews: [], usage: emptyUsage(),
    reviewedAt: null, reviewMode: null, manifestHash: null, controlConsumedAt: null, error: null });
  delete record.resultsReviewedAt; delete record.resultsReviewHash; delete record.failureModes;
  delete record.acceptedDraftHash;
  delete record.targetRelease; delete record.assessmentOf; delete record.assessmentTrialIds; delete record.evidenceHash; delete record.releaseLog;
  retainAcceptedTests(record);
  record.evaluatorVersion = evaluatorVersion(record.settings);
  record.limitations = previous.limitations.filter(note => !note.startsWith('Scripted mode skipped') && !note.startsWith('Не удалось назвать типы провалов:')
    && !note.startsWith('Внешнее состояние карточек не подтверждено'));
  return record;
}

export const DISCOVERY_BATCH_ITEMS = 25;
export const DISCOVERY_BATCH_CHARS = 60_000;

const discoveryDialogue = (dialogue: DiscoverInput['dialogues'][number]): DiscoveryDialogue => ({
  id: dialogue.id,
  messages: dialogue.messages.map((message, seq) => ({ seq, role: message.role, content: message.content })),
});
const discoveryPayloadSize = (dialogues: DiscoveryDialogue[]) => JSON.stringify({ dialogues }).length;

/** Pure call/batch plan shown before any model work. */
export function planDiscovery(input: Pick<DiscoverInput, 'dialogues' | 'materials'> & { settings?: DiscoverInput['settings'] }): DiscoveryPlan {
  const batches: DiscoveryDialogue[][] = [];
  const oversizedIds: string[] = [];
  let batch: DiscoveryDialogue[] = [];
  for (const raw of input.dialogues) {
    const dialogue = discoveryDialogue(raw);
    if (discoveryPayloadSize([dialogue]) > DISCOVERY_BATCH_CHARS) { oversizedIds.push(dialogue.id); continue; }
    if (batch.length === DISCOVERY_BATCH_ITEMS || discoveryPayloadSize([...batch, dialogue]) > DISCOVERY_BATCH_CHARS) {
      if (batch.length) batches.push(batch);
      batch = [];
    }
    batch.push(dialogue);
  }
  if (batch.length) batches.push(batch);
  const eligible = input.dialogues.filter(dialogue => !oversizedIds.includes(dialogue.id)
    && dialogue.messages.some(message => message.role === 'user')).length;
  const selectedCap = Math.min(5, eligible);
  const metrics = 2 + Number(input.materials.some(material => material.kind === 'prompt'));
  const batchCount = batches.length;
  const nominalCalls = batchCount + (2 * metrics + 1) * selectedCap + 3;
  const base = settingsSchema.parse(input.settings ?? {});
  const maxCalls = nominalCalls + Math.max(10, Math.ceil(batchCount / 4));
  const maxDurationMs = Math.min(14_400_000, Math.max(base.maxDurationMs, Math.ceil(base.maxDurationMs * maxCalls / base.maxCalls)));
  return {
    batches, batchCount, oversizedIds, selectedCap, metrics, nominalCalls,
    maxCalls, maxDurationMs, baseMaxCalls: base.maxCalls, baseMaxDurationMs: base.maxDurationMs,
    seed: fingerprint({ protocol: DISCOVERY_PROTOCOL, dialogues: input.dialogues.map(discoveryDialogue) }),
  };
}

const localUnknown = (dialogueId: string, summary: string): DiscoveryObservation => ({
  dialogueId, classification: 'unknown', summary, citations: [],
});

function reconcileDiscoveryBatch(batch: DiscoveryDialogue[], raw: DiscoveryObservation[], requirements: Requirement[]): DiscoveryObservation[] {
  const requirementIds = new Set(requirements.map(requirement => requirement.id));
  return batch.map(dialogue => {
    const matches = raw.filter(observation => observation.dialogueId === dialogue.id);
    if (matches.length !== 1) return localUnknown(dialogue.id, matches.length ? 'Модель вернула несколько классификаций.' : 'Модель не вернула классификацию.');
    const parsed = discoveryObservationSchema.safeParse(matches[0]);
    if (!parsed.success) return localUnknown(dialogue.id, 'Классификация модели не прошла проверку.');
    const observation = parsed.data;
    if (!dialogue.messages.some(message => message.role === 'user')) return localUnknown(dialogue.id, 'В диалоге нет реплики пользователя.');
    if (observation.requirementId && !requirementIds.has(observation.requirementId)) return localUnknown(dialogue.id, 'Ссылка на неизвестное требование владельца.');
    for (const citation of observation.citations) {
      const event = dialogue.messages.find(message => message.seq === citation.seq);
      const exact = event && verbatimSpan(event.content, citation.quote);
      if (!event || !exact) return localUnknown(dialogue.id, 'Ссылка на событие диалога не подтверждена.');
      citation.quote = exact;
    }
    if (observation.classification === 'candidate' && !observation.citations.some(citation =>
      dialogue.messages.some(message => message.seq === citation.seq && message.role === 'assistant'))) {
      return localUnknown(dialogue.id, 'Кандидат не содержит точной ссылки на ответ агента.');
    }
    return observation;
  });
}

function reconcileDiscoveryGroups(raw: unknown, observations: DiscoveryObservation[], requirements: Requirement[]): DiscoveryGroup[] {
  if (!Array.isArray(raw)) return [];
  const requirementIds = new Set(requirements.map(requirement => requirement.id));
  const candidates = new Set(observations.filter(observation => observation.classification === 'candidate' && observation.requirementId)
    .map(observation => `${observation.requirementId}:${observation.dialogueId}`));
  const unique = new Map<string, DiscoveryGroup>();
  for (const value of raw) {
    const parsed = discoveryGroupSchema.safeParse(value);
    if (!parsed.success || !requirementIds.has(parsed.data.requirementId)
      || parsed.data.dialogueIds.some(id => !candidates.has(`${parsed.data.requirementId}:${id}`))) continue;
    const group = { ...parsed.data, dialogueIds: [...parsed.data.dialogueIds].sort() };
    unique.set(fingerprint({ requirementId: group.requirementId, dialogueIds: group.dialogueIds }), group);
  }
  const groups = [...unique.values()];
  const memberships = new Map<string, number>();
  for (const group of groups) for (const id of group.dialogueIds) {
    const key = `${group.requirementId}:${id}`;
    memberships.set(key, (memberships.get(key) ?? 0) + 1);
  }
  return groups.filter(group => group.dialogueIds.every(id => memberships.get(`${group.requirementId}:${id}`) === 1))
    .sort((left, right) => fingerprint({ requirementId: left.requirementId, dialogueIds: left.dialogueIds })
      .localeCompare(fingerprint({ requirementId: right.requirementId, dialogueIds: right.dialogueIds })));
}

function selectDiscoveryFocus(record: Experiment): void {
  const discovery = record.discovery!;
  const recurring = (discovery.groups ?? []).filter(group => group.dialogueIds.length >= 2)
    .map(group => [group.requirementId, new Set(group.dialogueIds)] as const)
    .sort(([left, leftIds], [right, rightIds]) => rightIds.size - leftIds.size
      || fingerprint({ seed: discovery.seed, requirementId: left, dialogueIds: [...leftIds].sort() })
        .localeCompare(fingerprint({ seed: discovery.seed, requirementId: right, dialogueIds: [...rightIds].sort() })));
  const focus = recurring[0];
  if (!focus) return;
  const [requirementId, memberSet] = focus;
  const rank = (role: 'representative' | 'control', dialogueId: string) => fingerprint({ seed: discovery.seed, role, requirementId, dialogueId });
  const members = [...memberSet].sort((left, right) => rank('representative', left).localeCompare(rank('representative', right)) || left.localeCompare(right));
  const controls = record.dialogues.map(dialogue => dialogue.id).filter(id => !memberSet.has(id) && !discovery.oversizedIds.includes(id)
    && record.dialogues.find(dialogue => dialogue.id === id)!.messages.some(message => message.role === 'user'))
    .sort((left, right) => rank('control', left).localeCompare(rank('control', right)) || left.localeCompare(right));
  discovery.focusRequirementId = requirementId;
  discovery.representativeIds = members.slice(0, 3);
  discovery.controlIds = controls.slice(0, 2);
  discovery.selectedIds = [...discovery.representativeIds, ...discovery.controlIds];
}

function confirmedDiscoveryRepresentativeIds(discovery: DiscoveryRecord, requirementId: string): Set<string> {
  return new Set(discovery.deep.filter(result => {
    const verdicts = result.assessments?.filter(assessment => assessment.metricId === 'goal_attainment') ?? [];
    return result.role === 'representative' && discovery.representativeIds.includes(result.dialogueId)
      && discovery.observations.some(observation => observation.dialogueId === result.dialogueId
        && observation.classification === 'candidate' && observation.requirementId === requirementId)
      && result.goal?.requirementIds?.length === 1 && result.goal.requirementIds[0] === requirementId
      && verdicts.length === 1 && verdicts[0]!.result === 'fail';
  }).map(result => result.dialogueId));
}

export class ExperimentLab {
  readonly store: ExperimentStore;
  private active: { record: Experiment; controller: AbortController; done: Promise<void>; startedAtMs: number; discoveryElapsedBeforeMs: number } | null = null;
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
      for (const record of await this.store.list()) if (runningPhases.has(record.phase)) {
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
      target: input.target, goldenCases: input.goldenCases, dialogues: input.dialogues, profiles: input.profiles, notes: input.notes,
      evaluatorVersion: evaluatorVersion(input.settings),
      ...(input.targetVersion ? { targetVersion: input.targetVersion } : {}),
      limitations: [
        input.target.kind === 'sandbox' ? 'Tools operate on isolated test records, not production systems. Only instructions and registered tool permissions are edited.' : 'External agent state and tool events are reported by its adapter. Isolation and reset of external services are the responsibility of that adapter.',
        'Scenario expectations are grounded automatically and should be spot-checked; text matching checks measure literal content, not semantic correctness.',
        'Synthetic simulations do not establish performance with real users. Model rubric assessments are provisional; human review is reserved for disputes and calibration claims.',
        'Model costs are observed usage estimates; unknown costs remain unknown. Call limits are not hard provider billing caps.',
        ...(input.mode === 'demo' ? ['Scripted demonstration: user/target behavior and the missing-tool repair are deterministic fixtures, not a measured LLM improvement.'] : []),
      ],
    };
  }
  async create(raw: CreateInput): Promise<Experiment> { return this.createPrepared(raw); }
  private async createPrepared(raw: CreateInput, preparedRequirements?: Requirement[]): Promise<Experiment> {
    this.ensureIdle();
    const input = createInputSchema.parse(raw);
    if (input.validationCount) input.settings.userModes = ['reactive'];
    if (input.workflow === 'compare' && input.settings.userModes.length !== 1) throw new Error('Сравнительный эксперимент идёт в одном режиме пользователя: выберите static, scripted или reactive.');
    if (input.workflow === 'compare' && input.target.kind !== 'sandbox') throw new Error('Для внешнего агента используйте evaluate и повтор набора; автоматический ремонт поддерживает только песочницу.');
    const record = this.newRecord(input);
    await this.launch(record, async ctx => {
      await preflightTarget(record.target);
      record.targetFingerprint = await targetFingerprint(record.target);
      const runtime = await this.runtime(record);
      const confirmed = !!input.confirmedHypothesis;
      const replay = !confirmed && record.dialogues.length > 0 && input.scenarioCount === 0
        && (!!input.validationCount || input.settings.userModes.length === 1 && input.settings.userModes[0] === 'scripted');
      const exclude = (item: ValidationExclusion) => {
        record.validationExclusions = [...(record.validationExclusions ?? []), item];
        record.limitations.push(`Исключён ${item.dialogueId}: ${item.reason.replace(/\.$/, '')}.`);
      };
      if (input.validationCount) record.dialogues = record.dialogues.filter(dialogue => {
        const issue = validationDialogueIssue(dialogue);
        if (issue) exclude({ dialogueId: dialogue.id, ...issue });
        return !issue;
      });
      if (new Set(record.profiles.map(p => p.id)).size !== record.profiles.length) throw new Error('У профилей повторяются идентификаторы.');
      const preparationInput = (observedGoals: ObservedGoal[] = []) => ({
        task: record.task, sources: record.sources, existingAgent: input.existingAgent, workflow: input.workflow, scenarioCount: input.scenarioCount,
        profiles: structuredClone(record.profiles), goldenCases: structuredClone(record.goldenCases), notes: record.notes, observedGoals: structuredClone(observedGoals),
        targetKind: record.target.kind, confirmedHypothesis: input.confirmedHypothesis, goalObservation: input.goalObservation,
        dialogues: structuredClone(record.dialogues), userModes: structuredClone(record.settings.userModes), requirements: preparedRequirements,
      });
      // A validation replay first grounds owner requirements, then derives exactly one card per sampled dialogue.
      const grounding = replay ? await runtime.prepare(preparationInput(), ctx) : undefined;
      let observedGoals: ObservedGoal[] = [];
      if (!confirmed && record.dialogues.length) {
        if (!runtime.goals) throw new Error('Модель не умеет извлекать цели из записанных диалогов.');
        if (replay) {
          const extract = async (dialogue: Dialogue) => {
            const request = () => runtime.goals!({ task: record.task, sources: structuredClone(record.sources), dialogues: [structuredClone(dialogue)], profiles: structuredClone(record.profiles), requirements: structuredClone(grounding!.requirements), requireApplicable: !!input.validationCount }, ctx);
            try { return await request(); }
            catch (error) {
              if (!/connection failure|fetch failed|ECONNRESET/i.test(error instanceof Error ? error.message : String(error))) throw error;
              return request();
            }
          };
          for (let index = 0; index < record.dialogues.length && observedGoals.length < (input.validationCount ?? Infinity); index += 2) {
            const batch = record.dialogues.slice(index, index + 2);
            const extracted = (await Promise.all(batch.map(extract))).flat();
            if (input.validationCount) for (const dialogue of batch) {
              const goal = extracted.find(goal => goal.evidenceDialogueIds.includes(dialogue.id));
              if (goal?.testability !== 'knowledge') exclude({ dialogueId: dialogue.id, kind: goal?.testability === 'customer_data' ? 'customer_data' : 'unconfirmed',
                reason: goal?.testabilityReason ?? 'ожидание или достаточность среды для prompt/RAG не подтверждены' });
            }
            observedGoals.push(...extracted.filter(goal => !input.validationCount || goal.testability === 'knowledge'));
          }
          if (input.validationCount) observedGoals = observedGoals.slice(0, input.validationCount);
        } else observedGoals = await runtime.goals({ task: record.task, sources: structuredClone(record.sources), dialogues: structuredClone(record.dialogues), profiles: structuredClone(record.profiles) }, ctx);
      }
      if (input.validationCount && !observedGoals.length) throw new Error('Нет измеримых prompt/RAG-сценариев: нужны требования владельца и случаи без отсутствующих данных клиента. Причины исключений сохранены.');
      if (input.validationCount && observedGoals.length < input.validationCount) record.limitations.push(`Измеримы ${observedGoals.length} из запрошенных ${input.validationCount} карточек. Исключённые случаи не входят в accuracy.`);
      validateObservedGoals(observedGoals, record.dialogues, record.profiles);
      const generated = grounding ?? await runtime.prepare(preparationInput(observedGoals), ctx);
      if (confirmed && input.goalObservation === 'reply') for (const scenario of generated.scenarios) {
        const seeded = Object.keys(scenario.initialState.records).length > 0 || scenario.initialState.writableFields.length > 0
          || scenario.initialState.transientFailures > 0 || Object.keys(scenario.initialState.external ?? {}).length > 0;
        if (seeded || scenario.checks.some(check => !['answer_equals', 'answer_contains', 'answer_omits'].includes(check.kind))) {
          throw new Error(`Карточка ${scenario.id}: reply-only RAG тест не может задавать backend state или tool/state проверки.`);
        }
      }
      const production = observedGoals.map(goal => {
        if (!replay) return goalToScenario(goal, record.profiles.find(p => p.id === goal.profileId));
        const dialogue = record.dialogues.find(item => item.id === goal.evidenceDialogueIds[0]);
        if (!dialogue || goal.evidenceDialogueIds.length !== 1) throw new Error(`Validation goal ${goal.id} must cite exactly one sampled dialogue.`);
        const scenario = input.validationCount ? validationScenario(dialogue, goal) : dialogueToScenario(dialogue, { goal: goal.goal, successCriteria: goal.successCriteria,
          requirementIds: goal.requirementIds, goalObservation: input.goalObservation ?? 'reply' });
        if (record.sources.some(source => source.kind === 'prompt')) scenario.metrics!.unshift({ ...promptCompliance });
        return scenario;
      });
      const golden = record.goldenCases.map(goldenToScenario);
      const synthetic = generated.scenarios.map(s => ({ ...s, provenance: 'synthetic' as const }));
      if (replay && input.validationCount) {
        const selected = new Set(observedGoals.flatMap(goal => goal.evidenceDialogueIds));
        record.dialogues = record.dialogues.filter(dialogue => selected.has(dialogue.id));
      }
      const scenarios = [...synthetic, ...production, ...golden].map(scenario => {
        const goalObservation = input.goalObservation ?? scenario.goalObservation ?? (record.target.kind === 'sandbox' ? undefined : 'reply');
        return goalObservation ? { ...scenario, goalObservation } : scenario;
      });
      const prepared = validatePreparation({ ...generated, scenarios }, record.sources, input.workflow, record.profiles);
      Object.assign(record, { requirements: prepared.requirements, questions: prepared.questions, scenarios: prepared.scenarios });
      const baseline = revision(input.existingAgent ?? prepared.agent, null, input.workflow === 'evaluate' ? 'Agent configuration selected for dialogue evaluation.' : 'Original agent before measured improvements.');
      record.revisions.push(baseline); record.selectedRevisionId = baseline.id;
      await this.checkpoint(record, 'review', 'Тест готов. Проверьте запрос, ожидаемый результат и план запуска.');
    });
    return structuredClone(record);
  }
  /** Preserve recorded dialogues as offline evidence. The target and simulator are never opened. */
  async score(raw: CreateInput, options: { codeOnly?: boolean } = {}): Promise<Experiment> {
    this.ensureIdle();
    const input = createInputSchema.parse({ ...raw, workflow: 'evaluate', scenarioCount: 0, goldenCases: [] });
    if (!input.dialogues.length) throw new Error('Для оценки записанных диалогов нужен хотя бы один диалог.');
    for (const dialogue of input.dialogues) if (!dialogue.messages.some(message => message.role === 'user')) {
      throw new Error(`В записанном диалоге ${dialogue.id} нет реплики пользователя.`);
    }
    const record = this.newRecord(input);
    record.message = 'Читаю записанные диалоги и сохраняю исходные события.';
    record.limitations.push('Записанные диалоги: агент и симулятор не запускались; результаты внешних действий не наблюдались.');
    if (options.codeOnly) record.limitations.push('Режим code-only сохранил факты без модельной оценки и кластеров; семантические рубрики остаются без решения.');
    await this.launch(record, async ctx => {
      const runtime = options.codeOnly ? undefined : await this.runtime(record);
      const grounding = runtime ? await runtime.prepare({
        task: record.task, sources: structuredClone(record.sources), existingAgent: input.existingAgent,
        workflow: 'evaluate', scenarioCount: 0, profiles: [], goldenCases: [], notes: record.notes, targetKind: record.target.kind,
      }, ctx) : undefined;
      if (grounding) Object.assign(record, { requirements: grounding.requirements, questions: grounding.questions });
      const unresolved = !!grounding?.questions.length;
      const hasPrompt = record.sources.some(source => source.kind === 'prompt');
      const scenarios: Omit<Scenario, 'split'>[] = [];
      for (const dialogue of record.dialogues) {
        ctx.signal.throwIfAborted();
        if (runtime && !runtime.goals) throw new Error('Модельный score не умеет извлекать цели из записанных диалогов.');
        const goals = runtime?.goals && !unresolved ? await runtime.goals({ task: record.task, sources: structuredClone(record.sources), dialogues: [structuredClone(dialogue)], profiles: [], requirements: structuredClone(grounding!.requirements) }, ctx) : [];
        if (runtime && !unresolved && goals.length !== 1) throw new Error(`Модельный score должен вернуть ровно одну цель для диалога ${dialogue.id}.`);
        const goal = goals[0];
        if (goal) {
          validateObservedGoals([goal], [dialogue], []);
          const known = new Set(grounding!.requirements.map(requirement => requirement.id));
          const unknown = (goal.requirementIds ?? []).filter(id => !known.has(id));
          if (!goal.requirementIds?.length || unknown.length) throw new Error(`Цель диалога ${dialogue.id} ссылается на неизвестные требования владельца: ${unknown.join(', ') || 'нет ссылки'}.`);
        }
        const opening = dialogue.messages.find(message => message.role === 'user')!.content;
        const scenario = dialogueToScenario(dialogue, goal ? {
          goal: goal.goal, successCriteria: goal.successCriteria, requirementIds: goal.requirementIds, goalObservation: input.goalObservation,
        } : {
          goal: dialogue.goal ?? opening,
          ...(dialogue.goal ? { successCriteria: dialogue.goal } : {}),
          goalObservation: input.goalObservation,
        });
        if (hasPrompt) scenario.metrics!.unshift({ ...promptCompliance });
        scenarios.push(scenario);
      }
      const agent = input.existingAgent ?? grounding?.agent ?? { name: 'Записанный агент', instructions: 'Агент не запускался; сохранены только записанные диалоги.', tools: [] };
      if (grounding && !unresolved) {
        const prepared = validatePreparation({ ...grounding, scenarios }, record.sources, 'evaluate');
        Object.assign(record, { requirements: prepared.requirements, questions: prepared.questions, scenarios: prepared.scenarios });
      } else {
        record.scenarios = scenarios.map(scenario => ({ ...scenario, split: 'dev' }));
      }
      const baseline = revision(agent, null, 'Agent configuration associated with imported recorded dialogues.');
      record.revisions.push(baseline); record.selectedRevisionId = baseline.id;
      record.reviewedAt = new Date().toISOString(); record.reviewMode = 'automated';
      record.manifestHash = measurementHash(record);
      for (const dialogue of record.dialogues) {
        const trial = dialogueToTrial(dialogue, record.scenarios.find(scenario => scenario.id === dialogue.id)!, baseline.id);
        trial.manifestHash = record.manifestHash;
        for (const event of trial.events) this.store.appendTrace(record.id, trial.id, event);
        record.trials.push(trial);
      }
      await this.checkpoint(record, 'results_review', unresolved
        ? `Импортировано ${record.trials.length} записанных диалогов. Нужны ответы владельца; оценка не запускалась.`
        : `Импортировано ${record.trials.length} записанных диалогов. Агент и симулятор не запускались.`);
    });
    return structuredClone(record);
  }
  async discover(raw: DiscoverInput): Promise<Experiment> {
    this.ensureIdle();
    const input = discoverInputSchema.parse(raw);
    const plan = planDiscovery(input);
    const settings = settingsSchema.parse({ ...input.settings, maxCalls: plan.maxCalls, maxDurationMs: plan.maxDurationMs });
    const base: CreateInput = {
      task: input.task, materials: input.materials, mode: input.mode, settings,
      workflow: 'evaluate', scenarioCount: 0, target: input.target, goldenCases: [], dialogues: input.dialogues,
      notes: input.notes, profiles: [], ...(input.existingAgent ? { existingAgent: input.existingAgent } : {}),
      ...(input.targetVersion ? { targetVersion: input.targetVersion } : {}),
    };
    const record = this.newRecord(base);
    record.message = 'Ищу повторяющуюся проверяемую проблему в записанных диалогах.';
    const agent = input.existingAgent ?? { name: 'External agent', instructions: 'The recorded agent is not executed during discovery.', tools: [] };
    record.revisions = [revision(agent, null, 'Agent configuration associated with exploratory log discovery.')];
    record.selectedRevisionId = record.revisions[0]!.id;
    record.limitations.push('Exploratory discovery selects suspicious examples; it is not production accuracy or an unbiased quality estimate.');
    record.discovery = {
      protocol: DISCOVERY_PROTOCOL, phase: 'running', error: null, requirements: [], observations: plan.oversizedIds.map(id => localUnknown(id, 'Диалог целиком превышает лимит 60 000 символов и не отправлялся модели.')),
      seed: plan.seed, representativeIds: [], controlIds: [], selectedIds: [], completedBatchCount: 0, groupingComplete: false,
      completedDeepIds: [], deep: [], groups: [], callPlan: { batches: plan.batchCount, selectedCap: plan.selectedCap, metrics: plan.metrics,
        nominalCalls: plan.nominalCalls, maxCalls: plan.maxCalls, baseMaxCalls: plan.baseMaxCalls,
        baseMaxDurationMs: plan.baseMaxDurationMs, maxDurationMs: plan.maxDurationMs }, callsUsed: 0, elapsedMs: 0,
      totalDialogues: input.dialogues.length, oversizedIds: plan.oversizedIds,
    };
    await this.launch(record, ctx => this.executeDiscovery(record, plan, ctx));
    return structuredClone(record);
  }
  async resumeDiscovery(id: string): Promise<Experiment> {
    this.ensureIdle();
    const record = await this.store.get(id);
    if (!record.discovery || record.discovery.phase === 'ready' || record.discovery.phase === 'insufficient') throw new Error('Этот discovery run не требует возобновления.');
    if (record.discovery.activeCall) throw new Error(`Discovery остановился во время модельного вызова «${record.discovery.activeCall}». Его стоимость неизвестна; начните новый discovery run, чтобы не потратить бюджет повторно.`);
    if (record.usage.calls >= record.settings.maxCalls) throw new Error('Бюджет discovery исчерпан; найденные доказательства сохранены.');
    if (record.discovery.callPlan.legacyBudgetMissing) {
      throw new Error('Старая discovery-запись не содержит исходный бюджет. Начните новый discovery run; лимиты не будут увеличены автоматически.');
    }
    if ((record.discovery.elapsedMs ?? 0) >= record.discovery.callPlan.maxDurationMs) {
      throw new Error('Лимит времени discovery исчерпан; найденные доказательства сохранены.');
    }
    const plan = planDiscovery({ dialogues: record.dialogues, materials: record.sources.map(source => ({ name: source.name, content: source.content, kind: source.kind })),
      settings: { ...record.settings, maxCalls: record.discovery.callPlan.baseMaxCalls, maxDurationMs: record.discovery.callPlan.baseMaxDurationMs } });
    record.phase = 'preparing'; record.error = null; record.discovery.phase = 'running'; record.discovery.error = null;
    await this.launch(record, ctx => this.executeDiscovery(record, plan, ctx));
    return structuredClone(record);
  }
  async buildFromDiscovery(fromRunId: string, confirmedHypothesis: string): Promise<Experiment> {
    this.ensureIdle();
    const source = await this.store.get(fromRunId);
    const discovery = source.discovery;
    if (!discovery || discovery.phase !== 'ready' || !discovery.hypothesis) throw new Error('Нужен готовый сохранённый discovery run.');
    if (confirmedHypothesis !== discovery.hypothesis.text) throw new Error('Гипотеза изменилась. Откройте свежий discovery результат перед подтверждением.');
    if (discovery.hypothesis.proposedGoalObservation !== 'reply' || discovery.hypothesis.requirementId !== discovery.focusRequirementId) {
      throw new Error('Сохранённая гипотеза потеряла подтверждённый канал наблюдения или provenance.');
    }
    if (discovery.callPlan.legacyBudgetMissing) {
      throw new Error('Старая discovery-запись не содержит исходный бюджет. Соберите гипотезу заново; лимиты не будут увеличены автоматически.');
    }
    const requirement = discovery.requirements.find(item => item.id === discovery.hypothesis!.requirementId);
    if (!requirement) throw new Error('Требование сохранённой гипотезы отсутствует.');
    const confirmedRepresentatives = confirmedDiscoveryRepresentativeIds(discovery, requirement.id);
    if (confirmedRepresentatives.size < 2) {
      throw new Error('Сохранённая гипотеза не имеет goal_attainment fail, подтверждённого deep-судьёй минимум в двух representative-диалогах.');
    }
    const candidateEvents = new Set(discovery.observations.filter(observation => observation.classification === 'candidate'
      && observation.requirementId === requirement.id && confirmedRepresentatives.has(observation.dialogueId))
      .flatMap(observation => observation.citations.filter(citation => {
        const message = source.dialogues.find(dialogue => dialogue.id === observation.dialogueId)?.messages[citation.seq];
        return message?.role === 'assistant' && !!verbatimSpan(message.content, citation.quote);
      }).map(citation => `${observation.dialogueId}:${citation.seq}`)));
    if (discovery.hypothesis.eventIds.some(citation => !candidateEvents.has(`${citation.dialogueId}:${citation.seq}`))) {
      throw new Error('Гипотеза ссылается не на сохранённый ответ агента из candidate-наблюдения.');
    }
    const evidenceIds = new Set(discovery.hypothesis.eventIds.map(event => event.dialogueId));
    const dialogues = source.dialogues.filter(dialogue => evidenceIds.has(dialogue.id));
    if (!dialogues.length || discovery.hypothesis.eventIds.some(citation => !dialogues.some(dialogue => dialogue.id === citation.dialogueId
      && dialogue.messages[citation.seq]))) throw new Error('Исходные события сохранённой гипотезы отсутствуют.');
    return this.createPrepared({
      task: source.task, confirmedHypothesis, goalObservation: 'reply', mode: source.mode, workflow: 'evaluate', scenarioCount: 1,
      materials: source.sources.map(item => ({ name: item.name, content: item.content, ...(item.kind ? { kind: item.kind } : {}) })),
      settings: settingsSchema.parse({ ...source.settings, maxCalls: discovery.callPlan.baseMaxCalls,
        maxDurationMs: discovery.callPlan.baseMaxDurationMs }),
      target: source.target, targetVersion: source.targetVersion, existingAgent: source.revisions[0]?.spec,
      goldenCases: [], dialogues, notes: source.notes, profiles: [],
    }, [requirement]);
  }
  private async executeDiscovery(record: Experiment, plan: DiscoveryPlan, ctx: CallContext): Promise<void> {
    const discovery = record.discovery!;
    const updateCalls = () => { discovery.callsUsed = record.usage.calls; };
    const modelCall = async <T>(label: string, call: () => Promise<T>): Promise<T> => {
      discovery.activeCall = label; updateCalls();
      await this.checkpoint(record, 'preparing', `Выполняю модельный этап discovery: ${label}.`);
      const result = await call();
      delete discovery.activeCall;
      return result;
    };
    try {
      const runtime = await this.runtime(record);
      if (!runtime.discover || !runtime.goals || !runtime.assess) throw new Error('Выбранный Runtime не поддерживает staged log discovery.');
      if (!discovery.requirements.length) {
        const output = await modelCall('requirements', () => runtime.discover!({ kind: 'requirements', task: record.task, sources: structuredClone(record.sources) }, ctx));
        if (output.kind !== 'requirements') throw new Error('Runtime вернул ответ другого этапа discovery.');
        const requirements = requirementSchema.array().min(1).parse(output.requirements);
        if (new Set(requirements.map(item => item.id)).size !== requirements.length) throw new Error('Требования discovery содержат повторяющиеся ID.');
        for (const requirement of requirements) {
          const source = record.sources.find(item => item.id === requirement.sourceId);
          const exact = source && verbatimSpan(source.content, requirement.quote);
          if (!source || !exact) throw new Error(`Требование ${requirement.id} не подтверждено материалом владельца.`);
          requirement.quote = exact;
        }
        discovery.requirements = requirements; record.requirements = structuredClone(requirements); record.questions = output.questions;
        updateCalls(); await this.checkpoint(record, 'preparing', 'Требования владельца сохранены для первичного разбора логов.');
        if (record.questions.length) {
          discovery.phase = 'insufficient';
          await this.checkpoint(record, 'complete', 'Нужны ответы владельца на вопросы к требованиям; диалоги не классифицировались.');
          return;
        }
      }
      for (let index = discovery.completedBatchCount; index < plan.batches.length; index++) {
        const batch = plan.batches[index]!;
        const output = await modelCall(`coarse ${index + 1}/${plan.batchCount}`, () => runtime.discover!({ kind: 'coarse', requirements: structuredClone(discovery.requirements), dialogues: structuredClone(batch) }, ctx));
        if (output.kind !== 'coarse') throw new Error('Runtime вернул ответ другого этапа discovery.');
        discovery.observations.push(...reconcileDiscoveryBatch(batch, output.observations, discovery.requirements));
        discovery.completedBatchCount = index + 1; updateCalls();
        await this.checkpoint(record, 'preparing', `Первично разобрано партий: ${discovery.completedBatchCount}/${plan.batchCount}.`);
      }
      const order = new Map(record.dialogues.map((dialogue, index) => [dialogue.id, index]));
      discovery.observations.sort((left, right) => order.get(left.dialogueId)! - order.get(right.dialogueId)!);
      if (!discovery.groupingComplete || (!discovery.groups && !discovery.focusRequirementId)) {
        const candidates = discovery.observations.filter(observation => observation.classification === 'candidate');
        const output = await modelCall('grouping', () => runtime.discover!({ kind: 'group', requirements: structuredClone(discovery.requirements),
          observations: structuredClone(candidates) }, ctx));
        if (output.kind !== 'group') throw new Error('Runtime вернул ответ другого этапа discovery.');
        discovery.groups = reconcileDiscoveryGroups(output.groups, candidates, discovery.requirements);
        discovery.groupingComplete = true; updateCalls();
        await this.checkpoint(record, 'preparing', 'Первичный разбор и поведенческие группы сохранены; выбираю повторяющийся фокус.');
      }
      if (!discovery.focusRequirementId) selectDiscoveryFocus(record);
      if (!discovery.focusRequirementId) {
        discovery.phase = 'insufficient'; discovery.error = null; updateCalls();
        await this.checkpoint(record, 'complete', 'Повторяющаяся проблема минимум в двух диалогах не подтверждена.');
        return;
      }
      const focus = discovery.requirements.find(requirement => requirement.id === discovery.focusRequirementId)!;
      for (const dialogueId of discovery.selectedIds) {
        if (discovery.completedDeepIds.includes(dialogueId)) continue;
        discovery.deep = discovery.deep.filter(result => result.dialogueId !== dialogueId);
        const dialogue = record.dialogues.find(item => item.id === dialogueId)!;
        try {
          const deep = await modelCall(`deep ${dialogueId}`, async () => {
            const { outcome: _storedOutcome, ...dialogueEvidence } = dialogue;
            const goals = await runtime.goals!({ task: record.task, sources: structuredClone(record.sources), dialogues: [structuredClone(dialogueEvidence) as typeof dialogue], profiles: [], requirements: [structuredClone(focus)] }, ctx);
            if (goals.length !== 1) throw new Error(`Подробный разбор ${dialogueId} должен вернуть ровно одну цель.`);
            const goal = goals[0]!;
            validateObservedGoals([goal], [dialogue], []);
            if (goal.requirementIds?.length !== 1 || goal.requirementIds[0] !== focus.id) throw new Error(`Цель ${dialogueId} потеряла единый discovery focus.`);
            const base = dialogueToScenario(dialogue, { goal: goal.goal, successCriteria: goal.successCriteria, requirementIds: [focus.id] });
            const scenario: Scenario = { ...base, goalObservation: 'reply', split: 'dev' };
            if (record.sources.some(source => source.kind === 'prompt')) scenario.metrics!.unshift({ ...promptCompliance });
            const trial = dialogueToTrial(dialogue, scenario, record.revisions[0]!.id);
            return { goal, assessments: await assessTrial(runtime, scenario, record.sources, trial, ctx, [focus]) };
          });
          discovery.deep.push({ dialogueId, role: discovery.representativeIds.includes(dialogueId) ? 'representative' : 'control', ...deep });
          discovery.completedDeepIds.push(dialogueId); updateCalls();
          await this.checkpoint(record, 'preparing', `Подробно проверено ${discovery.completedDeepIds.length}/${discovery.selectedIds.length}; controls — false-negative probe.`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          discovery.deep.push({ dialogueId, role: discovery.representativeIds.includes(dialogueId) ? 'representative' : 'control', error: message });
          if (message !== 'Judge response rejected; original responses and errors are preserved in judgeAudit') throw error;
          delete discovery.activeCall;
          discovery.completedDeepIds.push(dialogueId); updateCalls();
          await this.checkpoint(record, 'preparing', `Подробная оценка ${dialogueId} отклонена; исходный ответ судьи сохранён, продолжаю с остальными примерами.`);
        }
      }
      const confirmedRepresentatives = confirmedDiscoveryRepresentativeIds(discovery, focus.id);
      if (confirmedRepresentatives.size < 2) {
        discovery.phase = 'insufficient'; discovery.error = null; updateCalls();
        await this.checkpoint(record, 'complete', 'Подробный судья не подтвердил один и тот же goal_attainment fail минимум в двух диалогах.');
        return;
      }
      if (!discovery.hypothesis) {
        const evidence = discovery.observations.filter(observation => confirmedRepresentatives.has(observation.dialogueId)
          && observation.classification === 'candidate' && observation.requirementId === focus.id);
        const deepEvidence = discovery.deep.filter(result => confirmedRepresentatives.has(result.dialogueId)).map(result => result.goal
          ? { ...result, goal: Object.fromEntries(Object.entries(result.goal).filter(([key]) => key !== 'outcome')) as typeof result.goal }
          : result);
        const output = await modelCall('hypothesis', () => runtime.discover!({ kind: 'hypothesis', requirement: structuredClone(focus), observations: structuredClone(evidence), deep: structuredClone(deepEvidence) }, ctx));
        if (output.kind !== 'hypothesis') throw new Error('Runtime вернул ответ другого этапа discovery.');
        const eventIds = evidence.flatMap(observation => observation.citations.filter(citation => record.dialogues.find(dialogue => dialogue.id === observation.dialogueId)
          ?.messages[citation.seq]?.role === 'assistant').map(citation => ({ dialogueId: observation.dialogueId, seq: citation.seq })));
        discovery.hypothesis = {
          text: `${output.hypothesis.trim()}\nНАБЛЮДЕНИЕ: ответ агента (reply)`, proposedGoalObservation: 'reply', requirementId: focus.id, eventIds,
        };
      }
      discovery.phase = 'ready'; discovery.error = null; updateCalls();
      await this.checkpoint(record, 'complete', 'Одна exploratory-гипотеза готова. Это отбор кандидата на тест, не accuracy. Проверим?');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      discovery.error = message; updateCalls();
      discovery.phase = /budget exhausted/i.test(message) ? 'budget_exhausted'
        : discovery.completedBatchCount || discovery.completedDeepIds.length ? 'partial' : 'error';
      await this.checkpoint(record, 'preparing', message);
      throw error;
    }
  }
  async updateDraft(id: string, expectedHash: string, raw: DraftPatch): Promise<Experiment> {
    return this.change(async () => {
      const record = await this.store.get(id);
      if (record.phase !== 'review') throw new Error('Править можно только незапущенный черновик. Готовые доказательства остаются как есть, для изменений создайте новый эксперимент.');
      if (draftHash(record) !== expectedHash) throw new Error('Черновик изменился. Откройте карточки заново, прежде чем править.');
      const patch = draftPatchSchema.parse(raw);
      const beforeCards = new Map(record.scenarios.map(s => [s.id, s]));
      const removed = new Set(patch.removeScenarioIds ?? []);
      for (const id of removed) if (!beforeCards.has(id)) throw new Error(`Нет карточки для удаления: ${id}`);
      for (const scenario of patch.scenarios ?? []) {
        const before = record.scenarios.find(s => s.id === scenario.id);
        if (scenario.provenance !== (before?.provenance ?? 'synthetic')) throw new Error('Происхождение карточки нельзя повысить правкой. Golden и production добавляются через импорт исходных данных.');
        if (before && scenario.successCriteria !== before.successCriteria
          && fingerprint([scenario.checks, scenario.metrics ?? []]) === fingerprint([before.checks, before.metrics ?? []])) {
          throw new Error(`Ожидание «${scenario.title}» изменилось, а исполняемые проверки остались прежними. Измените checks или metrics вместе с successCriteria; описание само по себе не меняет тест.`);
        }
        if (scenario.profileId && before?.profileId === scenario.profileId && !patch.profileEdits?.some(e => e.id === scenario.profileId)
          && fingerprint([scenario.user.persona, scenario.user.characteristics]) !== fingerprint([before.user.persona, before.user.characteristics])) {
          throw new Error(`Карточка ${scenario.id} связана с профилем ${scenario.profileId}. Измените profileEdits или уберите profileId, чтобы задать отдельную персону.`);
        }
      }
      for (const edit of patch.profileEdits ?? []) {
        const profile = record.profiles.find(p => p.id === edit.id);
        if (!profile) throw new Error(`Неизвестный профиль: ${edit.id}`);
        if (edit.override === null) delete profile.draftOverride;
        else profile.draftOverride = edit.override;
      }
      const agent = patch.agent ?? record.revisions[0]?.spec;
      const cards = new Map(record.scenarios.filter(s => !removed.has(s.id)).map(({ split: _split, ...s }) => [s.id, s]));
      for (const { split: _split, ...scenario } of patch.scenarios ?? []) cards.set(scenario.id, scenario);
      const scenarios = [...cards.values()];
      const prepared = validatePreparation({ requirements: record.requirements, questions: record.questions, agent, scenarios }, record.sources, record.workflow ?? 'compare', record.profiles);
      record.scenarios = prepared.scenarios;
      retainAcceptedTests(record);
      if (patch.agent) record.revisions = [revision(patch.agent, null, 'Agent configuration reviewed in the draft.')];
      record.settings = settingsSchema.parse({ ...record.settings, ...patch.settings,
        roles: Object.fromEntries(Object.entries({ ...record.settings.roles, ...patch.settings?.roles }).filter(([, value]) => value !== null)) });
      record.evaluatorVersion = evaluatorVersion(record.settings);
      if (patch.target) record.target = patch.target;
      if (patch.targetVersion) record.targetVersion = patch.targetVersion;
      await preflightTarget(record.target);
      record.targetFingerprint = await targetFingerprint(record.target);
      record.selectedRevisionId = record.revisions[0]!.id;
      record.reviewedAt = null; record.reviewMode = null; record.manifestHash = null;
      const added = record.scenarios.filter(s => !beforeCards.has(s.id)).length;
      const changed = record.scenarios.filter(s => beforeCards.has(s.id) && fingerprint(s) !== fingerprint(beforeCards.get(s.id))).length;
      await this.checkpoint(record, 'review', `${patch.agent ? 'Агент обновлён. ' : ''}${patch.settings || patch.target || patch.targetVersion ? 'Настройки прогона обновлены. ' : ''}Карточки: изменено ${changed}, добавлено ${added}, удалено ${removed.size}. Проверьте черновик перед запуском.`);
      return structuredClone(record);
    });
  }
  async acceptDraft(id: string, expectedHash: string): Promise<Experiment> {
    return this.change(async () => {
      const record = await this.store.get(id);
      if (record.workflow !== 'evaluate') throw new Error('Принять тест можно только в workflow evaluate.');
      if (record.phase !== 'review') throw new Error('Принять можно только незапущенный черновик.');
      if (record.scenarios.length !== 1) throw new Error('Принять можно ровно один тест.');
      const currentHash = draftHash(record);
      if (expectedHash !== currentHash) throw new Error('Черновик изменился. Откройте тест заново, прежде чем принимать.');
      const scenario = record.scenarios[0]!;
      const definitionHash = fingerprint(scenario);
      const existing = (record.acceptedTests ?? []).find(test => test.scenarioId === scenario.id && test.definitionHash === definitionHash);
      if (record.acceptedDraftHash === currentHash && existing) return structuredClone(record);
      record.acceptedTests = [existing ?? { testId: randomUUID(), scenarioId: scenario.id, definitionHash, acceptedAt: new Date().toISOString() }];
      record.acceptedDraftHash = currentHash;
      await this.store.save(record);
      return structuredClone(record);
    });
  }
  /** Reuse the exact reviewed materials and cards; only evidence and approvals start afresh. */
  async repeat(id: string, scenarioIds?: string[]): Promise<Experiment> {
    return this.change(async () => {
      const previous = await this.store.get(id);
      if (previous.workflow !== 'evaluate' || !previous.reviewedAt || runningPhases.has(previous.phase)) {
        throw new Error('Повторить можно остановленный или завершённый прогон с утверждёнными карточками.');
      }
      const record = freshDraft(previous, scenarioIds);
      record.targetFingerprint = await targetFingerprint(record.target);
      await this.store.save(record);
      return structuredClone(record);
    });
  }
  /** A versionable local definition: provenance survives, run results and approvals do not. */
  async saveSuite(id: string, file: string, scenarioIds?: string[]): Promise<string> {
    const previous = await this.get(id);
    if (previous.workflow !== 'evaluate' || !previous.scenarios.length || runningPhases.has(previous.phase)) throw new Error('Сначала дождитесь готовых тестов.');
    const definition = freshDraft(previous, scenarioIds);
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
      const prepared = validatePreparation({ requirements: record.requirements, questions: record.questions,
        agent: record.revisions[0]?.spec, scenarios: record.scenarios.map(({ split: _split, ...s }) => s) }, record.sources, 'evaluate', record.profiles);
      record.scenarios = prepared.scenarios;
      retainAcceptedTests(record);
      await preflightTarget(record.target);
      record.targetFingerprint = await targetFingerprint(record.target);
      await this.store.save(record);
      return structuredClone(record);
    });
  }
  /** A separate result over the same facts. No target session or simulator is opened. */
  async reassess(id: string, raw: ReassessmentInput = {}, options: { carryUsage?: boolean } = {}): Promise<Experiment> {
    return this.change(async () => {
      const input = reassessmentSchema.parse(raw);
      const previous = await this.store.get(id);
      if (previous.workflow !== 'evaluate' || runningPhases.has(previous.phase) || !previous.trials.length) throw new Error('Нужен завершённый прогон с сохранёнными трассами.');
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
      const prepared = validatePreparation({ requirements: record.requirements, questions: record.questions, agent: record.revisions[0]?.spec,
        scenarios: record.scenarios.map(({ split: _, ...s }) => s) }, record.sources, 'evaluate', record.profiles);
      record.scenarios = prepared.scenarios;
      retainAcceptedTests(record);
      if (input.judge) { record.settings.judge = input.judge; delete record.settings.roles.judge; }
      record.evaluatorVersion = evaluatorVersion(record.settings);
      record.assessmentOf = previous.id;
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
          trial.usage = emptyUsage(); delete trial.externalUsage; delete trial.assessments; delete trial.assessmentError; delete trial.judgeAudit;
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
              if (assessmentRubrics(scenario, trial).length && runtime) trial.assessments = await assessTrial(runtime, scenario, record.sources, trial, { ...ctx,
                beforeCall() { ctx.beforeCall(); trial.usage.calls++; },
                addUsage(usage) { ctx.addUsage(usage); trial.usage.inputTokens += usage.inputTokens; trial.usage.outputTokens += usage.outputTokens;
                  trial.usage.costUsd = usage.costUsd === null || trial.usage.costUsd === null ? null : trial.usage.costUsd + usage.costUsd; } }, record.requirements);
              else if (scenario.metrics?.length) trial.assessmentError = 'Только точные проверки; рубрики не переоценивались.';
            } catch (error) {
              trial.assessmentError = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
              if (!trial.checks.length || ctx.signal.aborted) trial.outcome = ctx.signal.aborted ? 'cancelled' : 'invalid';
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
      if (input.metricId && (!scenario || !assessmentRubrics(scenario, trial).some(m => m.id === input.metricId))) throw new Error('Такой рубрики в этой карточке нет.');
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
  async start(id: string, options: { approved: boolean; reviewer?: 'human' | 'automated'; expectedHash?: string; parallel?: number }): Promise<Experiment> {
    const parallel = options.parallel ?? 1;
    if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) throw new Error('Параллельных диалогов может быть от 1 до 8.');
    return this.change(async () => {
      const record = await this.store.get(id);
      if (record.phase !== 'review') throw new Error('Запустить можно только эксперимент, ожидающий проверки. Чтобы поменять набор карточек, создайте новый.');
      if (record.workflow === 'compare' && (record.target.kind !== 'sandbox' || record.settings.userModes.length !== 1)) throw new Error('Автоматическое сравнение поддерживает только песочницу и один режим пользователя.');
      if (!options.approved) throw new Error('Набор карточек замораживается только после вашего подтверждения.');
      if (record.workflow === 'evaluate' && options.expectedHash !== draftHash(record)) {
        throw new Error('Нужно подтверждение именно этой версии черновика. Откройте свежие тесты и план запуска.');
      }
      if (record.questions.length) throw new Error('Сначала ответьте на бизнес-вопросы из черновика: добавьте ответы в материалы и подготовьте новый эксперимент.');
      if (record.settings.userModes.includes('scripted')) for (const scenario of record.scenarios) {
        const issue = scriptIssue(scenario.user, record.settings.maxTurns);
        if (issue) throw new Error(`${scenario.title}: ${issue}`);
      }
      await preflightTarget(record.target);
      if (record.evaluatorVersion && record.evaluatorVersion !== evaluatorVersion(record.settings)) throw new Error('Версия оценщика изменилась. Обновите черновик и проверьте условия запуска.');
      if (record.targetFingerprint && record.targetFingerprint !== await targetFingerprint(record.target)) {
        throw new Error('Код агента изменился после подготовки карточек. Обновите подключение в настройках и подтвердите новую версию.');
      }
      record.reviewedAt = new Date().toISOString();
      record.reviewMode = options.reviewer ?? 'human';
      if (record.reviewMode === 'automated') record.limitations.push('Generated scenario expectations were checked automatically, without human validation. Spot-check disputes; decisive automatic results remain usable as provisional evidence.');
      record.manifestHash = measurementHash(record);
      record.phase = record.workflow === 'evaluate' ? 'evaluating' : 'baseline';
      record.message = record.workflow === 'evaluate' ? 'Выполняю согласованный план проверки.' : 'Starting the frozen development comparison.';
      await this.launch(record, ctx => record.workflow === 'evaluate' ? this.evaluateReviewed(record, ctx, parallel) : this.execute(record, ctx), true);
      return structuredClone(record);
    });
  }
  async cancel(id: string): Promise<Experiment> {
    if (this.active?.record.id !== id) throw new Error('Этот эксперимент сейчас не идёт.');
    this.active.controller.abort(new Error('Cancelled by the user.'));
    this.active.record.message = 'Cancelling; preserving recorded evidence.';
    return structuredClone(this.active.record);
  }
  async waitForIdle(): Promise<void> { await this.lastTask; }
  async close(): Promise<void> {
    this.closed = true; this.closing = true;
    this.active?.controller.abort(new Error('Application is closing.'));
    try { await this.initializing; await this.waitForIdle(); await this.mutation; } finally { await this.store.close(); }
  }
  private async runtime(record: Experiment): Promise<Runtime> {
    if (this.injectedRuntime) return this.injectedRuntime;
    return record.mode === 'demo' ? createDemoRuntime() : createPiRuntime(record.settings);
  }
  private async launch(record: Experiment, work: (ctx: CallContext) => Promise<void>, ownsMutation = false): Promise<void> {
    this.ensureIdle(ownsMutation);
    const controller = new AbortController();
    const discoveryElapsedBeforeMs = record.discovery?.elapsedMs ?? 0;
    const active = { record, controller, done: Promise.resolve(), startedAtMs: performance.now(), discoveryElapsedBeforeMs };
    this.active = active; // Reserve before the first await, including the initial checkpoint.
    let saved = false;
    let ready!: () => void;
    let failed!: (error: unknown) => void;
    const initialCheckpoint = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    const remainingDurationMs = record.discovery
      ? Math.max(0, record.discovery.callPlan.maxDurationMs - discoveryElapsedBeforeMs)
      : record.settings.maxDurationMs;
    const timer = setTimeout(() => controller.abort(new Error('Experiment time limit reached.')), remainingDurationMs);
    const ctx: CallContext = {
      signal: controller.signal, timeoutMs: record.settings.timeoutMs,
      beforeCall: () => {
        controller.signal.throwIfAborted();
        if (record.usage.calls >= record.settings.maxCalls) {
          controller.abort(new Error('Model call budget exhausted.')); controller.signal.throwIfAborted();
        }
        record.usage.calls++;
      },
      addUsage: usage => {
        record.usage.inputTokens += usage.inputTokens;
        record.usage.outputTokens += usage.outputTokens;
        record.usage.costUsd = usage.costUsd === null || record.usage.costUsd === null ? null : record.usage.costUsd + usage.costUsd;
      },
      onTrace: (trialId, event) => this.store.appendTrace(record.id, trialId, event),
      onJudgment: (trialId, audit) => this.store.appendJudgment(record.id, trialId, audit),
    };
    active.done = (async () => {
      try {
        await this.store.save(record); saved = true; ready();
        controller.signal.throwIfAborted();
        await work(ctx); controller.signal.throwIfAborted();
      }
      catch (error) {
        if (!saved) { failed(error); throw error; }
        const reason = controller.signal.aborted ? controller.signal.reason : error;
        record.error = reason instanceof Error ? reason.message : String(reason);
        record.phase = controller.signal.aborted && /user|closing/i.test(record.error) ? 'cancelled' : 'error';
        record.message = record.error;
      } finally {
        clearTimeout(timer); this.updateDiscoveryElapsed(record); record.updatedAt = new Date().toISOString();
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
    this.updateDiscoveryElapsed(record);
    record.phase = phase; record.message = message; record.updatedAt = new Date().toISOString();
    // ponytail: full JSON checkpoints keep one canonical record; split trial storage when runs exceed local-scale sizes.
    await this.store.save(record);
  }
  private updateDiscoveryElapsed(record: Experiment): void {
    if (!record.discovery || this.active?.record !== record) return;
    record.discovery.elapsedMs = Math.min(record.discovery.callPlan.maxDurationMs,
      this.active.discoveryElapsedBeforeMs + Math.max(0, Math.round(performance.now() - this.active.startedAtMs)));
  }
  /** Re-checks the frozen manifest before and after every trial; a drifted suite stops the run instead of grading it. */
  private frozenGuard(record: Experiment, hash: string, ctx: CallContext): () => void {
    const message = record.workflow === 'evaluate'
      ? 'The approved evaluation conditions changed. Create a fresh reviewed run.'
      : 'The frozen measurement changed; a fresh baseline is required.';
    return () => {
      ctx.signal.throwIfAborted();
      if (measurementHash(record) !== hash) throw new Error(message);
    };
  }
  /** The single trial loop: every user mode, every scenario of the split, every repeat, one checkpoint per trial. */
  private async runSuite(record: Experiment, runtime: Runtime, revision: Revision, split: 'dev' | 'control', label: string, ctx: CallContext, parallel = 1): Promise<void> {
    const hash = record.manifestHash;
    if (!hash) throw new Error('Missing measurement manifest.');
    const guard = this.frozenGuard(record, hash, ctx);
    const scenarios = record.scenarios.filter(s => s.split === split);
    const planned = plannedTrials({ ...record, scenarios });
    // Every attempt in the order it would run one at a time; a pool of `parallel` workers takes them from the front,
    // so a finished dialogue is recorded as soon as it ends and the trial order is the completion order.
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
      if (record.targetFingerprint && record.targetFingerprint !== await targetFingerprint(record.target)) throw new Error(message);
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
        const progress = () => `${label}${prefix}${scenario.title} · диалог ${completed + 1}/${planned}${running()}`;
        record.message = `${progress()} · открываем сессию`;
        const trial = await evaluateTrial({ runtime, revision, scenario, repeat, manifestHash: hash, sources: record.sources, requirements: record.requirements, settings: record.settings,
          onStage: stage => { record.message = `${progress()} · ${{ target: 'ответ агента', user: 'реплика пользователя', assessment: 'оценка критериев' }[stage]}`; },
          ctx: { ...ctx, onTrace: (trialId, event) => {
            ctx.onTrace?.(trialId, event);
            const stage = event.type === 'user' ? 'ждём ответ агента' : event.type === 'assistant' ? 'ответ получен · готовим следующий шаг'
              : event.type === 'simulator' ? 'реплика симулятора готова' : event.type === 'tool_call' ? `инструмент ${event.tool ?? ''}`
              : event.type === 'tool_result' ? 'инструмент завершён' : event.type === 'retrieval' ? 'RAG-контекст получен' : 'сбой диалога';
            record.message = `${progress()} · ${stage}`;
          } }, userMode, target: record.target });
        record.trials.push(trial);
        if (record.target.kind !== 'sandbox' && scenario.initialState.external && trial.observation?.resetConfirmed !== true) {
          const note = 'Внешнее состояние карточек не подтверждено адаптером (resetConfirmed): проверки состояния не измерены.';
          if (!record.limitations.includes(note)) record.limitations.push(note);
        }
        if (trial.observation?.version) {
          if (record.targetRelease && record.targetRelease !== trial.observation.version) throw new Error('Внешний агент сообщил разные версии в одном прогоне. Сравнение недоступно.');
          record.targetRelease = trial.observation.version;
        }
        completed++;
        await this.checkpoint(record, record.phase, `${label}${prefix}${scenario.title} · ${repeat + 1}/${record.settings.repeats}`);
        await fingerprintCheck('Код внешнего агента изменился во время диалога. Результат сохранён, но сравнение недоступно.');
        guard();
      }
    };
    // One failure stops the pool: the other workers finish the dialogue they are in and take no more; the first error is the run's error.
    const results = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(parallel, attempts.length)) }, () => worker().catch(error => { failed = true; throw error; })));
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (rejected) throw rejected.reason;
  }
  /** The rollout of the version under test. The adapter's reported `version` remains the identity; this only performs the deployment. */
  private async release(record: Experiment, ctx: CallContext): Promise<void> {
    const target = record.target;
    if (target.kind === 'sandbox' || !target.release) return;
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
    await this.runSuite(record, runtime, agent, 'dev', '', ctx, parallel);
    this.frozenGuard(record, record.manifestHash, ctx)();
    await this.nameFailureModes(record, runtime, ctx);
    if (record.target.kind !== 'sandbox' && record.trials.some(t => !['invalid', 'cancelled'].includes(t.outcome))) {
      await rememberConnection(this.store.directory, { format: 'agent-lab-connection-1', target: record.target, targetVersion: record.targetVersion });
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
    const failed = record.trials.filter(t => isAgentFailure(record, t));
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
      if (ctx.signal.aborted) throw error;
      record.limitations.push(`Не удалось назвать типы провалов: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async execute(record: Experiment, ctx: CallContext): Promise<void> {
    const runtime = await this.runtime(record);
    const baseline = record.revisions[0];
    if (!baseline || !record.manifestHash) throw new Error('Missing frozen baseline or measurement manifest.');
    const hash = record.manifestHash;
    const guard = this.frozenGuard(record, hash, ctx);
    const evaluate = (current: Revision, split: 'dev' | 'control') =>
      this.runSuite(record, runtime, current, split, split === 'dev' ? 'Development: ' : 'Control: ', ctx);
    await this.checkpoint(record, 'baseline', 'Measuring the original agent on development scenarios.');
    await evaluate(baseline, 'dev');
    let best = baseline;
    for (let iteration = 0; iteration < record.settings.maxIterations; iteration++) {
      guard();
      const currentTrials = record.trials.filter(t => t.revisionId === best.id && t.split === 'dev');
      if (currentTrials.some(t => t.outcome === 'invalid' || t.outcome === 'cancelled')) throw new Error('Development trials are invalid; inspect the evidence before improving.');
      const outcomes = currentTrials.map(t => automaticTrialResult(record.scenarios.find(s => s.id === t.scenarioId), t, record.humanReviews));
      if (outcomes.includes('unknown') || currentTrials.some(t => !trialAssessmentComplete(record.scenarios.find(s => s.id === t.scenarioId)!, t, record.humanReviews))) throw new Error('Development assessment is incomplete; inspect the evaluator before improving.');
      if (outcomes.every(outcome => outcome === 'pass')) break;
      await this.checkpoint(record, 'improving', `Building candidate ${iteration + 1}/${record.settings.maxIterations} from development evidence only.`);
      const proposal = proposalSchema.parse(await runtime.improve({
        task: record.task, sources: structuredClone(record.sources), requirements: structuredClone(record.requirements), agent: structuredClone(best.spec),
        feedback: record.scenarios.filter(s => s.split === 'dev').map(s => ({ scenario: structuredClone(s), trials: structuredClone(currentTrials.filter(t => t.scenarioId === s.id)) })),
      }, ctx));
      guard();
      const candidate = revision(agentSchema.parse(proposal.agent), best.id, proposal.hypothesis);
      if (record.revisions.some(r => r.id === candidate.id)) {
        record.iterations.push({ revisionId: candidate.id, accepted: false, reason: 'No new agent revision was proposed.' }); break;
      }
      record.revisions.push(candidate);
      await evaluate(candidate, 'dev');
      const comparison = compareTrials({ baselineId: best.id, candidateId: candidate.id, manifestHash: hash, scenarios: record.scenarios, repeats: record.settings.repeats, trials: record.trials, split: 'dev', mode: record.mode });
      record.comparisons.push(comparison);
      const accepted = comparison.verdict !== 'incomparable' && comparison.validPairs === comparison.plannedPairs && comparison.invalidPairs === 0 && comparison.regressed === 0 && comparison.fixed > 0;
      record.iterations.push({ revisionId: candidate.id, accepted, reason: accepted ? 'More passing development trials with no regression and complete valid pairs.' : 'Candidate did not improve all required development conditions; retaining the previous best.' });
      if (accepted) { best = candidate; record.selectedRevisionId = best.id; }
    }
    guard();
    record.selectedRevisionId = best.id; record.controlConsumedAt = new Date().toISOString();
    await this.checkpoint(record, 'control', 'Candidate selected. Running the final control comparison; results will not return to the builder.');
    await evaluate(baseline, 'control');
    if (best.id !== baseline.id) await evaluate(best, 'control');
    guard();
    const final = compareTrials({ baselineId: baseline.id, candidateId: best.id, manifestHash: hash, scenarios: record.scenarios, repeats: record.settings.repeats, trials: record.trials, split: 'control', mode: record.mode });
    if (record.reviewMode !== 'human') {
      final.reasons.push('Scenario expectations have not been validated by a human; this comparison is provisional.');
      if (final.verdict === 'improved') final.verdict = 'insufficient';
    }
    record.comparisons.push(final);
    await this.checkpoint(record, 'complete', 'Comparison complete. Inspect observed changes, regressions and evidence limits.');
  }
}
