import { resolve } from 'node:path';
import { z } from 'zod';
import { CONNECTION_FORMAT, rememberConnection, saveConnection, TOOL_PROBE_OPENING, type Connection } from './connection.js';
import { conversationFields, type CurlField, type CurlFields, type CurlReady, type Place } from './curl.js';
import { AgentRequestFailed } from './errors.js';
import { atPointer, pointerTokens, stringFields } from './http-template.js';
import type { StructuredTask, TaskRunner } from './llm/structured.js';
import type { BuilderModel } from './miner/topic-map.js';
import { CONNECT_REPLY_ROLE, CONNECT_REQUEST_ROLE } from './prompts.js';
import type { CallContext } from './runtime.js';
import type { TemplateTarget } from './targets.js';
import { clip } from './text.js';

export { missingVariables } from './targets.js';

/*
 * Connecting an agent in its own request format from the owner's curl, the part the chat and the command line share.
 *
 *   curl ──connectionFromCurl──► request fields ──conversation: by key names and turns (structure)──┐
 *                                              └─message: the last turn, the only text field, or the builder's pick (enum of pointers)
 *        ──owner confirms──► test message ──reply fields──► the reply's text: the only one, or the builder's pick
 *        ──owner confirms──► second message in the same conversation ──► connection.json + Lab's remembered connection
 *
 * What the builder reads is the owner's own example request — its secrets already placeholders — and the agent's
 * replies to Lab's fixed test phrases, never a customer's conversation. Its answer is a proposal: every reference is
 * an enum of this call, and the owner confirms or corrects it in a native dialog. Without a model the owner picks
 * from the same lists.
 */

/** The project file the chat writes; the command line may name another. */
export const CONNECTION_FILE = 'connection.json';
/** One answer and one repair per reading: each proposal costs at most two calls. */
const READING_ATTEMPTS = 2;
const REASON_CHARS = 160;
/** How much of a reply field the builder reads, and how many fields. */
const REPLY_TEXT_CHARS = 500;
const REPLY_FIELDS = 100;

/** A field in the owner's words: its keys joined by dots, as the owner's JSON writes them. */
export const fieldLabel = (pointer: string): string => pointer === '' ? 'весь ответ' : pointerTokens(pointer).join('.');
/** The reply's field in the owner's words; a path through every bubble says that several are joined. */
export function replyLabel(pointer: string): string {
  const tokens = pointerTokens(pointer);
  const at = tokens.lastIndexOf('-');
  if (at < 0) return fieldLabel(pointer);
  const list = tokens.slice(0, at).join('.'), item = tokens.slice(at + 1).join('.');
  return `${item || 'текст'} каждого сообщения${list ? ` в ${list}` : ' ответа'} (несколько сообщений Lab склеит)`;
}

/** A body field that may carry the customer's message: its example value from the curl, verbatim. */
export interface RequestField { pointer: string; keys: string[]; value: string }
/** Which field is the customer's message and which fields are the conversation; `reason` when Lab's model proposed it. */
export interface RequestChoice { message: string; conversation: string[]; reason?: string }
/** A reply field with text: its pointer and the agent's text there. */
export interface ReplyField { pointer: string; keys: string[]; text: string }
/** Where the agent's text is in its reply; `reason` when Lab's model proposed it. */
export interface ReplyChoice { pointer: string; reason?: string }

/** The builder model that reads a request and a reply: the Pi runtime's, or a test's with scripted replies. */
export interface ConnectionReader {
  builder: BuilderModel;
  /** `fields` are all the body's text fields; the message is one of `candidates`, the conversation any of the fields. */
  request(input: { fields: readonly RequestField[]; candidates: readonly string[] }, ctx: CallContext): Promise<RequestChoice>;
  reply(input: { sent: string; fields: readonly ReplyField[] }, ctx: CallContext): Promise<ReplyChoice>;
}

const reasonSchema = z.string().trim().min(1).max(REASON_CHARS, { error: `The reason is at most ${REASON_CHARS} characters: one short line.` })
  .refine(value => !value.includes('\n'), 'The reason is one line.');
const pointers = (fields: readonly { pointer: string }[]) => fields.map(field => field.pointer) as [string, ...string[]];

const listed = (values: readonly string[], what: string) => z.enum(values as [string, ...string[]], { error: `Not ${what}: answer with a pointer listed in fields.` });

