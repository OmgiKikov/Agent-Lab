import type { ModelRuntime, ProviderConfig } from '@earendil-works/pi-coding-agent';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildChatRequest, normalizeResponseFormat, parseCatalog, parseChatResponse, type GigaAssistantMessage, type GigaContext, type GigaModel, type GigaOptions, type GigaResponse,
} from './giga-protocol.js';
import {
  CLIENT_CERTIFICATE_ALERT, clientCertificateAlert, createGigaTransport, gatewayCertificateProblem, gatewayEnvironment, GigaTransportError,
  keyMatchesCertificate, readGigaConfig, unusableFile, type Environment, type GatewayCertificateProblem, type GigaConfig, type GigaResponseText, type GigaTransport,
} from './giga-transport.js';

/*
 * The personal model gateway as the Pi provider giga. A connection reads the gateway's catalog with the owner's files
 * and yields the provider with its chat models, or a GatewayFailure: a kind with a Node error code, a TLS alert or an
 * HTTP status, never a path, a response body or a certificate, so it is shown and printed as it is.
 *
 *   Pi session start ─────────► reconnectGateway ──┐
 *   /agent-lab gateway ───────► keepConnection ────┼──► the process's connection, one per configuration:
 *   a runtime, `agent-lab status` ► processGateway ─┘    made on first use, then reused, so the gateway is asked once
 */

// The gateway reports neither a context window nor an answer limit nor prices. maxTokens is not below the judge
// protocol's 16384, or a verdict would be cut silently.
const MAX_TOKENS = 32768;
const CONTEXT_WINDOW = 128000;
// The catalog is a short listing: unlike a chat answer, it has no reason to take long.
const CATALOG_TIMEOUT_MS = 10000;

/** Why the gateway did not connect. */
export type GatewayFailure =
  | { kind: 'not configured' | 'bad configuration' | 'timeout' | 'aborted' | 'too large' | 'bad JSON' | 'empty catalog' | 'request failed' }
  /** A file of the owner's that TLS cannot take. */
  | { kind: 'unusable file'; file: 'certificate' | 'key' | 'ca' }
  /** The key is not the certificate's pair, so the gateway received no certificate. */
  | { kind: 'key mismatch' }
  /** Lab could not verify the gateway's own certificate: the only failure after which skipping that check is offered. */
  | { kind: 'gateway certificate'; code: string; problem: GatewayCertificateProblem }
  /** The gateway refused the owner's certificate with this TLS alert. */
  | { kind: 'client certificate'; code: string; alert: number }
  | { kind: 'connection'; code: string }
  | { kind: 'http'; status: number };

export type GatewayConnection = { provider: ProviderConfig; models: string[] } | { failure: GatewayFailure };

/** A failure as the short label of a diagnostic line: `connection <code>`, `HTTP <status>` or its kind. */
export function failureLabel(failure: GatewayFailure): string {
  switch (failure.kind) {
    case 'gateway certificate': case 'client certificate': case 'connection': return `connection ${failure.code}`;
    case 'http': return `HTTP ${failure.status}`;
    case 'unusable file': return `unusable ${failure.file}`;
    default: return failure.kind;
  }
}

const GATEWAY_CERTIFICATE_TEXT: Record<GatewayCertificateProblem, string> = {
  chain: 'не удалось проверить сертификат самого шлюза. Укажите цепочку CA или, осознанно, отключите проверку.',
  dates: 'сертификат самого шлюза просрочен или ещё не действует. Проверьте дату и время на компьютере или, осознанно, отключите проверку.',
  name: 'сертификат самого шлюза выписан на другой адрес. Проверьте адрес шлюза или, осознанно, отключите проверку.',
};
const UNUSABLE_FILE_TEXT = {
  certificate: 'файл вашего сертификата не читается как сертификат: нужен формат PEM.',
  key: 'файл вашего ключа не читается как ключ: нужен формат PEM, без пароля.',
  ca: 'файл цепочки CA не читается как сертификат: нужен формат PEM.',
} as const;

