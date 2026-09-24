/*
 * A curl command line → the request an HTTP agent in its own format expects (http-template.ts).
 *
 *   curl text ──shell words (quotes, \, $(...), $NAME)──► url · method · headers · -d body
 *            ──owner's choices (the message field, the conversation fields)──► http target with a request template
 *
 * The parse is of a command line's structure: quoting and substitutions are shell syntax, and header names and
 * JSON keys are structure, so reading them is not reading human text. What a substitution meant is decided by the
 * name it stands under: a time (Request-Time, *time*, *date*) becomes {{now}}, an id becomes {{uuid}}, a shell
 * variable becomes {{env:NAME}}; anything else stays literal with a warning. A header that looks secret never
 * reaches the file: it becomes a named environment variable (headersEnv), read at request time.
 */

import { runnableTargetSchema, type RunnableTarget } from './target-schema.js';
import { stringFields } from './http-template.js';

/** One piece of a shell word: literal text, a command substitution `$(...)` or a variable `$NAME`/`${NAME}`. */
type Part = { kind: 'text'; value: string } | { kind: 'command'; value: string } | { kind: 'variable'; name: string };
type Word = Part[];

const NAME_START = (c: string | undefined) => !!c && (c === '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'));
const NAME_CHAR = (c: string | undefined) => NAME_START(c) || (!!c && c >= '0' && c <= '9');

/** Splits a command line into words the way a POSIX shell would, keeping substitutions as parts instead of running them. */
export function shellWords(line: string): Word[] {
  const words: Word[] = [];
  let word: Word | undefined;
  let i = 0;
  const text = (value: string) => {
    word ??= [];
    const last = word.at(-1);
    if (last?.kind === 'text') last.value += value; else word.push({ kind: 'text', value });
  };
  const substitution = (): boolean => {
    // At `$`: a command substitution with nested parentheses, a braced or plain variable; a lone `$` is literal.
    if (line[i + 1] === '(') {
      let depth = 1, j = i + 2;
      for (; j < line.length && depth > 0; j++) { if (line[j] === '(') depth++; else if (line[j] === ')') depth--; }
      if (depth > 0) throw new Error('В команде curl не закрыта скобка $(…).');
      (word ??= []).push({ kind: 'command', value: line.slice(i, j) });
      i = j; return true;
    }
    if (line[i + 1] === '{') {
      const end = line.indexOf('}', i + 2);
      if (end < 0) throw new Error('В команде curl не закрыта скобка ${…}.');
      (word ??= []).push({ kind: 'variable', name: line.slice(i + 2, end) });
      i = end + 1; return true;
    }
    if (!NAME_START(line[i + 1])) return false;
    let j = i + 1;
    while (NAME_CHAR(line[j])) j++;
    (word ??= []).push({ kind: 'variable', name: line.slice(i + 1, j) });
    i = j; return true;
  };
  while (i < line.length) {
    const c = line[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { if (word) { words.push(word); word = undefined; } i++; continue; }
    if (c === '\\') { if (line[i + 1] === '\n') i += 2; else if (line[i + 1] === '\r' && line[i + 2] === '\n') i += 3; else { text(line[i + 1] ?? ''); i += 2; } continue; }
    if (c === '#' && !word) { while (i < line.length && line[i] !== '\n') i++; continue; }
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) throw new Error('В команде curl не закрыта одинарная кавычка.');
      text(line.slice(i + 1, end)); i = end + 1; continue;
    }
    if (c === '$' && line[i + 1] === "'") {
      // ANSI-C quoting: the common escapes only.
      const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' };
      let j = i + 2, value = '';
      for (; j < line.length && line[j] !== "'"; j++) value += line[j] === '\\' ? escapes[line[++j] ?? ''] ?? `\\${line[j] ?? ''}` : line[j];
      if (j >= line.length) throw new Error('В команде curl не закрыта кавычка $\'…\'.');
      text(value); i = j + 1; continue;
    }
    if (c === '"') {
      text('');
      i++;
      while (i < line.length && line[i] !== '"') {
        const d = line[i]!;
        if (d === '\\' && ['$', '`', '"', '\\', '\n'].includes(line[i + 1] ?? '')) { if (line[i + 1] !== '\n') text(line[i + 1]!); i += 2; continue; }
        if (d === '$' && substitution()) continue;
        text(d); i++;
      }
      if (i >= line.length) throw new Error('В команде curl не закрыта двойная кавычка.');
      i++; continue;
    }
    if (c === '$' && substitution()) continue;
    text(c); i++;
  }
  if (word) words.push(word);
  return words;
}

