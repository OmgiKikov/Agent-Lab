import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { delimiter, extname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { fingerprint, isRunnable, scalarSchema, usageSchema, type ReleaseHook, type ReleaseLog, type RunnableTarget, type Target, type World } from './contracts.js';
import type { CallContext, DialogueMessage, TargetSession } from './runtime.js';
import { targetEntryPath } from './target-version.js';
import { AgentRequestFailed } from './errors.js';
import { identifierSchema as identifier, sha256Schema } from './ids.js';
import { addressVariables, atPointer, renderAddress, renderRequest, replyText, templateVariables, type Json, type RequestTemplate, type RequestValues } from './http-template.js';
import { countText } from './plural.js';

type HttpTarget = Extract<Target, { kind: 'http' }>;

function httpHeaders(target: HttpTarget): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  for (const [header, variable] of Object.entries(target.headersEnv)) {
    const value = process.env[variable];
    if (!value) throw new Error(`Не задана переменная окружения ${variable} для заголовка ${header}. Задайте её перед запуском Pi.`);
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
export const externalReplySchema = z.union([
  z.string().max(20000),
  z.strictObject({
    reply: z.string().max(20000),
    measurementError: z.string().trim().min(1).max(2000).optional(),
    /** Exact chunks supplied to the model for this reply; Agent Lab persists them as cited trace evidence. */
    retrievals: z.array(z.strictObject({
      source: z.string().trim().min(1).max(500),
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
type ExternalReply = z.infer<typeof externalReplySchema>;
interface ExternalTargetInput {
  target: RunnableTarget; sessionId: string; scenarioId: string;
  state: World; history: () => DialogueMessage[]; ctx: CallContext;
  /** Called whenever the agent's harness reports records; the runner uses it to label reported state. */
  onRecords?: () => void;
  onReply?(reply: ExternalReply): void;
  prompt?: string;
}
type SessionInput<K extends ExternalTargetInput['target']['kind']> = Omit<ExternalTargetInput, 'target'> & { target: Extract<Target, { kind: K }> };

function applyReply(raw: unknown, state: World, ctx: CallContext, onRecords?: () => void, onReply?: ExternalTargetInput['onReply']): string {
  const parsed = externalReplySchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Ответ агента не по контракту Lab (${[...new Set(parsed.error.issues.map(i => i.path.join('.') || 'весь ответ'))].join(', ')}): ожидается строка или объект с полем reply.`);
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
    throw new Error(`Ошибка измерения внешнего агента: ${measurementError}`);
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
  if (Number(response.headers.get('content-length')) > REPLY_BYTES) { await response.body?.cancel(); throw new Error(REPLY_TOO_LARGE); }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); } catch (error) { throw failed(error); }
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > REPLY_BYTES) { await reader.cancel(); throw new Error(REPLY_TOO_LARGE); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new Error('Агент ответил не JSON: Lab ждёт ответ в формате JSON.'); }
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
  if (target.request.reply === undefined) throw new Error('В подключении не выбран путь к тексту ответа агента: запустите agent-lab doctor --connection подключение.json --yes и укажите --reply.');
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
    async respond(message) {
      if (closed) throw new Error('Сессия с внешним агентом закрыта.');
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
        ...(input.prompt !== undefined ? { prompt: input.prompt, promptHash: fingerprint(input.prompt) } : {}) }, target.timeoutMs, ctx.signal);
      return applyReply(body, state, ctx, input.onRecords, input.onReply);
    },
    async close() { closed = true; },
  };
}

async function moduleSession(input: SessionInput<'module'>): Promise<TargetSession> {
  return commandSession({ ...input, initialize: true, target: {
    kind: 'command', command: process.execPath,
    args: [fileURLToPath(new URL('./module-worker.mjs', import.meta.url)), input.target.path, input.target.exportName],
    timeoutMs: input.target.timeoutMs ?? input.ctx.timeoutMs,
  } });
}

/*
 * Command adapter: one process per dialogue, JSON lines both ways.
 *   stdin  → {"type":"respond", sessionId, scenarioId, initialState, messages, message}
 *   stdout ← "reply"  |  {"reply", "events"?, "records"?}      one JSON line per request
 *   stdin  → {"type":"close", sessionId}, then stdin ends
 * A stdout line that is not JSON (a stray print) is diagnostics, kept with the stderr tail; it never answers a request.
 * A reply that misses the deadline kills the process; an early exit surfaces the exit code and the diagnostics tail.
 */
async function commandSession(input: SessionInput<'command'> & { initialize?: boolean }): Promise<TargetSession> {
  const { target, sessionId, scenarioId, state, history, ctx } = input;
  ctx.signal.throwIfAborted();
  const grouped = process.platform !== 'win32';
  const child = spawn(target.command, target.args, { cwd: target.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env, detached: grouped });
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
  child.stdin.on('error', () => {});
  let pending: { resolve: (reply: unknown) => void; reject: (error: Error) => void } | undefined;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const takePending = () => { const waiting = pending; pending = undefined; return waiting; };
  const exited = () => new Error(`Процесс агента завершился${exit ? exit.code !== null ? ` с кодом ${exit.code}` : ` по сигналу ${exit.signal}` : ''}${diagnostics.trim() ? `: ${diagnostics.trim()}` : '.'}`);
  let bytes = 0;
  child.stdout.on('data', chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > REPLY_BYTES) { takePending()?.reject(new Error(REPLY_TOO_LARGE)); kill(); }
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let reply: unknown;
    try { reply = JSON.parse(line); } catch { note(`${line}\n`); return; }
    const waiting = takePending();
    if (waiting) waiting.resolve(reply); else note(`${line}\n`);
  });
  child.on('close', (code, signal) => { exit = { code, signal }; takePending()?.reject(exited()); });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', error => reject(new Error(`Не удалось запустить агента ${target.command}: ${spawnReason(error)}`)));
  });
  const initialState = structuredClone(state);
  let closed = false;
  const exchange = async (payload: unknown): Promise<unknown> => {
    if (closed) throw new Error('Сессия с внешним агентом закрыта.');
    ctx.signal.throwIfAborted();
    if (exit) throw exited();
    if (pending) throw new Error('У сессии уже есть активный запрос.');
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
      return body;
    } finally { clearTimeout(timer); ctx.signal.removeEventListener('abort', onAbort); }
  };
  const session: TargetSession = {
    async respond(message) {
      const body = await exchange({ type: 'respond', sessionId, scenarioId, initialState, messages: history(), message, ...(input.prompt !== undefined ? { prompt: input.prompt, promptHash: fingerprint(input.prompt) } : {}) });
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
    },
  };
  if (input.initialize) {
    try { await exchange({ type: 'open', sessionId, scenarioId, initialState, prompt: input.prompt, promptHash: input.prompt === undefined ? undefined : fingerprint(input.prompt) }); }
    catch (error) { kill(); await session.close(); throw error; }
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
export async function openExternalTarget(input: ExternalTargetInput): Promise<TargetSession> {
  if (input.target.promptFile) {
    const prompt = await readPrompt(input.target.promptFile);
    const original = input.onReply;
    input = { ...input, prompt, onReply(reply) {
      if (typeof reply === 'string' || reply.promptHash !== fingerprint(prompt)) throw new Error('Адаптер не подтвердил применение выбранного промпта (promptHash).');
      original?.(reply);
    } };
  }
  switch (input.target.kind) {
    case 'http': return httpSession({ ...input, target: input.target });
    case 'module': return moduleSession({ ...input, target: input.target });
    case 'command': return commandSession({ ...input, target: input.target });
  }
}
