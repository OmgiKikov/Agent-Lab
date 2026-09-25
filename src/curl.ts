/*
 * A curl command line → the request an HTTP agent in its own format expects (http-template.ts).
 *
 *   curl text ──words (POSIX quotes, \, $(...), $NAME; Windows cmd ^, "…", %NAME%)──► url · headers · -d body
 *            ──the owner's choices (the message field, the conversation fields)──► http target with a request template
 *
 * The parse is of a command line's structure: quoting and substitutions are shell syntax, and header names, JSON keys
 * and query names are structure, so reading them is not reading human text. A substitution keeps the format of its
 * command where Lab knows the command (`date -u +%s`, `uuidgen | tr -d -`); otherwise its meaning is read from the
 * name it stands under. A secret reaches neither the file nor a model: every header but the plainly harmless ones, and
 * every body field or query value named like a key, is read from an environment variable at request time — the
 * owner's own `$NAME` where the curl names one, a named AGENT_LAB_… variable where the curl holds the value itself.
 * The conversation is read from the body's structure: turns with roles (OpenAI-style `messages`) travel whole every
 * turn; an id field is Lab's fresh id per dialogue, a number where the curl had a number, the agent's own id where
 * the curl left it empty.
 */

import { runnableTargetSchema, type RunnableTarget } from './target-schema.js';
import { HISTORY, HISTORY_BEFORE, atPointer, envNameSchema, pointerOf, pointerTokens, timeFormatSupported, type Json } from './http-template.js';

/** One piece of a shell word: literal text, a command substitution `$(...)`, a variable, or a control operator (`|`, `;`, `&`, `<`, `>`). */
type Part = { kind: 'text'; value: string } | { kind: 'command'; value: string } | { kind: 'variable'; name: string } | { kind: 'operator'; value: string };
type Word = Part[];

const NAME_START = (c: string | undefined) => !!c && (c === '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'));
const NAME_CHAR = (c: string | undefined) => NAME_START(c) || (!!c && c >= '0' && c <= '9');
const OPERATORS = '|;&<>';
const isName = (name: string) => NAME_START(name[0]) && [...name].every(NAME_CHAR);

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
    // A backtick at the end of a line continues a PowerShell command.
    if (c === '`' && (line[i + 1] === '\n' || line[i + 1] === '\r' && line[i + 2] === '\n')) { i += line[i + 1] === '\n' ? 2 : 3; continue; }
    if (c === '#' && !word) { while (i < line.length && line[i] !== '\n') i++; continue; }
    if (OPERATORS.includes(c)) { if (word) { words.push(word); word = undefined; } words.push([{ kind: 'operator', value: c }]); i++; continue; }
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

/** A command line written for Windows cmd: lines continued with `^`, or quotes escaped as `^"` («Copy as cURL (cmd)»). */
const windowsCmd = (line: string) => line.includes('^"') || line.split('\n').slice(0, -1).some(row => row.trimEnd().endsWith('^'));

/** Splits a Windows cmd line: first what cmd does (carets, %NAME%, operators outside quotes), then argv quoting as a program reads it. */
function cmdWords(line: string): Word[] {
  type Token = { char: string; operator?: true } | { variable: string };
  const tokens: Token[] = [];
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '^' && !quoted) {
      if (line[i + 1] === '\n') { i++; continue; }
      if (line[i + 1] === '\r' && line[i + 2] === '\n') { i += 2; continue; }
      if (i + 1 < line.length) tokens.push({ char: line[++i]! });
      continue;
    }
    if (c === '%') {
      const end = line.indexOf('%', i + 1);
      const name = end < 0 ? '' : line.slice(i + 1, end);
      if (isName(name)) { tokens.push({ variable: name }); i = end; continue; }
    }
    if (c === '"') quoted = !quoted;
    tokens.push(!quoted && OPERATORS.includes(c) ? { char: c, operator: true } : { char: c });
  }
  // A program's argv (MSVC rules): quotes group; 2n backslashes before a quote are n and the quote toggles, 2n+1 are n and a literal quote.
  const words: Word[] = [];
  let word: Word | undefined, inQuotes = false;
  const text = (value: string) => { word ??= []; const last = word.at(-1); if (last?.kind === 'text') last.value += value; else word.push({ kind: 'text', value }); };
  const char = (at: number) => { const token = tokens[at]; return token && 'char' in token ? token.char : undefined; };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if ('variable' in token) { (word ??= []).push({ kind: 'variable', name: token.variable }); continue; }
    const c = token.char;
    if (token.operator) { if (word) { words.push(word); word = undefined; } words.push([{ kind: 'operator', value: c }]); continue; }
    if (!inQuotes && (c === ' ' || c === '\t' || c === '\n' || c === '\r')) { if (word) { words.push(word); word = undefined; } continue; }
    if (c === '\\') {
      let n = 1;
      while (char(i + n) === '\\') n++;
      if (char(i + n) === '"') { text('\\'.repeat(Math.floor(n / 2))); if (n % 2) { text('"'); i += n; } else i += n - 1; continue; }
      text('\\'.repeat(n)); i += n - 1; continue;
    }
    if (c === '"') { word ??= []; inQuotes = !inQuotes; continue; }
    text(c);
  }
  if (word) words.push(word);
  return words;
}

