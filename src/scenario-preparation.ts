import { assessScenarioLibrary, workInputIssue, serializedBytes, SCENARIO_OUTPUT_BYTES } from './scenario-work.js';
export { assessScenarioLibrary } from './scenario-work.js';
import { createLibrary, compileLibrary, libraryHash, libraryQuality, librarySnapshot, recordSemanticAssessment, semanticPaths } from './scenario-library.js';
import { importBatchSchema, type ImportBatch, type ScenarioLibrary, type ScenarioProposal } from './scenario-contracts.js';
import { fingerprint, validatePreparation, type CallContext, type CreateInput, type Experiment, type Requirement, type Runtime, type ScenarioProposalsInput, type Source } from './contracts.js';
import { SOURCES_PER_DIALOGUE } from './limits.js';
import type { ExperimentStore } from './store.js';

export const SCENARIO_EXTRACTION_PROTOCOL = 'chronological-scenarios-v1' as const;
export function chronologicalInput(batch: ImportBatch, ids = batch.dialogues.map(d => d.id)): ScenarioProposalsInput['dialogues'] {
  return batch.dialogues.filter(d => ids.includes(d.id)).map(d => ({ id: d.id, observation: d.observation, events: structuredClone(d.events),
    messages: d.events.flatMap(e => e.type === 'message' && e.role && e.content ? [{ index: e.index, role: e.role, content: e.content }] : []) }));
}

