import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { addUsage, checkSchema, emptyUsage, experimentSchema, fingerprint, isRunnable, runnableTargetSchema, settingsSchema, targetSchema, worldSchema, type Experiment, type RunnableTarget, type Scenario, type Target, type ToolChannel } from './contracts.js';
import type { Runtime } from './runtime.js';
import { evaluateTrial } from './evaluation.js';
import { hasCompleteJudgment, observableSources, scenarioSources, sealJudgeReceipt } from './judge.js';
import { sourceIdentity } from './normalize.js';
import { agentSession, preflightTarget, templateRequest, type TemplateTarget } from './targets.js';
import { atPointer, bubblePointer, pointerOf, pointerTokens, replyAt, replyStructure, scalarFields, stringFields, type Json, type RequestTemplate } from './http-template.js';
import { writeFileAtomic } from './fs-atomic.js';
import { SUITE_FORMAT } from './suite.js';

const step = z.strictObject({ message: z.string().trim().min(1).max(3000), reply: z.string().min(1).max(8000) });
const probeSchema = z.strictObject({
  initialState: worldSchema, write: step, read: step, reset: step,
  checks: z.array(checkSchema).max(10).default([]),
}).refine(p => p.read.reply !== p.reset.reply, 'Проверка должна различать сохранённую историю и новую сессию.');
/** Marks a saved connection file; project detection recognises one by it before reading the file as a connection. */
export const CONNECTION_FORMAT = 'agent-lab-connection-1';
const connectionSchema = z.strictObject({ format: z.literal(CONNECTION_FORMAT), target: runnableTargetSchema,
  targetVersion: z.string().trim().min(1).max(200).optional(), probe: probeSchema.optional(), verifiedAt: z.string().optional() });
export type Connection = z.infer<typeof connectionSchema>;

/** Only paths have a base directory. Arguments and environment variable names remain literal. */
export function resolveTarget(raw: unknown, base: string): Target {
  if (!raw || typeof raw !== 'object') return targetSchema.parse(raw);
  const target = { ...raw } as Record<string, unknown>;
  if (typeof target.promptFile === 'string') target.promptFile = resolve(base, target.promptFile);
  if (target.kind === 'module' && typeof target.path === 'string') target.path = resolve(base, target.path);
  if (target.kind === 'command') {
    target.cwd = resolve(base, typeof target.cwd === 'string' ? target.cwd : '.');
    if (typeof target.command === 'string' && target.command.includes('/')) target.command = resolve(target.cwd as string, target.command);
  }
  if (target.kind !== 'sandbox' && target.release && typeof target.release === 'object') {
    const release = { ...(target.release as Record<string, unknown>) };
    release.cwd = resolve(base, typeof release.cwd === 'string' ? release.cwd : '.');
    if (typeof release.command === 'string' && release.command.includes('/')) release.command = resolve(typeof release.cwd === 'string' ? release.cwd : base, release.command);
    target.release = release;
  }
  return targetSchema.parse(target);
}

export function portableTarget(target: Target, base: string): unknown {
  const path = (file: string) => relative(base, file) || '.';
  const executable = (cwd: string, file: string) => { const value = relative(cwd, file); return value.includes('/') ? value : `./${value}`; };
  const prompt = isRunnable(target) && target.promptFile ? { promptFile: path(target.promptFile) } : {};
  const release = isRunnable(target) && target.release ? { release: { ...target.release, ...(target.release.cwd ? { cwd: path(target.release.cwd) } : {}),
    command: isAbsolute(target.release.command) ? executable(target.release.cwd ?? base, target.release.command) : target.release.command } } : {};
  if (target.kind === 'module') return { ...target, ...prompt, ...release, path: path(target.path) };
  if (target.kind !== 'command') return { ...target, ...prompt, ...release };
  const cwd = target.cwd ?? process.cwd();
  return { ...target, ...prompt, ...release, cwd: path(cwd), command: isAbsolute(target.command) ? executable(cwd, target.command) : target.command,
    args: target.args.map(arg => isAbsolute(arg) && /\.(?:[cm]?js|ts|py|sh)$/.test(arg) ? relative(cwd, arg) : arg) };
}

