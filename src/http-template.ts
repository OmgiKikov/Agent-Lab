import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

/*
 * An HTTP agent in its own request format: the owner's envelope with placeholders, rendered for every turn.
 *
 *   template address/body/headers ──render (the placeholders below)──► POST
 *   reply JSON ──JSON pointer (RFC 6901; a `-` token: every bubble of that array)──► the agent's text
 *
 * How the agent keeps a conversation is what the owner's curl shows, and the template says it in one of three ways:
 *   {{conversation}}  Lab names it: a fresh id per dialogue, the same in all its turns (a number where the curl had one);
 *   {{history}}       the request carries the conversation itself (OpenAI-style `messages`): each turn sends every turn so far;
 *   {{session}}       the agent names it: the id its previous reply gave (`session.reply`) goes into the next request.
 * Every dialogue is a new conversation — that is its reset. Placeholders are parsed over the TEMPLATE only (structure
 * the owner wrote); a reply is read by pointer, never searched. Environment values are read at request time and never
 * stored, like `headersEnv`.
 */

const ENV_NAME = '[A-Za-z_][A-Za-z0-9_]{0,99}';
/** An environment variable a connection reads: a header's value, a template's {{env:NAME}}. */
export const envNameSchema = z.string().regex(new RegExp(`^${ENV_NAME}$`), 'Invalid environment variable name');
const NAMES = `message|conversation(?::number)?|session|uuid(?::hex)?|now(?::[^{}]{1,60})?|env:${ENV_NAME}`;
/** Every placeholder a body or a header may hold; anything else in double braces is refused when the connection is read. */
const PLACEHOLDER = new RegExp(`\\{\\{(${NAMES})\\}\\}`, 'g');
/** A turn of the conversation also names its speaker and its words. */
const TURN_PLACEHOLDER = new RegExp(`\\{\\{(${NAMES}|role|text)\\}\\}`, 'g');
const ENV_PLACEHOLDER = new RegExp(`\\{\\{env:(${ENV_NAME})\\}\\}`, 'g');
const BRACES = /\{\{[^{}]*\}\}/g;
/** The array element that stands for the conversation's turns: all of them, or those before the new message. */
export const HISTORY = '{{history}}', HISTORY_BEFORE = '{{history:before}}';
const INDEX = /^(0|[1-9][0-9]*)$/;

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const jsonSchema: z.ZodType<Json> = z.lazy(() => z.union([z.string().max(20000), z.number().finite(), z.boolean(), z.null(),
  z.array(jsonSchema).max(200), z.record(z.string().max(200), jsonSchema)]));