/** Full imports are retained independently of the bounded model work and accepted run selection. */
export async function prepareScenarioLibrary(record: Experiment, input: CreateInput, batch: ImportBatch | undefined, runtime: Runtime, ctx: CallContext, store: ExperimentStore): Promise<void> {
  const original = batch ? await store.writeImport(importBatchSchema.parse(batch)) : undefined;
  if (original) record.originalImport = { id: original.id, contentHash: original.contentHash };
  const workIds = original ? original.dialogues.map(d => d.id) : ['owner_requirements'];
  record.preparationProgress = { protocol: SCENARIO_EXTRACTION_PROTOCOL, processed: [], pending: [...workIds],
    excluded: (batch?.rejected ?? []).map(d => ({ dialogueId: d.id ?? `row_${d.index}`, reason: d.reasons.join('; ') })), status: 'preparing' };
  let library = createLibrary({ id: `library_${record.id}`, batch: original, sources: record.sources, requirements: [], proposals: [], semanticRequired: true });
  let published: string | undefined;
  const publish = async () => {
    record.librarySnapshot = library;
    await store.publishLibrary(record, library, published);
    published = libraryHash(library);
  };
  await publish();
  try {
    ctx.signal.throwIfAborted();
    const groundingRequest = { task: record.task, sources: record.sources, existingAgent: input.existingAgent, workflow: record.workflow,
      scenarioCount: 0, targetKind: record.target.kind, notes: record.notes, dialogues: [], userModes: record.settings.userModes };
    const groundingIssue = workInputIssue(groundingRequest);
    // A knowledge base too large for one call is read per dialogue: the model picks articles from the table of contents.
    const perDialogue = !!groundingIssue && !!original && !!runtime.selectSources;
    if (groundingIssue && !perDialogue) {
      record.preparationProgress.excluded.push(...workIds.map(id => ({ dialogueId: id, reason: groundingIssue })));
      record.preparationProgress.status = 'partial'; await publish(); return;
    }
    const setBaseline = (agent: Experiment['revisions'][number]['spec']) => {
      const baseline = { id: fingerprint(agent), parentId: null, spec: agent, hypothesis: 'Конфигурация агента для библиотеки сценариев.', createdAt: new Date().toISOString() };
      record.revisions = [baseline]; record.selectedRevisionId = baseline.id;
    };
    if (!perDialogue) {
      const grounded = await runtime.prepare(groundingRequest, ctx);
      record.requirements = grounded.requirements; record.questions = grounded.questions;
      setBaseline(input.existingAgent ?? grounded.agent);
    } else record.preparationProgress.sourceSelection = [];
    const knowledge = record.sources.filter(source => source.kind !== 'prompt');
    const groundings = new Map<string, Awaited<ReturnType<Runtime['prepare']>>>();
    const proposals: ScenarioProposal[] = [];
    for (const workId of workIds) {
      ctx.signal.throwIfAborted();
      if (proposals.length >= 200) break;
      let sources = record.sources, requirements = record.requirements;
      if (perDialogue) {
        const dialogue = chronologicalInput(original!, [workId])[0]!;
        const selection = await runtime.selectSources!({ task: record.task, catalog: knowledge.map(({ id, name, content }) => ({ id, name, chars: content.length })),
          dialogue: { id: workId, messages: dialogue.messages.flatMap(({ role, content }) => role === 'user' || role === 'assistant' ? [{ role, content }] : []) }, limit: SOURCES_PER_DIALOGUE }, ctx);
        const chosen = [...new Set(selection.sourceIds)].filter(id => knowledge.some(source => source.id === id)).slice(0, SOURCES_PER_DIALOGUE);
        record.preparationProgress.sourceSelection!.push({ dialogueId: workId, sourceIds: chosen });
        const settle = (reason: string) => {
          record.preparationProgress!.excluded.push({ dialogueId: workId, reason });
          record.preparationProgress!.processed.push(workId);
          record.preparationProgress!.pending = record.preparationProgress!.pending.filter(id => id !== workId);
        };
        if (!chosen.length) { settle('В материалах владельца нет статьи под этот вопрос: модель не выбрала ни одной из оглавления.'); await publish(); continue; }
        // The model lists articles by importance; the least important go first when the call would not fit.
        while (chosen.length && workInputIssue({ ...groundingRequest, sources: record.sources.filter(source => source.kind === 'prompt' || chosen.includes(source.id)) })) chosen.pop();
        if (!chosen.length) { settle('Выбранные статьи не помещаются в один запрос модели даже по одной.'); await publish(); continue; }
        sources = record.sources.filter(source => source.kind === 'prompt' || chosen.includes(source.id));
        const key = fingerprint(sources.map(source => source.id));
        let grounded = groundings.get(key);
        if (!grounded) { grounded = await runtime.prepare({ ...groundingRequest, sources }, ctx); groundings.set(key, grounded); }
        if (!record.revisions.length) setBaseline(input.existingAgent ?? grounded.agent);
        record.questions = [...new Set([...record.questions, ...grounded.questions])].slice(0, 12);
        requirements = mergeRequirements(record, grounded.requirements, sources);
      }
      const request = { ...(record.generatorConfig?{generatorConfig:structuredClone(record.generatorConfig)}:{}), businessCatalog: library.businessScenarios.map(({ key, title, goal, conditions, requirementIds }) => ({ key, title, goal, conditions, requirementIds })), protocol: SCENARIO_EXTRACTION_PROTOCOL, task: record.task, sources: structuredClone(sources),
        requirements: structuredClone(requirements), ...(original ? { batchId: original.id } : { preparationMode: 'owner_requirements', scenarioCount: input.scenarioCount || 1 }), dialogues: original ? chronologicalInput(original, [workId]) : [] } as ScenarioProposalsInput;
      const oversize = workInputIssue(request);
      if (oversize) { record.preparationProgress.excluded.push({ dialogueId: workId, reason: oversize }); continue; }
      let extracted: ScenarioProposal[] = [], next: ScenarioLibrary | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        ctx.signal.throwIfAborted();
        const issue = workInputIssue(request);
        if (issue) { record.preparationProgress.excluded.push({ dialogueId: workId, reason: issue }); break; }
        extracted = await runtime.scenarioProposals!(request, ctx);
        if (serializedBytes({ proposals: extracted }) > SCENARIO_OUTPUT_BYTES) throw new Error('Предложение превышает допустимый объём ответа. Источник остаётся необработанным.');
        if (proposals.length + extracted.length > 200) break;
        next = createLibrary({ id: library.id, batch: original, sources: record.sources, requirements: record.requirements,
          proposals: [...proposals, ...extracted], createdAt: library.createdAt, semanticRequired: true });
        const proposedIds = new Set(extracted.map(p => p.variant.id));
        const issues = libraryQuality(next).filter(i => !i.code.startsWith('semantic_') && (!i.variantId || proposedIds.has(i.variantId))
          && !['uncertain_fact', 'uncertain_grouping'].includes(i.code));
        if (!issues.length) break;
        request.feedback = { proposals: extracted, issues: issues.slice(0, 12).map(({ code, path, message }) => ({ code, path, message: message.slice(0, 240) })) };
      }
      if (!next) continue;
      // Invalid but structurally parseable final proposals remain visible and blocked; there is no model-owned acceptance.
      next.revision = library.revision + 1;
      library = next; proposals.push(...extracted);
      record.preparationProgress.processed.push(workId);
      record.preparationProgress.pending = record.preparationProgress.pending.filter(id => id !== workId);
      if (!extracted.length) record.preparationProgress.excluded.push({ dialogueId: workId, reason: 'Нет применимого предложения из требований владельца.' });
      await publish();
    }
    if (fingerprint(library.requirements) !== fingerprint(record.requirements)) {
      // Requirements merged after the last accepted proposal still belong to the library the run will be checked against.
      library = createLibrary({ id: library.id, batch: original, sources: record.sources, requirements: record.requirements, proposals, createdAt: library.createdAt, semanticRequired: true });
      library.revision++;
    }
    if (library.variants.length && runtime.assessScenarioProposals) {
      library = await assessScenarioLibrary(library, runtime, ctx, async partial => { library = partial; await publish(); });
      library.revision++;
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
 * Adds one dialogue's requirements to the record: a rule already known by its source and exact quote keeps its id,
 * a new rule whose id is taken gets a numbered one. Returns the record's requirements for the given sources, with the ids the proposals must cite.
 */
function mergeRequirements(record: Experiment, extracted: Requirement[], sources: Source[]): Requirement[] {
  for (const requirement of extracted) {
    if (record.requirements.some(known => known.sourceId === requirement.sourceId && known.quote === requirement.quote)) continue;
    let id = requirement.id;
    for (let n = 2; record.requirements.some(known => known.id === id); n++) id = `${requirement.id}_${n}`;
    record.requirements.push({ ...requirement, id });
  }
  return record.requirements.filter(requirement => sources.some(source => source.id === requirement.sourceId));
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
  return validatePreparation({ requirements: library.requirements, questions: record.questions, agent: record.revisions[0]?.spec,
    scenarios: compileLibrary(library).map(({ split, ...scenario }) => scenario) }, library.sources, record.workflow, record.profiles).scenarios;
}
