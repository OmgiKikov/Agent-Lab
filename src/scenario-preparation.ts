import { assessScenarioLibrary, workInputIssue, serializedBytes, SCENARIO_OUTPUT_BYTES } from './scenario-work.js';
export { assessScenarioLibrary } from './scenario-work.js';
import { createLibrary, compileLibrary, libraryHash, libraryQuality, librarySnapshot, recordSemanticAssessment, semanticPaths } from './scenario-library.js';
import { importBatchSchema, type ImportBatch, type ScenarioLibrary, type ScenarioProposal } from './scenario-contracts.js';
import { fingerprint, validatePreparation, type CallContext, type CreateInput, type Experiment, type Runtime, type ScenarioProposalsInput } from './contracts.js';
import type { ExperimentStore } from './store.js';

export const SCENARIO_EXTRACTION_PROTOCOL = 'chronological-scenarios-v1' as const;
export function chronologicalInput(batch: ImportBatch, ids = batch.dialogues.map(d => d.id)): ScenarioProposalsInput['dialogues'] {
  return batch.dialogues.filter(d => ids.includes(d.id)).map(d => ({ id: d.id, observation: d.observation, events: structuredClone(d.events),
    messages: d.events.flatMap(e => e.type === 'message' && e.role && e.content ? [{ index: e.index, role: e.role, content: e.content }] : []) }));
}

/** Full imports are retained independently of the bounded model work and accepted run selection. */
export async function prepareScenarioLibrary(record: Experiment, input: CreateInput, batch: ImportBatch, runtime: Runtime, ctx: CallContext, store: ExperimentStore): Promise<void> {
  const original = await store.writeImport(importBatchSchema.parse(batch));
  record.originalImport = { id: original.id, contentHash: original.contentHash };
  record.preparationProgress = { protocol: SCENARIO_EXTRACTION_PROTOCOL, processed: [], pending: batch.dialogues.map(d => d.id),
    excluded: batch.rejected.map(d => ({ dialogueId: d.id ?? `row_${d.index}`, reason: d.reasons.join('; ') })), status: 'preparing' };
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
    if (groundingIssue) {
      record.preparationProgress.excluded.push(...batch.dialogues.map(d => ({ dialogueId: d.id, reason: groundingIssue })));
      record.preparationProgress.status = 'partial'; await publish(); return;
    }
    const grounded = await runtime.prepare(groundingRequest, ctx);
    record.requirements = grounded.requirements; record.questions = grounded.questions;
    const agent = input.existingAgent ?? grounded.agent;
    const baseline = { id: fingerprint(agent), parentId: null, spec: agent, hypothesis: 'Конфигурация агента для библиотеки сценариев.', createdAt: new Date().toISOString() };
    record.revisions = [baseline]; record.selectedRevisionId = baseline.id;
    const proposals: ScenarioProposal[] = [];
    for (const dialogue of batch.dialogues) {
      ctx.signal.throwIfAborted();
      if (proposals.length >= 200) break;
      const request = { businessCatalog: library.businessScenarios.map(({ key, title, goal, conditions, requirementIds }) => ({ key, title, goal, conditions, requirementIds })), protocol: SCENARIO_EXTRACTION_PROTOCOL, task: record.task, sources: structuredClone(record.sources),
        requirements: structuredClone(record.requirements), batchId: original.id, dialogues: chronologicalInput(original, [dialogue.id]) } as ScenarioProposalsInput;
      const oversize = workInputIssue(request);
      if (oversize) { record.preparationProgress.excluded.push({ dialogueId: dialogue.id, reason: oversize }); continue; }
      let extracted: ScenarioProposal[] = [], next: ScenarioLibrary | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        ctx.signal.throwIfAborted();
        const issue = workInputIssue(request);
        if (issue) { record.preparationProgress.excluded.push({ dialogueId: dialogue.id, reason: issue }); break; }
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
      record.preparationProgress.processed.push(dialogue.id);
      record.preparationProgress.pending = record.preparationProgress.pending.filter(id => id !== dialogue.id);
      if (!extracted.length) record.preparationProgress.excluded.push({ dialogueId: dialogue.id, reason: 'Нет применимого предложения из требований владельца.' });
      await publish();
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