function clientCertificateText(alert: number): string {
  switch (alert) {
    case CLIENT_CERTIFICATE_ALERT.certificateExpired: return 'шлюз не принял ваш сертификат: срок его действия истёк. Нужен новый сертификат.';
    case CLIENT_CERTIFICATE_ALERT.certificateRevoked: return 'шлюз не принял ваш сертификат: он отозван. Нужен новый сертификат.';
    case CLIENT_CERTIFICATE_ALERT.unknownCa:
      return 'шлюз не принял ваш сертификат: его выдал удостоверяющий центр (CA), которому шлюз не доверяет. Нужен сертификат, выпущенный для этого шлюза.';
    case CLIENT_CERTIFICATE_ALERT.accessDenied: return 'шлюз узнал ваш сертификат, но доступа у него нет.';
    case CLIENT_CERTIFICATE_ALERT.noCertificate: case CLIENT_CERTIFICATE_ALERT.certificateRequired:
      return 'шлюз не получил ваш сертификат. Проверьте, что указан ваш сертификат, а не цепочка CA.';
    default: return 'шлюз не принял ваш сертификат. Проверьте, что это сертификат, выпущенный для этого шлюза.';
  }
}

const NOT_FOUND = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const NOT_ANSWERING = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT']);
/** The TLS connection itself failed, with no word on whose certificate: not HTTPS at that address, or no agreement on how. */
const NO_TLS = new Set(['EPROTO', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_PACKET_LENGTH_TOO_LONG', 'ERR_SSL_UNSUPPORTED_PROTOCOL',
  'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION', 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE', 'ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE']);

function connectionText(code: string): string {
  if (NOT_FOUND.has(code)) return 'адрес шлюза не найден в сети. Проверьте адрес и VPN.';
  if (NOT_ANSWERING.has(code)) return 'шлюз не отвечает. Проверьте VPN и адрес.';
  if (NO_TLS.has(code)) return 'защищённое соединение со шлюзом не установилось. Проверьте, что адрес ведёт на сам шлюз по https, а сертификат и ключ выпущены для него.';
  return `подключиться к шлюзу не удалось (${code}).`;
}

function httpText(status: number): string {
  if (status === 401 || status === 403) return 'шлюз не принял сертификат: у него нет доступа.';
  if (status === 404) return 'по этому адресу нет каталога моделей. Нужен корень шлюза, без /api.';
  return `шлюз ответил ошибкой (HTTP ${status}).`;
}

/** What the owner fixes, in the owner's words. */
export function gatewayFailureText(failure: GatewayFailure): string {
  switch (failure.kind) {
    case 'not configured': return 'шлюз моделей не настроен.';
    case 'bad configuration': return 'не удалось прочитать сертификат или ключ. Проверьте пути.';
    case 'unusable file': return UNUSABLE_FILE_TEXT[failure.file];
    case 'key mismatch': return 'сертификат и ключ не подходят друг к другу: укажите ваш сертификат и ключ из одной пары.';
    case 'gateway certificate': return GATEWAY_CERTIFICATE_TEXT[failure.problem];
    case 'client certificate': return clientCertificateText(failure.alert);
    case 'connection': return connectionText(failure.code);
    case 'timeout': return 'шлюз не отвечает. Проверьте VPN и адрес.';
    case 'aborted': return 'подключение к шлюзу прервано.';
    case 'too large': return 'по этому адресу пришёл слишком большой ответ: это не каталог моделей. Проверьте адрес шлюза.';
    case 'bad JSON': return 'по этому адресу ответил не шлюз моделей: ответ не читается как каталог. Нужен корень шлюза.';
    case 'empty catalog': return 'шлюз ответил, но моделей для разговора с этим сертификатом нет.';
    case 'request failed': return 'шлюз не ответил на запрос каталога.';
    case 'http': return httpText(failure.status);
  }
}

/** Why a run that uses a giga model cannot start: the gateway's own reason, not «model not found». */
export function gatewayUnavailableText(failure: GatewayFailure): string {
  return failure.kind === 'not configured'
    ? 'Модели giga недоступны: шлюз моделей не настроен. В Pi его подключает /agent-lab gateway.'
    : `Модели giga недоступны — шлюз моделей не подключился: ${gatewayFailureText(failure)} В Pi его подключает заново /agent-lab gateway.`;
}

/**
 * A failed catalog request as a GatewayFailure: what the transport threw and, where the gateway refused a certificate,
 * which of the owner's files is at fault.
 */
function refusal(error: unknown, config: GigaConfig | undefined): GatewayFailure {
  if (error instanceof GigaTransportError) return { kind: error.kind };
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (!code) return { kind: 'request failed' };
  const problem = gatewayCertificateProblem(code);
  // A CA file TLS ignored is why the chain did not verify: the owner fixes the file, nothing is offered to skip.
  if (problem) return config && unusableFile(config) === 'ca' ? { kind: 'unusable file', file: 'ca' } : { kind: 'gateway certificate', code, problem };
  const alert = clientCertificateAlert(error);
  if (alert !== undefined) {
    const unsent = alert === CLIENT_CERTIFICATE_ALERT.noCertificate || alert === CLIENT_CERTIFICATE_ALERT.certificateRequired;
    return unsent && config && !keyMatchesCertificate(config) ? { kind: 'key mismatch' } : { kind: 'client certificate', code, alert };
  }
  // A certificate or a key TLS cannot take fails the request before it leaves.
  const file = config ? unusableFile(config) : undefined;
  return file === 'certificate' || file === 'key' ? { kind: 'unusable file', file } : { kind: 'connection', code };
}

/** The one diagnostic line of a refused catalog: its label only, never a response body, a path or a certificate. */
function reportCatalogFailure(failure: GatewayFailure): void {
  process.stderr.write(`giga: каталог моделей недоступен (${failureLabel(failure)})\n`);
}

/**
 * What a chat request that got no answer says of itself: the transport's own kind or the network's code, never a path, a
 * response body or a certificate. The words are the ones src/llm/model-call.ts reads a provider's failure by («timeout»,
 * «connection»), so a timeout or a reset reads as one, and not as missing access.
 */
function transportFailureText(error: unknown): string {
  if (error instanceof GigaTransportError) return error.kind === 'timeout' ? 'Giga gateway request failed: timeout' : 'Giga gateway response is too large to be an answer';
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code ? `Giga gateway connection failed: ${code}` : 'Giga gateway request failed';
}

/**
 * Statuses with which the gateway refuses the request as it was asked (a parameter or a tool description the model
 * does not accept) rather than fails to serve it: repeating the same request cannot succeed.
 */
const REJECTED_STATUSES: ReadonlySet<number> = new Set([400, 422]);

/** A chat request the gateway answered with an error status, in the words a reply carries: the status, never the response body. */
function refusalText(status: number): string {
  return REJECTED_STATUSES.has(status)
    ? `Giga gateway rejected the request with HTTP ${status}: it does not accept a parameter or a tool description of this request`
    : `Giga gateway request failed with HTTP ${status}`;
}

export async function createGigaProvider(
  env?: Environment,
  injectedTransport?: GigaTransport,
  signal?: AbortSignal,
): Promise<ProviderConfig | undefined> {
  const connection = await connectGateway(env, injectedTransport, signal);
  if ('provider' in connection) return connection.provider;
  if (connection.failure.kind !== 'not configured') reportCatalogFailure(connection.failure);
  return undefined;
}

/** Connects to the gateway: reads its catalog with the owner's files, under its own short deadline. */
export async function connectGateway(
  env?: Environment,
  injectedTransport?: GigaTransport,
  signal?: AbortSignal,
): Promise<GatewayConnection> {
  let config: GigaConfig | undefined;
  try {
    // An unreadable path or a damaged personal file must not bring down runs on other providers.
    config = injectedTransport ? undefined : readGigaConfig(env ?? gatewayEnvironment());
  } catch { return { failure: { kind: 'bad configuration' } }; }
  if (!injectedTransport && !config) return { failure: { kind: 'not configured' } };
  const transport = injectedTransport ?? createGigaTransport(config!);

  let catalog: { status: number; text: string };
  try { catalog = await transport('/v1/models', undefined, { signal, timeoutMs: CATALOG_TIMEOUT_MS }); }
  catch (error) { return { failure: refusal(error, config) }; }
  if (catalog.status !== 200) return { failure: { kind: 'http', status: catalog.status } };

  let parsedCatalog: unknown;
  try { parsedCatalog = JSON.parse(catalog.text); }
  catch { return { failure: { kind: 'bad JSON' } }; }

  const ids = parseCatalog(parsedCatalog);
  if (!ids.length) return { failure: { kind: 'empty catalog' } };
  return { provider: gatewayProvider(config, transport, ids), models: ids };
}

function gatewayProvider(config: GigaConfig | undefined, transport: GigaTransport, ids: string[]): ProviderConfig {
  return {
    name: 'Internal model gateway',
    baseUrl: `${config?.baseUrl ?? ''}/v2`,
    // The transport authenticates (the client certificate). The value only makes Pi count the provider as configured;
    // no header is sent.
    apiKey: 'mtls-client-certificate',
    authHeader: false,
    api: 'giga-v2',
    models: ids.map(id => ({
      id, name: id, reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: CONTEXT_WINDOW, maxTokens: MAX_TOKENS,
    })),
    streamSimple(model, context, options) {
      const finished = (async (): Promise<GigaAssistantMessage> => {
        const base = buildChatRequest(model.id, context, options ?? {}) as unknown as Record<string, unknown>;
        const hooked = (await options?.onPayload?.(base, model)) ?? base;
        return exchange(transport, model, context, options ?? {}, normalizeResponseFormat(hooked as Record<string, unknown>));
      })();
      // AssistantMessageEventStream is a pi-ai class with private fields that cannot be imported here directly; the
      // object below implements its public contract (result and an async iterator), hence the cast through unknown. As in
      // pi-ai's own providers, a request that got no answer never emits `start`: nothing of an answer began.
      return {
        result: () => finished,
        async *[Symbol.asyncIterator]() {
          const message = await finished;
          if (message.stopReason === 'error' || message.stopReason === 'aborted') { yield { type: 'error', reason: message.stopReason, error: message }; return; }
          yield { type: 'start', partial: message };
          yield { type: 'done', reason: message.stopReason, message };
        },
      } as unknown as ReturnType<NonNullable<ProviderConfig['streamSimple']>>;
    },
  };
}

/** A reply that carries no answer, the way pi-ai's providers report one: no content, nothing used, the reason in its text. */
function failed(model: GigaModel, stopReason: 'error' | 'aborted', errorMessage: string): GigaAssistantMessage {
  return { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, errorMessage, timestamp: Date.now() };
}

/**
 * The gateway's own words on a refused request, kept on this computer only (0600, beside the gateway's settings): a reply
 * never carries them, since they may echo the prompt, yet without them a 422 cannot be told from another. The last one
 * replaces the one before. Undefined when it could not be written: the refusal is reported all the same.
 */
async function keepRefusal(status: number, text: string): Promise<string | undefined> {
  const directory = join(homedir(), '.agent-lab');
  const file = join(directory, 'giga-refusal.json');
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ status, at: new Date().toISOString(), body: text.slice(0, 20_000) }, null, 2) + '\n', { mode: 0o600 });
    return file;
  } catch { return undefined; }
}

