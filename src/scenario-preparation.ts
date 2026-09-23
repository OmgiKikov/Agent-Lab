import { assessScenarioLibrary, workInputIssue, serializedBytes, SCENARIO_OUTPUT_BYTES } from './scenario-work.js';
export { assessScenarioLibrary } from './scenario-work.js';
import { appendScenarioProposals, createLibrary, compileLibrary, libraryHash, libraryQuality, librarySnapshot } from './scenario-library.js';
import { importBatchSchema, type ImportBatch, type ScenarioLibrary, type ScenarioProposal } from './scenario-contracts.js';
import { fingerprint, internalPromptRule, validatePreparation, type AgentSpec, type CallContext, type CreateInput, type Experiment, type GroundingInput, type Requirement, type Runtime, type ScenarioProposalsInput, type Source } from './contracts.js';
import { SOURCES_PER_DIALOGUE } from './limits.js';
import { selectScenarioSources } from './scenario-sources.js';
import { StructuredTaskError } from './llm/structured.js';
import type { ExperimentStore } from './store.js';

const SCENARIO_EXTRACTION_PROTOCOL = 'chronological-scenarios-v1' as const;
/** The agent label of a library run when the owner names none: the agent under test runs outside Lab with its own instructions and tools. */
const EXTERNAL_AGENT: AgentSpec = { name: 'External agent', instructions: 'The agent under evaluation runs outside Agent Lab and keeps its own instructions and tools.', tools: [] };
/** Extraction, JSON correction and later semantic repair share one per-source call allowance. */
const SOURCE_GENERATION_ATTEMPTS = 5;
function preparationInputHash(record: Experiment): string {
  const { maxCalls: _calls, maxDurationMs: _duration, timeoutMs: _timeout, ...settings } = record.settings;
  return fingerprint({ protocol: SCENARIO_EXTRACTION_PROTOCOL, task: record.task, mode: record.mode, sources: record.sources,
    target: record.target, notes: record.notes, originalImport: record.originalImport, settings });
}
export function chronologicalInput(batch: ImportBatch, ids = batch.dialogues.map(d => d.id)): ScenarioProposalsInput['dialogues'] {
  return batch.dialogues.filter(d => ids.includes(d.id)).map(d => ({ id: d.id, observation: d.observation, events: structuredClone(d.events),
    messages: d.events.flatMap(e => e.type === 'message' && e.role && e.content ? [{ index: e.index, role: e.role, content: e.content }] : []) }));
}

/** Only the actual request can establish coverage obligations, including absence of later source turns. */
function proposalsFromLibrary(library: ScenarioLibrary): ScenarioProposal[] {
  return library.variants.map(variant => {
    const business = library.businessScenarios.find(item => item.id === variant.businessScenarioId);
    if (!business) throw new Error(`Нет группы для карточки ${variant.id}`);
    const { id: _id, sourceDialogues: _sources, ...proposalBusiness } = business;
    const { businessScenarioId: _business, familyId: _family, revision: _revision, quality: _quality, issues: _issues, ownerDecision: _decision, history: _history, semanticReviewRequired: _review, ...proposalVariant } = variant;
    return { business: proposalBusiness, variant: proposalVariant };
  });
}

function requireSourceCoverage(proposals: ScenarioProposal[], request: ScenarioProposalsInput): ScenarioProposal[] {
  const basis = request.dialogues.flatMap(dialogue => dialogue.messages.filter(message => message.role === 'user').slice(1)
    .map(message => ({ batchId: request.batchId!, dialogueId: dialogue.id, eventIndex: message.index })));
  return proposals.map(proposal => {
    const { sourceCoverageRequired: _required, sourceCoverageBasis: _basis, ...definition } = proposal.variant;
    return { ...proposal, variant: { ...definition, ...(basis.length ? { sourceCoverageRequired: true as const, sourceCoverageBasis: structuredClone(basis) } : {}) } };
  });
}

type PreparationStart = {
  original: ImportBatch | undefined;
  workIds: string[];
  library: ScenarioLibrary;
  proposals: ScenarioProposal[];
  previousAssessment: ScenarioLibrary['semanticAssessment'];
  /** Fresh preparation grounds requirements once. A continuation already has them. */
  groundOnce: boolean;
  expectedHash?: string;
};

