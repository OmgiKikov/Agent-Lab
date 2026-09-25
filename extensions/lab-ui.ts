import type { AgentToolResult, ExtensionContext, Theme, ToolDefinition, ToolRenderResultOptions } from '@earendil-works/pi-coding-agent';
import type { Component } from '@earendil-works/pi-tui';
import { z } from 'zod';
import { safeText } from '../src/text.js';
import { AgentRequestFailed, CommandRefused, LibraryConflict, LockedError, StaleRevisionError, STOP_LABEL, STOP_REASONS, Stopped, UnknownReference } from '../src/errors.js';
import type { Experiment } from '../src/contracts.js';
import { convertible } from '../src/card/legacy-v1.js';
import { ProviderFailure, type ProviderFailureKind } from '../src/llm/model-call.js';
import { StructuredTaskError } from '../src/llm/structured.js';
import { ActionHead, contentText, lineBody, renderFeedResult, callText } from './render/feed.ts';
import { renderAgentLabResult } from './render/verdict-block.ts';
import type { Tone } from './render/theme.ts';

/**
 * A result that is neither a feed nor a result block: a progress update while the action runs, or the details an
 * older session stored. Never raw JSON: the progress text is written for the owner, an old record's details are not.
 */
export function legacyResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme): Component {
  if (options.isPartial) return lineBody(contentText(result).split('\n')[0] ?? '', 'muted', theme);
  return lineBody('Это действие из прошлой сессии — попросите показать его ещё раз.', 'muted', theme);
}

/** What the ● of a tool row shows while no result has arrived, and after: the result tells its own colour. */
interface RowState { tone?: Tone }

/**
 * Every Agent Lab tool draws its own row, Claude-Code-like (docs/design/ui-spec.md §4.10): «● what is being done», then its
 * summary under └ and details on ctrl+o. Pi's coloured box is not used: the row is the component.
 */
export const displayFor = (name: string): Pick<ToolDefinition, 'renderShell' | 'renderCall' | 'renderResult'> => ({
  renderShell: 'self',
  renderCall: (args, theme, context) => {
    // Pi shares one state object between the call and the result of a row; a host that gives none keeps the tone local.
    const state: RowState = context.state ?? {};
    return new ActionHead(callText(name, args as Record<string, unknown>), theme,
      () => context.isError ? 'error' : state.tone ?? (context.isPartial ? 'muted' : 'success'));
  },
  renderResult: (result, options, theme, context) => {
    const state: RowState = context.state ?? {};
    if (context.isError) { state.tone = 'error'; return lineBody(contentText(result), 'error', theme); }
    if (options.isPartial) { state.tone = 'muted'; return legacyResult(result, options, theme); }
    return renderFeedResult(result, options, theme, (r, o, t) => renderAgentLabResult(r, o, t, legacyResult, tone => { state.tone = tone; }), tone => { state.tone = tone; });
  },
});

/** Native confirmations exist only in Pi's interactive terminal. */
export const isInteractive = (ctx: Pick<ExtensionContext, 'hasUI' | 'mode'>): boolean => !!ctx.hasUI && ctx.mode === 'tui';
/**
 * What needs a person's native confirmation never runs headless: outside the terminal the call fails with `message`.
 * The model reads the message too, so it says what the owner does in their own words and never hands the model a
 * command line that would consent for the owner.
 */
export function requireInteractive(ctx: Pick<ExtensionContext, 'hasUI' | 'mode'>, message: string): void {
  if (!isInteractive(ctx)) throw new Error(message);
}

/**
 * A native question with Russian answers instead of Yes/No (docs/design/ui-spec.md §2): true only when the owner picked `yes`.
 * `body` is shown under the question; both are escaped here.
 */
export async function ask(ctx: Pick<ExtensionContext, 'ui'>, question: string, body: string[], yes: string, no = 'Не сейчас'): Promise<boolean> {
  const title = [question, ...(body.length ? ['', ...body] : [])].map(line => safeText(line)).join('\n');
  return await ctx.ui.select(title, [yes, no]) === yes;
}

/** The model has to put a question to the owner; nothing was written. `code` says what is missing; `ownerText` is what the owner reads — never the model's instruction or an id. */
export class NeedsOwner extends Error {
  constructor(readonly code: 'ambiguous_reference' | 'unknown_reference' | 'needs_owner_input' | 'declined', message: string,
    readonly options: string[], readonly ownerText: string) { super(message); }
}

/* ───────────────────────────── errors in the owner's words ───────────────────────────── */

/** Why long work stopped (Stopped), what was kept and the way on. */
const STOPPED: Record<Stopped['reason'], string> = {
  budget: 'Закончился лимит вызовов модели; сделанное сохранено. Поднять лимит — ваше решение: скажите «подними лимит».',
  time: 'Закончилось время, отведённое на эту работу; сделанное сохранено.',
  cancelled: 'Остановлено по вашей просьбе; сделанное сохранено.',
  closing: 'Работа остановилась при закрытии Agent Lab; сделанное сохранено.',
};
/**
 * The fixed labels lab/operation.ts gives each stop (src/errors.ts STOP_LABEL), and the English ones records kept before
 * them. A record keeps its stop's label as its error, so a stored stop is read back here by exact equality with these,
 * never by searching the text.
 */
