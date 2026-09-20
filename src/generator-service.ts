import { z } from 'zod';
import { settingsSchema, type Runtime } from './contracts.js';
import { createPiRuntime } from './pi.js';
import { generatorConfigSchema } from './generator-corpus.js';
import { evaluateGenerator, optimizeGenerator, loadGeneratorCorpus, type GeneratorAdapter, type GeneratorReport } from './generator-evaluation.js';
import type { ExperimentStore } from './store.js';
const generatorSettingsSchema = settingsSchema.extend({ maxCalls: z.number().int().min(1).max(300) });
export const generatorRequestSchema = z.strictObject({ config: generatorConfigSchema, settings: generatorSettingsSchema.optional(), controls: z.boolean().default(true), caseIds: z.array(z.string().max(80)).min(1).max(24).optional(), maxCandidates: z.number().int().min(0).max(3).default(1) });
export type GeneratorRequest = z.input<typeof generatorRequestSchema>;
export function runGeneratorOperation(operation: 'evaluate', raw: GeneratorRequest, store: ExperimentStore, injected?: Runtime, signal?: AbortSignal): Promise<GeneratorReport>;
export function runGeneratorOperation(operation: 'optimize', raw: GeneratorRequest, store: ExperimentStore, injected?: Runtime, signal?: AbortSignal): ReturnType<typeof optimizeGenerator>;
export async function runGeneratorOperation(operation: 'evaluate' | 'optimize', raw: GeneratorRequest, store: ExperimentStore, injected?: Runtime, signal?: AbortSignal) {
    const input = generatorRequestSchema.parse(raw), settings = generatorSettingsSchema.parse(input.settings ?? { maxCalls: 60, maxDurationMs: 120000, timeoutMs: 30000 });
    const corpus = await loadGeneratorCorpus();
    if (input.caseIds) {
        if (new Set(input.caseIds).size !== input.caseIds.length || input.caseIds.some(id => !corpus.cases.some(c => c.id === id)))
            throw new Error('Выберите известные примеры без повторов.');
        if (operation === 'optimize')
            throw new Error('Оптимизация использует полный зафиксированный корпус; поднабор допустим только для evaluate.');
        corpus.cases = corpus.cases.filter(c => input.caseIds!.includes(c.id));
    }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('Лимит времени генератора исчерпан.')), settings.maxDurationMs);
    let calls = 0;
    const ctx = { store, signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal, timeoutMs: settings.timeoutMs, beforeCall() { ctx.signal.throwIfAborted(); if (calls >= settings.maxCalls) {
            controller.abort(new Error('Лимит вызовов генератора исчерпан.'));
            ctx.signal.throwIfAborted();
        } calls++; }, addUsage() { } };
    try {
        ctx.signal.throwIfAborted();
        const runtime = injected ?? await createPiRuntime(settings);
        if (!runtime.generateScenarioCase)
            throw new Error('Среда не поддерживает оценку генератора.');
        const generator: GeneratorAdapter = { config: input.config, runtimeIdentity: { settings }, transport: runtime.generatorTransport ?? 'deterministic-test', generate: (caseInput, config, ctx) => runtime.generateScenarioCase!({ input: caseInput, config }, ctx),
            propose: runtime.proposeGeneratorConfig ? (input, ctx) => runtime.proposeGeneratorConfig!(input, ctx) : undefined, judge: runtime };
        return operation === 'evaluate' ? await evaluateGenerator(corpus, generator, input.controls, ctx) : await optimizeGenerator({ corpus, generator, maxCandidates: input.maxCandidates, controls: input.controls }, ctx);
    }
    finally {
        clearTimeout(timer);
    }
}
