import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { delimiter, extname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { fingerprint, isRunnable, scalarSchema, usageSchema, type ReleaseHook, type ReleaseLog, type RunnableTarget, type Target, type World } from './contracts.js';
import type { CallContext, DialogueMessage, TargetSession } from './runtime.js';
import { targetEntryPath } from './target-version.js';
import { AgentFailure, AgentRequestFailed, ConnectionFailure, MeasurementFailure } from './errors.js';
import { identifierSchema as identifier, sha256Schema } from './ids.js';
import { addressVariables, atPointer, renderAddress, renderRequest, replyText, templateVariables, type Json, type RequestTemplate, type RequestValues } from './http-template.js';
import { countText } from './plural.js';
import { clip } from './text.js';

type HttpTarget = Extract<Target, { kind: 'http' }>;

function httpHeaders(target: HttpTarget): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  for (const [header, variable] of Object.entries(target.headersEnv)) {
    const value = process.env[variable];
    if (!value) throw new ConnectionFailure('start', `Не задана переменная окружения ${variable} для заголовка ${header}. Задайте её перед запуском Pi.`);
    headers[header] = value;
  }
  return headers;
}

/** The environment variables an HTTP connection reads that are not set in this process: its headers', its template's and its address's. */
export function missingVariables(target: HttpTarget): string[] {
  const names = [...Object.values(target.headersEnv), ...(target.request ? templateVariables(target.request, target.url) : addressVariables(target.url))];
  return [...new Set(names)].filter(name => !process.env[name]);
}

/** Resolves `command` the way the shell would (PATH, PATHEXT on Windows) and requires execute permission; never runs it. */
async function ensureExecutable(command: string, cwd: string, labels: { missing: string; denied: string }): Promise<void> {
  const windows = process.platform === 'win32';
  const hasPath = command.includes('/') || windows && command.includes('\\');
  const path = windows ? Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] : process.env.PATH;
  const directories = hasPath ? [''] : (path ?? (windows ? '' : '/usr/bin:/bin')).split(delimiter);
  const suffixes = windows && !extname(command) ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  let denied: string | undefined;
  for (const directory of directories) for (const suffix of suffixes) {
    const candidate = resolve(cwd, directory, command + suffix);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') denied ??= candidate;
      else if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
  }
  if (denied) throw new Error(`${labels.denied}: ${denied}. Проверьте права или выберите другой исполняемый файл.`);
  throw new Error(`${labels.missing}: ${command}. Укажите полный путь к исполняемому файлу или добавьте его папку в PATH.`);
}

/**
 * Static readiness only: never imports, starts, or sends a request to the target. It runs before a run starts and
 * before a connection is saved, so a missing file or variable stops the start in the owner's words before any call;
 * actual execution still handles drift and errors.
 */
