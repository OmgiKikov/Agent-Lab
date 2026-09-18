import type { ProviderConfig } from '@earendil-works/pi-coding-agent';

type StreamSimple = NonNullable<ProviderConfig['streamSimple']>;
export type GigaModel = Parameters<StreamSimple>[0];
export type GigaContext = Parameters<StreamSimple>[1];
export type GigaOptions = NonNullable<Parameters<StreamSimple>[2]>;
export type GigaStream = ReturnType<StreamSimple>;
export type GigaAssistantMessage = Awaited<ReturnType<GigaStream['result']>>;
type GigaMessage = GigaContext['messages'][number];

export interface GigaContentPart {
  text?: string;
  function_call?: { name: string; arguments?: unknown };
  function_result?: { name: string; result: unknown };
}

export interface GigaRequestMessage { role: string; content: GigaContentPart[]; tools_state_id?: string }

export interface GigaRequest {
  model: string;
  messages: GigaRequestMessage[];
  model_options?: Record<string, unknown>;
  tools?: { functions: { specifications: { name: string; description: string; parameters: unknown }[] } }[];
}

export interface GigaResponse {
  model?: string;
  created_at?: number;
  finish_reason?: string;
  messages?: { role?: string; content?: GigaContentPart[]; tool_state_id?: string; tools_state_id?: string }[];
  usage?: {
    input_tokens?: number;
    input_tokens_details?: { prompt_tokens?: number; cached_tokens?: number };
    output_tokens?: number;
    total_tokens?: number;
  };
}

// Достаёт текстовые части content; мысли и тул-коллы — не текст, для них у buildChatRequest
// есть отдельные ветки по роли (assistant с вызовом функции, toolResult с его результатом).
function textOf(content: GigaMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.filter(part => part.type === 'text').map(part => (part as { text: string }).text).join('\n');
}

// Шлюз ждёт result объектом (видно в записи вызовов официального SDK), а инструменты Pi отдают
// результат текстом. Нераспознанный текст оставляем как есть: пусть решает шлюз, а не мы.
function toolResult(text: string): unknown {
  try { return JSON.parse(text); }
  catch { return text; }
}

/** Идентификатор вызова собран как `${tools_state_id}#${индекс}`, чтобы состояние читалось обратно из истории. */
function stateOf(toolCallId: string): { tools_state_id?: string } {
  const state = toolCallId.split('#')[0];
  return state ? { tools_state_id: state } : {};
}

interface JsonSchema {
  type?: unknown; description?: string; properties?: Record<string, JsonSchema>; items?: JsonSchema;
  enum?: unknown[]; const?: unknown; anyOf?: JsonSchema[]; oneOf?: JsonSchema[]; $ref?: string; $defs?: unknown; definitions?: unknown;
}
interface ObjectParameters { required?: unknown; properties?: Record<string, JsonSchema> }

/*
 * Шлюз принимает узкое подмножество JSON Schema: type, description, properties, items, enum и
 * required. Лишние ключи (additionalProperties, pattern, minLength, $schema) отвергаются, у каждого
 * свойства обязано быть описание, а объект без собственного properties не проходит валидацию —
 * подтверждено ответами /v1/functions/validate и живыми 422. Инструменты разговора Agent Lab
 * описаны богаче инструментов песочницы, поэтому правило общее:
 *   - перечисление вида anyOf из const становится enum — без потерь;
 *   - ограничения длины и шаблоны снимаются: их проверяет сам инструмент при вызове;
 *   - параметр верхнего уровня, который шлюз выразить не может ($ref, разнотипные объединения,
 *     объект без properties), объявляется JSON-строкой и расшифровывается при разборе ответа.
 * Кодирование только на верхнем уровне: так разбор ответа однозначен по имени параметра.
 */
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

/** Значения перечисления, если схема — anyOf/oneOf из const одного скалярного типа. */
function literalUnion(schema: JsonSchema): { type: string; values: unknown[] } | undefined {
  const options = schema.anyOf ?? schema.oneOf;
  if (!options?.length || !options.every(option => option && 'const' in option)) return undefined;
  const types = new Set(options.map(option => typeof option.const));
  if (types.size !== 1) return undefined;
  const type = [...types][0] === 'number' ? 'number' : [...types][0];
  return SCALAR_TYPES.has(type as string) ? { type: type as string, values: options.map(option => option.const) } : undefined;
}

function expressible(schema: JsonSchema | undefined): boolean {
  if (!schema || typeof schema !== 'object' || schema.$ref || schema.$defs || schema.definitions) return false;
  if (literalUnion(schema)) return true;
  if (typeof schema.type !== 'string') return false;
  if (SCALAR_TYPES.has(schema.type)) return true;
  if (schema.type === 'array') return expressible(schema.items);
  if (schema.type !== 'object') return false;
  const properties = Object.values(schema.properties ?? {});
  return properties.length > 0 && properties.every(expressible);
}

