import { randomUUID } from 'node:crypto';
import { addUsage, emptyUsage, fingerprint } from './contracts.js';
import type { CallContext, Runtime } from './runtime.js';

/**
 * The calls a journal names. Stored journals are read as written: `groundRequirements` is the grounding call of
 * preparations made before the proposal cited the materials itself, `prepare` how still older journals name it, and
 * `scenarioProposals` and `assessScenarioProposals` are the first format's preparation; nothing makes any of them now.
 */
type Method = 'groundRequirements' | 'prepare' | 'selectSources' | 'scenarioProposals' | 'assessScenarioProposals' | 'proposeScenario' | 'proposeCard' | 'reviewCard' | 'topicMap';
export type GeneratorEvidence = {
  workId: string;
  method: Method;
  at: string;
  transport: 'pi-model' | 'deterministic-test';
} & (
  | { kind: 'request'; input: unknown; inputHash: string }
  | { kind: 'response'; response: Parameters<NonNullable<CallContext['onGeneratorOutput']>>[0] }
  | { kind: 'transport'; model: Parameters<NonNullable<CallContext['onGeneratorTransport']>>[0] }
  | { kind: 'validation'; validation: Parameters<NonNullable<CallContext['onGeneratorValidation']>>[0] }
  | { kind: 'result'; output: unknown; elapsedMs: number; usage: ReturnType<typeof emptyUsage> }
  | { kind: 'error'; error: string; elapsedMs: number; usage: ReturnType<typeof emptyUsage> }
);

/** Observe the actual product roles. No extra prompts, model calls, labels or acceptance. */
export function captureGeneratorEvidence(runtime: Runtime, emit: (event: GeneratorEvidence) => void): Runtime {
  function capture<I, O>(method: Method, work: (input: I, ctx: CallContext) => Promise<O>) {
    return async (input: I, ctx: CallContext): Promise<O> => {
      const workId = randomUUID(), started = performance.now(), usage = emptyUsage();
      const base = () => ({ workId, method, at: new Date().toISOString(), transport: runtime.generatorTransport ?? 'deterministic-test' as const });
      emit({ ...base(), kind: 'request', input: structuredClone(input), inputHash: fingerprint(input) });
      try {
        const output = await work(input, { ...ctx,
          beforeCall() { ctx.beforeCall(); usage.calls++; },
          addUsage(value) { ctx.addUsage(value); addUsage(usage, value); },
          onGeneratorOutput(response) { emit({ ...base(), kind: 'response', response }); ctx.onGeneratorOutput?.(response); },
          onGeneratorTransport(model) { emit({ ...base(), kind: 'transport', model }); ctx.onGeneratorTransport?.(model); },
          onGeneratorValidation(validation) { emit({ ...base(), kind: 'validation', validation }); ctx.onGeneratorValidation?.(validation); },
        });
        emit({ ...base(), kind: 'result', output: structuredClone(output), elapsedMs: Math.round(performance.now() - started), usage });
        return output;
      } catch (error) {
        emit({ ...base(), kind: 'error', error: error instanceof Error ? error.message : String(error), elapsedMs: Math.round(performance.now() - started), usage });
        throw error;
      }
    };
  }
  const mapper = runtime.topicMap;
  // One journal entry per build: the plan it was given, every raw reply of its calls, then the map or the error.
  const topicMap: Runtime['topicMap'] = mapper && { builder: mapper.builder,
    build: (plan, ctx, onProgress) => capture('topicMap', (input: typeof plan, inner: CallContext) => mapper.build(input, inner, onProgress))(plan, ctx) };
  return { ...runtime,
    ...(topicMap ? { topicMap } : {}),
    ...(runtime.selectSources ? { selectSources: capture('selectSources', runtime.selectSources.bind(runtime)) } : {}),
    // The plan of a topic is the builder's paid work like a card: its request and answer are evidence too.
    ...(runtime.proposeScenario ? { proposeScenario: capture('proposeScenario', runtime.proposeScenario.bind(runtime)) } : {}),
    ...(runtime.proposeCard ? { proposeCard: capture('proposeCard', runtime.proposeCard.bind(runtime)) } : {}),
    ...(runtime.reviewCard ? { reviewCard: capture('reviewCard', runtime.reviewCard.bind(runtime)) } : {}),
  };
}