export async function preflightTarget(target: Target): Promise<void> {
  // A retired sandbox runs nothing; a draft whose agent is not connected yet has nothing to check until it is.
  if (!isRunnable(target)) return;
  if (target.promptFile) await readPrompt(target.promptFile);
  if (target.release) {
    const cwd = target.release.cwd ?? process.cwd();
    try { if (!(await stat(cwd)).isDirectory()) throw new Error(`Рабочая папка хука выпуска не является папкой: ${cwd}.`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Не найдена рабочая папка хука выпуска: ${cwd}.`); throw error; }
    await ensureExecutable(target.release.command, cwd, { missing: 'Не найдена команда хука выпуска', denied: 'Нет права запуска команды хука выпуска' });
  }
  if (target.kind === 'http') {
    const address = URL.parse(target.url);
    if (!address || (address.protocol !== 'http:' && address.protocol !== 'https:')) throw new Error(`Адрес агента «${target.url}» не похож на адрес вида https://хост/путь: исправьте его в подключении.`);
    if (address.username || address.password) throw new Error('В адресе агента записаны логин и пароль: такой адрес Lab не отправляет. Подключите агента заново — передайте их заголовком Authorization через переменную окружения.');
    const missing = missingVariables(target);
    if (missing.length === 1) throw new Error(`Не задана переменная окружения ${missing[0]}: её читает подключение агента. Задайте её и перезапустите Pi.`);
    if (missing.length) throw new Error(`Не заданы переменные окружения ${missing.join(', ')}: их читает подключение агента. Задайте их и перезапустите Pi.`);
    if (target.request) replyPointer({ ...target, request: target.request });
    return;
  }
  const entry = targetEntryPath(target);
  if (entry) {
    try {
      if (!(await stat(entry)).isFile()) throw new Error(`Вместо файла агента указана папка: ${entry}. Выберите файл адаптера.`);
      await access(entry, constants.R_OK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(`Не найден файл агента: ${entry}. Исправьте путь в подключении.`);
      if (code === 'EACCES' || code === 'EPERM') throw new Error(`Нет доступа к файлу агента: ${entry}. Проверьте права чтения.`);
      throw error;
    }
  }
  if (target.kind !== 'command') return;
  const cwd = target.cwd ?? process.cwd();
  try {
    if (!(await stat(cwd)).isDirectory()) throw new Error(`Рабочая папка агента не является папкой: ${cwd}. Исправьте cwd в подключении.`);
    await access(cwd, constants.X_OK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(`Не найдена рабочая папка агента: ${cwd}. Исправьте cwd в подключении.`);
    if (code === 'EACCES' || code === 'EPERM') throw new Error(`Нет доступа к рабочей папке агента: ${cwd}. Проверьте права доступа.`);
    throw error;
  }
  await ensureExecutable(target.command, cwd, { missing: 'Не найдена команда агента', denied: 'Нет права запуска команды агента' });
}

/** Why a process did not start, in the owner's words. */
function spawnReason(error: NodeJS.ErrnoException): string {
  return error.code === 'ENOENT' ? 'команда не найдена' : error.code === 'EACCES' || error.code === 'EPERM' ? 'нет права запуска' : error.code ?? error.message;
}

/** How long the output of a hook that has exited may still be arriving: what it printed just before the exit. */
const RELEASE_DRAIN_MS = 200;

/**
 * Deploys the version under test. The hook is done when it exits: a server it started in the background (`deploy;
 * server &`) keeps the output pipes but not the run — Lab drains them unread, so the server neither blocks nor loses
 * its output, and it is killed with the hook's process group only at the deadline or on a stop. Output tails are
 * kept for the record; the adapter's `version` remains the identity.
 */
export async function runRelease(release: ReleaseHook, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<ReleaseLog> {
  signal.throwIfAborted();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const grouped = process.platform !== 'win32';
  return new Promise((resolveLog, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(release.command, release.args, { cwd: release.cwd, env, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { reject(new Error(`Не удалось запустить хук выпуска ${release.command}: ${spawnReason(error as NodeJS.ErrnoException)}`)); return; }
    let stdout = '', stderr = '', timedOut = false, reading = true, finished = false;
    child.stdout?.on('data', chunk => { if (reading) stdout = `${stdout}${chunk}`.slice(-4000); });
    child.stderr?.on('data', chunk => { if (reading) stderr = `${stderr}${chunk}`.slice(-4000); });
    const kill = () => {
      try { if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, release.timeoutMs);
    signal.addEventListener('abort', kill, { once: true });
    const finish = (code: number | null, sig: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); signal.removeEventListener('abort', kill);
      // What the hook left running keeps its end of the pipes: drained unread, never keeping Lab itself alive.
      reading = false;
      for (const stream of [child.stdout, child.stderr]) { stream?.resume(); (stream as { unref?: () => void } | null)?.unref?.(); }
      if (timedOut) stderr = `${stderr}\nRelease hook exceeded ${release.timeoutMs} ms`.slice(-4000);
      resolveLog({ command: [release.command, ...release.args].join(' '), exitCode: timedOut || signal.aborted ? null : code, signal: sig, stdout, stderr, startedAt, durationMs: Math.round(performance.now() - started) });
    };
    child.once('error', error => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal.removeEventListener('abort', kill);
      reject(new Error(`Не удалось запустить хук выпуска ${release.command}: ${spawnReason(error)}`));
    });
    child.once('exit', (code, sig) => {
      // The pipes close with the hook unless something it started holds them; its last lines get a moment to arrive.
      const drained = setTimeout(() => finish(code, sig), RELEASE_DRAIN_MS);
      child.once('close', () => { clearTimeout(drained); finish(code, sig); });
    });
  });
}

/*
 * External targets: the agent under test lives outside this process.
 *
 *   runner ──respond(message)──► adapter ──JSON {sessionId, scenarioId, initialState, messages, message}──► http endpoint | module
 *                                   ▲                                                                              │
 *      trace ◄── tool_call / tool_result events ◄── reply, events?, records? ◄────────────────────────────────────┘
 *
 * `records` returned by the agent's harness replace the trial world before grading. They are reported state,
 * not state observed by trusted code; the runner labels it as such. Secrets come from the environment at request
 * time and never enter the persisted record. Every failure reaches the owner in Russian; a network failure keeps
 * its kind (AgentRequestFailed) and its cause's code.
 */
/** A button the agent offers with its reply: the text the customer sees, and the adapter's own value for it. */
export const agentButtonSchema = z.strictObject({ text: z.string().trim().min(1).max(300), value: z.string().max(300).optional() });
export type AgentButton = z.infer<typeof agentButtonSchema>;
/**
 * What a turn gave the customer, as the adapter knows it: `reply` — a message (the default of every adapter that does not
 * say), `handoff` — the agent passed the conversation to a person, `no_reply` — the customer got nothing (a service
 * status, an internal error, a generation that failed). A `no_reply` turn never reaches the customer Lab plays.
 */
export const TURN_OUTCOMES = ['reply', 'handoff', 'no_reply'] as const;
export type TurnOutcome = typeof TURN_OUTCOMES[number];
export const externalReplySchema = z.union([
  z.string().max(20000),
  z.strictObject({
    reply: z.string().max(20000),
    outcome: z.enum(TURN_OUTCOMES).optional(),
    /** The agent's own status of the turn («202-7»), kept for the record: Lab never reads its meaning. */
    status: z.string().trim().min(1).max(200).optional(),
    buttons: z.array(agentButtonSchema).max(20).optional(),
    measurementError: z.string().trim().min(1).max(2000).optional(),
    /** Exact chunks supplied to the model for this reply; Agent Lab persists them as cited trace evidence. */
    retrievals: z.array(z.strictObject({
      source: z.string().trim().min(1).max(500),
      chunkId: z.string().trim().min(1).max(500).optional(),
      content: z.string().min(1).max(12000).refine(value => !!value.trim(), 'Empty retrieval chunk'),
      score: z.number().finite().optional(),
      documentId: z.string().trim().min(1).max(500).optional(),
      version: z.string().trim().min(1).max(200).optional(),
      section: z.string().trim().min(1).max(500).optional(),
    })).max(20).refine(chunks => chunks.reduce((n, chunk) => n + chunk.content.length, 0) <= 60000, 'Retrieval context exceeds 60000 characters').optional(),
    retrievalsComplete: z.boolean().optional(),
    /** A search response is observable before we know which text reaches the answering model. */
    retrievalStage: z.enum(['retrieved', 'model_context']).optional(),
    events: z.array(z.strictObject({ tool: z.string().min(1).max(200), args: z.unknown().optional(), result: z.unknown().optional() })).max(50).default([]),
    records: z.record(identifier, z.record(identifier, scalarSchema)).refine(v => Object.keys(v).length <= 30, 'Too many records').optional(),
    promptHash: sha256Schema.optional(),
    eventScope: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:/-]*\*?$/).max(200)).min(1).max(50).optional(),
    eventsComplete: z.boolean().optional(), resetConfirmed: z.boolean().optional(),
    version: z.string().trim().min(1).max(200).optional(),
    sessionId: z.string().min(1).max(100).optional(), turn: z.number().int().positive().optional(),
    usage: usageSchema.optional(),
  }),
]);
export type ExternalReply = z.infer<typeof externalReplySchema>;
interface ExternalTargetInput {
  target: RunnableTarget; sessionId: string; scenarioId: string;
  state: World; history: () => DialogueMessage[]; ctx: CallContext;
  /** Called whenever the agent's harness reports records; the runner uses it to label reported state. */
  onRecords?: () => void;
  onReply?(reply: ExternalReply): void;
  prompt?: string;
}
type SessionInput<K extends ExternalTargetInput['target']['kind']> = Omit<ExternalTargetInput, 'target'> & { target: Extract<Target, { kind: K }> };

/** The types a reply's field may be expected to have, in the owner's words. */
const TYPE_WORDS: Record<string, string> = { string: 'строка', number: 'число', boolean: 'true или false', object: 'объект', array: 'список' };

/** What of a reply breaks Lab's contract, field by field: an object is read against the object's own rules, so the field is named. */
function contractIssues(raw: unknown): string {
  const object = externalReplySchema.options[1];
  const result = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? object.safeParse(raw) : undefined;
  if (!result || result.success) return 'ответ — не строка и не объект с полем reply';
  return [...new Set(result.error.issues.flatMap(issue => issue.code === 'unrecognized_keys' ? issue.keys.map(key => `лишнее поле «${clip(key, 60)}»`)
    : [`поле «${issue.path.join('.') || 'reply'}» — ${issue.code === 'invalid_type' ? `ожидается ${TYPE_WORDS[issue.expected] ?? issue.expected}` : 'значение не по контракту'}`]))]
    .slice(0, 5).join('; ');
}

function applyReply(raw: unknown, state: World, ctx: CallContext, onRecords?: () => void, onReply?: ExternalTargetInput['onReply']): string {
  const parsed = externalReplySchema.safeParse(raw);
  if (!parsed.success) throw new ConnectionFailure('contract', `Ответ агента не по контракту Lab: ${contractIssues(raw)}. Ожидается строка или объект с полем reply и только полями контракта.`);
  onReply?.(parsed.data);
  if (typeof parsed.data === 'string') return parsed.data;
  const { reply, retrievals, events, records, measurementError } = parsed.data;
  if (records) { state.records = structuredClone(records); onRecords?.(); }
  if (retrievals !== undefined) ctx.onTargetEvent?.({ type: 'retrieval', result: { chunks: retrievals, complete: parsed.data.retrievalsComplete === true,
    ...(parsed.data.retrievalStage ? { stage: parsed.data.retrievalStage } : {}) } });
  for (const event of events) {
    ctx.onTargetEvent?.({ type: 'tool_call', tool: event.tool, args: event.args });
    ctx.onTargetEvent?.({ type: 'tool_result', tool: event.tool, result: event.result, state });
  }
  if (measurementError) {
    if (reply.trim()) ctx.onTargetEvent?.({ type: 'assistant', text: reply });
    throw new MeasurementFailure(`Адаптер сообщил, что не может измерить этот ход: ${measurementError}`);
  }
  return reply;
}

/**
 * The most of one reply Lab reads. Cyrillic escaped by Python's json.dumps takes six bytes a character, so a reply with
 * its retrieved context runs to hundreds of kilobytes; two megabytes hold the largest reply the contract allows.
 */
export const REPLY_BYTES = 2_000_000;
const REPLY_TOO_LARGE = 'Ответ агента больше 2 МБ — Lab читает ответы до 2 МБ. Проверьте, не присылает ли агент лишнее: весь контекст, отладку или файлы.';
const seconds = (ms: number) => countText(Math.max(1, Math.round(ms / 1000)), ['секунду', 'секунды', 'секунд']);
const timedOut = (ms: number) => new AgentRequestFailed('timeout', `Агент не ответил за ${seconds(ms)}.`);

/** Certificate checks an address may fail: Node's codes of OpenSSL's verify results. */
const CERTIFICATE_CODES = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_UNTRUSTED', 'CERT_REJECTED', 'CERT_SIGNATURE_FAILURE', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED',
  'INVALID_CA', 'PATH_LENGTH_EXCEEDED', 'INVALID_PURPOSE', 'HOSTNAME_MISMATCH', 'ERR_TLS_CERT_ALTNAME_INVALID']);

/** The code of the first error in the chain that names one: fetch wraps the socket's error as its cause. */
function causeCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Why the request did not come back, typed, in the owner's words with the next step; `origin` never carries a path or a query. */
function requestFailure(error: unknown, origin: string): AgentRequestFailed {
  const code = causeCode(error);
  if (code && (CERTIFICATE_CODES.has(code) || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_') || code === 'EPROTO')) {
    const [why, next] = code === 'CERT_HAS_EXPIRED' || code === 'CERT_NOT_YET_VALID' ? ['срок действия сертификата агента истёк или ещё не начался', 'Обновите сертификат на стороне агента.']
      : code === 'HOSTNAME_MISMATCH' || code === 'ERR_TLS_CERT_ALTNAME_INVALID' ? ['сертификат агента выдан на другое имя', 'Проверьте адрес: имя в нём должно совпадать с именем в сертификате.']
      : code.startsWith('ERR_SSL_') || code === 'EPROTO' ? ['защищённое соединение не установилось', 'Проверьте адрес: возможно, агент ждёт http, а не https.']
      : [code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN' ? 'сертификат самоподписанный' : 'сертификат выдан центром, которому Node не доверяет (например, корпоративным)',
        'Укажите путь к корневому сертификату (CA) в переменной окружения NODE_EXTRA_CA_CERTS — например, NODE_EXTRA_CA_CERTS=/путь/к/ca.pem — и перезапустите Pi.'];
    return new AgentRequestFailed('tls', `Агент по адресу ${origin} не прошёл проверку сертификата: ${why}. ${next}`, undefined, code);
  }
  const why = code === 'ECONNREFUSED' ? 'соединение отклонено — агент не запущен или слушает другой порт'
    : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'такого имени хоста сеть не знает — проверьте адрес и VPN'
    : code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' ? 'соединение оборвалось'
    : code?.startsWith('HPE_') ? 'он ответил не по HTTP — проверьте, http или https, и порт'
    : 'нет связи — проверьте адрес и сеть (VPN, доступ с этой машины)';
  return new AgentRequestFailed('unreachable', `Агент по адресу ${origin} недоступен: ${why}.`, undefined, code);
}

/** One POST with the cap and the deadline every HTTP agent gets; the parsed JSON body of its reply. */
async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number, parent: AbortSignal): Promise<unknown> {
  parent.throwIfAborted();
  const origin = URL.parse(url)?.origin ?? 'из подключения';
  const signal = AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
  const failed = (error: unknown): unknown => parent.aborted ? parent.reason : signal.aborted ? timedOut(timeoutMs) : requestFailure(error, origin);
  let response: Response;
  try { response = await fetch(url, { method: 'POST', headers, signal, body: JSON.stringify(body) }); }
  catch (error) { throw failed(error); }
  if (!response.ok) { await response.body?.cancel(); throw new AgentRequestFailed('status', `Агент ответил ошибкой ${response.status}.`, response.status); }
  if (Number(response.headers.get('content-length')) > REPLY_BYTES) { await response.body?.cancel(); throw new ConnectionFailure('contract', REPLY_TOO_LARGE); }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); } catch (error) { throw failed(error); }
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > REPLY_BYTES) { await reader.cancel(); throw new ConnectionFailure('contract', REPLY_TOO_LARGE); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new ConnectionFailure('contract', 'Агент ответил не JSON: Lab ждёт ответ в формате JSON.'); }
}

