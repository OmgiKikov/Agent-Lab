import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Usage } from '../contracts.js';
import type { CallContext } from '../runtime.js';

/*
 * One request to a model, and nothing else. Structured tasks, the judge and the user simulator are
 * single request/response exchanges, so they reach the provider directly instead of opening a
 * coding-agent session: no tools, no resource discovery, no session state to switch off first.
 *
 *   credentials ─► a place among the provider's requests ─► budget (ctx.beforeCall, once) ─► request under ctx.signal + deadline
 *                                                                          ▲                                        │
 *                                                            wait (retry-after or backoff) ◄── refused before any answer, transient
 *                                                                                                                   ▼
 *                                                             usage recorded per request ─► text | ProviderFailure (kind, delivery, retryable)
 *                                                                                                  | ModelCallDefect (the SDK threw: Lab's own, journaled)
 */

export type Model = NonNullable<ReturnType<ModelRuntime['getModel']>>;
type Context = Parameters<ModelRuntime['streamSimple']>[1];
export type ChatMessage = Context['messages'][number];
type Stream = ReturnType<ModelRuntime['streamSimple']>;
/** A reply as the SDK finishes it: its content, stop reason, error text and usage. */
export type ModelReply = Awaited<ReturnType<Stream['result']>>;

export interface ModelRequest {
  system: string;
  messages: ChatMessage[];
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
 * Why a request produced no usable answer. The messages are the labels earlier releases stored in records and
 * judge audits ('Pi provider response incomplete: rate limit', 'Pi request deadline exceeded', …), so they stay
 * word for word; callers branch on the typed fields, never on the text.
 */
export type ProviderFailureKind = 'rate limit' | 'overloaded' | 'insufficient credit' | 'access denied' | 'context limit' | 'bad request'
  | 'connection failure' | 'timeout' | 'deadline' | 'length' | 'empty' | 'incomplete' | 'unavailable';

/**
 * What became of a request that gave no usable answer, which is what it cost:
 * - `refused`: turned away before any answer began — a rate limit, an overload, missing access or credit, a request too
 *   large. Transport errors without a refusal leave delivery uncertain.
 * - `answered`: a whole answer arrived and was billed at its reported usage, but it cannot be used as it stands (cut at
 *   the output cap, empty). It is an answer: a structured task repairs it like any rejected one.
 * - `cut`: the answer began and broke off, or the request ran out of time before its fate was known. It may have been
 *   billed, and nobody reported the cost.
 */
export type ProviderDelivery = 'refused' | 'answered' | 'cut';

export interface ProviderFailureDetails extends ErrorOptions {
  delivery?: ProviderDelivery;
  retryable?: boolean;
  status?: number;
}

/** Each kind as it usually happens; the observed request overrides the delivery (a rate limit can also break a started answer). */
const KIND_DEFAULTS: Readonly<Record<ProviderFailureKind, { delivery: ProviderDelivery; retryable: boolean }>> = {
  'rate limit': { delivery: 'refused', retryable: true },
  overloaded: { delivery: 'refused', retryable: true },
  'connection failure': { delivery: 'cut', retryable: true },
  'insufficient credit': { delivery: 'refused', retryable: false },
  'access denied': { delivery: 'refused', retryable: false },
  'context limit': { delivery: 'refused', retryable: false },
  // The provider refused the request as it was made (a parameter, a schema, a tool the model does not take): the same
  // request fails the same way.
  'bad request': { delivery: 'refused', retryable: false },
  unavailable: { delivery: 'refused', retryable: false },
  timeout: { delivery: 'cut', retryable: true },
  deadline: { delivery: 'cut', retryable: true },
  incomplete: { delivery: 'cut', retryable: false },
  length: { delivery: 'answered', retryable: false },
  empty: { delivery: 'answered', retryable: false },
};

/**
 * A request that gave no usable answer. `kind` says why; `delivery` says what the caller may assume about the charge
 * (see ProviderDelivery); `retryable` says whether the cause is transient, so the same request may succeed later.
 * callModel itself sends a request again only when it was refused and the cause is transient: nothing was billed, so
 * the repeat is not a new paid call. A `cut` failure is never repeated silently, retryable or not.
 */
export class ProviderFailure extends Error {
  readonly delivery: ProviderDelivery;
  readonly retryable: boolean;
  /** The HTTP status the provider answered with, when the SDK reported it or the provider's error text named it. */
  readonly status?: number;
  constructor(readonly kind: ProviderFailureKind, message: string, details: ProviderFailureDetails = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.delivery = details.delivery ?? KIND_DEFAULTS[kind].delivery;
    this.retryable = details.retryable ?? KIND_DEFAULTS[kind].retryable;
    if (details.status !== undefined) this.status = details.status;
  }
}

/**
 * A request that broke inside Lab or the SDK it calls, not at the provider: the SDK threw instead of answering through its
 * stream protocol, where every provider failure arrives. Nothing here says the key, the access or the provider is at fault,
 * so the owner is told it is Lab's own defect; the original error, with its stack, is its cause and goes to the operation's
 * journal (CallContext.onDefect). It is never sent again: a defect repeats, and whether the request left is unknown.
 */
export class ModelCallDefect extends Error {
  constructor(readonly model: string, cause: unknown) {
    super(`Внутренняя ошибка Lab при вызове модели ${model} — дело не в доступе и не в ключе. Подробности записаны в журнал работы; повторите, а если повторится — сообщите разработчикам Lab.`, { cause });
    this.name = 'ModelCallDefect';
  }
}

/*
 * Provider error text is an unstructured external format, so the table below is the one place that reads it, and only
 * where the SDK gives nothing structured. It reads whole words, never substrings: '429' inside «requested 142900
 * tokens» and 'balance' inside «load balancer» are not what they look like. A status is a number standing where
 * providers put one: first («429 Too Many Requests», «503: {…}») or right after http, status or code («HTTP 429»,
 * «got status: 503», «"code":429»). Only the kind leaves this module; the raw text can carry credentials and URLs and
 * is never stored. The SDK's own isRetryableAssistantError matches statuses as substrings and is not exported by the
 * package Lab depends on, so it is not used.
 */

/** Lower-case runs of letters or digits; a lower-case letter followed by an upper-case one starts a new word (RateLimitError). */
function errorWords(text: string): string[] {
  const words: string[] = [];
  let word = '', lower = false;
  for (const char of text) {
    const letter = char.toLowerCase() !== char.toUpperCase();
    if (!letter && (char < '0' || char > '9')) {
      if (word) words.push(word);
      word = ''; lower = false;
      continue;
    }
    const upper = letter && char === char.toUpperCase();
    if (word && upper && lower) { words.push(word); word = ''; }
    word += char.toLowerCase();
    lower = letter && !upper;
  }
  if (word) words.push(word);
  return words;
}

const contains = (words: readonly string[], phrase: readonly string[]): boolean =>
  words.some((_, start) => phrase.every((part, offset) => words[start + offset] === part));

/** Quota and billing exhaustion first: OpenAI reports an exhausted quota with the rate limit's status 429, and waiting never helps. */
const CREDIT: readonly (readonly string[])[] = [['credit'], ['credits'], ['billing'], ['insufficient', 'quota'], ['insufficient', 'balance'],
  ['insufficient', 'funds'], ['payment', 'required']];
/** The other kinds by their words, in this order, when the status did not decide. */
const PHRASES: readonly (readonly [ProviderFailureKind, readonly (readonly string[])[]])[] = [
  ['rate limit', [['rate', 'limit'], ['rate', 'limited'], ['ratelimit'], ['too', 'many', 'requests'], ['throttled'], ['throttling'], ['resource', 'exhausted']]],
  ['access denied', [['unauthorized'], ['unauthenticated'], ['forbidden'], ['permission', 'denied'], ['access', 'denied'], ['invalid', 'api', 'key'],
    ['incorrect', 'api', 'key'], ['authentication']]],
  ['context limit', [['context', 'length'], ['context', 'window'], ['maximum', 'context'], ['contextlength'], ['too', 'many', 'tokens'],
    ['prompt', 'is', 'too', 'long'], ['request', 'too', 'large']]],
  ['overloaded', [['overloaded'], ['service', 'unavailable'], ['bad', 'gateway'], ['server', 'error'], ['temporarily', 'unavailable']]],
  ['timeout', [['timeout'], ['timed', 'out'], ['etimedout']]],
  ['connection failure', [['fetch', 'failed'], ['connection'], ['socket'], ['network'], ['econnrefused'], ['econnreset'], ['enotfound'],
    ['eai', 'again'], ['getaddrinfo']]],
];

const httpStatus = (word: string | undefined): number | undefined => {
  if (word?.length !== 3 || [...word].some(char => char < '0' || char > '9')) return undefined;
  const value = Number(word);
  return value >= 400 && value <= 599 ? value : undefined;
};
function statusIn(words: readonly string[]): number | undefined {
  const first = httpStatus(words[0]);
  if (first !== undefined) return first;
  for (let i = 1; i < words.length; i++) {
    if (['http', 'status', 'code'].includes(words[i - 1]!)) {
      const value = httpStatus(words[i]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}
function kindOfStatus(status: number): ProviderFailureKind | undefined {
  if (status === 429) return 'rate limit';
  if (status === 402) return 'insufficient credit';
  if (status === 401 || status === 403) return 'access denied';
  if (status === 413) return 'context limit';
  if (status === 408) return 'timeout';
  return status >= 500 ? 'overloaded' : undefined;
}
/**
 * The kind of a status whose own words did not name one: a request refused as it was made (400, 422 — its words may still
 * say the context was too long, which then decides), a model or an endpoint the provider does not have (404).
 */
function kindAfterWords(status: number | undefined): ProviderFailureKind | undefined {
  if (status === 400 || status === 422) return 'bad request';
  return status === 404 ? 'unavailable' : undefined;
}

/** What a request showed of itself besides its reply: whether its answer began, and a refused response the adapter reported. */
export interface Observed { started: boolean; status?: number; retryAfterMs?: number }

/**
 * The failure of a reply that did not stop normally. The stream protocol is the structured part: an answer that began
 * emits `start` first, a request refused before generation never does. The status comes from the adapter's
 * `fetch` or its `onResponse` where they report a refused response, else from the error text; the kind, from the status,
 * else the words.
 */
export function providerFailureOf(reply: ModelReply, observed: Observed): ProviderFailure {
  if (reply.stopReason === 'length') return new ProviderFailure('length', 'Pi provider response incomplete: length');
  if (reply.stopReason !== 'error' && reply.stopReason !== 'aborted') {
    // A whole reply of the wrong shape (a tool call to a request without tools) was billed; a pending one is not over.
    return new ProviderFailure('incomplete', `Pi provider response incomplete: ${reply.stopReason}`, { delivery: reply.stopReason === 'toolUse' ? 'answered' : 'cut' });
  }
  const words = errorWords(reply.errorMessage ?? '');
  const status = observed.status ?? statusIn(words);
  const kind = CREDIT.some(phrase => contains(words, phrase)) ? 'insufficient credit'
    : (status === undefined ? undefined : kindOfStatus(status))
      ?? PHRASES.find(([candidate, phrases]) => (candidate !== 'connection failure' || status === undefined) && phrases.some(phrase => contains(words, phrase)))?.[0]
      ?? kindAfterWords(status) ?? 'incomplete';
  const began = observed.started || (reply.usage?.output ?? 0) > 0;
  // No stream event does not prove non-delivery: a reset can happen after the provider accepted the request.
  const uncertain = kind === 'timeout' || kind === 'connection failure' || kind === 'incomplete' && status === undefined;
  const delivery: ProviderDelivery = began || uncertain ? 'cut' : 'refused';
  return new ProviderFailure(kind, `Pi provider response incomplete: ${kind === 'incomplete' ? reply.stopReason : kind}`,
    { delivery, ...(status === undefined ? {} : { status }) });
}

/** No credentials for the model's provider: the request is refused before it leaves, and only this says «check access». */
const unavailable = (model: Model) => new ProviderFailure('unavailable',
  `Запрос к ${model.provider}/${model.id} не отправлен: Pi не нашёл действующего ключа или входа для этого провайдера. Проверьте доступ к модели.`, { delivery: 'refused' });

const counted = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
/** Tokens as the provider reported them; the cost only when it reported one for a priced model, otherwise unknown, never free. */
function usageOf(reply: ModelReply | undefined, model: Model): Omit<Usage, 'calls'> {
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

/** A wait that ends early, with the signal's reason, when the signal aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
}

/**
 * Requests in flight to one provider at once, over every role — the builder, the card reviewer, the judge on dialogues and
 * on logs, the simulated customer — and every operation of this process. Without it one run could send 128 judge votes at
 * once (16 dialogues × 8 votes) and meet the provider's rate limit with most of them. 16 keeps one request in flight for
 * each dialogue of the largest run pool (lab/run.ts MAX_PARALLEL); the rest wait here, in order, not at the provider.
 */
export const PROVIDER_CONCURRENCY = 16;
/**
 * How many times a request refused for a transient cause (a rate limit or an overload) is sent again. A refusal before
 * any answer began is not billed — true of OpenRouter and the providers behind it as far as Lab knows, which is why the
 * budget is charged once per call, never per repeat — so a repeat spends nothing; it only waits. Every repeat is still a
 * request: usage.attempts counts them apart from the calls. A provider that keeps refusing fails the step after the
 * waits below, never holds it.
 */
export const REFUSED_RETRIES = 4;
/**
 * The waits Lab chooses itself when the provider named none, doubling from the first, half fixed and half random so that
 * requests refused together do not come back together. An overload clears in seconds: 0.5–1, 1–2, 2–4, 4–8 s, 7.5–15 s in
 * all. A rate limit is counted per minute by most providers, so its waits reach into the next minute: 2–4, 4–8, 8–16,
 * 16–32 s, 30–60 s in all.
 */
const RETRY_BASE_MS: Readonly<Record<'rate limit' | 'other', number>> = { 'rate limit': 4_000, other: 1_000 };
/** A provider's own retry-after is honoured up to this; a longer one is not waited out, and the request stays refused. */
const RETRY_AFTER_MAX_MS = 60_000;

/** The wait before retry number `retry + 1`, or undefined when the provider asked for longer than Lab waits. */
function retryDelay(kind: ProviderFailureKind, retry: number, retryAfterMs: number | undefined): number | undefined {
  if (retryAfterMs !== undefined) return retryAfterMs <= RETRY_AFTER_MAX_MS ? retryAfterMs : undefined;
  const ceiling = RETRY_BASE_MS[kind === 'rate limit' ? 'rate limit' : 'other'] * 2 ** retry;
  return ceiling / 2 + Math.random() * ceiling / 2;
}

/** The retry-after a refused response carried, in milliseconds: retry-after-ms, or retry-after in seconds or as a date. */
function retryAfterOf(headers: Record<string, string>): number | undefined {
  const header = (name: string) => Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  const ms = Number.parseFloat(header('retry-after-ms') ?? '');
  if (Number.isFinite(ms)) return Math.max(0, ms);
  const after = header('retry-after');
  if (after === undefined) return undefined;
  const seconds = Number.parseFloat(after);
  const date = Date.parse(after);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** The places of one provider: a request takes one before it is charged and gives it back when it has its outcome. */
class ProviderGate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly size: number) {}

  /** Resolves with the release of a place once one is free, in arrival order; a signal that aborts first leaves the line. */
  async enter(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active < this.size) this.active++;
    else {
      await new Promise<void>((resolve, reject) => {
        const leave = () => {
          const index = this.waiting.indexOf(admit);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(signal.reason);
        };
        const admit = () => { signal.removeEventListener('abort', leave); resolve(); };
        this.waiting.push(admit);
        signal.addEventListener('abort', leave, { once: true });
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // The place passes straight to the next in line, so a newcomer never overtakes it.
      const next = this.waiting.shift();
      if (next) next(); else this.active--;
    };
  }
}
const gates = new Map<string, ProviderGate>();
const gateOf = (provider: string): ProviderGate => {
  let gate = gates.get(provider);
  if (!gate) { gate = new ProviderGate(PROVIDER_CONCURRENCY); gates.set(provider, gate); }
  return gate;
};

type Sent = { ok: true; text: string; message: ChatMessage } | { ok: false; failure: ProviderFailure; retryAfterMs?: number };

/** Reads a reply to its end, noting whether its answer began. */
async function read(stream: Stream, observed: Observed): Promise<ModelReply> {
  for await (const event of stream) if (event.type === 'start') observed.started = true;
  return stream.result();
}

/** A defect goes to the operation's journal; a call made outside any operation leaves it on the error output instead. */
function reportDefect(ctx: CallContext, defect: ModelCallDefect): void {
  if (ctx.onDefect) { ctx.onDefect(defect); return; }
  const cause = defect.cause;
  process.stderr.write(`Agent Lab: внутренняя ошибка при вызове модели ${defect.model}: ${cause instanceof Error ? cause.stack ?? `${cause.name}: ${cause.message}` : String(cause)}\n`);
}

/** Notes the status and the retry-after of a refused response; an answered one says nothing about a failure. */
function note(observed: Observed, status: number, headers: Record<string, string>): void {
  if (status < 400) return;
  observed.status = status;
  const after = retryAfterOf(headers);
  if (after !== undefined) observed.retryAfterMs = after;
}

/*
 * pi-ai reports a response to `onResponse` only once its SDK's request resolved, which a refused one never does: its
 * adapters call it after a 2xx. A 429's retry-after therefore never reached Lab that way. The adapters below take the
 * `fetch` of the request options (a documented option of pi-ai's ProviderRequestOptions, which they hand their SDK
 * client or call themselves); through it Lab reads the status and the retry-after of a refused response on its way to
 * the SDK, and changes nothing else. Google's adapters refuse a custom fetch and Bedrock's does not use one: there a
 * refusal is read from the reply's error text, and Lab waits by its own schedule. The gateway (giga) reports refusals
 * to `onResponse` itself. Review this list when pi-ai is upgraded.
 */
const OBSERVED_FETCH_APIS: ReadonlySet<string> = new Set(['openai-completions', 'openai-responses', 'azure-openai-responses', 'anthropic-messages', 'mistral-conversations']);
const observingFetch = (observed: Observed): typeof globalThis.fetch => async (input, init) => {
  const response = await globalThis.fetch(input, init);
  note(observed, response.status, Object.fromEntries(response.headers));
  return response;
};

/** One request under its own deadline; its usage is recorded exactly once, also when it fails. */
async function send(runtime: ModelRuntime, model: Model, request: ModelRequest, ctx: CallContext, onIncomplete?: (text: string) => void): Promise<Sent> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new ProviderFailure('deadline', 'Pi request deadline exceeded')), ctx.timeoutMs);
  const signal = AbortSignal.any([ctx.signal, deadline.signal]);
  const observed: Observed = { started: false };
  let reply: ModelReply | undefined;
  let defect: ModelCallDefect | undefined;
  try {
    const stream = runtime.streamSimple(model, { systemPrompt: request.system, messages: request.messages }, {
      signal, timeoutMs: ctx.timeoutMs, maxRetries: 0, transport: 'sse',
      maxTokens: model.maxTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.reasoning ? { reasoning: 'medium' as const } : {}),
      ...(request.responseFormat ? { onPayload: (payload: unknown) => ({ ...(payload as Record<string, unknown>), response_format: request.responseFormat }) } : {}),
      ...(OBSERVED_FETCH_APIS.has(model.api) ? { fetch: observingFetch(observed) } : {}),
      onResponse: response => note(observed, response.status, response.headers),
    });
    reply = await untilAborted(read(stream, observed), signal);
  } catch (error) {
    // Every provider failure reaches the stream protocol as a reply; only an abort or a defect outside it throws.
    if (!signal.aborted) defect = new ModelCallDefect(`${model.provider}/${model.id}`, error);
  } finally { clearTimeout(timer); }
  if (signal.aborted || !reply) {
    ctx.addUsage(usageOf(reply, model));
    if (signal.aborted) throw signal.reason;
    defect ??= new ModelCallDefect(`${model.provider}/${model.id}`, new Error('The SDK returned no reply'));
    reportDefect(ctx, defect);
    throw defect;
  }
  const text = reply.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
  const failure = reply.stopReason !== 'stop' ? providerFailureOf(reply, observed)
    : text.trim() ? undefined : new ProviderFailure('empty', 'Модель вернула пустой ответ.');
  const usage = usageOf(reply, model);
  // A request refused before any answer generated nothing: its cost is known, and it is zero.
  if (failure?.delivery === 'refused' && usage.inputTokens === 0 && usage.outputTokens === 0) usage.costUsd = 0;
  ctx.addUsage(usage);
  if (!failure) return { ok: true, text, message: reply };
  if (reply.stopReason !== 'stop' && text.trim()) onIncomplete?.(text);
  return { ok: false, failure, ...(observed.retryAfterMs === undefined ? {} : { retryAfterMs: observed.retryAfterMs }) };
}

/**
 * Sends one request and returns the model's text with the reply message (a repair continues from it).
 * The request waits for a place among its provider's requests first; the call is charged against the budget once, when
 * it gets one, and a request the provider refused before any answer is sent again up to REFUSED_RETRIES times without a
 * second charge. Usage is recorded for every request sent; the partial text of an incomplete reply goes to
 * `onIncomplete` as evidence and is never returned as an answer.
 */
export async function callModel(runtime: ModelRuntime, model: Model, request: ModelRequest, ctx: CallContext,
  onIncomplete?: (text: string) => void): Promise<{ text: string; message: ChatMessage }> {
  ctx.signal.throwIfAborted();
  if (request.maxRequestBytes && Buffer.byteLength(JSON.stringify({ systemPrompt: request.system, messages: request.messages }), 'utf8') > request.maxRequestBytes) {
    throw new Error('Запрос превышает безопасный контекст модели; полная хронология сохранена для меньшего пакета.');
  }
  if (!await authorized(runtime, model, ctx.signal)) throw unavailable(model);
  const release = await gateOf(model.provider).enter(ctx.signal);
  try {
    ctx.beforeCall();
    for (let retry = 0; ; retry++) {
      const sent = await send(runtime, model, request, ctx, onIncomplete);
      if (sent.ok) return { text: sent.text, message: sent.message };
      const { failure } = sent;
      const wait = failure.delivery === 'refused' && failure.retryable && retry < REFUSED_RETRIES ? retryDelay(failure.kind, retry, sent.retryAfterMs) : undefined;
      if (wait === undefined) throw failure;
      // The place is kept while waiting: a provider that refuses gets fewer requests, not more.
      await pause(wait, ctx.signal);
    }
  } finally { release(); }
}