/** The request's reading: the message is one of `candidates`, the conversation some of the listed fields. */
export function requestTask(fields: readonly RequestField[], candidates: readonly string[]): StructuredTask<RequestChoice> {
  const message = listed(candidates, 'a field that can carry the customer\'s words');
  const conversation = z.array(listed(pointers(fields), 'a listed field')).max(fields.length);
  return { id: 'connect-request', label: 'Поле сообщения клиента', role: 'builder', instructions: CONNECT_REQUEST_ROLE, attempts: READING_ATTEMPTS,
    output: z.strictObject({ message, conversation, reason: reasonSchema }) as z.ZodType<RequestChoice>,
    check: value => value.conversation.includes(value.message) ? `${value.message} cannot be both the message and the conversation.`
      : new Set(value.conversation).size !== value.conversation.length ? 'List each conversation pointer once.' : undefined };
}

/** The reply's reading: its text is one of the listed fields. */
function replyTask(fields: readonly ReplyField[]): StructuredTask<{ reply: string; reason: string }> {
  return { id: 'connect-reply', label: 'Поле ответа агента', role: 'builder', instructions: CONNECT_REPLY_ROLE, attempts: READING_ATTEMPTS,
    output: z.strictObject({ reply: listed(pointers(fields), 'a listed field'), reason: reasonSchema }) };
}

/** The Pi runtime's reader: both readings answered by `run`'s builder model. */
export function connectionReaderWith(builder: BuilderModel, run: TaskRunner): ConnectionReader {
  return {
    builder,
    request: (input, ctx) => run(requestTask(input.fields, input.candidates), { fields: input.fields, messageCandidates: input.candidates }, ctx),
    reply: async (input, ctx) => { const answer = await run(replyTask(input.fields), input, ctx); return { pointer: answer.reply, reason: answer.reason }; },
  };
}

/** The conversation fields the key names show, placeholders, numbers and empty values included: `$(uuidgen)` under conversation_id is still the conversation. */
export const defaultConversation = (asked: CurlFields): string[] => conversationFields(asked.fields.map(field => field.pointer));

/** A field's value as the owner's JSON writes it. */
export const fieldValue = (field: CurlField): string => typeof field.value === 'string' ? field.value : JSON.stringify(field.value);

/** The body's fields the owner wrote as text: a field Lab substitutes (a time, an id, a variable, a secret) or a turn's role carries no message. */
export const literalFields = (asked: CurlFields): RequestField[] => asked.fields
  .filter((field): field is CurlField & { value: string } => typeof field.value === 'string' && !field.value.includes('{{') && pointerTokens(field.pointer).at(-1) !== 'role')
  .map(field => ({ pointer: field.pointer, keys: pointerTokens(field.pointer), value: field.value }));

/** The fields that may carry the message: literal text of the curl, not a conversation field. */
export function requestFields(asked: CurlFields): RequestField[] {
  const conversation = new Set(defaultConversation(asked));
  return literalFields(asked).filter(field => !conversation.has(field.pointer));
}

/** The reply's fields with text, in document order. */
export const replyFields = (document: unknown): ReplyField[] => stringFields(document).filter(field => field.value.trim())
  .slice(0, REPLY_FIELDS).map(field => ({ pointer: field.pointer, keys: pointerTokens(field.pointer), text: field.value }));

/** A call budget for one reading: its attempts and nothing more. */
function readingContext(signal: AbortSignal, timeoutMs: number): CallContext {
  let calls = 0;
  return { signal, timeoutMs, addUsage() {},
    beforeCall() {
      signal.throwIfAborted();
      if (++calls > READING_ATTEMPTS) throw new Error(`Подключение агента: больше ${READING_ATTEMPTS} вызовов модели на одно чтение не предусмотрено.`);
    } };
}

interface ReadingOptions { reader?: ConnectionReader; timeoutMs: number; signal: AbortSignal }

/**
 * Lab's reading of the request. The conversation is read from the key names; the message is the last turn where the
 * body carries its conversation as turns, the only text field left, or the builder's pick among them (its conversation
 * pick counts only where the key names show none). Undefined when the owner has to pick: no model, or no usable answer.
 */