const literal = (word: Word): string | undefined => word.every(part => part.kind === 'text') ? word.map(part => part.kind === 'text' ? part.value : '').join('') : undefined;
const shown = (word: Word) => word.map(part => part.kind === 'variable' ? `$${part.name}` : part.value).join('');

/** `url` as the curl writes it (a variable as $NAME); `address` its parts, variables kept. */
export interface CurlRequest { url: string; address: Word; headers: { name: string; value: Word }[]; data: Word; timeoutMs?: number; warnings: string[] }

/** Options that take no value and change nothing Lab sends. */
const QUIET = new Set(['-s', '-S', '-L', '-i', '-v', '-f', '-N', '-g', '--silent', '--show-error', '--location', '--include', '--verbose', '--fail', '--compressed', '--no-buffer', '--globoff', '--http1.1', '--http2']);
const DATA = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--json']);

/** The request a curl command line sends; refuses what Lab cannot send the same way. */
export function parseCurl(source: string): CurlRequest {
  const words = windowsCmd(source) ? cmdWords(source) : shellWords(source);
  const first = words.shift();
  const program = first && literal(first);
  if (program !== 'curl' && program !== 'curl.exe') throw new Error('Ожидается команда curl: она начинается со слова curl.');
  const warnings: string[] = [];
  const headers: CurlRequest['headers'] = [];
  const urls: Word[] = [];
  let method: string | undefined, data: Word | undefined, timeoutMs: number | undefined;
  const plain = (word: Word | undefined, option: string) => {
    const value = word && literal(word);
    if (value === undefined) throw new Error(`Значение ${option} в команде curl должно быть задано прямо, без $(…) и переменных.`);
    return value;
  };
  const header = (word: Word) => {
    const [head, ...rest] = word;
    const text = head?.kind === 'text' ? head.value : '';
    const colon = text.indexOf(':');
    if (colon <= 0) throw new Error('В команде curl заголовок без имени. Ожидается -H \'Имя: значение\'.');
    const value: Word = [{ kind: 'text' as const, value: text.slice(colon + 1).trimStart() }, ...rest].filter(part => part.kind !== 'text' || part.value !== '');
    headers.push({ name: text.slice(0, colon).trim(), value });
  };
  while (words.length) {
    const word = words.shift()!;
    if (word[0]?.kind === 'operator') {
      // `| jq .`, `> reply.json`, `&& …`: the rest is another command; Lab reads the agent's reply itself.
      warnings.push(`Часть команды после «${word[0].value}» Lab не выполняет: ответ агента он читает сам.`);
      break;
    }
    const option = word[0]?.kind === 'text' ? word[0].value : '';
    if (!option.startsWith('-') || option === '-') { urls.push(word); continue; }
    // Short options may carry their value attached (-XPOST, -H'…', -d'{…}').
    const attached = option.length > 2 && !option.startsWith('--') && ['-X', '-H', '-d', '-m'].includes(option.slice(0, 2));
    const name = attached ? option.slice(0, 2) : option;
    const value = (): Word => {
      if (attached) return [{ kind: 'text', value: option.slice(2) }, ...word.slice(1)];
      const next = words.shift();
      if (!next || next[0]?.kind === 'operator') throw new Error(`У опции ${name} в команде curl нет значения.`);
      return next;
    };
    if (literal(word) === undefined && !attached) throw new Error(`Опция curl «${shown(word)}» не распознана.`);
    if (QUIET.has(name)) continue;
    if (/^-[sSLivfNg]+$/.test(name)) continue;
    if (name === '-k' || name === '--insecure') { warnings.push('Опция -k не переносится: Lab проверяет сертификат агента.'); continue; }
    if (name === '-X' || name === '--request') { method = plain(value(), '-X').toUpperCase(); continue; }
    if (name === '-H' || name === '--header') { header(value()); continue; }
    if (name === '--url') { urls.push(value()); continue; }
    if (name === '-m' || name === '--max-time') {
      const seconds = Number(plain(value(), '--max-time'));
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--max-time в команде curl должно быть числом секунд.');
      timeoutMs = Math.min(600000, Math.max(1000, Math.round(seconds * 1000))); continue;
    }
    if (name === '--connect-timeout') { value(); continue; }
    if (name === '-A' || name === '--user-agent') { headers.push({ name: 'User-Agent', value: value() }); continue; }
    if (name === '-b' || name === '--cookie') { headers.push({ name: 'Cookie', value: value() }); continue; }
    if (name === '-u' || name === '--user') throw new Error('Логин и пароль curl (-u) Lab не переносит: передайте их заголовком Authorization через переменную окружения, например -H "Authorization: Basic $AGENT_BASIC".');
    if (DATA.has(name)) {
      if (data) throw new Error('В команде curl несколько тел запроса (-d): оставьте одно JSON-тело.');
      data = value();
      if (data[0]?.kind === 'text' && data[0].value.startsWith('@')) throw new Error('Тело запроса из файла (-d @файл) не переносится: вставьте JSON прямо в команду.');
      if (name === '--json') headers.push({ name: 'Content-Type', value: [{ kind: 'text', value: 'application/json' }] });
      continue;
    }
    throw new Error(`Опция curl ${name} не поддерживается: уберите её или задайте подключение вручную.`);
  }
  if (!urls.length) throw new Error('В команде curl нет адреса агента.');
  if (urls.length > 1) throw new Error(`В команде curl несколько адресов: ${urls.map(url => `«${shown(url)}»`).join(', ')}. Оставьте один — адрес агента.`);
  if (!data) throw new Error('В команде curl нет тела запроса (-d): Lab отправляет агенту JSON.');
  if (method && method !== 'POST') throw new Error(`Lab отправляет агенту POST-запрос, а в curl указан ${method}.`);
  return { url: shown(urls[0]!), address: urls[0]!, headers, data, ...(timeoutMs !== undefined ? { timeoutMs } : {}), warnings };
}

