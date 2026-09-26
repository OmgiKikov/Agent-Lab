import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { settingsSchema } from '../src/contracts.js';
import { checkTemplate, TOOL_PROBE_OPENING } from '../src/connection.js';
import {
  CONNECTION_FILE, connectionLines, defaultConversation, fieldLabel, fieldValue, literalFields, missingVariables, proposeReply, proposeRequest, READING_ATTEMPTS, replyFields, replyLabel,
  saveProjectConnection, shownAddress, testCallFailure, variableUse, type ConnectionReader, type ReplyField, type RequestChoice,
} from '../src/connect.js';
import { connectionFromCurl, type CurlFields, type CurlReady } from '../src/curl.js';
import type { ExperimentLab } from '../src/experiment.js';
import { countText } from '../src/plural.js';
import type { TemplateTarget } from '../src/targets.js';
import { clip, oneLine, safeText } from '../src/text.js';
import { row } from './conversation.ts';
import { displayFor, isInteractive } from './lab-ui.ts';
import type { Feed } from './render/feed.ts';
import { TOOL } from './steps.ts';

/*
 * «Вот ручка агента» with a curl pasted into the chat: Lab connects the agent in its own request format, and the owner
 * types no path and no flag. Two confirmations, both native: how the request is read (the address, the customer's
 * message, the conversation, what Lab fills in itself, the secrets), then — after the owner agrees to two test
 * messages — where the agent's text is in its reply. What the structure of the request shows needs no model; where it
 * does not, the owner picks the field, or lets the builder model propose it (connect.ts) — the model reads the curl's
 * fields only at that word, their secrets already names of variables. The consent to the test messages says the model
 * may read the agent's replies to them. Only a connection whose two test messages were answered is saved: the project's
 * connection.json and Lab's remembered connection, which the preparation and the run pick up. Nothing is saved on any
 * failure or step back, and the agent under test is only ever sent Lab's fixed test phrases.
 */

export interface ConnectHost {
  reading: (directory: string) => ExperimentLab;
  feedResult: (callId: string, output: unknown, feed: Feed, note: string) => AgentToolResult<unknown>;
}

const closed = { additionalProperties: false } as const;
const CHARACTERS: [string, string, string] = ['символ', 'символа', 'символов'];
const YES = 'Да';
const NOT_NOW = 'Не сейчас';

/** One native list with Russian answers; the answer picked, or undefined when the owner closed it. Every line is escaped here. */
async function choose(ctx: Pick<ExtensionContext, 'ui'>, question: string, body: readonly string[], options: readonly string[]): Promise<string | undefined> {
  const safe = options.map(option => safeText(option));
  const picked = await ctx.ui.select([question, ...(body.length ? ['', ...body] : [])].map(line => safeText(line)).join('\n'), safe);
  const index = picked === undefined ? -1 : safe.indexOf(picked);
  return index < 0 ? undefined : options[index];
}

const valueText = (value: string) => value ? `«${clip(oneLine(value), 40)}»` : 'пусто';

/** The offer to let the builder model read the request, with what it reads and what it costs. */
const PROPOSE_REQUEST = `Пусть предложит модель Lab — прочтёт поля запроса: до ${READING_ATTEMPTS} вызовов модели`;

/**
 * The owner's own reading of the request: the message field, then the conversation fields ticked through one list.
 * With `propose`, the same list offers to let the builder model read the request instead: nothing of the curl reaches
 * a model before the owner picks that offer. A model that could not answer leaves the pick to the owner.
 */