export async function proposeRequest(asked: CurlFields, options: ReadingOptions): Promise<RequestChoice | undefined> {
  const conversation = defaultConversation(asked);
  if (asked.lastTurn !== undefined) return { message: asked.lastTurn, conversation };
  const fields = requestFields(asked);
  if (!fields.length) throw new Error('В теле запроса curl нет текстового поля для сообщения клиента: вставьте запрос, где в теле есть пример сообщения.');
  if (fields.length === 1) return { message: fields[0]!.pointer, conversation };
  if (!options.reader) return undefined;
  // Secrets are placeholders by now ({{env:…}}): the builder reads the owner's example request, never a secret's value.
  const all = asked.fields.map(field => ({ pointer: field.pointer, keys: pointerTokens(field.pointer), value: fieldValue(field) }));
  try {
    const answer = await options.reader.request({ fields: all, candidates: fields.map(field => field.pointer) }, readingContext(options.signal, options.timeoutMs));
    return { message: answer.message, conversation: conversation.length ? conversation : answer.conversation.filter(pointer => pointer !== answer.message), reason: answer.reason };
  } catch (error) {
    if (options.signal.aborted) throw error;
    // A model that cannot answer leaves the pick to the owner: the connection never waits on it.
    return undefined;
  }
}

/** Lab's reading of the reply: the only text field, or the builder's pick; undefined when the owner has to pick. */
export async function proposeReply(fields: readonly ReplyField[], options: ReadingOptions): Promise<ReplyChoice | undefined> {
  if (fields.length === 1) return { pointer: fields[0]!.pointer };
  if (!fields.length || !options.reader) return undefined;
  try {
    const shown = fields.map(field => ({ ...field, text: clip(field.text, REPLY_TEXT_CHARS) }));
    return await options.reader.reply({ sent: TOOL_PROBE_OPENING, fields: shown }, readingContext(options.signal, options.timeoutMs));
  } catch (error) {
    if (options.signal.aborted) throw error;
    return undefined;
  }
}

/** A template's text as the owner reads it: what Lab fills in, in words; the owner's variables as $NAME. The template is structure the owner wrote. */
function shownText(text: string): string {
  return text.replace(/\{\{([^{}]+)\}\}/g, (_, name: string) => name.startsWith('env:') ? `$${name.slice('env:'.length)}`
    : name.startsWith('uuid') ? 'новый id' : name.startsWith('now') ? 'текущее время' : name === 'message' ? 'сообщение клиента' : 'id разговора');
}
/** The address as the owner reads it: a query value read from the environment shows as $NAME. */
export const shownAddress = (target: { url: string }): string => shownText(target.url);
const placeOf = (place: Place) => 'header' in place ? `заголовок ${place.header}` : 'query' in place ? `параметр адреса ${place.query}` : `поле ${fieldLabel(place.pointer)}`;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The one confirmation of a connection from curl, in the owner's words, for the chat and the command line alike: the
 * address, the message, how the conversation is kept, what Lab fills in itself, every saved header and how it is
 * stored (its value, or the name of the variable it is read from), and where each secret of the curl went.
 */