// ---- Names: structure that says what a value is ----

/** The words of a key or header name: `api_key`, `apiKey`, `X-Api-Key` → api, key. */
function nameWords(name: string): string[] {
  const words: string[] = [];
  let current = '';
  for (let i = 0; i < name.length; i++) {
    const c = name[i]!, lower = c.toLowerCase();
    const letterOrDigit = NAME_CHAR(c) && c !== '_';
    if (!letterOrDigit) { if (current) words.push(current); current = ''; continue; }
    // camelCase: a capital after a small letter starts a word.
    if (current && c !== lower && name[i - 1] === name[i - 1]!.toLowerCase() && name[i - 1] !== name[i - 1]!.toUpperCase()) { words.push(current); current = ''; }
    current += lower;
  }
  if (current) words.push(current);
  return words;
}
const timeLike = (name: string) => ['time', 'date'].some(word => name.toLowerCase().includes(word));
const idLike = (name: string) => { const lower = name.toLowerCase(); return lower.endsWith('id') || lower.endsWith('uuid'); };
/** Last words that name a credential: `api_key`, `access_token`, `client_secret` hold one; `token_type` and `max_tokens` do not. */
const CREDENTIAL = new Set(['key', 'apikey', 'token', 'secret', 'password', 'passwd', 'pwd', 'credential', 'credentials', 'auth', 'authorization', 'signature', 'cookie']);
const credentialName = (name: string): boolean => CREDENTIAL.has(nameWords(name).at(-1) ?? '');
/** Headers that never carry a secret; every other header is read from the environment unless the curl names a variable for it. */
const HARMLESS = new Set(['accept', 'accept-language', 'content-type', 'content-language', 'user-agent', 'origin', 'referer', 'cache-control', 'pragma', 'priority', 'dnt', 'upgrade-insecure-requests', 'x-requested-with']);
const harmless = (name: string) => { const lower = name.toLowerCase(); return HARMLESS.has(lower) || lower.startsWith('sec-ch-') || lower.startsWith('sec-fetch-'); };
/** Keys Lab takes for the conversation id when the owner names none: *conversation*id, *dialog*id, *session*id; chat_id and thread_id exactly. */
const conversationLike = (key: string) => {
  const lower = key.toLowerCase();
  if (['conversation', 'dialog', 'session'].some(word => { const at = lower.indexOf(word); return at >= 0 && lower.slice(at + word.length).endsWith('id'); })) return true;
  // A chatbot_id names the bot, not the conversation: only the word itself before the id.
  return ['chat', 'thread'].some(word => ['id', '_id', '-id'].some(tail => lower === word + tail));
};
const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/;
/** Set by the HTTP client itself: sending the curl's copy would be wrong or refused. */
const TRANSPORT_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'accept-encoding']);
/** Roles that are not a speaker of the conversation: their turns stay in the request as the curl has them. */
const INSTRUCTION_ROLES = new Set(['system', 'developer']);
/** The agent's role where the curl shows only the customer's. */
const PARTNER = new Map([['user', 'assistant'], ['User', 'Assistant'], ['USER', 'ASSISTANT'], ['human', 'ai'], ['Human', 'AI'], ['customer', 'agent'], ['client', 'bot']]);