/** Full imports are retained independently of the bounded model work and accepted run selection. */
export async function prepareScenarioLibrary(record: Experiment, input: CreateInput, batch: ImportBatch | undefined, runtime: Runtime, ctx: CallContext, store: ExperimentStore): Promise<void> {
  const original = batch ? await store.writeImport(importBatchSchema.parse(batch)) : undefined;
  if (original) record.originalImport = { id: original.id, contentHash: original.contentHash };
  const workIds = original ? original.dialogues.map(d => d.id) : ['owner_requirements'];
  record.preparationProgress = { protocol: SCENARIO_EXTRACTION_PROTOCOL, checkpointVersion: 1, requestedCount: input.scenarioCount, inputHash: preparationInputHash(record), groundingComplete: false, processed: [], pending: [...workIds],
    excluded: (batch?.rejected ?? []).map(d => ({ dialogueId: d.id ?? `row_${d.index}`, reason: d.reasons.join('; ') })), status: 'preparing' };
  const library = createLibrary({ id: `library_${record.id}`, batch: original, sources: record.sources, requirements: [], proposals: [], semanticRequired: true });
  await runPreparation(record, input, runtime, ctx, store, { original, workIds, library, proposals: [], previousAssessment: undefined, groundOnce: true });
}

/** Pending sources only. A call that died in flight is refused: its cost is unknown. */
export async function resumeScenarioLibrary(record: Experiment, input: CreateInput, batch: ImportBatch | undefined, runtime: Runtime, ctx: CallContext, store: ExperimentStore): Promise<void> {
  const progress = record.preparationProgress;
  if (!progress || progress.protocol !== SCENARIO_EXTRACTION_PROTOCOL) throw new Error('Эту подготовку нельзя продолжить: нет сохранённого плана.');
  if (progress.activeDialogueId) throw new Error(`Подготовка остановилась во время разбора «${progress.activeDialogueId}». Его стоимость неизвестна; этот источник не повторяется молча.`);
  if (progress.checkpointVersion !== 1) throw new Error('Старая подготовка не содержит достаточного checkpoint для продолжения. Создайте новый черновик.');
  if (progress.inputHash !== preparationInputHash(record)) throw new Error('Входы или модель подготовки изменились. Создайте новый черновик.');
  if (record.originalImport && (!batch || batch.id !== record.originalImport.id || batch.contentHash !== record.originalImport.contentHash)) throw new Error('Исходный импорт подготовки изменился или отсутствует.');
  if (batch && progress.pending.some(id => !batch.dialogues.some(dialogue => dialogue.id === id))) throw new Error('План подготовки ссылается на отсутствующий исходный диалог.');
  if (!progress.pending.length) throw new Error('Необработанных источников нет.');
  if (!record.librarySnapshot) throw new Error('Черновик библиотеки не сохранён; продолжить нельзя.');
  progress.status = 'preparing';
  const library = structuredClone(record.librarySnapshot);
  await runPreparation(record, input, runtime, ctx, store, {
    original: batch, workIds: [...progress.pending], library, proposals: proposalsFromLibrary(library),
    previousAssessment: structuredClone(library.semanticAssessment), groundOnce: !progress.groundingComplete, expectedHash: libraryHash(library),
  });
}