/** Схема в допустимом подмножестве; вызывается только для выразимых схем. */
function acceptedSchema(name: string, schema: JsonSchema): JsonSchema {
  const description = schema.description ?? name;
  const union = literalUnion(schema);
  if (union) return { type: union.type, description, enum: union.values };
  const accepted: JsonSchema = { type: schema.type, description };
  if (schema.enum) accepted.enum = schema.enum;
  if (schema.type === 'array' && schema.items) accepted.items = acceptedSchema(`${name} item`, schema.items);
  if (schema.type === 'object' && schema.properties) {
    accepted.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, acceptedSchema(key, value)]));
  }
  return accepted;
}

/** Параметры верхнего уровня, которые придётся передавать строкой. */
function stringEncodedKeys(parameters: unknown): Set<string> {
  const properties = (parameters as ObjectParameters | undefined)?.properties ?? {};
  return new Set(Object.entries(properties).filter(([, schema]) => !expressible(schema)).map(([key]) => key));
}

function declaredParameters(parameters: unknown): unknown {
  const original = (parameters ?? {}) as ObjectParameters;
  const encoded = stringEncodedKeys(parameters);
  const properties = Object.fromEntries(Object.entries(original.properties ?? {}).map(([key, schema]) => {
    if (!encoded.has(key)) return [key, acceptedSchema(key, schema)];
    const description = schema?.description;
    return [key, { type: 'string', description: `${description ? `${description} ` : ''}Provide this as a JSON-encoded string.` }];
  }));
  const required = Array.isArray(original.required) ? original.required.filter(key => typeof key === 'string' && key in properties) : [];
  return { type: 'object', ...(required.length ? { required } : {}), properties };
}

function decodeStringEncoded(toolName: string, args: Record<string, unknown>, tools: GigaContext['tools']): Record<string, unknown> {
  const tool = tools?.find(t => t.name === toolName);
  const keys = stringEncodedKeys(tool?.parameters);
  if (!keys.size) return args;
  const decoded = { ...args };
  for (const key of keys) {
    const value = decoded[key];
    if (typeof value !== 'string') continue;
    try { decoded[key] = JSON.parse(value); } catch { /* not valid JSON: leave the string, the tool's own validation will reject it clearly */ }
  }
  return decoded;
}

export function buildChatRequest(modelId: string, context: GigaContext, options: GigaOptions): GigaRequest {
  const messages: GigaRequestMessage[] = [];
  if (context.systemPrompt) messages.push({ role: 'system', content: [{ text: context.systemPrompt }] });
  for (const message of context.messages) {
    if (message.role === 'toolResult') {
      // Роль именно tool: с role: 'function' шлюз отвергает запрос, несущий результат инструмента.
      messages.push({
        role: 'tool',
        content: [{ function_result: { name: message.toolName, result: toolResult(textOf(message.content)) } }],
        ...stateOf(message.toolCallId),
      });
      continue;
    }
    if (message.role === 'assistant') {
      const parts: GigaContentPart[] = [];
      const text = textOf(message.content);
      if (text) parts.push({ text });
      let state: { tools_state_id?: string } = {};
      for (const item of message.content) {
        if (item.type !== 'toolCall') continue;
        parts.push({ function_call: { name: item.name, arguments: item.arguments ?? {} } });
        state = stateOf(item.id);
      }
      messages.push({ role: 'assistant', content: parts, ...state });
      continue;
    }
    messages.push({ role: message.role, content: [{ text: textOf(message.content) }] });
  }
  const modelOptions: Record<string, unknown> = {};
  if (options.temperature !== undefined) modelOptions.temperature = options.temperature;
  if (options.maxTokens !== undefined) modelOptions.max_tokens = options.maxTokens;
  // Qwen, GLM и DeepSeek за шлюзом рассуждают по умолчанию и выбирают весь лимит выходных
  // токенов, не дойдя до ответа. Уровень размышления Pi здесь всегда "off" (модели каталога
  // объявлены без reasoning), и это транслируется явным запретом рассуждений: на ИФТ-контуре
  // принимается значение off, хотя в опубликованной спецификации enum сведён к одному medium.
  modelOptions.reasoning = { effort: options.reasoning ? 'medium' : 'off' };
  const request: GigaRequest = { model: modelId, messages };
  if (Object.keys(modelOptions).length) request.model_options = modelOptions;
  if (context.tools?.length) {
    request.tools = [{
      functions: {
        specifications: context.tools.map(tool => ({
          name: tool.name, description: tool.description,
          parameters: declaredParameters(tool.parameters),
        })),
      },
    }];
  }
  return request;
}

const noCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

const KNOWN_FINISH_REASONS = new Set(['stop', 'length', 'function_call']);

// A content-filter block or a gateway-side error also arrives as a completed HTTP response with
// some finish_reason; treating anything unrecognized as a clean stop would grade a censored or
// empty body as if the model had answered normally. A function call present in the content is
// checked first: third-party models behind the gateway may label that stop differently.
function stopReason(finish: string | undefined, hasToolCall: boolean): GigaAssistantMessage['stopReason'] {
  if (hasToolCall) return 'toolUse';
  if (finish !== undefined && !KNOWN_FINISH_REASONS.has(finish)) {
    throw new Error(`Giga gateway reported an unrecognized finish reason: ${finish}`);
  }
  return finish === 'length' ? 'length' : 'stop';
}

// Gateways commonly send function_call.arguments as a JSON-encoded string rather than an
// object; passing that string straight to a tool would fail its validation obscurely.
function functionArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as Record<string, unknown>; }
    catch { return {}; }
  }
  return (raw ?? {}) as Record<string, unknown>;
}

export function parseChatResponse(model: GigaModel, body: GigaResponse, tools: GigaContext['tools'] = []): GigaAssistantMessage {
  const answer = body.messages?.find(message => message.role === 'assistant');
  const state = answer?.tools_state_id ?? answer?.tool_state_id ?? '';
  const parts = answer?.content ?? [];
  const text = parts.map(part => part.text ?? '').join('');
  const content: GigaAssistantMessage['content'] = [];
  if (text) content.push({ type: 'text', text });
  // Индекс в id считает только вызовы функций, а не позицию в content: гейтвей
  // может прислать текст и вызов в одном сообщении, и текст не должен сдвигать нумерацию.
  let callIndex = 0;
  for (const part of parts) {
    if (!part.function_call) continue;
    content.push({
      type: 'toolCall', id: `${state}#${callIndex}`, name: part.function_call.name,
      arguments: decodeStringEncoded(part.function_call.name, functionArguments(part.function_call.arguments), tools),
    });
    callIndex += 1;
  }
  const hasToolCall = content.some(item => item.type === 'toolCall');
  const inputTokens = body.usage?.input_tokens ?? 0;
  // Шлюз изредка присылает cached_tokens больше input_tokens; без зажима это раздуло бы
  // восстановленный в src/pi.ts счётчик входных токенов сверх реально оплаченного.
  const cacheRead = Math.min(body.usage?.input_tokens_details?.cached_tokens ?? 0, inputTokens);
  const input = inputTokens - cacheRead;
  const output = body.usage?.output_tokens ?? 0;
  return {
    role: 'assistant',
    content,
    api: model.api, provider: model.provider, model: model.id,
    ...(body.model ? { responseModel: body.model } : {}),
    usage: { input, output, cacheRead, cacheWrite: 0, totalTokens: body.usage?.total_tokens ?? input + cacheRead + output, cost: { ...noCost } },
    stopReason: stopReason(body.finish_reason, hasToolCall),
    ...(body.finish_reason ? { rawStopReason: body.finish_reason } : {}),
    timestamp: (body.created_at ?? Math.floor(Date.now() / 1000)) * 1000,
  };
}

interface CatalogEntry { id?: unknown; type?: unknown }

/*
 * Шлюз раздаёт не только чат: эмбеддинги и служебные модели чат-запрос не
 * обслуживают. Отбор идёт по полю type, без эвристик по именам моделей;
 * шлюз, который его не присылает вовсе, отдаёт весь каталог.
 */
export function parseCatalog(body: unknown): string[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return (data as CatalogEntry[])
    .filter(entry => typeof entry.id === 'string' && (typeof entry.type !== 'string' || entry.type === 'chat'))
    .map(entry => entry.id as string);
}

interface OpenAiResponseFormat {
  type?: string;
  json_schema?: { name?: string; strict?: boolean; schema?: unknown };
}

/*
 * Хук onPayload в src/pi.ts кладёт схему судьи в OpenAI-форме на верхний уровень.
 * Контракт v2 ждёт её как model_options.response_format с полем schema.
 */
export function normalizeResponseFormat(payload: Record<string, unknown>): Record<string, unknown> {
  const format = payload.response_format as OpenAiResponseFormat | undefined;
  if (!format) return payload;
  const { response_format: _dropped, ...rest } = payload;
  const modelOptions = { ...(rest.model_options as Record<string, unknown> | undefined) };
  modelOptions.response_format = format.json_schema
    ? { type: format.type ?? 'json_schema', schema: format.json_schema.schema, strict: format.json_schema.strict ?? true }
    : format;
  return { ...rest, model_options: modelOptions };
}