// ---- Substitutions ----

/** Stand for a substitution inside the JSON body until it is parsed; a pasted curl never holds them. */
const OPEN = '\uE000', CLOSE = '\uE001';

/** What a command substitution produces, where Lab knows the command: a time in its format, or a fresh id. */
function commandValue(command: string): { placeholder: string } | undefined {
  let words: Word[];
  try { words = shellWords(command.slice(2, -1)); } catch { return undefined; }
  const stages: string[][] = [[]];
  for (const word of words) {
    if (word[0]?.kind === 'operator') { if (word[0].value !== '|') return undefined; stages.push([]); continue; }
    const text = literal(word);
    if (text === undefined) return undefined;
    stages.at(-1)!.push(text);
  }
  const [program = [], ...filters] = stages;
  let hex = false;
  for (const filter of filters) {
    // `tr -d -` drops the dashes of an id; changing its letter case changes nothing Lab sends.
    if (filter[0] === 'tr' && filter[1] === '-d' && filter[2]?.includes('-')) hex = true;
    else if (filter[0] !== 'tr' || filter.length !== 3) return undefined;
  }
  const script = program.slice(2).join(' ');
  if (program[0] === 'date' && !filters.length) return dateValue(program.slice(1));
  if (program[0] === 'uuidgen' || program[0] === 'cat' && program[1] === '/proc/sys/kernel/random/uuid') return { placeholder: hex ? '{{uuid:hex}}' : '{{uuid}}' };
  if (program[0] === 'openssl' && program[1] === 'rand' && program[2] === '-hex' && program[3] === '16') return { placeholder: '{{uuid:hex}}' };
  if ((program[0] === 'python' || program[0] === 'python3') && program[1] === '-c' && script.includes('uuid4()'))
    return { placeholder: hex || script.includes('uuid4().hex') ? '{{uuid:hex}}' : '{{uuid}}' };
  if (program[0] === 'node' && program[1] === '-e' && script.includes('randomUUID()')) return { placeholder: hex ? '{{uuid:hex}}' : '{{uuid}}' };
  if (program[0] === 'node' && program[1] === '-e' && script.includes('Date.now()') && !filters.length) return { placeholder: '{{now:%s%3N}}' };
  return undefined;
}

/** `date` arguments → the time in the same format; undefined where Lab does not render it (another moment, a locale format). */
function dateValue(args: string[]): { placeholder: string } | undefined {
  const ISO = new Map([['date', '%F'], ['hours', '%Y-%m-%dT%H%:z'], ['minutes', '%Y-%m-%dT%H:%M%:z'], ['seconds', '%Y-%m-%dT%H:%M:%S%:z'], ['ns', '%Y-%m-%dT%H:%M:%S,%N%:z']]);
  let utc = false, format: string | undefined;
  for (const arg of args) {
    if (arg === '-u' || arg === '--utc' || arg === '--universal') utc = true;
    else if (arg.startsWith('+')) format = arg.slice(1);
    else if (arg === '-I' || arg === '--iso-8601') format = ISO.get('date');
    else if (arg.startsWith('-I') && ISO.has(arg.slice(2))) format = ISO.get(arg.slice(2));
    else if (arg.startsWith('--iso-8601=') && ISO.has(arg.slice('--iso-8601='.length))) format = ISO.get(arg.slice('--iso-8601='.length));
    else return undefined;
  }
  if (!format || format.length > 60 || format.includes('{') || format.includes('}') || !timeFormatSupported(format)) return undefined;
  return { placeholder: utc ? `{{now:utc:${format}}}` : `{{now:${format}}}` };
}