export type TemplateTarget = HttpTarget & { request: RequestTemplate };

/** One request of an agent in its own format: the body Lab sent, and the reply as it came. */
export async function templateRequest(target: TemplateTarget, values: RequestValues, signal: AbortSignal): Promise<{ sent: Json; reply: unknown }> {
  const rendered = renderRequest(target.request, values);
  // Header names are case-insensitive: the template's own Content-Type replaces Lab's default; a secret read from the environment always wins.
  const secret = new Set(Object.keys(target.headersEnv).map(name => name.toLowerCase()));
  const headers = new Headers(httpHeaders(target));
  for (const [name, value] of Object.entries(rendered.headers)) if (!secret.has(name.toLowerCase())) headers.set(name, value);
  return { sent: rendered.body, reply: await postJson(renderAddress(target.url), Object.fromEntries(headers), rendered.body, target.timeoutMs, signal) };
}

/**
 * One request of an agent in its own format: the template rendered for this message and conversation. The raw
 * reply comes back as is — the session reads its text by pointer, the connection check shows its structure.
 */
export async function templateExchange(target: TemplateTarget, values: RequestValues, signal: AbortSignal): Promise<unknown> {
  return (await templateRequest(target, values, signal)).reply;
}

/** The conversation id an agent named in its reply, where its template reads one. */
export function agentSession(target: TemplateTarget, reply: unknown): string | number | undefined {
  const at = target.request.session?.reply;
  const value = at === undefined ? undefined : atPointer(reply, at);
  return typeof value === 'string' && value !== '' || typeof value === 'number' ? value : undefined;
}

