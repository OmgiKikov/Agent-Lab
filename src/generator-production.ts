import { fingerprint, type CallContext, type Runtime, type ScenarioProposalsInput } from './contracts.js';
import { createLibrary, importBatch, libraryQuality } from './scenario-library.js';
import { chronologicalInput } from './scenario-preparation.js';
import { assessScenarioLibrary } from './scenario-work.js';
import { generatorOutputSchema, type GeneratorCaseInput, type GeneratorConfig } from './generator-corpus.js';
import type { ScenarioLibrary, ScenarioProposal } from './scenario-contracts.js';
export interface ProductionEvidence {
    rawProposals: ScenarioProposal[];
    library?: ScenarioLibrary;
    issues: ReturnType<typeof libraryQuality>;
    error?: string;
    rawAssessment?: unknown;
}
export interface GeneratedCaseAssessment {
    input: GeneratorCaseInput;
    proposals: ScenarioProposal[];
    findings: ScenarioLibrary['semanticAssessment'];
    issues: ReturnType<typeof libraryQuality>;
}
/** The same extraction + admission + semantic assessor used for a new library, with no owner acceptance fabricated. */
export async function generateProductionCase(runtime: Runtime, input: GeneratorCaseInput, config: GeneratorConfig, ctx: CallContext) {
    if (!runtime.scenarioProposals || !runtime.assessScenarioProposals || !runtime.assessGeneratedCase)
        throw new Error('Нужны production extraction, semantic assessment и независимая оценка результата.');
    const batch = importBatch([{ id: 'case', messages: input.dialogue }]);
    const sources = [{ id: 'owner', name: 'Синтетическое правило владельца', content: input.source, hash: fingerprint(input.source) }];
    if (!input.source.includes(input.ownerRequirement))
        throw new Error('Правило корпуса не подтверждено источником.');
    const requirements = [{ id: 'owner_rule', sourceId: 'owner', text: input.ownerRequirement, quote: input.ownerRequirement, critical: true }];
    const request: ScenarioProposalsInput = { protocol: 'chronological-scenarios-v1', task: `Подготовьте проверку для заданного варианта: ${JSON.stringify(input.proposedVariant)}. Сохраните личные факты, исправления и происхождение знания. Предлагаемые факты: ${JSON.stringify(input.factCandidates)}. Сравнение: ${JSON.stringify(input.comparisonVariants)}. Обратная связь окружения: ${input.worldFeedback ?? 'нет'}. Источник синтетический; production обозначает только извлечение из предоставленного диалога.`, sources, requirements, batchId: batch.id, dialogues: chronologicalInput(batch), generatorConfig: config };
    const production: ProductionEvidence = { rawProposals: [], issues: [] };
    try {
        production.rawProposals = structuredClone(await runtime.scenarioProposals(request, ctx));
        if (Buffer.byteLength(JSON.stringify(production.rawProposals), 'utf8') > 12000)
            throw new Error('Предложение превышает 12000 байт.');
        let library = createLibrary({ id: 'benchmark', batch, sources, requirements, proposals: production.rawProposals, semanticRequired: true });
        production.library = library;
        if (library.variants.length)
            library = await assessScenarioLibrary(library, runtime, ctx, async (partial) => { production.library = partial; });
        production.library = library;
        production.issues = libraryQuality(library);
        if (!library.variants.length)
            throw new Error('Генератор не вернул проверяемого варианта.');
        production.rawAssessment = await runtime.assessGeneratedCase({ input, proposals: production.rawProposals, findings: library.semanticAssessment, issues: production.issues }, ctx);
        const output = generatorOutputSchema.parse(production.rawAssessment);
        // An evaluator cannot launder structural knowledge provenance or bypass real library admission.
        output.facts = input.factCandidates.map(candidate => {
            const found = library.variants.flatMap(v => v.userState.facts).filter(f => f.id === candidate.id || f.statement.includes(candidate.statement) || f.value !== undefined && candidate.statement === String(f.value));
            const availability = found.some(f => f.availability === 'initial') ? 'initial' : found.some(f => f.availability === 'learned_in_source') ? 'learned_in_source' : 'unavailable';
            return { id: candidate.id, availability };
        });
        if (production.issues.some(i => i.severity === 'blocked'))
            output.validity = 'invalid';
        else if (production.issues.length)
            output.validity = 'unknown';
        if (production.issues.some(i => i.code === 'duplicate_variant'))
            output.duplicate = 'exact';
        return { output, production };
    }
    catch (error) {
        production.error = String(error).slice(0, 4000);
        if (production.library)
            production.issues = libraryQuality(production.library);
        return { output: null, production };
    }
}