export interface CurlChoices {
  /** JSON pointer of the body's string field that carries the customer's message. */
  message?: string;
  /** JSON pointers of the conversation id fields; by default the keys named like one. */
  conversation?: string[];
}
/** Where in the request a value stands: a header by name, a body field by pointer, a query value of the address by name. */
export type Place = { header: string } | { pointer: string } | { query: string };
/** A part of the request Lab fills in itself on every request: a time, a fresh id or an environment variable. */
export type Substitution = Place & { by: 'now' | 'uuid' | 'env'; variable?: string };
/** A value of the curl that is a secret: it is not written anywhere, Lab reads it from `variable` at request time. */
export type Secret = Place & { variable: string };
/** A body field Lab may fill: its pointer and the curl's own value (a placeholder where Lab substitutes). */
export interface CurlField { pointer: string; value: string | number | null; length: number }
/** The conversation carried as turns: where they are, the request's names of the two speakers, and whether the new message is among them. */
export interface CurlHistory { at: string; roles: { user: string; assistant: string }; withMessage: boolean; fixed: number }
/** The request's fields, to pick the message from: every string, number and empty value of the body. */
export interface CurlFields { kind: 'ask_message'; url: string; fields: CurlField[]; warnings: string[]
  /** The last turn's words where the body carries its conversation as turns: the customer's message, known without a model. */
  lastTurn?: string }
export interface CurlReady { kind: 'ready'; target: RunnableTarget; message: string; conversation: string[]; history?: CurlHistory
  substitutions: Substitution[]; secrets: Secret[]; warnings: string[] }
export type CurlConnection = CurlFields | CurlReady;

/** The fields Lab takes for the conversation id when the owner names none: the keys named like one. */
export const conversationFields = (pointers: readonly string[]): string[] => pointers.filter(pointer => conversationLike(pointerTokens(pointer).at(-1) ?? ''));

/** Every string, number and null of a JSON value with its pointer. */
function bodyFields(body: unknown, pointer = ''): CurlField[] {
  if (body === null) return [{ pointer, value: null, length: 0 }];
  if (typeof body === 'string' || typeof body === 'number') return [{ pointer, value: body, length: String(body).length }];
  if (Array.isArray(body)) return body.flatMap((item, i) => bodyFields(item, `${pointer}/${i}`));
  if (body && typeof body === 'object') return Object.entries(body).flatMap(([key, item]) => bodyFields(item, pointer + pointerOf([key])));
  return [];
}

function setAt(document: Json, pointer: string, value: Json): void {
  const tokens = pointerTokens(pointer);
  const key = tokens.pop()!;
  let current = document as Record<string, Json>;
  for (const token of tokens) current = current[token] as Record<string, Json>;
  current[key] = value;
}

function mapStrings(value: Json, fn: (pointer: string, text: string) => Json, pointer = ''): Json {
  if (typeof value === 'string') return fn(pointer, value);
  if (Array.isArray(value)) return value.map((item, i) => mapStrings(item, fn, `${pointer}/${i}`));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, fn, pointer + pointerOf([key]))]));
  return value;
}

const isObject = (value: unknown): value is Record<string, Json> => !!value && typeof value === 'object' && !Array.isArray(value);
/** A turn's words: `content`, `text` or `message` as a string, or the text of its first part (`parts: [{ text }]`). */
function turnText(turn: Record<string, Json>): string | undefined {
  for (const key of ['content', 'text', 'message']) if (typeof turn[key] === 'string') return pointerOf([key]);
  const parts = turn.parts ?? turn.content;
  if (Array.isArray(parts)) {
    const at = parts.findIndex(part => isObject(part) && typeof part.text === 'string');
    if (at >= 0) return pointerOf([Array.isArray(turn.parts) ? 'parts' : 'content', String(at), 'text']);
  }
  return undefined;
}