const literal = (word: Word): string | undefined => word.every(part => part.kind === 'text') ? word.map(part => part.kind === 'text' ? part.value : '').join('') : undefined;
const shown = (word: Word) => word.map(part => part.kind === 'text' ? part.value : part.kind === 'command' ? part.value : `$${part.name}`).join('');

export interface CurlRequest { url: string; headers: { name: string; value: Word }[]; data: Word; timeoutMs?: number; warnings: string[] }

/** Options that take no value and change nothing Lab sends. */
const QUIET = new Set(['-s', '-S', '-L', '-i', '-v', '-f', '-N', '--silent', '--show-error', '--location', '--include', '--verbose', '--fail', '--compressed', '--no-buffer', '--http1.1', '--http2']);
const DATA = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--json']);

/** The request a curl command line sends; refuses what Lab cannot send the same way. */
export function parseCurl(source: string): CurlRequest {
  const words = shellWords(source);
  const first = words.shift();
  if (!first || literal(first) !== 'curl') throw new Error('Ожидается команда curl: она начинается со слова curl.');
  const warnings: string[] = [];
  const headers: CurlRequest['headers'] = [];
  let url: string | undefined, method: string | undefined, data: Word | undefined, timeoutMs: number | undefined;
  const plain = (word: Word | undefined, option: string) => {
    const value = word && literal(word);
    if (value === undefined) throw new Error(`Значение ${option} в команде curl должно быть задано прямо, без $(…) и переменных.`);
    return value;
  };
  const header = (word: Word) => {
    const [head, ...rest] = word;
    const text = head?.kind === 'text' ? head.value : '';
    const colon = text.indexOf(':');
    if (colon <= 0) throw new Error(`Заголовок curl без имени: «${shown(word)}». Ожидается -H 'Имя: значение'.`);
    const value: Word = [{ kind: 'text' as const, value: text.slice(colon + 1).trimStart() }, ...rest].filter(part => part.kind !== 'text' || part.value !== '');
    headers.push({ name: text.slice(0, colon).trim(), value });
  };
  while (words.length) {
    const word = words.shift()!;
    const option = word[0]?.kind === 'text' ? word[0].value : '';
    if (!option.startsWith('-') || option === '-') { url = plain(word, 'адреса'); continue; }
    // Short options may carry their value attached (-XPOST, -H'…', -d'{…}').
    const attached = option.length > 2 && !option.startsWith('--') && ['-X', '-H', '-d', '-m'].includes(option.slice(0, 2));
    const name = attached ? option.slice(0, 2) : option;
    const value = (): Word => {
      if (attached) return [{ kind: 'text', value: option.slice(2) }, ...word.slice(1)];
      const next = words.shift();
      if (!next) throw new Error(`У опции ${name} в команде curl нет значения.`);
      return next;
    };
    if (literal(word) === undefined && !attached) throw new Error(`Опция curl «${shown(word)}» не распознана.`);
    if (QUIET.has(name)) continue;
    if (/^-[sSLivfN]+$/.test(name)) continue;
    if (name === '-k' || name === '--insecure') { warnings.push('Опция -k не переносится: Lab проверяет сертификат агента.'); continue; }
    if (name === '-X' || name === '--request') { method = plain(value(), '-X').toUpperCase(); continue; }
    if (name === '-H' || name === '--header') { header(value()); continue; }
    if (name === '--url') { url = plain(value(), '--url'); continue; }
    if (name === '-m' || name === '--max-time') {
      const seconds = Number(plain(value(), '--max-time'));
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--max-time в команде curl должно быть числом секунд.');
      timeoutMs = Math.min(600000, Math.max(1000, Math.round(seconds * 1000))); continue;
    }
    if (name === '--connect-timeout') { value(); continue; }
    if (name === '-A' || name === '--user-agent') { headers.push({ name: 'User-Agent', value: value() }); continue; }
    if (name === '-b' || name === '--cookie') { headers.push({ name: 'Cookie', value: value() }); continue; }
    if (name === '-u' || name === '--user') throw new Error('Логин и пароль curl (-u) Lab не переносит: передайте их заголовком Authorization, Lab прочтёт его из переменной окружения.');
    if (DATA.has(name)) {
      if (data) throw new Error('В команде curl несколько тел запроса (-d): оставьте одно JSON-тело.');
      data = value();
      if (data[0]?.kind === 'text' && data[0].value.startsWith('@')) throw new Error('Тело запроса из файла (-d @файл) не переносится: вставьте JSON прямо в команду.');
      if (name === '--json') headers.push({ name: 'Content-Type', value: [{ kind: 'text', value: 'application/json' }] });
      continue;
    }
    throw new Error(`Опция curl ${name} не поддерживается: уберите её или задайте подключение вручную.`);
  }
  if (!url) throw new Error('В команде curl нет адреса агента.');
  if (!data) throw new Error('В команде curl нет тела запроса (-d): Lab отправляет агенту JSON.');
  if (method && method !== 'POST') throw new Error(`Lab отправляет агенту POST-запрос, а в curl указан ${method}.`);
  return { url, headers, data, ...(timeoutMs !== undefined ? { timeoutMs } : {}), warnings };
}

