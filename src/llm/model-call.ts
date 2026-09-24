import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Usage } from '../contracts.js';
import type { CallContext } from '../runtime.js';

/*
 * One request to a model, and nothing else. Structured tasks, the judge and the user simulator are
 * single request/response exchanges, so they reach the provider directly instead of opening a
 * coding-agent session: no tools, no resource discovery, no session state to switch off first.
 *
 *   credentials ─► budget (ctx.beforeCall) ─► request under ctx.signal + deadline ─► usage recorded once ─► text | ProviderFailure
 */

export type Model = NonNullable<ReturnType<ModelRuntime['getModel']>>;
type Context = Parameters<ModelRuntime['completeSimple']>[1];
export type ChatMessage = Context['messages'][number];
type Reply = Awaited<ReturnType<ModelRuntime['completeSimple']>>;

export interface ModelRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
  /** Omitted: the provider's default. */
  temperature?: number;
  /** Medium thinking for a reasoning model; off otherwise. */
  reasoning?: boolean;
  /** A provider-native response format, set only where the transport honours it. */
  responseFormat?: Record<string, unknown>;
  /** A cap on the serialized request, in UTF-8 bytes. Bytes, not tokens: the provider still rejects a prompt over its window. */
  maxRequestBytes?: number;
}

/**
 * Why a request produced no answer. The messages are the labels earlier releases stored in records and
 * judge audits ('Pi provider response incomplete: rate limit', 'Pi request deadline exceeded', …), so they
 * stay word for word; callers branch on `kind`.
 */
export type ProviderFailureKind = 'rate limit' | 'insufficient credit' | 'access denied' | 'timeout' | 'connection failure'
  | 'context limit' | 'incomplete' | 'deadline' | 'unavailable' | 'empty';
export class ProviderFailure extends Error {
  constructor(readonly kind: ProviderFailureKind, message: string, options?: ErrorOptions) { super(message, options); }
}

/**
 * Provider error text is an unstructured external format, so this table is the one place that reads it:
 * each kind with the phrases providers spell it with, first match wins. Only the kind leaves this module;
 * the raw text can carry credentials and URLs and is never stored.
 */
const FAILURE_PHRASES: readonly (readonly [ProviderFailureKind, readonly string[]])[] = [
  ['rate limit', ['429', 'rate limit', 'rate-limit', 'rate_limit', 'ratelimit']],
  ['insufficient credit', ['402', 'credit', 'balance']],
  ['access denied', ['401', '403', 'unauthorized', 'forbidden']],
  ['timeout', ['timeout', 'timed out']],
  ['connection failure', ['fetch failed', 'connection', 'socket', 'network']],
  ['context limit', ['context length', 'context_length', 'context-length', 'contextlength', 'too many tokens']],
];
function incomplete(reply: Reply): ProviderFailure {
  const text = (reply.errorMessage ?? '').toLowerCase();
  const kind = FAILURE_PHRASES.find(([, phrases]) => phrases.some(phrase => text.includes(phrase)))?.[0];
  return new ProviderFailure(kind ?? 'incomplete', `Pi provider response incomplete: ${kind ?? reply.stopReason}`);
}
const unavailable = (model: Model) => new ProviderFailure('unavailable',
  `Запрос к ${model.provider}/${model.id} не прошёл. Проверьте доступ, права на модель и доступность провайдера.`);

const counted = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
/** Tokens as the provider reported them; the cost only when it reported one for a priced model, otherwise unknown, never free. */
function usageOf(reply: Reply | undefined, model: Model): Omit<Usage, 'calls'> {
  const usage = reply?.usage;
  if (!usage || ![usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(counted)) return { inputTokens: 0, outputTokens: 0, costUsd: null };
  const priced = Object.values(model.cost).some(n => typeof n === 'number' && n > 0);
  return { inputTokens: usage.input + usage.cacheRead + usage.cacheWrite, outputTokens: usage.output,
    costUsd: priced && usage.totalTokens > 0 && counted(usage.cost?.total) ? usage.cost.total : null };
}

/** Missing credentials are refused like an unreachable provider, before the budget is charged for a request that never leaves. */
async function authorized(runtime: ModelRuntime, model: Model, signal: AbortSignal): Promise<boolean> {
  if (runtime.hasConfiguredAuth(model.provider)) return true;
  try { return await runtime.checkAuth(model.provider, { signal }) !== undefined; }
  catch { signal.throwIfAborted(); return false; }
}

/** The request ends when its signal does, even when a provider ignores the signal: a late reply is dropped, never used. */
async function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); });
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) abort();
    return await Promise.race([pending, aborted]);
  } finally { signal.removeEventListener('abort', abort); }
}

/**
 * Sends one request and returns the model's text with the reply message (a repair continues from it).
 * The call is charged against the budget before it is sent and its usage is recorded exactly once, also
 * when it fails; the partial text of an incomplete reply goes to `onIncomplete` as evidence and is never
 * returned as an answer.
 */
export async function callModel(runtime: ModelRuntime, model: Model, request: ModelRequest, ctx: CallContext,
  onIncomplete?: (text: string) => void): Promise<{ text: string; message: ChatMessage }> {
  ctx.signal.throwIfAborted();
  const context: Context = { systemPrompt: request.system, messages: request.messages };
  if (request.maxRequestBytes && Buffer.byteLength(JSON.stringify(context), 'utf8') > request.maxRequestBytes) {
    throw new Error('Запрос превышает безопасный контекст модели; полная хронология сохранена для меньшего пакета.');
  }
  if (!await authorized(runtime, model, ctx.signal)) throw unavailable(model);
  ctx.beforeCall();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new ProviderFailure('deadline', 'Pi request deadline exceeded')), ctx.timeoutMs);
  const signal = AbortSignal.any([ctx.signal, deadline.signal]);
  let reply: Reply | undefined;
  try {
    reply = await untilAborted(runtime.completeSimple(model, context, {
      signal, timeoutMs: ctx.timeoutMs, maxRetries: 0, transport: 'sse',
      maxTokens: Math.min(request.maxTokens, model.maxTokens),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.reasoning ? { reasoning: 'medium' as const } : {}),
      ...(request.responseFormat ? { onPayload: (payload: unknown) => ({ ...(payload as Record<string, unknown>), response_format: request.responseFormat }) } : {}),
    }), signal);
  } catch {
    if (signal.aborted) throw signal.reason;
    throw unavailable(model);
  } finally {
    clearTimeout(timer);
    ctx.addUsage(usageOf(reply, model));
  }
  if (signal.aborted) throw signal.reason;
  const text = reply.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
  if (reply.stopReason !== 'stop') {
    if (text.trim()) onIncomplete?.(text);
    throw incomplete(reply);
  }
  if (!text.trim()) throw new ProviderFailure('empty', 'Модель вернула пустой ответ.');
  return { text, message: reply };
}