/** The body's list of turns with roles (OpenAI-style `messages`, Gemini `contents`): where it is. */
function turnLists(body: Json, pointer = ''): string[] {
  if (Array.isArray(body)) {
    if (body.length && body.every(isObject) && body.some(item => typeof (item as Record<string, Json>).role === 'string' && turnText(item as Record<string, Json>) !== undefined)) return [pointer];
    return body.flatMap((item, i) => turnLists(item, `${pointer}/${i}`));
  }
  return isObject(body) ? Object.entries(body).flatMap(([key, item]) => turnLists(item, pointer + pointerOf([key]))) : [];
}

/** A curl command and the owner's choices → an http target in the agent's own format, with what Lab did said in plain words. */
export function connectionFromCurl(source: string): CurlFields;
export function connectionFromCurl(source: string, choices: CurlChoices & { message: string }): CurlReady;
export function connectionFromCurl(source: string, choices: CurlChoices): CurlConnection;
export function connectionFromCurl(source: string, choices: CurlChoices = {}): CurlConnection {
  const request = parseCurl(source);
  const warnings = [...request.warnings];
  const substitutions: Substitution[] = [];
  const secrets: Secret[] = [];
  const secretValues = new Map<string, string>();
  /** A variable of its own for each secret value; one value in two places reads one variable. */
  const secret = (place: Place, name: string, value: string): string => {
    const base = `AGENT_LAB_${nameWords(name).join('_').toUpperCase() || 'SECRET'}`.slice(0, 100);
    let variable = base;
    for (let n = 2; secretValues.has(variable) && secretValues.get(variable) !== value; n++) variable = `${base.slice(0, 96)}_${n}`;
    secretValues.set(variable, value);
    secrets.push({ ...place, variable });
    return variable;
  };
  const where = (place: Place) => 'header' in place ? `Заголовок ${place.header}` : 'query' in place ? `Параметр адреса ${place.query}` : `Поле ${pointerTokens(place.pointer).join('.')}`;
  // A substitution's meaning: the command's own format where Lab knows it, else the name it stands under.
  const resolve = (part: Part, name: string, place: Place): string => {
    if (part.kind === 'text' || part.kind === 'operator') return part.value;
    if (part.kind === 'variable') {
      if (envNameSchema.safeParse(part.name).success) { substitutions.push({ ...place, by: 'env', variable: part.name }); return `{{env:${part.name}}}`; }
      warnings.push(`${where(place)}: $${part.name} оставлено как текст — это не имя переменной окружения.`);
      return `$${part.name}`;
    }
    const known = commandValue(part.value);
    if (known) { substitutions.push({ ...place, by: known.placeholder.startsWith('{{now') ? 'now' : 'uuid' }); return known.placeholder; }
    if (timeLike(name)) {
      substitutions.push({ ...place, by: 'now' });
      warnings.push(`${where(place)}: формат времени из ${part.value} Lab не распознал — подставит время в виде 2026-09-24T12:00:00.000Z.`);
      return '{{now}}';
    }
    if (idLike(name)) {
      substitutions.push({ ...place, by: 'uuid' });
      warnings.push(`${where(place)}: формат идентификатора из ${part.value} Lab не распознал — подставит новый UUID с дефисами.`);
      return '{{uuid}}';
    }
    warnings.push(`${where(place)}: ${part.value} оставлено как текст — Lab не выполняет команды.`);
    return part.value;
  };

  const url = agentAddress(request.address, secret, resolve);
  const headers: Record<string, string> = {};
  const headersEnv: Record<string, string> = {};
  for (const { name, value } of request.headers) {
    if (!HEADER_NAME.test(name)) throw new Error(`Имя заголовка «${name}» Lab отправить не может: допустимы латинские буквы, цифры и дефис.`);
    if (TRANSPORT_HEADERS.has(name.toLowerCase())) continue;
    const place = { header: name };
    const variables = value.flatMap(part => part.kind === 'variable' ? [part.name] : []);
    const variable = variables[0];
    const text = value.flatMap(part => part.kind === 'text' ? [part.value] : []).join('');
    if (value.length === 1 && variable !== undefined && envNameSchema.safeParse(variable).success) {
      // The owner's own variable holds the whole value: Lab reads that very variable.
      headersEnv[name] = variable;
      substitutions.push({ ...place, by: 'env', variable });
    } else if (harmless(name) || !text.trim() || variables.length && variables.every(item => envNameSchema.safeParse(item).success)) {
      // Nothing secret is written as it stands: harmless text, a substitution, or the owner's variable inside plain text (`Bearer $TOKEN`).
      headers[name] = value.map(part => resolve(part, name, place)).join('');
    } else headersEnv[name] = secret(place, name, shown(value));
  }

  // Substitutions inside the JSON body stand in as private-use markers, so the body parses as JSON first.
  const parts: Part[] = [];
  const raw = request.data.map(part => part.kind === 'text' ? part.value : `${OPEN}${parts.push(part) - 1}${CLOSE}`).join('');
  if (request.data.some(part => part.kind === 'text' && (part.value.includes(OPEN) || part.value.includes(CLOSE)))) throw new Error('В теле запроса curl есть служебные символы U+E000/U+E001: уберите их.');
  let body: Json;
  try { body = JSON.parse(raw) as Json; } catch { throw new Error('Тело запроса curl не является JSON: Lab отправляет агенту JSON.'); }
  if (!body || typeof body !== 'object') throw new Error('Тело запроса curl должно быть JSON-объектом.');
  body = mapStrings(body, (pointer, text) => {
    const key = pointerTokens(pointer).at(-1) ?? '';
    if (!text.includes(OPEN)) return credentialName(key) && text ? `{{env:${secret({ pointer }, key, text)}}}` : text;
    let out = '';
    for (const piece of text.split(OPEN)) {
      const end = piece.indexOf(CLOSE);
      if (end < 0) { out += piece; continue; }
      out += resolve(parts[Number(piece.slice(0, end))]!, key, { pointer }) + piece.slice(end + 1);
    }
    return out;
  });

  const fields = bodyFields(body);
  const lists = turnLists(body);
  if (choices.message === undefined) {
    // A request that carries its conversation as turns ends with the customer's: its words are the message.
    const list = lists.length === 1 ? atPointer(body, lists[0]!) as Json[] : undefined;
    const last = list?.at(-1);
    const text = isObject(last) && typeof last.role === 'string' && PARTNER.has(last.role) ? turnText(last) : undefined;
    return { kind: 'ask_message', url, fields, warnings, ...(text !== undefined ? { lastTurn: `${lists[0]}/${list!.length - 1}${text}` } : {}) };
  }
  const strings = new Set(fields.filter(field => typeof field.value === 'string').map(field => field.pointer));
  if (!strings.has(choices.message)) throw new Error(`В теле запроса нет строкового поля ${choices.message}. Строковые поля: ${[...strings].join(', ') || 'нет'}.`);
  const known = new Set(fields.map(field => field.pointer));
  const named = choices.conversation ?? conversationFields([...known]).filter(pointer => pointer !== choices.message);
  for (const pointer of named) {
    if (!known.has(pointer)) throw new Error(`В теле запроса нет поля ${pointer} для идентификатора разговора.`);
    if (pointer === choices.message) throw new Error('Одно и то же поле не может быть и сообщением клиента, и идентификатором разговора.');
  }
  const history = conversationTurns(body, lists, choices.message, named);
  // Ids inside the curl's example turns go with those turns.
  const conversation = history ? named.filter(pointer => !pointer.startsWith(`${history.at}/`)) : named;
  if (!history || !history.withMessage) setAt(body, choices.message, '{{message}}');
  // The conversation id: Lab's fresh one per dialogue, as a number where the curl had a number; where the curl left it empty the agent names it.
  let session: { first: Json } | undefined;
  for (const pointer of conversation) {
    const value = atPointer(body, pointer);
    if (value === '' || value === null) { session = { first: value }; setAt(body, pointer, '{{session}}'); }
    else setAt(body, pointer, typeof value === 'number' ? '{{conversation:number}}' : '{{conversation}}');
  }
  const parsed = runnableTargetSchema.safeParse({ kind: 'http', url, headersEnv, ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
    request: { body, headers, ...(history ? { history: { turn: history.turn, roles: history.roles } } : {}), ...(session ? { session } : {}) } });
  if (!parsed.success) throw new Error(`Подключение из curl не сложилось: ${parsed.error.issues.map(issue => issue.message).join('; ')}`);
  return { kind: 'ready', target: parsed.data, message: choices.message, conversation, substitutions, secrets, warnings,
    ...(history ? { history: { at: history.at, roles: history.roles, withMessage: history.withMessage, fixed: history.fixed } } : {}) };
}