async function pickRequest(ctx: Pick<ExtensionContext, 'ui'>, asked: CurlFields, conversation: readonly string[],
  propose?: () => Promise<RequestChoice | undefined>): Promise<RequestChoice | undefined> {
  const fields = literalFields(asked);
  const labels = fields.map(field => `${fieldLabel(field.pointer)} · ${valueText(field.value)}`);
  const offer = propose ? [PROPOSE_REQUEST] : [];
  const picked = await choose(ctx, 'Какое поле запроса — сообщение клиента?', ['Сюда Lab подставит слова клиента в каждой реплике.',
    ...(propose ? ['Выберите поле сами или поручите модели Lab: она прочтёт имена и значения полей запроса из вашего curl — секреты в них уже заменены именами переменных окружения.'] : [])],
  [...labels, ...offer, NOT_NOW]);
  if (propose && picked === PROPOSE_REQUEST) return await propose() ?? pickRequest(ctx, asked, conversation);
  const message = fields[labels.indexOf(picked ?? '')]?.pointer;
  if (message === undefined) return undefined;
  // A conversation id is a value of the request: not a turn's role, not a secret read from the environment.
  const others = asked.fields.filter(field => field.pointer !== message && !field.pointer.endsWith('/role') && !(typeof field.value === 'string' && field.value.startsWith('{{env:')));
  const chosen = new Set(conversation.filter(pointer => pointer !== message));
  while (true) {
    const ordered = others.filter(field => chosen.has(field.pointer)).map(field => field.pointer);
    const done = ordered.length ? `Готово — разговор: ${ordered.map(fieldLabel).join(', ')}` : 'Готово — без поля разговора';
    const toggles = others.map(field => `${chosen.has(field.pointer) ? '✓' : '○'} ${fieldLabel(field.pointer)} · ${valueText(field.value === null ? '' : fieldValue(field))}`);
    const answer = await choose(ctx, 'Какие поля — идентификатор разговора?', ['В них Lab ставит новое значение в каждой ситуации, чтобы агент начинал её с чистого листа. Отметьте и нажмите «Готово».'],
      [done, ...toggles, NOT_NOW]);
    if (answer === done) return { message, conversation: ordered };
    const field = others[toggles.indexOf(answer ?? '')];
    if (!field) return undefined;
    if (chosen.has(field.pointer)) chosen.delete(field.pointer); else chosen.add(field.pointer);
  }
}

/** The owner's pick of the reply field: its path, length and beginning — the agent's answer to Lab's test phrase. */
async function pickReply(ctx: Pick<ExtensionContext, 'ui'>, fields: readonly ReplyField[]): Promise<string | undefined> {
  const labels = fields.map(field => `${fieldLabel(field.pointer)} · ${countText(field.text.length, CHARACTERS)} · ${valueText(field.text)}`);
  const picked = await choose(ctx, 'Где в ответе агента его текст клиенту?', [`Lab написал агенту «${TOOL_PROBE_OPENING}».`], [...labels, NOT_NOW]);
  return fields[labels.indexOf(picked ?? '')]?.pointer;
}

/** The one confirmation of the reply: the text found at the proposed or picked field. */
async function confirmReply(ctx: Pick<ExtensionContext, 'ui'>, fields: readonly ReplyField[], proposed: string | undefined): Promise<string | undefined> {
  let pointer = proposed ?? await pickReply(ctx, fields);
  while (pointer !== undefined) {
    const field = fields.find(item => item.pointer === pointer)!;
    const answer = await choose(ctx, `Агент ответил: «${clip(oneLine(field.text), 120)}» — это ответ?`, [`Поле ответа: ${fieldLabel(pointer)}.`], [YES, 'Нет, выбрать другое поле']);
    if (answer === YES) return pointer;
    if (answer === undefined) return undefined;
    pointer = await pickReply(ctx, fields);
  }
  return undefined;
}

/** The chat's model reads the request and the reply when Pi can reach it; without one the owner picks. */
async function readerOf(ctx: Pick<ExtensionContext, 'model'>, lab: ExperimentLab): Promise<{ reader?: ConnectionReader; timeoutMs: number }> {
  const settings = ctx.model && settingsSchema.parse({ provider: ctx.model.provider, model: ctx.model.id });
  if (!settings) return { timeoutMs: 0 };
  const reader = (await lab.modelRuntime(settings).catch(() => undefined))?.connectionReading;
  return { ...(reader ? { reader } : {}), timeoutMs: settings.timeoutMs };
}

