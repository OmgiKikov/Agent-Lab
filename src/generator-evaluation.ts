import { SCENARIO_PROPOSALS_ROLE, SCENARIO_SEMANTIC_ROLE, CHECKPOINT_ROLE, USER_CONTROLLER_ROLE } from './prompts.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fingerprint, emptyUsage, type CallContext, type Runtime } from './contracts.js';
import { generatorCorpusSchema, generatorConfigSchema, generatorOutputSchema, type GeneratorCorpus, type GeneratorConfig, type GeneratorCaseInput } from './generator-corpus.js';
import type { ExperimentStore } from './store.js';
import { runGeneratorControls, CONTROL_PROTOCOL } from './generator-controls.js';
export { loadGeneratorCorpus } from './generator-corpus.js';
export { runGeneratorControls } from './generator-controls.js';
export const GENERATOR_PROTOCOL = 'generator-evaluation-v1';
export const GENERATOR_ROLE = 'Оцените ФАКТИЧЕСКИ созданные proposals, а не идеальный сценарий: проверьте допустимость с опорой на findings и issues реальной библиотеки. Классифицируйте применимость ожидаемого действия по требованию и условиям, дубли относительно comparisonVariants. Если доказательств недостаточно, unknown. Проверьте структуру сценария по полной хронологии. Для каждого factCandidate верните доступность: initial — личное знание до ответа агента, learned_in_source — узнал из ответа агента, unavailable — скрытое знание. Ожидание задаёт только ownerRequirement; applicability applicable/not_applicable/unknown. duplicate exact при одинаковых нормализованных условиях, unresolved при семантическом сходстве, none иначе. validity invalid при утечке скрытого знания, точном дубле или недействительном мире; unknown при неразрешённом дубле; valid для допустимой проверки. Верните все факты и короткое обоснование. Конфигурация меняет только эти инструкции генератора, не правила владельца.';
export const GENERATOR_PROPOSER_ROLE = 'Предложите одну короткую текстовую конфигурацию генератора по dev-примерам и обратной связи. Не меняйте источник, правила владельца, корпус, разметку, инструменты, контрольные дефекты или промпт испытуемого. Возвращайте instructions и temperature.';
export interface GeneratorAdapter {
    config: GeneratorConfig;
    transport: 'pi-model' | 'deterministic-test';
    runtimeIdentity?: unknown;
    generate(input: GeneratorCaseInput, config: GeneratorConfig, ctx: CallContext): Promise<unknown>;
    propose?(input: {
        config: GeneratorConfig;
        examples: GeneratorCorpus['cases'];
        feedback: GeneratorFeedback;
    }, ctx: CallContext): Promise<unknown>;
    judge?: Pick<Runtime, 'assessCheckpoints'>;
}
export interface GeneratorFeedback {
    configHash: string;
    dimensions: GeneratorReport['dimensions'];
    cases: {
        id: string;
        errors: string[];
        unknown: boolean;
        error?: string;
        output?: unknown;
        admission?: unknown;
    }[];
}
export type GeneratorContext = CallContext & {
    store?: ExperimentStore;
};
export interface GeneratorRecord {
    id: string;
    formatVersion: '1';
    kind: string;
    [key: string]: unknown;
}
export interface CaseResult {
    id: string;
    dimension: 'provenance' | 'applicability' | 'variants';
    split: 'dev' | 'holdout';
    inputHash: string;
    rawOutput: unknown;
    transports?:Parameters<NonNullable<CallContext['onGeneratorTransport']>>[0][];
    rawResponses?: {
        role: string;
        text: string;
    }[];
    errors: string[];
    unknown: boolean;
    error?: string;
}
export interface GeneratorReport extends GeneratorRecord {
    kind: 'generator-evaluation';
    runKind: 'generator';
    protocol: string;
    protocolHash: string;
    config: GeneratorConfig;
    configHash: string;
    corpusHash: string;
    corpus: GeneratorCorpus;
    transport: GeneratorAdapter['transport'];
    cases: CaseResult[];
    dimensions: Record<CaseResult['dimension'], {
        total: number;
        errors: number;
        unknown: number;
    }>;
    controls: Awaited<ReturnType<typeof runGeneratorControls>> | null;
    usage: ReturnType<typeof emptyUsage>;
    limitations: string[];
}
function metered(ctx: CallContext) {
    const usage = emptyUsage();
    return { usage, ctx: { ...ctx, beforeCall() { ctx.signal.throwIfAborted(); ctx.beforeCall(); usage.calls++; }, addUsage(value) { ctx.addUsage(value); usage.inputTokens += value.inputTokens; usage.outputTokens += value.outputTokens; usage.costUsd = usage.costUsd === null || value.costUsd === null ? null : usage.costUsd + value.costUsd; } } satisfies CallContext };
}
/** Labels never enter generate(). Raw transport errors stay local and cannot enter a later proposer after holdout. */
export async function evaluateGenerator(rawCorpus: GeneratorCorpus, generator: GeneratorAdapter, controls: boolean, ctx: GeneratorContext): Promise<GeneratorReport> {
    return evaluateFrozenGenerator(rawCorpus, generator, controls, ctx, false);
}
async function evaluateFrozenGenerator(rawCorpus: GeneratorCorpus, generator: GeneratorAdapter, controls: boolean, ctx: GeneratorContext, reserved: boolean): Promise<GeneratorReport> {
    const corpus = generatorCorpusSchema.parse(structuredClone(rawCorpus)), config = generatorConfigSchema.parse(structuredClone(generator.config));
    const meter = metered(ctx);
    const report: GeneratorReport = { id: `gen_${randomUUID()}`, formatVersion: '1', kind: 'generator-evaluation', runKind: 'generator', protocol: GENERATOR_PROTOCOL,
        protocolHash: fingerprint({ protocol: GENERATOR_PROTOCOL, role: GENERATOR_ROLE, extraction: SCENARIO_PROPOSALS_ROLE, semantic: SCENARIO_SEMANTIC_ROLE, checkpoint: CHECKPOINT_ROLE, controller: USER_CONTROLLER_ROLE, controls: CONTROL_PROTOCOL, controlsEnabled: controls, runtimeIdentity: generator.runtimeIdentity, output: z.toJSONSchema(generatorOutputSchema) }), config, configHash: fingerprint(config), corpusHash: fingerprint(corpus), corpus, transport: generator.transport, cases: [], dimensions: { provenance: { total: 0, errors: 0, unknown: 0 }, applicability: { total: 0, errors: 0, unknown: 0 }, variants: { total: 0, errors: 0, unknown: 0 } }, controls: null, usage: meter.usage,
        limitations: ['Предварительная разметка разработчика; экспертной проверки нет.', `Проверено ${corpus.cases.length} синтетических примеров; выводы ограничены этими примерами.`, 'Контрольные исполнения и модельная калибровка судьи учитываются отдельно.'] };
    if (generator.runtimeIdentity)
        report.runtimeIdentity = structuredClone(generator.runtimeIdentity);
    if (ctx.store)
        await ctx.store.saveGeneratorRecord({ id: `gen_${randomUUID()}`, formatVersion: '1', kind: 'generator-evaluation-plan', evaluationId: report.id, config: report.config, configHash: report.configHash, corpus, corpusHash: report.corpusHash, protocolHash: report.protocolHash, ...(generator.runtimeIdentity ? { runtimeIdentity: generator.runtimeIdentity } : {}) });
    const held = corpus.cases.filter(c => c.split === 'holdout');
    if (held.length && ctx.store && !reserved) {
        await ctx.store.consumeGeneratorHoldout(holdoutIdentity(held).hash, { evaluationId: report.id, configHash: report.configHash, protocolHash: report.protocolHash, corpusHash: report.corpusHash }, holdoutIdentity(held).cases);
    }
    if (held.length) {
        report.holdoutConsumed = !!ctx.store;
        report.independentAudit = !!ctx.store;
    }
    if (held.length && !ctx.store)
        report.limitations.push('Без постоянного писателя использование holdout не отслеживается; это не независимый аудит.');
    for (const item of corpus.cases) {
        const result: CaseResult = { id: item.id, dimension: item.dimension, split: item.split, inputHash: fingerprint(item.input), rawOutput: null, rawResponses: [], transports:[], errors: [], unknown: false };
        try {
            ctx.signal.throwIfAborted();
            const raw = await generator.generate(structuredClone(item.input), structuredClone(config), { ...meter.ctx, onGeneratorTransport:transport=>{result.transports!.push(transport);ctx.onGeneratorTransport?.(transport);}, onGeneratorOutput: response => { result.rawResponses!.push({ role: response.role, text: response.text.slice(0, 96000) }); ctx.onGeneratorOutput?.(response); } });
            if (Buffer.byteLength(JSON.stringify(raw) ?? '', 'utf8') > 256000)
                throw new Error('Ответ генератора превышает 256000 байт.');
            result.rawOutput = structuredClone(raw);
            const envelope = raw && typeof raw === 'object' && 'production' in raw ? raw as {
                output: unknown;
                production: {
                    error?: string;
                    issues: {
                        severity: string;
                    }[];
                };
            } : undefined;
            if (envelope?.production.error)
                throw new Error(envelope.production.error);
            const output = generatorOutputSchema.parse(envelope ? envelope.output : raw);
            if (item.expected.validity === 'valid' && envelope?.production.issues.some(i => i.severity === 'blocked'))
                result.errors.push('production_admission');
            for (const fact of item.expected.facts) {
                const returned = output.facts.filter(f => f.id === fact.id);
                if (returned.length !== 1 || returned[0]!.availability !== fact.availability)
                    result.errors.push('provenance');
                if (fact.availability !== 'initial' && returned.some(f => f.availability === 'initial'))
                    result.errors.push('learned_fact_leak');
            }
            if (output.facts.some(f => !item.expected.facts.some(e => e.id === f.id)))
                result.errors.push('invented_fact');
            for (const key of ['applicability', 'duplicate', 'validity'] as const)
                if (output[key] !== item.expected[key])
                    result.errors.push(key);
            result.unknown = output.applicability === 'unknown' && item.expected.applicability !== 'unknown' || output.validity === 'unknown' && item.expected.validity !== 'unknown';
            result.errors = [...new Set(result.errors)];
        }
        catch (error) {
            result.unknown = true;
            result.error = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
            result.errors.push('unmeasured');
        }
        if (ctx.store)
            await ctx.store.saveGeneratorRecord({ id: `gen_${randomUUID()}`, formatVersion: '1', kind: 'generator-case', evaluationId: report.id, configHash: report.configHash, protocolHash: report.protocolHash, corpusHash: report.corpusHash, result, usage: structuredClone(meter.usage) });
        report.cases.push(result);
        const dimension = report.dimensions[item.dimension];
        dimension.total++;
        if (result.errors.length)
            dimension.errors++;
        if (result.unknown)
            dimension.unknown++;
    }
    if (controls)
        report.controls = await runGeneratorControls(generator.judge, meter.ctx);
    if (ctx.store)
        await ctx.store.saveGeneratorRecord(report);
    return report;
}
export function compareGenerators(baseline: GeneratorReport, candidate: GeneratorReport) {
    if (!!baseline.controls !== !!candidate.controls)
        return { admitted: false, reason: 'Контрольный протокол изменён.' };
    if (baseline.corpusHash !== candidate.corpusHash || baseline.protocolHash !== candidate.protocolHash || baseline.transport !== candidate.transport)
        return { admitted: false, reason: 'Несопоставимые корпус, протокол или транспорт.' };
    const values = Object.keys(baseline.dimensions) as CaseResult['dimension'][];
    const errorCount=(report:GeneratorReport,code:string)=>report.cases.filter(c=>c.errors.includes(code)).length;
    const newMandatoryError=[...new Set(candidate.cases.flatMap(c=>c.errors))].some(code=>errorCount(candidate,code)>errorCount(baseline,code));
    const regressed = newMandatoryError || values.some(key => candidate.dimensions[key].errors > baseline.dimensions[key].errors || candidate.dimensions[key].unknown > baseline.dimensions[key].unknown);
    const controlBad = (r: GeneratorReport) => r.controls ? r.controls.missedDefects + r.controls.falsePositives + r.controls.invalid + r.controls.unknown + r.controls.calibration.missedDefects + r.controls.calibration.falsePositives + r.controls.calibration.unknown : 0;
    const improved = values.some(key => candidate.dimensions[key].errors < baseline.dimensions[key].errors);
    return { admitted: !regressed && improved && controlBad(candidate) <= controlBad(baseline), reason: regressed ? 'Обязательная корректность ухудшилась.' : !improved ? 'Улучшение не подтверждено.' : 'Измеренные ошибки уменьшились без ухудшения обязательных измерений.' };
}
export interface SelectionCandidate {
    id: string;
    contentHash: string;
    quality: string;
    provenanceErrors: number;
    applicabilityErrors: number;
    validity: string;
    duplicate: string;
    coverage: string[];
    unmetConditions: number;
    reproducibleIssues: number;
    instability: number;
    targetFailures?: number;
}
export function selectNextVariants(candidates: SelectionCandidate[], history: {
    contentHash: string;
    coverage?: string[];
}[]) {
    const seen = new Set(history.map(h => h.contentHash)), covered = new Set(history.flatMap(h => h.coverage ?? []));
    const excluded: {
        id: string;
        reason: string;
    }[] = [], selected: {
        id: string;
        priority: number[];
        reason: string;
    }[] = [];
    for (const c of candidates) {
        const reason = c.quality !== 'ready' ? 'Качество не допущено.' : c.provenanceErrors || c.applicabilityErrors ? 'Ошибка происхождения или применимости.' : c.validity !== 'valid' ? 'Недопустимый или неизвестный мир.' : c.duplicate !== 'none' ? 'Точный или неразрешённый смысловой дубль.' : seen.has(c.contentHash) ? 'Уже встречавшиеся условия.' : undefined;
        if (reason) {
            excluded.push({ id: c.id, reason });
            continue;
        }
        seen.add(c.contentHash);
        const safe = (n: number) => Number.isFinite(n) ? Math.max(0, n) : 0;
        const priority = [new Set(c.coverage.filter(x => !covered.has(x))).size, safe(c.unmetConditions), safe(c.reproducibleIssues), Math.min(1, safe(c.instability))];
        selected.push({ id: c.id, priority, reason: 'Новое покрытие → незакрытое условие → воспроизводимость → нестабильность. Провал испытуемого не учитывается.' });
    }
    selected.sort((a, b) => { for (let i = 0; i < a.priority.length; i++) {
        const delta = b.priority[i]! - a.priority[i]!;
        if (delta)
            return delta;
    } return a.id.localeCompare(b.id); });
    return { policy: 'generator-selection-v1', selected, excluded };
}
export async function optimizeGenerator(input: {
    corpus: GeneratorCorpus;
    generator: GeneratorAdapter;
    maxCandidates: number;
    controls: boolean;
}, ctx: GeneratorContext & {
    store: ExperimentStore;
}) {
    if (!Number.isInteger(input.maxCandidates) || input.maxCandidates < 0 || input.maxCandidates > 3)
        throw new Error('Допустимо 0–3 кандидата генератора.');
    const corpus = generatorCorpusSchema.parse(structuredClone(input.corpus)), dev = { ...corpus, cases: corpus.cases.filter(c => c.split === 'dev') }, holdout = { ...corpus, cases: corpus.cases.filter(c => c.split === 'holdout') };
    if (!dev.cases.length || !holdout.cases.length)
        throw new Error('Нужны отдельные dev и holdout.');
    const holdoutKey = holdoutIdentity(holdout.cases), holdoutHash = holdoutKey.hash;
    await ctx.store.assertGeneratorHoldoutFresh(holdoutHash, holdoutKey.cases);
    const meter = metered(ctx), work = { ...meter.ctx, store: ctx.store };
    let current = await evaluateGenerator(dev, input.generator, input.controls, work);
    const baseline = current, candidates: {
        report: GeneratorReport;
        comparison: ReturnType<typeof compareGenerators>;
    }[] = [], proposals: unknown[] = [];
    for (let i = 0; i < input.maxCandidates; i++) {
        if (!input.generator.propose)
            throw new Error('Среда не поддерживает предложение конфигурации.');
        // Construct the payload exclusively from dev objects; never from a mixed report, summary or error graph.
        const request = JSON.parse(JSON.stringify({ config: structuredClone(current.config), examples: structuredClone(dev.cases), feedback: { configHash: current.configHash, dimensions: structuredClone(current.dimensions), cases: current.cases.map(c => ({ id: c.id, errors: [...c.errors], unknown: c.unknown, ...(c.error ? { error: c.error.slice(0, 500) } : {}), output: c.rawOutput && typeof c.rawOutput === 'object' && 'output' in c.rawOutput ? (c.rawOutput as {
                        output: unknown;
                    }).output : undefined, admission: c.rawOutput && typeof c.rawOutput === 'object' && 'production' in c.rawOutput ? (c.rawOutput as {
                        production: {
                            issues: unknown[];
                        };
                    }).production.issues.slice(0, 6) : undefined })) } }));
        let raw: unknown;
        const rawResponses: {
            role: string;
            text: string;
        }[] = [];
        try {
            raw = await input.generator.propose(request, { ...meter.ctx, onGeneratorOutput: response => rawResponses.push({ role: response.role, text: response.text.slice(0, 96000) }) });
            proposals.push({ request, rawOutput: structuredClone(raw), rawResponses });
            const config = generatorConfigSchema.parse(raw);
            const report = await evaluateGenerator(dev, { ...input.generator, config }, input.controls, work), comparison = compareGenerators(current, report);
            candidates.push({ report, comparison });
            if (comparison.admitted)
                current = report;
        }
        catch (error) {
            proposals.push({ request, rawOutput: raw ?? null, rawResponses, error: String(error).slice(0, 4000) });
            break;
        }
    }
    const id = `gen_${randomUUID()}`, finalConfig = structuredClone(current.config), finalConfigHash = fingerprint(finalConfig);
    const frozen = { id: `gen_${randomUUID()}`, formatVersion: '1' as const, kind: 'generator-final', optimizationId: id, config: finalConfig, configHash: finalConfigHash, corpusHash: fingerprint(corpus), protocolHash: current.protocolHash, holdoutHash };
    await ctx.store.saveGeneratorRecord(frozen);
    await ctx.store.consumeGeneratorHoldout(holdoutHash, { finalId: frozen.id, optimizationId: id, finalConfigHash, corpusHash: fingerprint(corpus) }, holdoutKey.cases);
    const final = await evaluateFrozenGenerator(holdout, { ...input.generator, config: finalConfig }, input.controls, work, true);
    const result = { id, formatVersion: '1' as const, kind: 'generator-optimization', runKind: 'generator', baseline, candidates, proposals, finalConfig, finalConfigHash, frozenFinalId: frozen.id, holdout: final, holdoutHash, holdoutConsumed: true, usage: meter.usage, limitations: ['Holdout использован; следующему независимому аудиту нужна новая скрытая выборка.', 'Результат holdout не возвращается предложителю и не выбирает следующего кандидата.'] };
    await ctx.store.saveGeneratorRecord(result);
    return result;
}
function holdoutIdentity(cases: GeneratorCorpus['cases']) { const identities = [...new Set(cases.map(c => fingerprint(c.input)))].sort(); return { hash: fingerprint(identities), cases: [...identities, fingerprint(cases)] }; }
export function generatorSummary(record: GeneratorRecord) {
    const report = (record.kind === 'generator-optimization' ? record.holdout : record) as GeneratorReport;
    return { id: record.id, kind: record.kind, runKind: 'generator', transport: report.transport, cases: report.cases?.length, dimensions: report.dimensions, usage: record.usage, holdoutConsumed: record.holdoutConsumed ?? false,
        controls: report.controls ? { missedDefects: report.controls.missedDefects, falsePositives: report.controls.falsePositives, invalid: report.controls.invalid, unknown: report.controls.unknown, calibration: { missedDefects: report.controls.calibration.missedDefects, falsePositives: report.controls.calibration.falsePositives, unknown: report.controls.calibration.unknown } } : null,
        config: record.kind === 'generator-optimization' ? record.finalConfig : report.config, configHash: record.kind === 'generator-optimization' ? record.finalConfigHash : report.configHash,
        errors: report.cases?.filter(c => c.errors.length || c.unknown).slice(0, 6).map(c => ({ id: c.id, errors: c.errors, unknown: c.unknown, ...(c.error ? { error: c.error.slice(0, 240) } : {}) })),
        candidateComparisons: record.kind === 'generator-optimization' ? (record.candidates as {
            comparison: unknown;
        }[]).map(c => c.comparison) : undefined, limitations: record.limitations };
}