/**
 * The conversation as turns, where the body carries it so: the list that holds the message (every turn goes, the new
 * one last), or else a list of earlier turns beside the message. The turn holding the message — or the list's last —
 * is the shape of every turn; instructions (system) stay first as the curl has them; the curl's example turns go.
 */
function conversationTurns(body: Json, lists: string[], message: string, conversation: string[]): (CurlHistory & { turn: Json }) | undefined {
  const holding = lists.find(at => message.startsWith(`${at}/`));
  const at = holding ?? lists.find(list => !conversation.some(pointer => pointer.startsWith(`${list}/`)));
  if (at === undefined) return undefined;
  const list = atPointer(body, at) as Record<string, Json>[];
  const index = holding ? Number(pointerTokens(message.slice(at.length))[0]) : list.length - 1;
  const example = list[index]!;
  const text = holding ? message.slice(`${at}/${index}`.length) : turnText(example);
  const own = typeof example.role === 'string' ? example.role : undefined;
  if (text === undefined || own === undefined || INSTRUCTION_ROLES.has(own)) return undefined;
  const speakers = [...new Set(list.map(item => item.role).filter((role): role is string => typeof role === 'string' && !INSTRUCTION_ROLES.has(role)))];
  // Without a message beside it, the example turn may be the agent's: the customer is the other speaker, or the one that opens.
  const user = holding ? own : speakers.find(role => PARTNER.has(role)) ?? own;
  const assistant = speakers.find(role => role !== user) ?? (at.endsWith('/contents') || at === '/contents' ? 'model' : PARTNER.get(user) ?? 'assistant');
  const turn = structuredClone(example) as Json;
  setAt(turn, '/role', '{{role}}');
  setAt(turn, text, '{{text}}');
  const fixed = list.filter(item => typeof item.role === 'string' && INSTRUCTION_ROLES.has(item.role));
  setAt(body, at, [...fixed, holding ? HISTORY : HISTORY_BEFORE]);
  return { at, turn, roles: { user, assistant }, withMessage: !!holding, fixed: fixed.length };
}

