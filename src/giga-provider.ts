import type { ModelRuntime, ProviderConfig } from '@earendil-works/pi-coding-agent';
import { buildChatRequest, normalizeResponseFormat, parseCatalog, parseChatResponse, type GigaAssistantMessage, type GigaResponse } from './giga-protocol.js';
import { createGigaTransport, gatewayEnvironment, readGigaConfig, type GigaConfig, type GigaTransport } from './giga-transport.js';

// Шлюз не сообщает ни окна контекста, ни лимита ответа, ни цен.
// maxTokens не ниже протокола судьи (16384), иначе вердикт молча обрежется.
const MAX_TOKENS = 32768;
const CONTEXT_WINDOW = 128000;
// Список моделей — не более чем справочник; в отличие от чата, ждать его 120 секунд незачем.
const CATALOG_TIMEOUT_MS = 10000;

/** Единственная точка диагностики отказа каталога: только категория, без тела ответа, путей и содержимого сертификатов. */
function reportCatalogFailure(category: string): void {
  process.stderr.write(`giga: каталог моделей недоступен (${category})\n`);
}

/*
 * src/pi.ts намеренно заменяет ошибку провайдера общим текстом «Проверьте доступ, права на
 * модель и доступность провайдера», потому что сырой текст может нести заголовки и секреты.
 * Из-за этого таймаут и 500 выглядят как отозванный доступ. Категорию пишем сами: только
 * статус или код ошибки, без тела ответа.
 */
function reportRequestFailure(modelId: string, category: string): void {
  process.stderr.write(`giga: запрос к модели ${modelId} не прошёл (${category})\n`);
}

function failureCategory(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code) return `connection ${code}`;
  const message = error instanceof Error ? error.message : '';
  if (/timed out/i.test(message)) return 'timeout';
  if (/aborted/i.test(message)) return 'aborted';
  return 'request failed';
}

export type GatewayConnection = { provider: ProviderConfig; models: string[] } | { failure: string };

export async function createGigaProvider(
  env?: Record<string, string | undefined>,
  injectedTransport?: GigaTransport,
  signal?: AbortSignal,
): Promise<ProviderConfig | undefined> {
  const connection = await connectGateway(env, injectedTransport, signal);
  if ('provider' in connection) return connection.provider;
  if (connection.failure !== 'not configured') reportCatalogFailure(connection.failure);
  return undefined;
}

/**
 * Подключение к шлюзу с причиной отказа. Причина — только категория (код ошибки Node, HTTP-статус),
 * без тела ответа, путей и содержимого сертификатов: она показывается владельцу в разговоре.
 */
export async function connectGateway(
  env?: Record<string, string | undefined>,
  injectedTransport?: GigaTransport,
  signal?: AbortSignal,
): Promise<GatewayConnection> {
  let config: GigaConfig | undefined;
  try {
    // Нечитаемый путь или повреждённый личный файл не должны ронять прогоны на других провайдерах.
    config = injectedTransport ? undefined : readGigaConfig(env ?? gatewayEnvironment());
  } catch { return { failure: 'bad configuration' }; }
  if (!injectedTransport && !config) return { failure: 'not configured' };
  const transport = injectedTransport ?? createGigaTransport(config!);

  let catalog: { status: number; text: string };
  try {
    const deadline = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
    catalog = await transport('/v1/models', undefined, signal ? AbortSignal.any([signal, deadline]) : deadline);
  } catch (error) {
    // Код ошибки Node (ENOTFOUND, UNABLE_TO_VERIFY_LEAF_SIGNATURE, CERT_HAS_EXPIRED…) сразу
    // говорит оператору, что чинить, и не несёт ни путей, ни содержимого сертификата.
    const code = (error as NodeJS.ErrnoException).code;
    return { failure: code ? `connection ${code}` : 'timeout or aborted' };
  }
  if (catalog.status !== 200) return { failure: `HTTP ${catalog.status}` };

  let parsedCatalog: unknown;
  try { parsedCatalog = JSON.parse(catalog.text); }
  catch { return { failure: 'bad JSON' }; }

  const ids = parseCatalog(parsedCatalog);
  if (!ids.length) return { failure: 'empty catalog' };
  return { provider: gatewayProvider(config, transport, ids), models: ids };
}

function gatewayProvider(config: GigaConfig | undefined, transport: GigaTransport, ids: string[]): ProviderConfig {
  return {
    name: 'Internal model gateway',
    baseUrl: `${config?.baseUrl ?? ''}/v2`,
    // Аутентификация транспортная (клиентский сертификат). Значение нужно лишь
    // для того, чтобы Pi считал провайдера настроенным; заголовок не шлём.
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
        const payload = normalizeResponseFormat(hooked as Record<string, unknown>);
        let response: { status: number; text: string };
        try { response = await transport('/v2/chat/completions', payload, options?.signal); }
        catch (error) { reportRequestFailure(model.id, failureCategory(error)); throw error; }
        // Тело ответа в текст ошибки не попадает: там бывает эхо промпта или страница прокси.
        if (response.status !== 200) {
          reportRequestFailure(model.id, `HTTP ${response.status}`);
          throw new Error(`Giga gateway request failed with HTTP ${response.status}`);
        }
        let body: GigaResponse;
        try { body = JSON.parse(response.text) as GigaResponse; }
        catch { reportRequestFailure(model.id, 'bad JSON'); throw new Error('Giga gateway returned a non-JSON response'); }
        return parseChatResponse(model, body, context.tools);
      })();
      // AssistantMessageEventStream — класс с приватными полями из pi-ai, который сюда нельзя
      // импортировать напрямую; объект ниже реализует его публичный контракт (result +
      // асинхронный итератор), поэтому приводится через unknown, а не напрямую.
      return {
        result: () => finished,
        async *[Symbol.asyncIterator]() {
          const message = await finished;
          yield { type: 'start', partial: message };
          yield { type: 'done', reason: message.stopReason, message };
        },
      } as unknown as ReturnType<NonNullable<ProviderConfig['streamSimple']>>;
    },
  };
}

export const GIGA_PROVIDER_ID = 'giga';

/** Внутренний шлюз нельзя описать декларативным models.json: там нужен клиентский сертификат. */
export async function registerGigaProvider(
  runtime: ModelRuntime,
  env?: Record<string, string | undefined>,
  injectedTransport?: GigaTransport,
  signal?: AbortSignal,
): Promise<void> {
  const provider = await createGigaProvider(env, injectedTransport, signal);
  if (provider) runtime.registerProvider(GIGA_PROVIDER_ID, provider);
}