/** What a made connection sends: the http target with its request template. */
const templateOf = (made: CurlReady): TemplateTarget => {
  const target = made.target;
  if (target.kind !== 'http' || !target.request) throw new Error('Подключение из curl не сложилось: нет шаблона запроса.');
  return { ...target, request: target.request };
};

export function registerConnectTool(pi: Pick<ExtensionAPI, 'registerTool'>, host: ConnectHost): void {
  pi.registerTool({
    ...displayFor(TOOL.connect), name: TOOL.connect, label: 'Connect the agent from curl',
    description: 'Connects the agent under test from a curl command the owner pasted (their working request to the agent): pass the whole text exactly as written, quotes and line breaks included. Lab reads which field is the customer\'s message and which fields are the conversation, the owner confirms in a native dialog, agrees to two test messages, confirms where the agent\'s answer is, and Lab saves connection.json; the next preparation and run use it. Never ask the owner for field paths or flags.',
    parameters: Type.Object({
      curl: Type.String({ minLength: 1, maxLength: 20000, description: 'The curl command exactly as the owner pasted it.' }),
    }, closed),
    executionMode: 'sequential',
    async execute(callId, params, toolSignal, _onUpdate, ctx) {
      const signal = AbortSignal.any([toolSignal, ctx.signal].filter((item): item is AbortSignal => !!item));
      signal.throwIfAborted();
      return connect(host, callId, ctx, signal, params.curl);
    },
  });
}