async function runPreparation(record: Experiment, input: CreateInput, runtime: Runtime, ctx: CallContext, store: ExperimentStore, start: PreparationStart): Promise<void> {
  if (!record.preparationProgress) throw new Error('План подготовки не записан.');
  const original = start.original;
  const workIds = start.workIds;
  let library = start.library;
  const retained = structuredClone(start.library);
  const existingIds = new Set(retained.variants.map(variant => variant.id));
  let manifest = [...(library.readingManifest ?? [])];
  const keepManifest = (next: ScenarioLibrary): ScenarioLibrary => { if (manifest.length) next.readingManifest = manifest; return next; };
  let published = start.expectedHash;
  const publish = async () => {
    record.librarySnapshot = library;
    await store.publishLibrary(record, library, published);
    published = libraryHash(library);
  };
  const assemble = (proposals: ScenarioProposal[]) => keepManifest(appendScenarioProposals(retained,
    proposals.filter(proposal => !existingIds.has(proposal.variant.id)), record.requirements));
  const call = async <T>(dialogueId: string, stage: 'select' | 'ground' | 'extract' | 'repair', work: (context: CallContext) => Promise<T>): Promise<T> => {
    const progress = record.preparationProgress!;
    progress.activeDialogueId = dialogueId; progress.activeStage = stage;
    await publish();
    const used = record.usage.calls;
    try {
      const scoped: CallContext = stage !== 'extract' && stage !== 'repair' ? ctx : { ...ctx, beforeCall() {
        const attempts = progress.generationAttempts ??= [];
        let unit = attempts.find(item => item.dialogueId === dialogueId);
        if (!unit) { unit = { dialogueId, calls: 0 }; attempts.push(unit); }
        if (unit.calls >= SOURCE_GENERATION_ATTEMPTS) throw new StructuredTaskError(`Для источника «${dialogueId}» исчерпаны ${SOURCE_GENERATION_ATTEMPTS} попыток извлечения и исправления. Сохранённый черновик доступен для правки.`);
        ctx.beforeCall(); unit.calls++;
      } };
      const result = await work(scoped);
      delete progress.activeDialogueId; delete progress.activeStage;
      return result;
    } catch (error) {
      // No started call means no ambiguous provider charge. A started, failed call is never replayed silently.
      if (record.usage.calls === used || error instanceof StructuredTaskError) { delete progress.activeDialogueId; delete progress.activeStage; }
      throw error;
    }
  };
  await publish();
  try {
    ctx.signal.throwIfAborted();
    const groundingRequest: GroundingInput = { task: record.task, sources: record.sources };
    const groundingIssue = workInputIssue(groundingRequest);
    // A knowledge base too large for one call is read per dialogue: the model picks articles from the table of contents.
    const perDialogue = !!groundingIssue && !!original && !!runtime.selectSources;
    if (groundingIssue && !perDialogue) {
      record.preparationProgress.excluded.push(...workIds.map(id => ({ dialogueId: id, reason: groundingIssue })));
      record.preparationProgress.status = 'partial'; await publish(); return;
    }
    if (!record.revisions.length) {
      const agent = input.existingAgent ?? EXTERNAL_AGENT;
      const baseline = { id: fingerprint(agent), parentId: null, spec: agent, hypothesis: 'Конфигурация агента для библиотеки сценариев.', createdAt: new Date().toISOString() };
      record.revisions = [baseline]; record.selectedRevisionId = baseline.id;
    }
    const ground = (request: GroundingInput) => {
      if (!runtime.groundRequirements) throw new Error('Эта среда не умеет извлекать требования из материалов владельца.');
      return runtime.groundRequirements(request, ctx);
    };
    if (start.groundOnce && !perDialogue) {
      const grounded = await call(workIds[0] ?? 'owner_requirements', 'ground', () => ground(groundingRequest));
      record.requirements = grounded.requirements; record.questions = grounded.questions;
    } else if (start.groundOnce) record.preparationProgress.sourceSelection = [];
    record.preparationProgress.groundingComplete = true;
    const knowledge = record.sources.filter(source => source.kind !== 'prompt');
    const proposals = start.proposals;
    const previousAssessment = start.previousAssessment;
    const proposalBatches: { request: ScenarioProposalsInput; ids: string[] }[] = [];
    for (const workId of workIds) {
      ctx.signal.throwIfAborted();
      if (proposals.length >= 200) break;
      let sources = record.sources, requirements = record.requirements;
      if (perDialogue) {
        const dialogue = chronologicalInput(original!, [workId])[0]!;
        const messages = dialogue.messages.flatMap(({ role, content }) => role === 'user' || role === 'assistant' ? [{ role, content }] : []);
        const selected = await call(workId, 'select', () => selectScenarioSources({ task: record.task, catalog: knowledge.map(({ id, name, content }) => ({ id, name, chars: content.length })),
          dialogue: { id: workId, messages }, limit: SOURCES_PER_DIALOGUE }, knowledge, record.sources.filter(source => source.kind === 'prompt'), runtime, ctx));
        const settle = (reason: string) => {
          record.preparationProgress!.excluded.push({ dialogueId: workId, reason });
          record.preparationProgress!.processed.push(workId);
          record.preparationProgress!.pending = record.preparationProgress!.pending.filter(id => id !== workId);
        };
        const chosen = selected.map(source => source.id);
        record.preparationProgress.sourceSelection = [...(record.preparationProgress.sourceSelection ?? []).filter(row => row.dialogueId !== workId), { dialogueId: workId, sourceIds: chosen }];
        manifest = [...manifest.filter(row => row.dialogueId !== workId), { dialogueId: workId, ...(original ? { batchId: original.id } : {}), sourceIds: chosen }];
        library = keepManifest(library);
        if (!chosen.length) {
          settle('Не удалось подобрать достаточные статьи в пределах запроса. Это не доказывает отсутствие правила в базе.');
          await publish(); continue;
        }
        sources = [...record.sources.filter(source => source.kind === 'prompt'), ...selected];
        const focus = { dialogueId: workId, customerMessages: messages.filter(m => m.role === 'user').map(m => m.content) };
        // The same article can answer different questions; grounding is specific to this dialogue.
        const grounded = await call(workId, 'ground', () => ground({ ...groundingRequest, sources, focus }));
        record.questions = [...new Set([...record.questions, ...grounded.questions])].slice(0, 12);
        requirements = mergeRequirements(record, grounded.requirements, sources);
      }
      const request = { businessCatalog: library.businessScenarios.map(({ key, title, goal, conditions, requirementIds }) => ({ key, title, goal, conditions, requirementIds })), protocol: SCENARIO_EXTRACTION_PROTOCOL, task: record.task, sources: structuredClone(sources),
        // An internal prompt rule (a machine output format) is recorded but never becomes an expectation of a card.
        requirements: structuredClone(requirements.filter(requirement => !internalPromptRule(sources, requirement))), ...(original ? { batchId: original.id } : { preparationMode: 'owner_requirements', scenarioCount: input.scenarioCount || 1 }), dialogues: original ? chronologicalInput(original, [workId]) : [] } as ScenarioProposalsInput;
      const oversize = workInputIssue(request);
      if (oversize) { record.preparationProgress.excluded.push({ dialogueId: workId, reason: oversize }); continue; }
      let extracted: ScenarioProposal[] = [], next: ScenarioLibrary | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        ctx.signal.throwIfAborted();
        const issue = workInputIssue(request);
        if (issue) { record.preparationProgress.excluded.push({ dialogueId: workId, reason: issue }); break; }
        try {
          extracted = requireSourceCoverage(await call(workId, 'extract', scoped => runtime.scenarioProposals!(request, scoped)), request);
          if (extracted.some(proposal => existingIds.has(proposal.variant.id))) throw new Error('Предложение подменяет ID ранее сохранённой карточки.');
        } catch (error) {
          // A malformed answer for one source must not hide unrelated usable cases.
          // Cancellation and the shared budget still stop all work immediately.
          ctx.signal.throwIfAborted();
          record.preparationProgress.excluded.push({ dialogueId: workId, reason: error instanceof Error ? error.message : String(error) });
          next = undefined;
          await publish();
          if (record.preparationProgress.activeDialogueId) throw error;
          break;
        }
        if (serializedBytes({ proposals: extracted }) > SCENARIO_OUTPUT_BYTES) throw new Error('Предложение превышает допустимый объём ответа. Источник остаётся необработанным.');
        if (proposals.length + extracted.length > 200) break;
        next = assemble([...proposals, ...extracted]);
        const proposedIds = new Set(extracted.map(p => p.variant.id));
        const issues = libraryQuality(next).filter(i => !i.code.startsWith('semantic_') && (!i.variantId || proposedIds.has(i.variantId))
          && !['uncertain_fact', 'uncertain_grouping'].includes(i.code));
        if (!issues.length) break;
        request.feedback = { proposals: extracted, issues: issues.slice(0, 12).map(({ code, path, message }) => ({ code, path, message: message.slice(0, 240) })) };
      }
      if (!next) continue;
      // Bind evidence to the generated identities. Later card edits cannot narrow this reading.
      manifest = [...manifest.filter(row => row.dialogueId !== workId), { dialogueId: workId,
        ...(original ? { batchId: original.id } : {}), sourceIds: sources.map(source => source.id),
        variantIds: extracted.map(proposal => proposal.variant.id), requestHash: fingerprint(request) }];
      keepManifest(next);
      // Invalid but structurally parseable final proposals remain visible and blocked; there is no model-owned acceptance.
      next.revision = library.revision + 1;
      library = next; proposals.push(...extracted);
      proposalBatches.push({ request: structuredClone(request), ids: extracted.map(p => p.variant.id) });
      record.preparationProgress.processed.push(workId);
      record.preparationProgress.pending = record.preparationProgress.pending.filter(id => id !== workId);
      if (!extracted.length) record.preparationProgress.excluded.push({ dialogueId: workId, reason: 'Нет применимого предложения из требований владельца.' });
      await publish();
    }
    if (fingerprint(library.requirements) !== fingerprint(record.requirements)) {
      // Requirements merged after the last accepted proposal still belong to the library the run will be checked against.
      const revision = library.revision + 1;
      library = assemble(proposals); library.revision = revision;
    }
    if (previousAssessment) library.semanticAssessment = previousAssessment;
    if (library.variants.length && runtime.assessScenarioProposals) {
      library = await assessScenarioLibrary(library, runtime, ctx, async partial => { library = partial; await publish(); });
      library.revision++;
      await publish();
      // One bounded repair from the independent field findings. The first draft and every raw response remain in the journal.
      // Empty/different-id replies cannot improve readiness by deleting a difficult case.
      let repaired = false;
      for (const batch of proposalBatches) {
        const issues = libraryQuality(library).filter(i => i.code === 'semantic_finding' && i.variantId && batch.ids.includes(i.variantId));
        if (!issues.length) continue;
        ctx.signal.throwIfAborted();
        const previous = proposals.filter(p => batch.ids.includes(p.variant.id));
        const request = { ...batch.request, feedback: { proposals: previous,
          issues: issues.slice(0, 12).map(({ code, path, message }) => ({ code, path, message: message.slice(0, 240) })) } };
        if (workInputIssue(request)) continue;
        let revised: ScenarioProposal[];
        try { revised = requireSourceCoverage(await call(request.dialogues[0]?.id ?? 'owner_requirements', 'repair', scoped => runtime.scenarioProposals!(request, scoped)), request); }
        catch (error) {
          if (!(error instanceof StructuredTaskError)) throw error;
          record.limitations.push(error.message); await publish(); continue;
        }
        if (serializedBytes({ proposals: revised }) > SCENARIO_OUTPUT_BYTES) throw new Error('Исправление превышает допустимый объём ответа. Исходная карточка сохранена.');
        if (revised.length !== previous.length || batch.ids.some(id => revised.filter(p => p.variant.id === id).length !== 1)) continue;
        for (const proposal of revised) proposals[proposals.findIndex(p => p.variant.id === proposal.variant.id)] = proposal;
        repaired = true;
      }
      if (repaired) {
        const revision = library.revision + 1;
        library = assemble(proposals);
        library.revision = revision;
        await publish();
        library = await assessScenarioLibrary(library, runtime, ctx, async partial => { library = partial; await publish(); });
        library.revision++;
      }
    } else if (library.variants.length) record.limitations.push('Смысловая проверка недоступна: варианты требуют проверки и не могут быть приняты.');
    record.preparationProgress.status = record.preparationProgress.pending.length ? 'partial' : 'complete';
    await publish();
  } catch (error) {
    record.preparationProgress.status = ctx.signal.aborted ? 'cancelled' : 'partial';
    await publish();
    throw error;
  }
}