export async function readConnection(file: string): Promise<Connection> {
  const raw = JSON.parse(await readFile(file, 'utf8'));
  return connectionSchema.parse({ ...raw, target: resolveTarget(raw.target, dirname(resolve(file))) });
}
export async function rememberedConnection(directory: string): Promise<Connection | undefined> {
  try { return await readConnection(resolve(directory, 'connection.local.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}
export async function rememberConnection(directory: string, connection: Connection): Promise<void> {
  const previous = await rememberedConnection(directory);
  if (!connection.probe && previous?.probe && fingerprint(previous.target) === fingerprint(connection.target)) connection = { ...connection, probe: previous.probe };
  const path = resolve(directory, 'connection.local.json');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, JSON.stringify(connectionSchema.parse({ ...connection, verifiedAt: new Date().toISOString() }), null, 2) + '\n');
}

export async function listSuites(directory: string) {
  const files = await readdir(directory);
  return Promise.all(files.filter(file => file.endsWith('.json')).sort().map(async file => {
    const path = resolve(directory, file);
    try {
      const raw = JSON.parse(await readFile(path, 'utf8'));
      if (raw.format !== SUITE_FORMAT) return { file: path, error: 'Не является набором Agent Lab.' };
      const record = experimentSchema.parse({ ...raw.definition, target: resolveTarget(raw.definition.target, dirname(path)) });
      const accepted = (record.acceptedTests ?? []).filter(test => {
        const scenario = record.scenarios.find(candidate => candidate.id === test.scenarioId);
        return scenario !== undefined && fingerprint(scenario) === test.definitionHash;
      });
      return { file: path, task: record.task, cases: record.scenarios.map(s => ({ id: s.id, title: s.title, tier: s.tier })),
        acceptedCount: accepted.length, acceptedTestIds: accepted.map(test => test.testId),
        sourceRunId: record.sourceEvidence?.runId ?? record.parentRunId, sourceTrials: record.sourceEvidence?.trials.length ?? 0 };
    } catch (error) { return { file: path, error: error instanceof Error ? error.message : String(error) }; }
  }));
}

/** An explicit three-request probe exercises history and reset, using the real adapter path. */
export async function doctor(connection: Connection, signal = new AbortController().signal) {
  const probe = probeSchema.parse(connection.probe);
  await preflightTarget(connection.target);
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(new Error('Connection probe exceeded 180 seconds')), 180000);
  const usage = emptyUsage();
  // Scripted probe cards without rubrics: nothing here calls a model or generates a user.
  const runtime: Runtime = {};
  const settings = settingsSchema.parse({ repeats: 1, maxTurns: 2, maxCalls: 5, userModes: ['scripted'], maxDurationMs: 180000 });
  const spec = { name: 'Connection probe', instructions: 'Use the external connection.', tools: [] };
  const revision = { id: fingerprint(spec), spec, parentId: null, hypothesis: 'Connection probe', createdAt: new Date().toISOString() };
  const makeCard = (reset: boolean): Scenario => ({ id: reset ? 'probe-reset' : 'probe-history', familyId: 'probe', split: 'dev',
    title: reset ? 'Новая сессия и сброс состояния' : 'Два хода с сохранением истории', tier: 'smoke', provenance: 'curated', requirementIds: [],
    user: { goal: 'Проверить подключение', facts: 'Заданы владельцем адаптера', behavior: 'Следовать сценарию',
      opening: reset ? probe.reset.message : probe.write.message, script: reset ? [] : [probe.read.message], maxFollowUps: reset ? 0 : 1 },
    initialState: probe.initialState,
    checks: [{ id: 'reply', kind: 'answer_equals', description: 'Ожидаемый ответ проверки подключения', value: reset ? probe.reset.reply : probe.read.reply },
      ...(reset ? Object.entries(probe.initialState.records).flatMap(([recordId, fields]) => Object.entries(fields).map(([field, value], i) =>
        ({ id: `reset-${recordId}-${i}`, kind: 'state_equals' as const, description: 'Новая сессия восстановила исходное состояние', recordId, field, value }))) : probe.checks)],
  });
  try {
    const trials = [];
    for (const reset of [false, true]) trials.push(await evaluateTrial({ runtime, revision, scenario: makeCard(reset), sources: [], requirements: [], repeat: 0,
      manifestHash: fingerprint(probe), settings, userMode: 'scripted', target: connection.target,
      ctx: { signal: combined, timeoutMs: 60000, beforeCall() { combined.throwIfAborted(); if (++usage.calls > 3) throw new Error('Probe call limit exceeded'); },
        addUsage(u) { addUsage(usage, u); } } }));
    const firstReply = trials[0]!.events.find(e => e.type === 'assistant')?.text;
    const passed = trials.every(t => t.outcome === 'pass') && firstReply === probe.write.reply
      && trials.every(t => t.observation?.resetConfirmed === true && t.observation.tools === 'complete' && !!t.observation.version)
      && trials[0]!.observation?.version === trials[1]!.observation?.version;
    return { format: 'agent-lab-doctor-1', passed, createdAt: new Date().toISOString(), target: connection.target, trials,
      message: passed ? 'История и сброс прошли заданную проверку; адаптер сообщил версию и полную трассу в заявленной области инструментов.'
        : 'Проверьте ответы, итоговое состояние, resetConfirmed, eventsComplete и стабильную version.',
      limitation: 'Это проверка заданного поведения. Состояние и полноту событий сообщает адаптер; его реализацию нужно сверять с тестовой системой.' };
  } finally { clearTimeout(timer); }
}

/** The customer's message of the tool probe when the preparation has no logged one: the agent answers it as it would anyone. */
export const TOOL_PROBE_OPENING = 'Здравствуйте! Подскажите, пожалуйста, чем вы можете помочь?';
const TEMPLATE_SECOND_MESSAGE = 'Спасибо! А что ещё вы можете подсказать?';

/**
 * How the agent keeps the conversation, as its template says, and what the second turn showed of it: `history` —
 * the turns went whole; `conversation` — Lab's id went in both requests; `session` — the id the agent named went back
 * to it; `none` — the request carries neither.
 */
export interface MemoryCheck { claim: 'history' | 'conversation' | 'session' | 'none'; shown: boolean }

/** What the check of an agent in its own format saw: the reply's structure, and — once the text's path is known — both turns. */
export interface TemplateCheck {
  /** Where the first reply's strings are and how long they are; never their values. */
  structure: { pointer: string; length: number }[];
  /** The path the check read — every bubble where the reply is an array of them; undefined while the owner has not picked one. */
  reply?: string;
  /** Characters of text at that path in each turn of the same conversation; null when there was none. */
  turns: (number | null)[];
  /** The template to save: the reply path, and where the agent names its own conversation. */
  request?: RequestTemplate;
  memory?: MemoryCheck;
  passed: boolean;
  /** Why the check did not pass, in the owner's words. */
  failure?: string;
  /** What the check could not decide: said to the owner, never a silent pass. */
  warnings: string[];
}

/** A key as a conversation id is named in a request and in a reply alike: `session_id` and `sessionId` are one. */
const idKey = (pointer: string) => [...(pointerTokens(pointer).at(-1) ?? '')].filter(char => char !== '_' && char !== '-').join('').toLowerCase();
const CONVERSATION_VALUES = new Set(['{{conversation}}', '{{conversation:number}}', '{{session}}']);

/**
 * The connection check of an agent in its own format: one test message shows the reply's structure; with the
 * text's path known, a second message in the same conversation must be answered too, and what the template says
 * about the conversation is checked by structure alone: the turns really went whole, the agent's own id really went
 * back to it and it answered in that same conversation, Lab's id came back unchanged where the agent names it.
 * What cannot be decided so is a warning. There is no reset to check: every dialogue of a run is a new conversation.
 * `reply` is the path, or how to pick it from the first reply (the chat asks the owner there); undefined leaves it unpicked.
 */
export async function checkTemplate(target: TemplateTarget, reply: string | undefined | ((first: unknown) => Promise<string | undefined>),
  signal = new AbortController().signal): Promise<TemplateCheck> {
  const conversation = randomUUID();
  const first = await templateRequest(target, { message: TOOL_PROBE_OPENING, conversation, turns: [{ role: 'user', text: TOOL_PROBE_OPENING }] }, signal);
  const structure = replyStructure(first.reply);
  if (typeof reply === 'function') reply = await reply(first.reply);
  if (reply === undefined) return { structure, turns: [], passed: false, warnings: [] };
  const pointer = bubblePointer(first.reply, reply);
  const length = (text: string | undefined) => text?.trim() ? text.length : null;
  const firstText = replyAt(first.reply, pointer);
  const turns = [length(firstText)];
  const warnings: string[] = [];
  let request: RequestTemplate = { ...target.request, reply: pointer };
  if (turns[0] === null) return { structure, reply: pointer, turns, request, passed: false, failure: 'В этом поле ответа нет текста.', warnings };

  // Where the request names the conversation, and whether the first reply names it under the same key.
  const fields = stringFields(request.body).filter(field => CONVERSATION_VALUES.has(field.value));
  const replied = scalarFields(first.reply);
  const echo = (field: { pointer: string }) => replied.find(item => idKey(item.pointer) === idKey(field.pointer) && item.value !== '');
  const same = (a: unknown, b: unknown) => a !== undefined && b !== undefined && String(a) === String(b);
  const agentNamed = fields.filter(field => field.value === '{{session}}' || echo(field) && !same(echo(field)!.value, atPointer(first.sent, field.pointer)));
  if (agentNamed.length) {
    // The agent names the conversation itself: the id its reply gave goes into the next request, Lab's own id only opens one.
    const at = agentNamed.map(echo).find(item => item !== undefined)?.pointer;
    const opening = agentNamed.find(field => field.value !== '{{session}}')?.value;
    let body = request.body;
    for (const field of agentNamed) body = replaced(body, field.pointer, '{{session}}');
    request = { ...request, body, session: { first: request.session?.first ?? opening ?? '', ...(at !== undefined ? { reply: at } : {}) } };
  }
  const checked: TemplateTarget = { ...target, request };
  const session = agentSession(checked, first.reply);
  const second = await templateRequest(checked, { message: TEMPLATE_SECOND_MESSAGE, conversation, ...(session !== undefined ? { session } : {}),
    turns: [{ role: 'user', text: TOOL_PROBE_OPENING }, { role: 'assistant', text: firstText! }, { role: 'user', text: TEMPLATE_SECOND_MESSAGE }] }, signal);
  turns.push(length(replyAt(second.reply, pointer)));
  if (turns[1] === null) return { structure, reply: pointer, turns, request, passed: false, failure: 'На второе сообщение в том же разговоре агент ответил без текста в этом поле.', warnings };

  const sent = stringFields(second.sent).map(field => field.value);
  const named = (document: unknown) => request.session?.reply === undefined ? undefined : atPointer(document, request.session.reply);
  let memory: MemoryCheck;
  let failure: string | undefined;
  if (request.history) {
    memory = { claim: 'history', shown: [TOOL_PROBE_OPENING, firstText!, TEMPLATE_SECOND_MESSAGE].every(text => sent.includes(text)) };
    if (!memory.shown) failure = 'Во втором запросе не ушла история разговора: проверьте поле с репликами в curl.';
  } else if (request.session) {
    const carried = session !== undefined && agentNamed.every(field => same(atPointer(second.sent, field.pointer), session));
    const again = named(second.reply);
    memory = { claim: 'session', shown: carried && (again === undefined || same(again, session)) };
    if (session === undefined) warnings.push('Агент не назвал в ответе свой идентификатор разговора: каждое сообщение уйдёт как начало нового разговора. Если агент не помнит разговор иначе, многоходовые ситуации измерятся неверно.');
    else if (!memory.shown) failure = 'На второе сообщение агент открыл новый разговор: идентификатор из его первого ответа он не продолжил.';
  } else if (fields.length) {
    const echoed = fields.map(echo).find(item => item !== undefined);
    const again = echoed ? atPointer(second.reply, echoed.pointer) : undefined;
    memory = { claim: 'conversation', shown: echoed !== undefined && same(again, atPointer(second.sent, fields.find(field => echo(field) === echoed)!.pointer)) };
    if (echoed === undefined) warnings.push('Агент не называет разговор в ответе: Lab не может проверить, что он помнит первое сообщение по идентификатору разговора. Если в многоходовых ситуациях агент «забывает» сказанное — причина в этом.');
    else if (!memory.shown) failure = 'На второе сообщение агент ответил в другом разговоре: разговор по идентификатору от Lab он не держит.';
  } else {
    memory = { claim: 'none', shown: false };
    warnings.push('В запросе нет ни идентификатора разговора, ни истории сообщений: Lab не может ни начать каждую ситуацию с нового разговора, ни проверить, что агент помнит первое сообщение. Если в запросе есть поле разговора, подключите заново и отметьте его.');
  }
  return { structure, reply: pointer, turns, request, memory, passed: !failure, ...(failure ? { failure } : {}), warnings };
}

/** A copy of a JSON value with the value at `pointer` replaced. */
function replaced(document: Json, pointer: string, value: Json): Json {
  const [head, ...rest] = pointerTokens(pointer);
  if (head === undefined) return value;
  const tail = pointerOf(rest);
  if (Array.isArray(document)) return document.map((item, i) => String(i) === head ? replaced(item, tail, value) : item);
  if (document && typeof document === 'object') return { ...document, [head]: replaced(document[head] ?? null, tail, value) };
  return document;
}

/** Saves a connection file the owner named; `replace` only for an explicit change of that same file. */
export async function saveConnection(file: string, connection: Connection, replace: boolean): Promise<void> {
  const checked = connectionSchema.parse(connection);
  const text = JSON.stringify({ ...checked, target: portableTarget(checked.target, dirname(resolve(file))) }, null, 2) + '\n';
  if (replace) await writeFileAtomic(file, text);
  else await writeFile(file, text, { flag: 'wx', mode: 0o600 });
}

/**
 * Whether the agent's tool calls can be judged: one message through the real adapter path, no model call. The tool
 * channel is confirmed only when every reply declares its tool journal complete (eventsComplete) and names at least
 * one tool — in its declared scope or in the calls it made; a wildcard scope names no tool. Anything else leaves the
 * agent judged on its replies, and the reason says why in the owner's words. The probe is part of the preparation's
 * consent («Lab один раз спросит агента…»), and its answer is stored on the record so a resume and the acceptance
 * read the same channel.
 */
export async function probeToolChannel(target: RunnableTarget, opening: string, signal: AbortSignal): Promise<ToolChannel> {
  const settings = settingsSchema.parse({ repeats: 1, maxTurns: 2, maxCalls: 5, userModes: ['static'], maxDurationMs: 180000 });
  const spec = { name: 'Tool probe', instructions: 'Use the external connection.', tools: [] };
  const revision = { id: fingerprint(spec), spec, parentId: null, hypothesis: 'Tool probe', createdAt: new Date().toISOString() };
  const scenario: Scenario = { id: 'probe-tools', familyId: 'probe', split: 'dev', title: 'Какие инструменты показывает агент', tier: 'smoke', provenance: 'curated',
    requirementIds: [], user: { goal: 'Узнать, чем агент может помочь', facts: 'Нет', behavior: 'Одно сообщение', opening, maxFollowUps: 0 },
    initialState: { records: {}, writableFields: [], transientFailures: 0 }, checks: [] };
  const trial = await evaluateTrial({ runtime: {}, revision, scenario, sources: [], requirements: [], repeat: 0, manifestHash: fingerprint(scenario), settings,
    userMode: 'static', target, ctx: { signal, timeoutMs: 60000, beforeCall() { signal.throwIfAborted(); }, addUsage() {} } });
  const checkedAt = new Date().toISOString();
  if (trial.outcome === 'invalid' || trial.outcome === 'cancelled') return { confirmed: false, tools: [], reason: 'агент не ответил на пробное сообщение — оцениваем только ответы', checkedAt };
  if (trial.observation?.tools !== 'complete') return { confirmed: false, tools: [], reason: 'агент не подтвердил полный журнал инструментов — оцениваем только ответы', checkedAt };
  const called = trial.events.flatMap(event => event.type === 'tool_call' && event.tool ? [event.tool] : []);
  const tools = [...new Set([...(trial.observation.toolScope ?? []).filter(tool => !tool.endsWith('*')), ...called])].slice(0, 50);
  return tools.length ? { confirmed: true, tools, checkedAt }
    : { confirmed: false, tools: [], reason: 'агент не назвал ни одного инструмента — оцениваем только ответы', checkedAt };
}

/**
 * The source attempts a saved suite or a reassessment carries. A legacy full judge audit is
 * replaced by a receipt sealed with the full verifier now, so the copy never duplicates the audit.
 */
export function suiteEvidence(record: Experiment, scenarioIds: string[]) {
  const selected = new Set(scenarioIds);
  const trials = record.trials.filter(trial => selected.has(trial.scenarioId)).map(trial => {
    const copy = structuredClone(trial);
    if (copy.judgeAudit) {
      const scenario = record.scenarios.find(s => s.id === copy.scenarioId);
      const complete = !!scenario && hasCompleteJudgment({ scenario, sources: observableSources(scenarioSources(record, scenario), record.requirements), trial: copy });
      copy.judgeReceipt ??= sealJudgeReceipt(copy.judgeAudit, complete);
      delete copy.judgeAudit;
    }
    return copy;
  });
  const trialIds = new Set(trials.map(trial => trial.id));
  return { runId: record.id, ...(record.parentRunId ? { parentRunId: record.parentRunId } : {}), trials,
    humanReviews: record.humanReviews.filter(review => trialIds.has(review.trialId)).map(review => structuredClone(review)),
    identity: sourceIdentity(record, scenarioIds) };
}
