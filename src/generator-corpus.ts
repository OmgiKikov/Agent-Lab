import { readFile } from 'node:fs/promises';
import { z } from 'zod';
const text = z.string().min(1).max(4000);
export const generatorLabelsSchema = z.strictObject({
    facts: z.array(z.strictObject({ id: z.string().min(1).max(80), availability: z.enum(['initial', 'learned_in_source', 'unavailable']) })).max(20),
    applicability: z.enum(['applicable', 'not_applicable', 'unknown']), duplicate: z.enum(['none', 'exact', 'unresolved']), validity: z.enum(['valid', 'invalid', 'unknown']),
});
export const generatorOutputSchema = generatorLabelsSchema.extend({ rationale: z.string().max(800) });
export const generatorConfigSchema = z.strictObject({ instructions: text, temperature: z.number().min(0).max(1).default(0) });
export const generatorCaseInputSchema = z.strictObject({ source: text, ownerRequirement: text,
    dialogue: z.array(z.strictObject({ role: z.enum(['user', 'assistant', 'tool', 'system']), content: text })).min(1).max(20),
    factCandidates: z.array(z.strictObject({ id: z.string().min(1).max(80), statement: text })).max(20),
    proposedVariant: z.strictObject({ condition: text, operation: text }),
    comparisonVariants: z.array(z.strictObject({ condition: text, operation: text })).max(10), worldFeedback: text.optional(),
});
export const generatorCorpusSchema = z.strictObject({ formatVersion: z.literal('1'), revision: z.string().min(1).max(100), labelStatus: z.literal('developer-labeled'),
    cases: z.array(z.strictObject({ id: z.string().min(1).max(80), dimension: z.enum(['provenance', 'applicability', 'variants']), split: z.enum(['dev', 'holdout']), lineage: text,
        provenance: z.literal('synthetic'), input: generatorCaseInputSchema, expected: generatorLabelsSchema, feedback: text })).min(1).max(100),
}).superRefine((value, ctx) => {
    if (new Set(value.cases.map(c => c.id)).size !== value.cases.length)
        ctx.addIssue({ code: 'custom', message: 'Повтор ID корпуса' });
    for (const c of value.cases)
        if (value.cases.some(other => other.lineage === c.lineage && other.split !== c.split))
            ctx.addIssue({ code: 'custom', message: 'Связанные примеры пересекают dev/holdout' });
});
export type GeneratorCorpus = z.infer<typeof generatorCorpusSchema>;
export type GeneratorCaseInput = z.infer<typeof generatorCaseInputSchema>;
export type GeneratorConfig = z.infer<typeof generatorConfigSchema>;
export type GeneratorOutput = z.infer<typeof generatorOutputSchema>;
export async function loadGeneratorCorpus(): Promise<GeneratorCorpus> {
    return generatorCorpusSchema.parse(JSON.parse(await readFile(new URL('../test/fixtures/generator-corpus.json', import.meta.url), 'utf8')));
}