/**
 * Adds one dialogue's requirements to the record: a rule already known by its source, exact quote and meaning keeps its id,
 * a new rule whose id is taken gets a numbered one. Returns only this dialogue's requirements, with the ids the proposals must cite.
 */
function mergeRequirements(record: Experiment, extracted: Requirement[], sources: Source[]): Requirement[] {
  const focused: Requirement[] = [];
  for (const requirement of extracted) {
    if (!sources.some(source => source.id === requirement.sourceId)) throw new Error('Требование ссылается на статью вне выбранных материалов.');
    const known = record.requirements.find(known => known.sourceId === requirement.sourceId && known.quote === requirement.quote
      && known.text === requirement.text && known.critical === requirement.critical);
    if (known) { focused.push(known); continue; }
    let id = requirement.id;
    for (let n = 2; record.requirements.some(known => known.id === id); n++) id = `${requirement.id}_${n}`;
    const merged = { ...requirement, id };
    record.requirements.push(merged); focused.push(merged);
  }
  return focused;
}

/** No run or legacy editor can launder a draft or change a compiled card after library acceptance. */
export function assertLibraryRun(record: Experiment): void {
  const library = record.librarySnapshot;
  if (!library) return;
  librarySnapshot(library);
  if (fingerprint(record.requirements) !== fingerprint(library.requirements) || fingerprint(record.sources) !== fingerprint(library.sources)) throw new Error('Требования библиотеки изменились; требуется новая подготовка и принятие.');
  const compiled = compiledLibraryScenarios(record, library);
  const ids = record.selectedScenarioIds ?? library.acceptance!.variantIds;
  const expected = compiled.filter(s => ids.includes(s.id)).map(scenario => {
    const recorded = record.scenarios.find(s => s.id === scenario.id);
    // Pre-controller accepted cards retain their exact definition and simulator protocol.
    // A matching historical acceptance receipt prevents dropping execution from a new card.
    if (recorded && !recorded.execution && record.acceptedTests?.some(t => t.scenarioId === recorded.id && t.definitionHash === fingerprint(recorded))) {
      const { execution, ...legacy } = scenario;
      return legacy;
    }
    return scenario;
  });
  if (!expected.length || ids.some(id => !compiled.some(s => s.id === id)) || fingerprint(expected) !== fingerprint(record.scenarios)) throw new Error('Карточки отличаются от принятой библиотеки; повторите принятие.');
}
export function compiledLibraryScenarios(record: Experiment, library: ScenarioLibrary) {
  return validatePreparation({ requirements: library.requirements, questions: record.questions,
    scenarios: compileLibrary(library).map(({ split, ...scenario }) => scenario) }, library.sources).scenarios;
}