/**
 * The agent's address as the file keeps it: http or https, no login in it (fetch refuses one, and it is a secret), the
 * owner's `$NAME` and every query value named like a key read from the environment — {{env:NAME}} in the query.
 */
function agentAddress(word: Word, secret: (place: Place, name: string, value: string) => string, resolve: (part: Part, name: string, place: Place) => string): string {
  const variables: Part[] = [];
  let text = word.map(part => part.kind === 'text' ? part.value : `${OPEN}${variables.push(part) - 1}${CLOSE}`).join('');
  const shownAddress = shown(word);
  const at = text.indexOf('?');
  if ((at < 0 ? text : text.slice(0, at)).includes(OPEN)) throw new Error(`Адрес агента в curl собран из переменной (${shownAddress}): вставьте curl с адресом целиком — переменной может быть только значение параметра после «?».`);
  if (!text.includes('://')) text = `http://${text}`;
  const url = URL.parse(text);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) throw new Error(`Адрес агента «${shownAddress}» не похож на адрес вида https://хост/путь.`);
  if (url.username || url.password) throw new Error('Логин и пароль в адресе агента Lab не переносит: fetch такой адрес не принимает, а в файле они стали бы открытым текстом. Передайте их заголовком Authorization через переменную окружения.');
  const query: string[] = [];
  for (const [name, value] of url.searchParams) {
    const place = { query: name };
    const pieces = value.split(OPEN);
    let rendered: string;
    if (pieces.length > 1) {
      // `?key=$API_KEY`: the value is the owner's variable, read at request time; the address renders nothing else.
      rendered = pieces.map((piece, i) => {
        if (i === 0) return encodeURIComponent(piece);
        const end = piece.indexOf(CLOSE);
        const part = variables[Number(piece.slice(0, end))]!;
        if (part.kind !== 'variable') throw new Error(`Параметр адреса ${name} задан командой: Lab команды не выполняет — вставьте значение или переменную.`);
        return resolve(part, name, place) + encodeURIComponent(piece.slice(end + 1));
      }).join('');
    } else rendered = credentialName(name) && value ? `{{env:${secret(place, name, value)}}}` : encodeURIComponent(value);
    query.push(`${encodeURIComponent(name)}=${rendered}`);
  }
  return `${url.origin}${url.pathname}${query.length ? `?${query.join('&')}` : ''}`;
}