const STOP_LABELS: Readonly<Record<string, Stopped['reason']>> = {
  ...Object.fromEntries(STOP_REASONS.map(reason => [STOP_LABEL[reason], reason])),
  'Model call budget exhausted.': 'budget', 'Experiment time limit reached.': 'time', 'Cancelled by the user.': 'cancelled', 'Application is closing.': 'closing',
};
const PROVIDER: Record<ProviderFailureKind, string> = {
  'rate limit': 'Провайдер модели ограничил частоту запросов. Подождите минуту и повторите.',
  overloaded: 'Провайдер модели перегружен или временно недоступен — повторите позже.',
  'insufficient credit': 'У провайдера модели закончились средства. Пополните счёт или выберите другую модель (/model).',
  'access denied': 'Провайдер модели отказал в доступе. Проверьте ключ и права на модель (/login).',
  timeout: 'Модель не ответила вовремя. Повторите позже.',
  'connection failure': 'Нет связи с провайдером модели. Проверьте сеть и повторите.',
  'context limit': 'Запрос не поместился в окно модели. Выберите модель с окном больше (/model) или меньше материалов.',
  'bad request': 'Провайдер модели отверг запрос в таком виде — повтор не поможет. Выберите другую модель (/model) или сообщите разработчикам Lab.',
  incomplete: 'Модель оборвала ответ. Повторите.',
  deadline: 'Модель не ответила за отведённое время. Повторите позже.',
  unavailable: 'Модель недоступна. Проверьте ключ и права на модель (/login, /model).',
  empty: 'Модель вернула пустой ответ. Повторите.',
  length: 'Ответ модели упёрся в предел длины. Повторите или выберите модель с большим пределом ответа (/model).',
};
const AGENT: Record<AgentRequestFailed['kind'], string> = {
  unreachable: 'Агент не отвечает. Проверьте, что он запущен и доступен, и повторите.',
  timeout: 'Агент не ответил вовремя. Проверьте его и повторите.',
  status: 'Агент ответил ошибкой. Посмотрите его журнал и повторите.',
  tls: 'Сертификат агента не прошёл проверку. Укажите корневой сертификат (CA) в NODE_EXTRA_CA_CERTS и перезапустите Pi.',
};
/** The fields an input names, as the owner calls them. */
const FIELD: Readonly<Record<string, string>> = {
  task: 'описание агента', materials: 'правила', rules: 'правило', requirementIds: 'правило', bind: 'правило', unbind: 'правило', included: 'правила свода', kinds: 'виды правил',
  text: 'формулировка', appliesWhen: 'условие', label: 'название факта', value: 'значение факта', askedAs: 'вопрос агента о факте', disclosure: 'когда клиент называет факт',
  when: 'когда клиент называет факт', wants: 'чего хочет клиент', writes: 'первая реплика клиента', leaves: 'когда клиент уходит', says: 'слова клиента', after: 'после чего',
  turn: 'поворот', title: 'название ситуации', maxCalls: 'лимит вызовов модели', maxDurationMs: 'время на работу', timeoutMs: 'время на один ответ', maxTurns: 'число реплик клиента',
  repeats: 'число попыток', scenarioCount: 'число ситуаций', situations: 'число ситуаций', note: 'причина', version: 'версия агента', url: 'адрес агента',
  command: 'команда запуска агента', path: 'файл агента', module: 'файл агента', args: 'аргументы запуска',
};

/** Whether a message was written for the owner: everything the engine says to a person is Russian, an English message is a diagnostic. */
const forOwner = (message: string): boolean => [...message].some(char => (char >= 'А' && char <= 'я') || char === 'ё' || char === 'Ё');

/** What one zod issue says, in plain words. */
function problemOf(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'too_big': return issue.origin === 'string' ? `не длиннее ${issue.maximum} знаков` : `не больше ${issue.maximum}`;
    case 'too_small': return issue.origin === 'string' ? Number(issue.minimum) <= 1 ? 'не может быть пустым' : `не короче ${issue.minimum} знаков`
      : issue.origin === 'array' ? `нужно хотя бы ${issue.minimum}` : `не меньше ${issue.minimum}`;
    case 'invalid_format': return 'в недопустимом виде';
    case 'invalid_value': return 'такого значения нет';
    case 'invalid_type': return 'не указано или не того вида';
    case 'unrecognized_keys': return 'лишние поля';
    case 'custom': return forOwner(issue.message) ? issue.message : 'не проходит проверку';
    default: return 'не проходит проверку';
  }
}

/** A zod error as the owner reads it: the field and what is wrong with it, never a raw issue dump. */
export function zodText(error: z.ZodError): string {
  return error.issues.slice(0, 3).map(issue => {
    const name = [...issue.path].reverse().find((key): key is string => typeof key === 'string');
    return `${name !== undefined && Object.hasOwn(FIELD, name) ? FIELD[name] : 'значение'} — ${problemOf(issue)}`;
  }).join('; ');
}