export function connectionLines(made: CurlReady, reason?: string): string[] {
  if (made.target.kind !== 'http' || !made.target.request) return [];
  const { request, headersEnv } = made.target;
  const valueOf = (pointer: string) => atPointer(request.body, pointer);
  const lines = [`Адрес: ${shownAddress(made.target)}`, `Сообщение клиента → ${fieldLabel(made.message)}${reason ? ` (${reason})` : ''}`];
  if (made.history) {
    const roles = `реплики клиента — с ролью ${made.history.roles.user}, агента — ${made.history.roles.assistant}`;
    lines.push(made.history.withMessage
      ? `Разговор → ${fieldLabel(made.history.at)}: в каждом запросе вся история разговора, ${roles}${made.history.fixed ? '; инструкции из curl остаются первыми' : ''}`
      : `История → ${fieldLabel(made.history.at)}: реплики до нового сообщения, ${roles}`);
  }
  const ours = made.conversation.filter(pointer => valueOf(pointer) !== '{{session}}');
  const agents = made.conversation.filter(pointer => valueOf(pointer) === '{{session}}');
  if (ours.length) lines.push(`Разговор → ${ours.map(fieldLabel).join(', ')} (новый в каждой ситуации${ours.some(pointer => valueOf(pointer) === '{{conversation:number}}') ? ', числом, как в curl' : ''})`);
  if (agents.length) lines.push(`Разговор → ${agents.map(fieldLabel).join(', ')}: в первом сообщении пусто, как в curl, дальше — идентификатор, который назовёт агент`);
  if (!made.history && !made.conversation.length) lines.push('Разговор: в запросе нет ни идентификатора разговора, ни истории сообщений — каждое сообщение уйдёт само по себе: если агент помнит разговор по чему-то другому, ситуации смешаются, если не помнит — многоходовые измерятся без памяти');
  const chosen = new Set([made.message, ...made.conversation]);
  const fields = made.substitutions.flatMap(item => 'pointer' in item && !chosen.has(item.pointer) ? [{ by: item.by, variable: item.variable, pointer: item.pointer }] : []);
  const automatic = fields.filter(item => item.by !== 'env').map(item => fieldLabel(item.pointer));
  if (automatic.length) lines.push(`Время и идентификатор запроса → ${automatic.join(', ')}: подставляются сами`);
  lines.push(...fields.filter(item => item.by === 'env').map(item => `${fieldLabel(item.pointer)} → из переменной окружения ${item.variable}`),
    ...made.substitutions.flatMap(item => 'query' in item && item.by === 'env' ? [`Параметр адреса ${item.query} → из переменной окружения ${item.variable}`] : []));
  const secretHeaders = new Set(made.secrets.flatMap(item => 'header' in item ? [item.header] : []));
  for (const [name, value] of Object.entries(request.headers)) {
    const variables = [...value.matchAll(/\{\{env:([^{}]+)\}\}/g)].map(m => m[1]!);
    const filled = value.includes('{{') && !variables.length;
    lines.push(`Заголовок ${name}: ${shownText(value)}${variables.length ? ` — из переменной окружения ${variables.join(', ')}, в файле только её имя` : filled ? ' — подставляется при каждом запросе' : ''}`);
  }
  for (const [name, variable] of Object.entries(headersEnv)) lines.push(secretHeaders.has(name)
    ? `Заголовок ${name} — секрет из curl: в файл не пишется, Lab прочтёт его из переменной ${variable}`
    : `Заголовок ${name} → из переменной окружения ${variable}, в файле только её имя`);
  lines.push(...made.secrets.filter(item => !('header' in item)).map(item => `${capital(placeOf(item))} — секрет из curl: в файл не пишется, Lab прочтёт его из переменной ${item.variable}`));
  return [...lines, ...made.warnings];
}

/** Where a variable the connection reads comes from, in the owner's words: a secret of the curl, or the owner's own variable the curl names. */
export function variableUse(made: CurlReady, variable: string): string {
  const secret = made.secrets.find(item => item.variable === variable);
  return secret ? `${variable} (значение: ${placeOf(secret)} из вашего curl)` : `${variable} (её называет ваш curl)`;
}

/** Why the test message got no reply, in the owner's words with the next step. */
export function testCallFailure(error: unknown): string {
  if (error instanceof AgentRequestFailed) {
    // The failure says itself what is wrong and what to do: the address, the network, the certificate.
    if (error.kind === 'unreachable' || error.kind === 'tls') return error.message;
    if (error.kind === 'timeout') return 'Агент не ответил за отведённое время: проверьте, что он запущен, или добавьте в curl --max-time с большим числом секунд.';
    const status = error.status ?? 0;
    if (status === 401 || status === 403) return `Агент отказал в доступе (${status}): проверьте значения переменных с секретами.`;
    return status >= 500 ? `Агент ответил ошибкой ${status} на своей стороне: проверьте, что он работает, и повторите.`
      : `Агент не принял запрос (${status}): сверьте curl с тем, что у вас работает.`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Saves a checked connection where the next steps find it: the project's connection.json (0600, atomic; `replace`
 * only after the owner agreed to replace the one there) and Lab's remembered connection in the data folder.
 */
export async function saveProjectConnection(input: { project: string; data: string; target: TemplateTarget; replace: boolean }): Promise<string> {
  const file = resolve(input.project, CONNECTION_FILE);
  const connection: Connection = { format: CONNECTION_FORMAT, target: input.target };
  await saveConnection(file, connection, input.replace);
  await rememberConnection(input.data, connection);
  return file;
}
