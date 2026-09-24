import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime, type ProviderConfig } from '@earendil-works/pi-coding-agent';
import { emptyUsage, settingsSchema } from '../../src/contracts.js';
import type { CallContext } from '../../src/runtime.js';
import { createPiRuntime } from '../../src/pi.js';

/*
 * An offline Pi provider registered on a real ModelRuntime: every request goes through the SDK's public
 * stream protocol exactly as a network provider's would; only the model's reply is scripted.
 */

export type Request = Parameters<NonNullable<ProviderConfig['streamSimple']>>[1];
export type Options = Parameters<NonNullable<ProviderConfig['streamSimple']>>[2];
export type Message = Awaited<ReturnType<ReturnType<ModelRuntime['streamSimple']>['result']>>;
/** Reply text, reply content, or a whole reply that ends some other way than a normal stop. */
export type Reply = string | Message['content'] | { content: Message['content']; stopReason: Message['stopReason']; errorMessage?: string };
export const fixtureSettings = settingsSchema.parse({ provider: 'agent-lab-test', model: 'test-model', timeoutMs: 1000 });

/** A call context with a call budget (`limit`) and summed usage; an unknown cost keeps the sum unknown. */
export function callContext(options: { timeoutMs?: number; signal?: AbortSignal; limit?: number } = {}) {
  const usage = emptyUsage();
  const ctx: CallContext = {
    signal: options.signal ?? new AbortController().signal, timeoutMs: options.timeoutMs ?? 1000,
    beforeCall() {
      if (usage.calls >= (options.limit ?? 100)) throw new Error('Call budget exhausted');
      usage.calls++;
    },
    addUsage(value) {
      usage.inputTokens += value.inputTokens;
      usage.outputTokens += value.outputTokens;
      usage.costUsd = usage.costUsd === null || value.costUsd === null ? null : usage.costUsd + value.costUsd;
    },
  };
  return { ctx, usage };
}

export async function fixture(reply: (request: Request, index: number, options?: Options) => Reply | Promise<Reply>, roleModel = false, reasoning = false) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-lab-pi-'));
  const requests: Request[] = [];
  const modelsUsed: string[] = [];
  const runtime = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'), modelsPath: null,
    modelsStorePath: join(directory, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false,
  });
  runtime.registerProvider('agent-lab-test', {
    api: 'openai-completions', apiKey: 'fixture-only-not-a-real-key', baseUrl: 'http://127.0.0.1:1',
    models: (roleModel ? ['test-model', 'role-model'] : ['test-model']).map(id => ({
      id, name: 'Offline SDK fixture', reasoning, input: ['text'],
      cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, contextWindow: 200000, maxTokens: 16384,
    })),
    streamSimple(model, request, options) {
      modelsUsed.push(model.id);
      const index = requests.length;
      requests.push(JSON.parse(JSON.stringify(request)));
      const finished = (async (): Promise<Message> => {
        const value = await reply(request, index, options);
        const shaped = typeof value === 'string' ? { content: [{ type: 'text' as const, text: value }] } : Array.isArray(value) ? { content: value } : value;
        return {
          role: 'assistant', content: shaped.content, api: model.api, provider: model.provider, model: model.id,
          usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18,
            cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.001, total: 0.032 } },
          stopReason: 'stopReason' in shaped ? shaped.stopReason : shaped.content.some(c => c.type === 'toolCall') ? 'toolUse' : 'stop',
          ...('errorMessage' in shaped && shaped.errorMessage ? { errorMessage: shaped.errorMessage } : {}), timestamp: Date.now(),
        };
      })();
      // The SDK consumes the public stream iterator/result protocol. No network or model output is mocked above it.
      return {
        result: () => finished,
        async *[Symbol.asyncIterator]() {
          const message = await finished;
          yield { type: 'start', partial: message };
          yield { type: 'done', reason: message.stopReason, message };
        },
      } as ReturnType<ModelRuntime['streamSimple']>;
    },
  });
  return {
    runtime, requests, directory, modelsUsed,
    adapter: await createPiRuntime(fixtureSettings, runtime),
    async close() { await rm(directory, { recursive: true, force: true }); },
  };
}