/** Where the connection says the agent's text is; unset until the owner picks it from the connection check. */
function replyPointer(target: TemplateTarget): string {
  if (target.request.reply === undefined) throw new ConnectionFailure('start', 'В подключении не выбран путь к тексту ответа агента: запустите agent-lab doctor --connection подключение.json --yes и укажите --reply.');
  return target.request.reply;
}

async function httpSession(input: SessionInput<'http'>): Promise<TargetSession> {
  const { target, sessionId, scenarioId, state, history, ctx } = input;
  const headers = httpHeaders(target);
  const initialState = structuredClone(state);
  const templated = target.request ? { ...target, request: target.request } : undefined;
  if (templated) replyPointer(templated);
  let closed = false;
  // The conversation id the agent itself named, carried from each reply into the next request.
  let session: string | number | undefined;
  return {
    async respond(message, options) {
      if (closed) throw new ConnectionFailure('protocol', 'Сессия с внешним агентом закрыта.');
      ctx.signal.throwIfAborted();
      if (templated) {
        // The agent keeps its conversation by the trial's own id, by the turns sent whole, or by the id it named itself.
        const past = history();
        const last = past.at(-1);
        const turns = (last?.role === 'user' && last.content === message ? past : [...past, { role: 'user' as const, content: message }]).map(turn => ({ role: turn.role, text: turn.content }));
        const body = await templateExchange(templated, { message, conversation: sessionId, turns, ...(session !== undefined ? { session } : {}) }, ctx.signal);
        session = agentSession(templated, body) ?? session;
        // Text only: such an agent shows neither its tools nor a reset, so the dialogue is judged on its replies.
        return applyReply(replyText(body, replyPointer(templated)), state, ctx, input.onRecords, input.onReply);
      }
      const body = await postJson(renderAddress(target.url), headers, { sessionId, scenarioId, initialState, messages: history(), message,
        ...(options?.choice ? { choice: options.choice } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt, promptHash: fingerprint(input.prompt) } : {}) }, target.timeoutMs, ctx.signal);
      return applyReply(body, state, ctx, input.onRecords, input.onReply);
    },
    async close() { closed = true; },
  };
}

