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

// The text parts of a content; thoughts and tool calls are not text, buildChatRequest has branches of their own for them
// by role (an assistant with a function call, a toolResult with its result).
function textOf(content: GigaMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.filter(part => part.type === 'text').map(part => (part as { text: string }).text).join('\n');
}

// The gateway expects the result as an object (as the official SDK's recorded calls show), while Pi's tools return text.
// Text that does not parse is passed on as it is: the gateway decides, not we.
function toolResult(text: string): unknown {
  try { return JSON.parse(text); }
  catch { return text; }
}

/** A call id is built as `${tools_state_id}#${index}`, so the state reads back from the history. */
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
 * The gateway accepts a narrow subset of JSON Schema: type, description, properties, items, enum and
 * required. Other keys (additionalProperties, pattern, minLength, $schema) are refused, every property
 * must have a description, and an object without properties of its own fails validation — confirmed
 * by /v1/functions/validate answers and live 422s. Agent Lab's conversation tools are described more
 * richly than the sandbox's, so the rule is general:
 *   - an enumeration written as anyOf of const becomes enum, losing nothing;
 *   - length limits and patterns are dropped: the tool itself checks them when called;
 *   - a top-level parameter the gateway cannot express ($ref, unions of different types, an object
 *     without properties) is declared as a JSON string and decoded when the answer is parsed.
 * Only the top level is encoded, so decoding an answer is unambiguous by the parameter's name.
 */
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

/** The values of an enumeration, when the schema is anyOf/oneOf of const values of one scalar type. */
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

/** The schema within the accepted subset; called for expressible schemas only. */
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

/** The top-level parameters that have to travel as strings. */
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
      // The role is exactly tool: with role 'function' the gateway refuses a request that carries a tool's result.
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
  // Qwen, GLM and DeepSeek behind the gateway reason by default and spend the whole output limit before they answer.
  // Pi's thinking level is always off here (the catalog models are declared without reasoning), and it is sent as an
  // explicit ban on reasoning. The owner's test environment (IFT) accepts `off`, though the published specification lists
  // only `medium`; a stricter gateway refuses such a request with 422, which the provider reports as a rejected request
  // (a refusal model-call.ts reads as 'bad request'). The catalog does not say which models reason (see parseCatalog), so the parameter cannot be
  // limited to them, and dropping it would bring the spent limit back on the gateway that works today.
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
  // The index in the id counts function calls only, not positions in content: the gateway may send text and a call in
  // one message, and the text must not shift the numbering.
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
  // The gateway now and then reports more cached_tokens than input_tokens; unclamped, that would inflate the input
  // tokens src/llm/model-call.ts restores (input + cacheRead + cacheWrite) beyond what was actually paid for.
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
 * The gateway serves more than chat: embeddings and service models do not answer a chat request.
 * Entries are picked by their type field, with no guessing from model names; a gateway that sends
 * no type at all yields its whole catalog. The entries carry nothing else Lab reads: no context
 * window, no prices, no word on reasoning.
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
 * The onPayload hook of src/llm/model-call.ts puts the judge's schema at the top level, in the
 * OpenAI shape. Contract v2 expects it as model_options.response_format with a schema field.
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
