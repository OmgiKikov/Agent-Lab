import { resolve } from 'node:path';
import { z } from 'zod';
import { CONNECTION_FORMAT, rememberConnection, saveConnection, TOOL_PROBE_OPENING, type Connection } from './connection.js';
import { conversationFields, type CurlFields, type CurlReady } from './curl.js';
import { AgentRequestFailed } from './errors.js';
import { stringFields, templateVariables } from './http-template.js';
import type { StructuredTask, TaskRunner } from './llm/structured.js';
import type { BuilderModel } from './miner/topic-map.js';
import { CONNECT_REPLY_ROLE, CONNECT_REQUEST_ROLE } from './prompts.js';
import type { CallContext } from './runtime.js';
import type { TemplateTarget } from './targets.js';
import { clip } from './text.js';

/*
 * Connecting an agent in its own request format from the owner's curl, the part the chat and the command line share.
 *
 *   curl ──connectionFromCurl──► request fields ──conversation: by key names (structure)──┐
 *                                              └─message: the only text field, or the builder's pick (enum of pointers)
 *        ──owner confirms──► test message ──reply fields──► the reply's text: the only one, or the builder's pick
 *        ──owner confirms──► second message in the same conversation ──► connection.json + Lab's remembered connection
 *
 * What the builder reads is the owner's own example request and the agent's replies to Lab's fixed test phrases —
 * never a customer's conversation. Its answer is a proposal: every reference is an enum of this call, and the owner
 * confirms or corrects it in a native dialog. Without a model the owner picks from the same lists.
 */

/** The project file the chat writes; the command line may name another. */
export const CONNECTION_FILE = 'connection.json';
/** One answer and one repair per reading: each proposal costs at most two calls. */
const READING_ATTEMPTS = 2;
const REASON_CHARS = 160;
/** How much of a reply field the builder reads, and how many fields. */
const REPLY_TEXT_CHARS = 500;
const REPLY_FIELDS = 100;

const decode = (token: string) => token.replaceAll('~1', '/').replaceAll('~0', '~');
/** The keys from the root to a field, as the curl names them. */
const keysOf = (pointer: string): string[] => pointer === '' ? [] : pointer.slice(1).split('/').map(decode);
/** A field in the owner's words: its keys joined by dots, as the owner's JSON writes them. */
export const fieldLabel = (pointer: string): string => pointer === '' ? 'весь ответ' : keysOf(pointer).join('.');

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

/** The conversation fields the key names show, placeholders included: `$(uuidgen)` under conversation_id is still the conversation. */
export const defaultConversation = (asked: CurlFields): string[] => conversationFields(asked.fields.map(field => field.pointer));

/** The body's fields the owner wrote as text: a field Lab substitutes (a time, an id, a variable) carries no message. */
export const literalFields = (asked: CurlFields): RequestField[] => asked.fields.filter(field => !field.value.includes('{{'))
  .map(field => ({ pointer: field.pointer, keys: keysOf(field.pointer), value: field.value }));

/** The fields that may carry the message: literal text of the curl, not a conversation field. */
export function requestFields(asked: CurlFields): RequestField[] {
  const conversation = new Set(defaultConversation(asked));
  return literalFields(asked).filter(field => !conversation.has(field.pointer));
}

/** The reply's fields with text, in document order. */
export const replyFields = (document: unknown): ReplyField[] => stringFields(document).filter(field => field.value.trim())
  .slice(0, REPLY_FIELDS).map(field => ({ pointer: field.pointer, keys: keysOf(field.pointer), text: field.value }));

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
 * Lab's reading of the request. The conversation is read from the key names; the message is the only text field
 * left, or the builder's pick among them (its conversation pick counts only where the key names show none).
 * Undefined when the owner has to pick: no model, or the model gave no usable answer.
 */
export async function proposeRequest(asked: CurlFields, options: ReadingOptions): Promise<RequestChoice | undefined> {
  const conversation = defaultConversation(asked);
  const fields = requestFields(asked);
  if (!fields.length) throw new Error('В теле запроса curl нет текстового поля для сообщения клиента: вставьте запрос, где в теле есть пример сообщения.');
  if (fields.length === 1) return { message: fields[0]!.pointer, conversation };
  if (!options.reader) return undefined;
  const all = asked.fields.map(field => ({ pointer: field.pointer, keys: keysOf(field.pointer), value: field.value }));
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

/** What the confirmation shows, in the owner's words: the address, the message, the conversation, what Lab fills in itself, the secrets. */
export function connectionLines(made: CurlReady, reason?: string): string[] {
  if (made.target.kind !== 'http') return [];
  const chosen = new Set([made.message, ...made.conversation]);
  const own = made.substitutions.filter(item => !('pointer' in item && chosen.has(item.pointer)));
  const place = (item: (typeof own)[number]) => 'header' in item ? item.header : fieldLabel(item.pointer);
  const automatic = own.filter(item => item.by !== 'env').map(place);
  return [`Адрес: ${made.target.url}`,
    `Сообщение клиента → ${fieldLabel(made.message)}${reason ? ` (${reason})` : ''}`,
    made.conversation.length ? `Разговор → ${made.conversation.map(fieldLabel).join(', ')} (новый в каждой ситуации)`
      : 'Разговор: поле не найдено — агент может смешать ситуации',
    ...(automatic.length ? [`Время и идентификатор запроса → ${automatic.join(', ')}: подставляются сами`] : []),
    ...own.filter(item => item.by === 'env').map(item => `${place(item)} → из переменной окружения ${item.variable}`),
    ...Object.entries(made.target.headersEnv).map(([header, variable]) => `Заголовок ${header} — секрет, в файл не пишется: Lab прочтёт его из переменной ${variable}`),
    ...made.warnings];
}

/** The environment variables the connection reads that are not set in this process. */
export function missingVariables(target: TemplateTarget): string[] {
  return [...new Set([...Object.values(target.headersEnv), ...templateVariables(target.request)])].filter(name => !process.env[name]);
}

/** Why the test message got no reply, in the owner's words with the next step. */
export function testCallFailure(error: unknown): string {
  if (error instanceof AgentRequestFailed) {
    if (error.kind === 'unreachable') return 'Агент не отвечает по этому адресу: проверьте адрес и сеть (VPN, доступ с этой машины).';
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