/** A name that stands for a moment in time or for an id: header names and JSON keys are structure, not text. */
const timeLike = (name: string) => ['time', 'date'].some(word => name.toLowerCase().includes(word));
const idLike = (name: string) => { const lower = name.toLowerCase(); return lower.endsWith('id') || lower.endsWith('uuid'); };
const SECRET = ['authorization', 'token', 'cookie', 'api-key', 'apikey', 'secret', 'password'];
const secretLike = (name: string) => SECRET.some(word => name.toLowerCase().includes(word));
/** Keys Lab takes for the conversation id when the owner names none: *conversation*id, *dialog*id, *session*id. */
const conversationLike = (key: string) => {
  const lower = key.toLowerCase();
  return ['conversation', 'dialog', 'session'].some(word => { const at = lower.indexOf(word); return at >= 0 && lower.slice(at + word.length).endsWith('id'); });
};
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,99}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/;
/** Set by the HTTP client itself: sending the curl's copy would be wrong or refused. */
const TRANSPORT_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);

const decodeToken = (token: string) => token.replaceAll('~1', '/').replaceAll('~0', '~');
const lastKey = (pointer: string) => decodeToken(pointer.slice(pointer.lastIndexOf('/') + 1));

function setAt(document: unknown, pointer: string, value: string): void {
  const tokens = pointer.slice(1).split('/').map(decodeToken);
  const key = tokens.pop()!;
  let current = document as Record<string, unknown>;
  for (const token of tokens) current = current[token] as Record<string, unknown>;
  current[key] = value;
}