async function connect(host: ConnectHost, callId: string, ctx: ExtensionContext, signal: AbortSignal, source: string): Promise<AgentToolResult<unknown>> {
  const directory = resolve(ctx.cwd, '.agent-lab');
  const refused = (text: string) => host.feedResult(callId, { connected: false, saved: false, reason: text,
    instruction: 'Nothing was saved. Tell the owner in one sentence what went wrong and the next step from the reason; do not retry on your own.' },
  { tone: 'warning', rows: [row(safeText(text))] }, 'Агент не подключён');
  const declined = (text: string) => host.feedResult(callId, { connected: false, saved: false, cancelled: true,
    instruction: 'The owner stepped back: nothing was saved. Do not ask again unless they do.' }, { tone: 'warning', rows: [row(safeText(text))] }, 'Подключение отменено');
  if (!isInteractive(ctx)) return refused('Подключение агента подтверждает владелец в интерактивном терминале Pi. Без него: agent-lab connect --curl запрос.txt.');

  let asked: CurlFields;
  try { asked = connectionFromCurl(source); } catch (error) { return refused(`${error instanceof Error ? error.message : String(error)} Ничего не отправлено и не сохранено.`); }
  const { reader, timeoutMs } = await readerOf(ctx, host.reading(directory));
  let made: CurlReady;
  try {
    // 1. How the request is read: what its structure shows, else the owner's pick — or, at their word, the model's reading; confirmed or corrected by the owner.
    let choice = await proposeRequest(asked, { timeoutMs, signal })
      ?? await pickRequest(ctx, asked, defaultConversation(asked), reader && (() => proposeRequest(asked, { reader, timeoutMs, signal })));
    while (true) {
      if (!choice) return declined('Агента не подключаю: вы не выбрали поля запроса. Ничего не отправлено.');
      made = connectionFromCurl(source, { message: choice.message, conversation: choice.conversation });
      const answer = await choose(ctx, 'Так подключить агента?', connectionLines(made, choice.reason), [YES, 'Нет, поправить']);
      if (answer === YES) break;
      if (answer === undefined) return declined('Агента не подключаю: вы закрыли подтверждение. Ничего не отправлено.');
      choice = await pickRequest(ctx, asked, choice.conversation);
    }
  } catch (error) { if (signal.aborted) throw error; return refused(`${error instanceof Error ? error.message : String(error)} Ничего не отправлено и не сохранено.`); }

  const target = templateOf(made);
  const missing = missingVariables(target);
  // A variable the curl names and the owner already has is read as it is; one Lab named for a secret of the curl is set once.
  if (missing.length) return refused(`Перед проверкой задайте в окружении ${missing.map(variable => variableUse(made, variable)).join(', ')} и перезапустите Pi, затем пришлите curl ещё раз. Ничего не отправлено и не сохранено.`);

  // 2. The owner's consent to the test messages, then where the agent's text is.
  if (await choose(ctx, 'Отправить агенту 2 тестовых сообщения?', [`Адрес: ${shownAddress(target)}`,
    'Агент должен уже работать по этому адресу: Lab его не запускает. Если он ещё не запущен, запустите его и тогда отправляйте.',
    `Lab напишет «${TOOL_PROBE_OPENING}» и ещё одно сообщение в том же разговоре и прочтёт ответы агента.`,
    ...(reader ? [`Если в ответе несколько текстовых полей, какое из них ответ клиенту, предложит модель Lab: она прочтёт ответ агента на первое сообщение — до ${READING_ATTEMPTS} вызовов модели.`] : [])],
  ['Отправить', NOT_NOW]) !== 'Отправить')
    return declined('Тестовые сообщения не отправляю: вы отказались. Ничего не сохранено.');
  let empty = false;
  let check: Awaited<ReturnType<typeof checkTemplate>>;
  try {
    check = await checkTemplate(target, async first => {
      const fields = replyFields(first);
      if (!fields.length) { empty = true; return undefined; }
      const proposed = await proposeReply(fields, { ...(reader ? { reader } : {}), timeoutMs, signal });
      return confirmReply(ctx, fields, proposed?.pointer);
    }, signal);
  } catch (error) { if (signal.aborted) throw error; return refused(`${testCallFailure(error)} Ничего не сохранено.`); }
  if (empty) return refused('Агент ответил, но в его ответе нет ни одного текста: проверьте, что curl ведёт к диалоговой ручке агента. Ничего не сохранено.');
  if (check.reply === undefined) return declined('Агента не подключаю: поле ответа не выбрано. Ничего не сохранено.');
  if (!check.passed || !check.request) return refused(`${check.failure ?? `Агент не ответил текстом в поле ${fieldLabel(check.reply)}.`} Ничего не сохранено.`);

  // 3. Saved where the preparation and the run find it; a connection.json already there is replaced only at the owner's word.
  const file = resolve(ctx.cwd, CONNECTION_FILE);
  const exists = await access(file).then(() => true, () => false);
  if (exists && await choose(ctx, `В папке проекта уже есть ${CONNECTION_FILE}. Заменить его этим подключением?`, [`Адрес: ${shownAddress(target)}`], ['Заменить', NOT_NOW]) !== 'Заменить')
    return declined(`Подключение проверено, но не сохранено: вы оставили прежний ${CONNECTION_FILE}.`);
  await saveProjectConnection({ project: ctx.cwd, data: directory, target: { ...target, request: check.request }, replace: exists });
  const variables = [...new Set([...Object.values(target.headersEnv), ...made.substitutions.flatMap(item => item.variable ? [item.variable] : [])])];
  return host.feedResult(callId, { connected: true, saved: CONNECTION_FILE, address: shownAddress(target), reply: replyLabel(check.reply),
    ...(variables.length ? { environment: variables } : {}), ...(check.warnings.length ? { warnings: check.warnings } : {}),
    instruction: check.warnings.length
      ? 'The agent is connected and both test messages were answered, but Lab could not confirm how it keeps the conversation (warnings). Tell the owner in one line, name the warning in plain words, and offer the next step: check the agent on its logs (agent_lab_prepare).'
      : 'The agent is connected and both test messages were answered; the next preparation and run use this connection. Tell the owner in one line and offer the next step: check the agent on its logs (agent_lab_prepare).' },
  { ...(check.warnings.length ? { tone: 'warning' as const } : {}),
    rows: [row(safeText(`Агент подключён: ${shownAddress(target)}`), 'text', true),
      row(safeText(`Ответ агента — поле ${replyLabel(check.reply)}; оба тестовых сообщения прошли. Сохранено в ${CONNECTION_FILE}.`), 'muted'),
      ...check.warnings.map(warning => row(safeText(warning))),
      row('Дальше: проверить агента на логах.', 'muted')] }, 'Подключение агента');
}