async function moduleSession(input: SessionInput<'module'>): Promise<TargetSession> {
  return commandSession({ ...input, initialize: true, channel: 'pipe', target: {
    kind: 'command', command: process.execPath,
    args: [fileURLToPath(new URL('./module-worker.mjs', import.meta.url)), input.target.path, input.target.exportName],
    timeoutMs: input.target.timeoutMs ?? input.ctx.timeoutMs,
  } });
}

/*
 * Command adapter: one process per dialogue, JSON lines both ways.
 *   stdin  → {"type":"respond", sessionId, scenarioId, initialState, messages, message, choice?}
 *   stdout ← "reply"  |  {"reply", "outcome"?, "buttons"?, "events"?, "records"?}      one JSON line per request
 *   stdin  → {"type":"close", sessionId}, then stdin ends
 * One JSON line answers one request. A JSON line no request waits for — a second answer to a request, a progress line
 * in JSON — breaks the protocol: the conversation is not measured, the adapter is named, not the agent. A line that is
 * not JSON (a stray print) is diagnostics, kept with the stderr tail; it never answers a request. The module worker
 * answers on a pipe of its own (`channel: 'pipe'`, fd 3), so whatever the module prints is diagnostics too.
 * A reply that misses the deadline kills the process; an early exit surfaces the exit code and the diagnostics tail.
 */