/**
 * One chat exchange, reported the way the stream protocol reports every provider's: an answer, or a reply with stopReason
 * `error` — never a throw, which the caller counts as Lab's own defect. A refused request tells its status and headers
 * through `onResponse`, as pi-ai's adapters do for theirs, so a 429 or a 5xx meets the same retry policy (and the
 * gateway's retry-after) as OpenRouter's, and a 401 or 403 alone reads as missing access. The response body never enters
 * a reply's text: it may echo the prompt or be a proxy's page.
 */
async function exchange(transport: GigaTransport, model: GigaModel, context: GigaContext, options: GigaOptions, payload: Record<string, unknown>): Promise<GigaAssistantMessage> {
  let response: GigaResponseText;
  // The caller's deadline bounds the whole exchange, since the gateway does not stream; its signal stops it sooner.
  try { response = await transport('/v2/chat/completions', payload, { signal: options.signal, timeoutMs: options.timeoutMs }); }
  catch (error) {
    if (options.signal?.aborted || error instanceof GigaTransportError && error.kind === 'aborted') return failed(model, 'aborted', 'Giga request aborted');
    return failed(model, 'error', transportFailureText(error));
  }
  if (response.status !== 200) {
    await options.onResponse?.({ status: response.status, headers: response.headers ?? {} }, model);
    const kept = REJECTED_STATUSES.has(response.status) ? await keepRefusal(response.status, response.text) : undefined;
    return failed(model, 'error', `${refusalText(response.status)}${kept ? `; the gateway's own words are in ${kept}` : ''}`);
  }
  let body: GigaResponse;
  try { body = JSON.parse(response.text) as GigaResponse; }
  catch { return failed(model, 'error', 'Giga gateway returned a response that is not JSON'); }
  // An answer Lab cannot read — an unrecognized finish reason (a content filter's block), a body of another shape — is the
  // gateway's, not a defect of Lab: it is reported like a provider's broken answer.
  try { return parseChatResponse(model, body, context.tools); }
  catch (error) { return failed(model, 'error', error instanceof Error ? `Giga gateway answer unreadable: ${error.message}` : 'Giga gateway answer unreadable'); }
}

export const GIGA_PROVIDER_ID = 'giga';

/** The internal gateway cannot be declared in a declarative models.json: it needs a client certificate. */
export async function registerGigaProvider(
  runtime: ModelRuntime,
  env?: Environment,
  injectedTransport?: GigaTransport,
  signal?: AbortSignal,
): Promise<void> {
  const provider = await createGigaProvider(env, injectedTransport, signal);
  if (provider) runtime.registerProvider(GIGA_PROVIDER_ID, provider);
}

/** The variables that decide which gateway a process reaches, and with which files. */
const CONNECTION_VARIABLES = ['AGENT_LAB_GATEWAY_URL', 'AGENT_LAB_GATEWAY_CERT_PATH', 'AGENT_LAB_GATEWAY_KEY_PATH', 'AGENT_LAB_GATEWAY_CA_PATH',
  'AGENT_LAB_GATEWAY_INSECURE'] as const;
const connections = new Map<string, Promise<GatewayConnection>>();
const configuration = (env: Environment): string => JSON.stringify(CONNECTION_VARIABLES.map(name => env[name] ?? ''));

/**
 * Connects now and makes the result, pending or settled, this process's connection for `env`: the Pi session connects
 * this way at its start, and a runtime created meanwhile waits for the same connection instead of opening its own.
 */
export function reconnectGateway(env: Environment, connect: typeof connectGateway = connectGateway): Promise<GatewayConnection> {
  const connection = connect(env);
  connections.set(configuration(env), connection);
  return connection;
}

/** A connection the owner made by hand (`/agent-lab gateway`) becomes this process's connection for its configuration. */
export function keepConnection(env: Environment, connection: GatewayConnection): void {
  connections.set(configuration(env), Promise.resolve(connection));
}

/** The owner switched the gateway off: nothing the process remembered connects it again. */
export function forgetConnections(): void { connections.clear(); }

/** The pending value, or the signal's reason once it aborts first. */
async function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let stop = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { stop = () => reject(signal.reason); });
  signal.addEventListener('abort', stop, { once: true });
  try { return await Promise.race([pending, stopped]); } finally { signal.removeEventListener('abort', stop); }
}

/**
 * This process's connection to the configured gateway: the one already made, else made now and kept. Lab asks the
 * gateway once per process, not once per operation; a caller's signal ends only its own wait.
 */
export async function processGateway(signal?: AbortSignal): Promise<GatewayConnection> {
  let env: Environment;
  try { env = gatewayEnvironment(); } catch { return { failure: { kind: 'bad configuration' } }; }
  const key = configuration(env);
  let connection = connections.get(key);
  if (!connection) {
    connection = connectGateway(env);
    connections.set(key, connection);
  }
  if (!signal) return connection;
  try { return await untilAborted(connection, signal); }
  catch { return { failure: { kind: signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? 'timeout' : 'aborted' } }; }
}