/** RFC 6901: empty for the whole document, otherwise `/`-separated tokens with `~1` for `/` and `~0` for `~`. */
export const pointerSchema = z.string().max(1000).refine(p => p === '' || p.startsWith('/'), 'JSON pointer starts with /');
/** The keys from the root to a field, decoded. */
export const pointerTokens = (pointer: string): string[] => pointer === '' ? [] : pointer.slice(1).split('/').map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'));
/** The pointer of a path of keys, encoded. */
export const pointerOf = (tokens: readonly string[]): string => tokens.map(token => `/${token.replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');

/** Every string and number of a JSON value with its pointer, in document order. */
export function scalarFields(value: unknown, pointer = ''): { pointer: string; value: string | number }[] {
  if (typeof value === 'string' || typeof value === 'number') return [{ pointer, value }];
  if (Array.isArray(value)) return value.flatMap((item, i) => scalarFields(item, `${pointer}/${i}`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => scalarFields(item, pointer + pointerOf([key])));
  return [];
}
/** Every string of a JSON value with its pointer, in document order. */
export const stringFields = (value: unknown, pointer = ''): { pointer: string; value: string }[] =>
  scalarFields(value, pointer).filter((field): field is { pointer: string; value: string } => typeof field.value === 'string');

// ---- Time in the format of the owner's `date` command ----

/** The `date +FORMAT` directives Lab renders; a time in any other form is sent as ISO 8601 (curl.ts says so). */
const TIME_DIRECTIVES = new Set(['Y', 'y', 'm', 'd', 'e', 'j', 'H', 'I', 'M', 'S', 'p', 's', 'N', 'F', 'T', 'z', '%']);

/** Whether Lab renders every directive of a `date +FORMAT` string: `%3N` (milliseconds) and `%:z` included. */
export function timeFormatSupported(format: string): boolean {
  for (let i = 0; i < format.length; i++) {
    if (format[i] !== '%') continue;
    const next = format[++i];
    if (next !== undefined && next >= '1' && next <= '9' && format[i + 1] === 'N') { i++; continue; }
    if (next === ':' && format[i + 1] === 'z') { i++; continue; }
    if (next === undefined || !TIME_DIRECTIVES.has(next)) return false;
  }
  return true;
}

/** `date +FORMAT` (GNU) of one moment, in local time or in UTC (`date -u`). */
export function formatTime(date: Date, format: string, utc: boolean): string {
  const year = utc ? date.getUTCFullYear() : date.getFullYear(), month = (utc ? date.getUTCMonth() : date.getMonth()) + 1;
  const day = utc ? date.getUTCDate() : date.getDate(), hour = utc ? date.getUTCHours() : date.getHours();
  const minute = utc ? date.getUTCMinutes() : date.getMinutes(), second = utc ? date.getUTCSeconds() : date.getSeconds();
  const nanoseconds = String(date.getMilliseconds() * 1_000_000).padStart(9, '0');
  const offset = utc ? 0 : -date.getTimezoneOffset();
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const zone = (colon: string) => `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}${colon}${pad(Math.abs(offset) % 60)}`;
  const dayOfYear = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86_400_000) + 1;
  let out = '';
  for (let i = 0; i < format.length; i++) {
    const char = format[i]!;
    if (char !== '%') { out += char; continue; }
    const next = format[++i];
    if (next !== undefined && next >= '1' && next <= '9' && format[i + 1] === 'N') { i++; out += nanoseconds.slice(0, Number(next)); continue; }
    if (next === ':' && format[i + 1] === 'z') { i++; out += zone(':'); continue; }
    switch (next) {
      case 'Y': out += pad(year, 4); break;
      case 'y': out += pad(year % 100); break;
      case 'm': out += pad(month); break;
      case 'd': out += pad(day); break;
      case 'e': out += String(day).padStart(2, ' '); break;
      case 'j': out += pad(dayOfYear, 3); break;
      case 'H': out += pad(hour); break;
      case 'I': out += pad(hour % 12 || 12); break;
      case 'M': out += pad(minute); break;
      case 'S': out += pad(second); break;
      case 'p': out += hour < 12 ? 'AM' : 'PM'; break;
      case 's': out += String(Math.floor(date.getTime() / 1000)); break;
      case 'N': out += nanoseconds; break;
      case 'F': out += `${pad(year, 4)}-${pad(month)}-${pad(day)}`; break;
      case 'T': out += `${pad(hour)}:${pad(minute)}:${pad(second)}`; break;
      case 'z': out += zone(''); break;
      default: out += `%${next ?? ''}`;
    }
  }
  return out;
}

// ---- The template ----

const historySchema = z.strictObject({
  /** One turn as the owner's request writes it: {{role}} where the speaker goes, {{text}} where the words go. */
  turn: jsonSchema,
  /** The request's own names of the customer and the agent. */
  roles: z.strictObject({ user: z.string().trim().min(1).max(100), assistant: z.string().trim().min(1).max(100) }),
});
const sessionSchema = z.strictObject({
  /** Where each reply names the conversation; unknown until the connection check saw a reply. */
  reply: pointerSchema.optional(),
  /** What the first request sends, before the agent named its conversation (the curl's value for a new one). */
  first: jsonSchema,
});

/** The template's texts where placeholders stand: body strings (the conversation markers aside), headers, the first session value. */
function templateTexts(template: { body: Json; headers: Record<string, string>; session?: { first: Json } | undefined }): string[] {
  return [...markerFree(template.body), ...Object.values(template.headers), ...(template.session ? markerFree(template.session.first) : [])];
}
const markerFree = (value: Json): string[] => stringFields(value).map(field => field.value).filter(text => text !== HISTORY && text !== HISTORY_BEFORE);
/** The conversation markers of a body: array elements that are exactly {{history}} or {{history:before}}. */
const markers = (value: Json): string[] => Array.isArray(value) ? value.flatMap(item => item === HISTORY || item === HISTORY_BEFORE ? [item] : markers(item))
  : value && typeof value === 'object' ? Object.values(value).flatMap(markers) : [];
const unknownIn = (text: string, known: RegExp) => [...text.matchAll(BRACES)].map(m => m[0]).filter(m => !new RegExp(`^${known.source}$`).test(m));
const timeFormats = (text: string) => [...text.matchAll(TURN_PLACEHOLDER)].map(m => m[1]!).filter(name => name.startsWith('now:'))
  .map(name => name.startsWith('now:utc:') ? name.slice('now:utc:'.length) : name.slice('now:'.length));

export const requestTemplateSchema = z.strictObject({
  body: jsonSchema,
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/, 'Invalid header name'), z.string().max(4000)).default({}),
  /** Where the agent's text is in its reply; unset until the owner picks it from `agent-lab doctor`. */
  reply: pointerSchema.optional(),
  /** The conversation travels in the request as its turns: the body's {{history}} element is where they go. */
  history: historySchema.optional(),
  /** The agent names the conversation in its replies: the body's {{session}} is the id the previous reply gave. */
  session: sessionSchema.optional(),
}).superRefine((template, ctx) => {
  const texts = templateTexts(template);
  const turnTexts = template.history ? markerFree(template.history.turn) : [];
  const unknown = [...new Set([...texts.flatMap(text => unknownIn(text, PLACEHOLDER)), ...turnTexts.flatMap(text => unknownIn(text, TURN_PLACEHOLDER))])];
  if (unknown.length) ctx.addIssue({ code: 'custom', message: `Неизвестные подстановки в шаблоне: ${unknown.join(', ')}. Доступны {{message}}, {{conversation}}, {{session}}, {{uuid}}, {{now}}, {{env:ИМЯ}} и {{history}}.` });
  const formats = [...texts, ...turnTexts].flatMap(timeFormats).filter(format => !timeFormatSupported(format));
  if (formats.length) ctx.addIssue({ code: 'custom', message: `Формат времени ${formats.join(', ')} Lab не знает: оставьте {{now}}.` });
  const found = markers(template.body);
  if (found.length > 1) ctx.addIssue({ code: 'custom', path: ['body'], message: 'В теле запроса больше одного места для истории разговора.' });
  if (!!template.history !== (found.length === 1)) ctx.addIssue({ code: 'custom', path: ['history'], message: 'История разговора нужна и в теле запроса ({{history}}), и в описании реплики (history).' });
  if (template.history && !turnTexts.some(text => text.includes('{{text}}'))) ctx.addIssue({ code: 'custom', path: ['history', 'turn'], message: 'В описании реплики нет {{text}}: агент не получит слова разговора.' });
  const message = texts.some(text => text.includes('{{message}}')) || found.includes(HISTORY);
  if (!message) ctx.addIssue({ code: 'custom', path: ['body'], message: 'В теле запроса нет {{message}}: агент не получит сообщение клиента.' });
  if (!!template.session !== [...markerFree(template.body), ...Object.values(template.headers)].some(text => text.includes('{{session}}')))
    ctx.addIssue({ code: 'custom', path: ['session'], message: 'Идентификатор разговора от агента нужен и в запросе ({{session}}), и в описании (session).' });
  if (template.session && markerFree(template.session.first).some(text => text.includes('{{session}}')))
    ctx.addIssue({ code: 'custom', path: ['session', 'first'], message: 'Первый запрос не может ждать идентификатора, который агент ещё не назвал.' });
  // A turn inside a turn would never end.
  if ([template.history?.turn, template.session?.first].some(value => value !== undefined && markers(value).length))
    ctx.addIssue({ code: 'custom', path: ['history'], message: 'История разговора стоит только в теле запроса, не внутри реплики.' });
});
export type RequestTemplate = z.infer<typeof requestTemplateSchema>;

/** The environment variables a template and its address read, each once: the owner sets them before Pi starts. */
export function templateVariables(template: RequestTemplate, address = ''): string[] {
  const texts = [...templateTexts(template), ...(template.history ? markerFree(template.history.turn) : []), address];
  return [...new Set(texts.flatMap(text => [...text.matchAll(ENV_PLACEHOLDER)].map(m => m[1]!)))];
}
/** The environment variables an address reads: {{env:NAME}} values of its query. */
export const addressVariables = (address: string): string[] => [...new Set([...address.matchAll(ENV_PLACEHOLDER)].map(m => m[1]!))];

// ---- Rendering one request ----

/** One turn of a dialogue: whose it is and what was said. */
export interface Turn { role: 'user' | 'assistant'; text: string }
/** The values of one request. */
export interface RequestValues {
  message: string;
  conversation: string;
  /** The dialogue so far, the new message last; without it the request carries the new message alone. */
  turns?: readonly Turn[];
  /** The id the agent named in its previous reply; undefined before it named one. */
  session?: string | number;
}
interface Rendering { template: RequestTemplate; values: RequestValues; uuid: string; now: Date }

/**
 * A dialogue's id as a positive whole number, for an agent whose conversations are numbered: the same in every turn of
 * it. A stand keeps the conversations of every run, so the number is drawn from every safe JSON integer (1 … 2^53 − 1):
 * in 31 bits, 200 000 conversations shared a number ten times over, and the agent would have mixed them.
 */
export const conversationNumber = (conversation: string): number =>
  Number(BigInt(`0x${createHash('sha256').update(conversation).digest('hex').slice(0, 16)}`) % BigInt(Number.MAX_SAFE_INTEGER)) + 1;

function environment(variable: string): string {
  const value = process.env[variable];
  if (!value) throw new Error(`Не задана переменная окружения ${variable} для шаблона запроса. Задайте её перед запуском Pi.`);
  return value;
}

function textValue(name: string, r: Rendering, turn?: Turn & { name: string }): string {
  if (name === 'message') return r.values.message;
  if (name === 'conversation') return r.values.conversation;
  if (name === 'conversation:number') return String(conversationNumber(r.values.conversation));
  if (name === 'session') { const value = sessionValue(r); return typeof value === 'string' || typeof value === 'number' ? String(value) : ''; }
  if (name === 'uuid') return r.uuid;
  if (name === 'uuid:hex') return r.uuid.replaceAll('-', '');
  if (name === 'now') return r.now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  if (name.startsWith('now:utc:')) return formatTime(r.now, name.slice('now:utc:'.length), true);
  if (name.startsWith('now:')) return formatTime(r.now, name.slice('now:'.length), false);
  if (name === 'role' && turn) return turn.name;
  if (name === 'text' && turn) return turn.text;
  return environment(name.slice('env:'.length));
}

const renderText = (text: string, r: Rendering, turn?: Turn & { name: string }): string =>
  text.replace(turn ? TURN_PLACEHOLDER : PLACEHOLDER, (_, name: string) => textValue(name, r, turn));

/** The conversation id this request sends: the one the agent named, or the first value before it named one. */
function sessionValue(r: Rendering): Json {
  if (r.values.session !== undefined) return r.values.session;
  return r.template.session ? renderJson(r.template.session.first, r) : '';
}

function renderJson(value: Json, r: Rendering, turn?: Turn & { name: string }): Json {
  if (typeof value === 'string') {
    // Whole values keep the type the curl had: a numbered conversation stays a number.
    if (value === '{{conversation:number}}') return conversationNumber(r.values.conversation);
    if (value === '{{session}}') return sessionValue(r);
    return renderText(value, r, turn);
  }
  if (Array.isArray(value)) return value.flatMap(item => item === HISTORY || item === HISTORY_BEFORE ? historyTurns(item === HISTORY, r) : [renderJson(item, r, turn)]);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderJson(item, r, turn)]));
  return value;
}

/** The dialogue's turns in the request's own shape and role names; before the new message only, where the body carries it apart. */
function historyTurns(withMessage: boolean, r: Rendering): Json[] {
  const history = r.template.history;
  if (!history) return [];
  const turns = r.values.turns ?? [{ role: 'user' as const, text: r.values.message }];
  return (withMessage ? turns : turns.slice(0, -1)).map(turn => renderJson(history.turn, r, { ...turn, name: history.roles[turn.role] }));
}

/** One request's body and headers: {{uuid}} and {{now}} are the same everywhere within it and new in the next. */
export function renderRequest(template: RequestTemplate, values: RequestValues): { body: Json; headers: Record<string, string> } {
  const r: Rendering = { template, values, uuid: randomUUID(), now: new Date() };
  return { body: renderJson(template.body, r), headers: Object.fromEntries(Object.entries(template.headers).map(([name, text]) => [name, renderText(text, r)])) };
}

/** The agent's address with its {{env:NAME}} query values read now, encoded for the query. */
export const renderAddress = (address: string): string => address.replace(ENV_PLACEHOLDER, (_, name: string) => encodeURIComponent(environment(name)));

// ---- Reading a reply ----

/** The value at an RFC 6901 pointer, or undefined when the path is not there. */
export function atPointer(document: unknown, pointer: string): unknown {
  let current = document;
  for (const token of pointerTokens(pointer)) {
    if (Array.isArray(current)) {
      if (!INDEX.test(token)) return undefined;
      current = current[Number(token)];
    } else if (current && typeof current === 'object' && Object.hasOwn(current, token)) current = (current as Record<string, unknown>)[token];
    else return undefined;
  }
  return current;
}

const roleOf = (item: unknown): unknown => item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>).role : undefined;
/** Where the last speaker's run of an array begins: the trailing elements with the same `role` (all of them when none names one). */
function speakerRun(array: readonly unknown[]): number {
  const speaker = roleOf(array.at(-1));
  let start = array.length;
  while (start > 0 && roleOf(array[start - 1]) === speaker) start--;
  return start;
}

/** The agent's text at `pointer`, or undefined where there is none; a `-` token joins the bubbles of the last speaker's run. */
export function replyAt(document: unknown, pointer: string): string | undefined {
  const tokens = pointerTokens(pointer);
  const at = tokens.lastIndexOf('-');
  const array = at < 0 ? undefined : atPointer(document, pointerOf(tokens.slice(0, at)));
  if (Array.isArray(array)) {
    const rest = pointerOf(tokens.slice(at + 1));
    const texts = array.slice(speakerRun(array)).map(item => atPointer(item, rest)).filter((text): text is string => typeof text === 'string');
    return texts.length ? texts.filter(text => text.trim()).join('\n\n') : undefined;
  }
  const value = atPointer(document, pointer);
  return typeof value === 'string' ? value : undefined;
}

export function replyText(document: unknown, pointer: string): string {
  const text = replyAt(document, pointer);
  if (text === undefined) throw new Error(`В ответе агента нет текста по пути ${pointer || '/'}. Проверьте путь: agent-lab doctor покажет строение ответа.`);
  return text;
}

/**
 * The reply path that reads every bubble of an answer (Rasa and the like answer with an array of messages): the
 * innermost array index of `pointer` becomes `-` when the element it names is in the last speaker's run, so a later
 * reply of two bubbles is read whole and the echo of the customer's own words never is.
 */
export function bubblePointer(document: unknown, pointer: string): string {
  const tokens = pointerTokens(pointer);
  for (let at = tokens.length - 1; at >= 0; at--) {
    const array = atPointer(document, pointerOf(tokens.slice(0, at)));
    if (!Array.isArray(array) || !INDEX.test(tokens[at]!)) continue;
    return Number(tokens[at]) >= speakerRun(array) ? pointerOf([...tokens.slice(0, at), '-', ...tokens.slice(at + 1)]) : pointer;
  }
  return pointer;
}

/** The reply's structure for the owner: where its strings are and how long they are — never their values. */
export function replyStructure(document: unknown): { pointer: string; length: number }[] {
  return stringFields(document).slice(0, 100).map(field => ({ pointer: field.pointer, length: field.value.length }));
}