function mapStrings(value: unknown, fn: (pointer: string, text: string) => string, pointer = ''): unknown {
  if (typeof value === 'string') return fn(pointer, value);
  if (Array.isArray(value)) return value.map((item, i) => mapStrings(item, fn, `${pointer}/${i}`));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, mapStrings(item, fn, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`)]));
  return value;
}

export interface CurlChoices {
  /** JSON pointer of the body's string field that carries the customer's message. */
  message?: string;
  /** JSON pointers of the conversation id fields; by default the keys named like one. */
  conversation?: string[];
}
/** Where in the request a substitution stands: a header by name, a body field by pointer. */
type Place = { header: string } | { pointer: string };
/** A part of the request Lab fills in itself on every request: a time, a fresh id or an environment variable. */
export type Substitution = Place & { by: 'now' | 'uuid' | 'env'; variable?: string };
const placeText = (place: Place): string => 'header' in place ? `Заголовок ${place.header}` : `Поле ${place.pointer}`;
/** The request's text fields, to pick the message from; `value` is the curl's own text (the owner's test request, a placeholder where Lab substitutes). */
export interface CurlFields { kind: 'ask_message'; url: string; fields: { pointer: string; length: number; value: string }[]; warnings: string[] }
export interface CurlReady { kind: 'ready'; target: RunnableTarget; message: string; conversation: string[]; substitutions: Substitution[]; lines: string[]; warnings: string[] }
export type CurlConnection = CurlFields | CurlReady;

/** The fields Lab takes for the conversation id when the owner names none: the keys named like one. */
export const conversationFields = (pointers: readonly string[]): string[] => pointers.filter(pointer => conversationLike(lastKey(pointer)));

/** A curl command and the owner's choices → an http target in the agent's own format, with what Lab did said in plain words. */
export function connectionFromCurl(source: string): CurlFields;
export function connectionFromCurl(source: string, choices: CurlChoices & { message: string }): CurlReady;
export function connectionFromCurl(source: string, choices: CurlChoices): CurlConnection;
export function connectionFromCurl(source: string, choices: CurlChoices = {}): CurlConnection {
  const request = parseCurl(source);
  const warnings = [...request.warnings];
  const substitutions: Substitution[] = [];
  // A substitution's meaning is read from the name it stands under.
  const resolve = (part: Part, name: string, place: Place): string => {
    const where = placeText(place);
    if (part.kind === 'text') return part.value;
    if (part.kind === 'variable') {
      if (ENV_NAME.test(part.name)) { substitutions.push({ ...place, by: 'env', variable: part.name }); return `{{env:${part.name}}}`; }
      warnings.push(`${where}: переменная $${part.name} оставлена как текст — Lab читает только переменные из заглавных букв.`);
      return `$${part.name}`;
    }
    if (timeLike(name)) { substitutions.push({ ...place, by: 'now' }); return '{{now}}'; }
    if (idLike(name)) { substitutions.push({ ...place, by: 'uuid' }); return '{{uuid}}'; }
    warnings.push(`${where}: ${part.value} оставлено как текст — Lab не выполняет команды.`);
    return part.value;
  };

  const headers: Record<string, string> = {};
  const headersEnv: Record<string, string> = {};
  for (const { name, value } of request.headers) {
    if (!HEADER_NAME.test(name)) throw new Error(`Имя заголовка «${name}» Lab отправить не может: допустимы латинские буквы, цифры и дефис.`);
    if (TRANSPORT_HEADERS.has(name.toLowerCase())) continue;
    if (secretLike(name)) {
      const variable = `AGENT_LAB_${name.toUpperCase().replaceAll('-', '_')}`;
      headersEnv[name] = variable;
      continue;
    }
    headers[name] = value.map(part => resolve(part, name, { header: name })).join('');
  }

  // Substitutions inside the JSON body stand in as private-use markers, so the body parses as JSON first.
  const parts: Part[] = [];
  const raw = request.data.map(part => part.kind === 'text' ? part.value : `${parts.push(part) - 1}`).join('');
  let body: unknown;
  try { body = JSON.parse(raw); } catch { throw new Error('Тело запроса curl не является JSON: Lab отправляет агенту JSON.'); }
  if (!body || typeof body !== 'object') throw new Error('Тело запроса curl должно быть JSON-объектом.');
  body = mapStrings(body, (pointer, text) => {
    if (!text.includes('')) return text;
    let out = '';
    for (const piece of text.split('')) {
      const end = piece.indexOf('');
      if (end < 0) { out += piece; continue; }
      out += resolve(parts[Number(piece.slice(0, end))]!, lastKey(pointer), { pointer }) + piece.slice(end + 1);
    }
    return out;
  });

  const fields = stringFields(body);
  const known = new Set(fields.map(field => field.pointer));
  if (choices.message === undefined) return { kind: 'ask_message', url: request.url, fields: fields.map(field => ({ pointer: field.pointer, length: field.value.length, value: field.value })), warnings };
  if (!known.has(choices.message)) throw new Error(`В теле запроса нет строкового поля ${choices.message}. Строковые поля: ${[...known].join(', ') || 'нет'}.`);
  const conversation = choices.conversation ?? conversationFields(fields.map(field => field.pointer)).filter(pointer => pointer !== choices.message);
  for (const pointer of conversation) {
    if (!known.has(pointer)) throw new Error(`В теле запроса нет строкового поля ${pointer} для идентификатора разговора.`);
    if (pointer === choices.message) throw new Error('Одно и то же поле не может быть и сообщением клиента, и идентификатором разговора.');
  }
  setAt(body, choices.message, '{{message}}');
  for (const pointer of conversation) setAt(body, pointer, '{{conversation}}');
  const lines = [`Адрес агента: ${request.url}`, `Сообщение клиента → ${choices.message}`,
    ...(conversation.length ? [`Идентификатор разговора → ${conversation.join(', ')}: новый в каждой ситуации, так агент начинает её с чистого листа`] : []),
    ...substitutions.map(({ by, variable, ...place }) => `${placeText(place)}: ${by === 'now' ? 'текущее время' : by === 'uuid' ? 'новый id' : `из переменной окружения ${variable}`} при каждом запросе`),
    ...Object.entries(headersEnv).map(([name, variable]) => `Заголовок ${name} похож на секрет: в файл он не записан. Задайте переменную ${variable} с его значением перед запуском.`)];
  if (!conversation.length) warnings.push('Поле идентификатора разговора не найдено: агент может смешать ситуации.');
  const parsed = runnableTargetSchema.safeParse({ kind: 'http', url: request.url, headersEnv, ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}), request: { body, headers } });
  if (!parsed.success) throw new Error(`Подключение из curl не сложилось: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
  return { kind: 'ready', target: parsed.data, message: choices.message, conversation, substitutions, lines, warnings };
}