async function commandSession(input: SessionInput<'command'> & { initialize?: boolean; channel?: 'stdout' | 'pipe' }): Promise<TargetSession> {
  const { target, sessionId, scenarioId, state, history, ctx } = input;
  ctx.signal.throwIfAborted();
  const grouped = process.platform !== 'win32';
  const own = input.channel === 'pipe';
  const child = spawn(target.command, target.args, { cwd: target.cwd, stdio: own ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'], env: process.env, detached: grouped });
  const answers = (own ? child.stdio[3] : child.stdout) as Readable;
  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    try { if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  let diagnostics = '';
  const note = (text: string) => { diagnostics = `${diagnostics}${text}`.slice(-4000); };
  child.stderr.on('data', chunk => note(String(chunk)));
  if (own) child.stdout.on('data', chunk => note(String(chunk)));
  child.stdin.on('error', () => {});
  let pending: { resolve: (reply: unknown) => void; reject: (error: Error) => void } | undefined;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const takePending = () => { const waiting = pending; pending = undefined; return waiting; };
  const exited = () => new AgentFailure(`Процесс агента завершился${exit ? exit.code !== null ? ` с кодом ${exit.code}` : ` по сигналу ${exit.signal}` : ''}${diagnostics.trim() ? `: ${diagnostics.trim()}` : '.'}`);
  let bytes = 0;
  answers.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > REPLY_BYTES) { takePending()?.reject(new ConnectionFailure('contract', REPLY_TOO_LARGE)); kill(); }
  });
  // The first line no request waited for: the session answers nothing more once it is there, and says so once.
  let violation: ConnectionFailure | undefined;
  let told = false;
  const broken = (): ConnectionFailure | undefined => { if (violation && !told) { told = true; return violation; } return undefined; };
  const lines = createInterface({ input: answers });
  lines.on('line', line => {
    let reply: unknown;
    try { reply = JSON.parse(line); } catch { note(`${line}\n`); return; }
    const waiting = takePending();
    if (waiting) { waiting.resolve(reply); return; }
    note(`${line}\n`);
    violation ??= new ConnectionFailure('protocol', `Адаптер прислал лишнюю строку без запроса: «${clip(line, 200)}». Одна строка JSON отвечает на один запрос; строки прогресса и отладки пишите в stderr.`);
  });
  child.on('close', (code, signal) => { exit = { code, signal }; takePending()?.reject(exited()); });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', error => reject(new ConnectionFailure('start', `Не удалось запустить агента ${target.command}: ${spawnReason(error)}.`)));
  });
  const initialState = structuredClone(state);
  let closed = false;
  const exchange = async (payload: unknown): Promise<unknown> => {
    if (closed) throw new ConnectionFailure('protocol', 'Сессия с внешним агентом закрыта.');
    ctx.signal.throwIfAborted();
    if (violation) throw broken() ?? violation;
    if (exit) throw exited();
    if (pending) throw new ConnectionFailure('protocol', 'У сессии уже есть активный запрос.');
    bytes = 0;
    const reply = new Promise<unknown>((resolve, reject) => { pending = { resolve, reject }; });
    // A stray print instead of the reply shows here: the owner sees what the agent wrote while Lab waited.
    const timer = setTimeout(() => { takePending()?.reject(diagnostics.trim() ? new AgentRequestFailed('timeout', `${timedOut(target.timeoutMs).message} Последний вывод агента: ${diagnostics.trim().slice(-500)}`)
      : timedOut(target.timeoutMs)); kill(); }, target.timeoutMs);
    const onAbort = () => { takePending()?.reject(ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('Диалог остановлен.')); kill(); };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const sent = new Promise<void>((resolve, reject) => { child.stdin.write(`${JSON.stringify(payload)}\n`, error => error ? reject(error) : resolve()); });
      const [, body] = await Promise.all([sent, reply]);
      ctx.signal.throwIfAborted();
      // A second line in the same breath as the answer is already read: that answer is not the agent's one reply.
      if (violation) throw broken() ?? violation;
      return body;
    } finally { clearTimeout(timer); ctx.signal.removeEventListener('abort', onAbort); }
  };
  const session: TargetSession = {
    async respond(message, options) {
      const body = await exchange({ type: 'respond', sessionId, scenarioId, initialState, messages: history(), message, ...(options?.choice ? { choice: options.choice } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt, promptHash: fingerprint(input.prompt) } : {}) });
      return applyReply(body, state, ctx, input.onRecords, input.onReply);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (!exit) {
        if (ctx.signal.aborted) kill();
        else child.stdin.end(`${JSON.stringify({ type: 'close', sessionId })}\n`);
        await new Promise<void>(resolve => {
          if (exit) { resolve(); return; }
          const timer = setTimeout(() => { kill(); resolve(); }, 2000);
          child.once('close', () => { clearTimeout(timer); resolve(); });
        });
      }
      lines.close();
      // A line that arrived after the last answer breaks the protocol as much as one before it.
      const unsaid = broken();
      if (unsaid) throw unsaid;
    },
  };
  if (input.initialize) {
    try { await exchange({ type: 'open', sessionId, scenarioId, initialState, prompt: input.prompt, promptHash: input.prompt === undefined ? undefined : fingerprint(input.prompt) }); }
    catch (error) {
      kill(); await session.close().catch(() => {});
      // Before its first message the adapter only starts: whatever stops it there is the connection's, not the agent's answer.
      throw ctx.signal.aborted || error instanceof ConnectionFailure ? error
        : new ConnectionFailure('start', `Адаптер агента не запустился: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  return session;
}

export async function readPrompt(file: string): Promise<string> {
  const info = await stat(file);
  if (!info.isFile() || info.size > 96000) throw new Error('Промпт должен быть текстовым файлом до 96 КБ.');
  const prompt = await readFile(file, 'utf8');
  if (!prompt.trim() || prompt.includes('\0')) throw new Error('Пустой или бинарный prompt-файл.');
  return prompt;
}
/** A failure of a session typed, so its cause is read by its kind (evaluation.ts): what no typed failure names is the connection's. */
function typed(error: unknown, signal: AbortSignal, kind: ConnectionFailure['kind']): unknown {
  if (signal.aborted || error instanceof ConnectionFailure || error instanceof AgentFailure || error instanceof MeasurementFailure || error instanceof AgentRequestFailed) return error;
  return new ConnectionFailure(kind, error instanceof Error ? error.message : String(error), { cause: error });
}

/**
 * A session with the agent under test. Every failure that leaves it is typed: the agent's side gave a turn nothing
 * (AgentRequestFailed, AgentFailure), the adapter could not measure a turn (MeasurementFailure), or Lab could not start
 * the adapter or read its reply (ConnectionFailure) — a stop keeps its own reason.
 */
export async function openExternalTarget(input: ExternalTargetInput): Promise<TargetSession> {
  const { signal } = input.ctx;
  let session: TargetSession;
  try {
    if (input.target.promptFile) {
      const file = input.target.promptFile;
      const prompt = await readPrompt(file).catch(error => {
        const code = (error as NodeJS.ErrnoException).code;
        throw new ConnectionFailure('start', code === 'ENOENT' || code === 'ENOTDIR' ? `Не найден файл промпта: ${file}. Исправьте promptFile в подключении.`
          : code === 'EACCES' || code === 'EPERM' ? `Нет доступа к файлу промпта: ${file}. Проверьте права чтения.` : `Файл промпта ${file} не читается: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      });
      const original = input.onReply;
      input = { ...input, prompt, onReply(reply) {
        if (typeof reply === 'string' || reply.promptHash !== fingerprint(prompt)) throw new ConnectionFailure('contract', 'Адаптер не подтвердил применение выбранного промпта (promptHash).');
        original?.(reply);
      } };
    }
    switch (input.target.kind) {
      case 'http': session = await httpSession({ ...input, target: input.target }); break;
      case 'module': session = await moduleSession({ ...input, target: input.target }); break;
      case 'command': session = await commandSession({ ...input, target: input.target }); break;
    }
  } catch (error) { throw typed(error, signal, 'start'); }
  return {
    async respond(message, options) {
      try { return await session.respond(message, options); } catch (error) { throw typed(error, signal, 'contract'); }
    },
    close: () => session.close(),
  };
}