/** The original of an error the owner is not shown: for whoever reads the terminal's error output. */
function diagnose(error: unknown): void {
  process.stderr.write(`Agent Lab: ${error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error)}\n`);
}

/** What the owner reads when the cause is not theirs to act on; the original goes to the terminal's error output. */
export const UNKNOWN_ERROR = 'Не получилось из-за внутренней ошибки Agent Lab. Попробуйте ещё раз; подробности — в выводе ошибок терминала.';

/** The owner's words for an error Lab knows; undefined for anything else. */
function knownText(error: unknown): string | undefined {
  if (error instanceof NeedsOwner) return error.ownerText;
  if (error instanceof LockedError) return `Папку данных ${error.directory} сейчас ведёт другой процесс Agent Lab — другая сессия Pi или команда agent-lab. Смотреть можно здесь; изменения и запуск — после его завершения. Если такого процесса точно нет, удалите файл ${error.lockFile} и повторите.`;
  if (error instanceof StaleRevisionError) return error.message;
  if (error instanceof LibraryConflict) return 'Ситуации изменились. Откройте их заново и повторите по свежему состоянию.';
  if (error instanceof CommandRefused || error instanceof UnknownReference) return error.message;
  if (error instanceof Stopped) return STOPPED[error.reason];
  if (error instanceof ProviderFailure) return error.kind === 'unavailable' && forOwner(error.message) ? error.message : PROVIDER[error.kind];
  // The target names the cause in the owner's words (an expired or untrusted certificate, a refused port); the table is the fallback.
  if (error instanceof AgentRequestFailed) return error.kind === 'status' ? (error.status !== undefined ? `Агент ответил ошибкой ${error.status}. Посмотрите его журнал и повторите.` : AGENT.status)
    : forOwner(error.message) ? error.message : AGENT[error.kind];
  if (error instanceof StructuredTaskError) { diagnose(error); return 'Модель Lab несколько раз ответила не в том виде; ничего не записано. Повторите позже или выберите другую модель (/model).'; }
  if (error instanceof z.ZodError) return `Не получилось: ${zodText(error)}. Ничего не записано.`;
  // The engine's own refusals are plain errors worded for the owner; a plain error in English is a diagnostic.
  if (error instanceof Error && Object.getPrototypeOf(error) === Error.prototype && forOwner(error.message)) return error.message;
  return undefined;
}

/**
 * Why an action did not happen, in the owner's words, with the way on: the one translator of the chat and the workspace.
 * Typed errors by their kind; a zod error as the field and the problem; the engine's own refusals as they are. Anything
 * else never reaches the owner or the model: a neutral phrase does, and the original goes to the terminal's error output.
 */
export function inputError(error: unknown): string {
  const known = knownText(error);
  if (known !== undefined) return safeText(known);
  diagnose(error);
  return UNKNOWN_ERROR;
}

/**
 * Why long work stopped, as its record keeps it, in the owner's words: a stop's fixed label by its kind, the engine's own
 * message as it is, anything else — a diagnostic the owner cannot act on — as a neutral phrase. Undefined without an error.
 */
export function recordErrorText(error: string | null | undefined): string | undefined {
  if (!error) return undefined;
  const stop = Object.hasOwn(STOP_LABELS, error) ? STOP_LABELS[error] : undefined;
  return safeText(stop ? STOPPED[stop] : forOwner(error) ? error : 'Работа прервалась из-за внутренней ошибки Agent Lab; сделанное сохранено.');
}
/** Whether a record's work was stopped by the owner's own request (its stop's fixed label). */
export const stoppedByOwner = (error: string | null | undefined): boolean => !!error && Object.hasOwn(STOP_LABELS, error) && STOP_LABELS[error] === 'cancelled';
/** How a record's last work was stopped: its typed stop, or — a record written before it — its stop's fixed label; undefined when no stop cut it short. */
export const stopOf = (record: Pick<Experiment, 'stop' | 'error'>): Stopped['reason'] | undefined =>
  record.stop ?? (record.error && Object.hasOwn(STOP_LABELS, record.error) ? STOP_LABELS[record.error] : undefined);

/** What the workspace hands to the conversation with a request about one object: stable identities, never a copy of editable state. */
export function boardDiscussionContext(record: Experiment, situation?: { number: number; id: string }) {
  return { run: record.id, phase: record.phase, ...(situation ? { situation: situation.number } : {}),
    task: record.librarySnapshot?.formatVersion === 2
      ? 'The request concerns this Agent Lab run and, if named here, the situation by its number. Read it fresh with agent_lab_cards; change it with agent_lab_edit; its question is answered through agent_lab_decide; run with agent_lab_run. For results read agent_lab_results and agent_lab_explain, and tell observations from suspected causes. The owner decides in native dialogs; never invent a human verdict or change the external agent without an explicit request.'
      : `The request concerns this Agent Lab run. Read its situations with agent_lab_cards (an older format: they are only read${convertible(record) ? '; the draft goes on in the current format through its decision in agent_lab_decide' : ''}) and its result with agent_lab_results and agent_lab_explain; tell observations from suspected causes. Run only with agent_lab_run and its native plan. Never invent a human verdict or change the external agent without an explicit request.`,
  };
}
