import type { z } from 'zod';
import type { Experiment } from './contracts.js';
import { AgentRequestFailed, CommandRefused, LibraryConflict, LockedError, NoSuchRecord, StaleRevisionError, STOP_LABEL, STOP_REASONS, Stopped, UnknownReference, UnreadableRecord } from './errors.js';
import { ModelCallDefect, ProviderFailure, type ProviderFailureKind } from './llm/model-call.js';
import { StructuredTaskError } from './llm/structured.js';

/*
 * Why something did not happen, in the owner's words — the one translator of every surface. The command line
 * (cli/errors.ts) and Pi (extensions/lab-ui.ts) add only what is theirs: the files and flags a command was given, the
 * questions the chat puts to the owner, Pi's own tool errors; the way on is said in each surface's terms (a command, a
 * slash command) through `way`.
 *
 * What reaches the owner is decided by the error's type, never by its words:
 *   Lab's typed failures ───────────── their text below (a stop, a provider, an agent, a lock, a record)
 *   an error Lab wrote for the owner ── its message, whatever its class: every Error but the JavaScript runtime's own
 *                                       (TypeError, RangeError…) and the system's (a code such as ENOENT), which are
 *                                       defects or files; its text must be the owner's language — an English one is a
 *                                       diagnostic, by the rule that everything Lab says to a person is Russian
 *   anything else ──────────────────── Lab's defect: a neutral phrase, the original for whoever reports it
 */

/** Where the words are shown: the command line or the chat. */
export type Surface = 'cli' | 'chat';
const way = (surface: Surface, cli: string, chat: string): string => surface === 'cli' ? cli : chat;

/** Whether a message was written for the owner: everything Lab says to a person is Russian, an English message is a diagnostic. */
export const forOwner = (message: string): boolean => [...message].some(char => (char >= 'А' && char <= 'я') || char === 'ё' || char === 'Ё');

/** Why long work stopped (Stopped), what was kept and the way on. */
function stoppedText(reason: Stopped['reason'], surface: Surface): string {
  switch (reason) {
    case 'budget': return `Закончился лимит вызовов модели; сделанное сохранено. ${way(surface, 'Поднимите settings.maxCalls в задаче и повторите.', 'Поднять лимит — ваше решение: скажите «подними лимит».')}`;
    case 'time': return 'Закончилось время, отведённое на эту работу; сделанное сохранено.';
    case 'cancelled': return 'Остановлено по вашей просьбе; сделанное сохранено.';
    case 'closing': return 'Работа остановилась при закрытии Agent Lab; сделанное сохранено.';
  }
}

/** A model call that gave no usable answer, by its kind. */
function providerText(kind: ProviderFailureKind, surface: Surface): string {
  const model = way(surface, ' в задаче', ' (/model)');
  switch (kind) {
    case 'rate limit': return 'Провайдер модели ограничил частоту запросов. Подождите минуту и повторите.';
    case 'overloaded': return 'Провайдер модели перегружен или временно недоступен — повторите позже.';
    case 'insufficient credit': return `У провайдера модели закончились средства. Пополните счёт или выберите другую модель${model}.`;
    case 'access denied': return `Провайдер модели отказал в доступе. Проверьте ключ и права на модель${way(surface, ': agent-lab status.', ' (/login).')}`;
    case 'timeout': return 'Модель не ответила вовремя. Повторите позже.';
    case 'connection failure': return 'Нет связи с провайдером модели. Проверьте сеть и повторите.';
    case 'context limit': return `Запрос не поместился в окно модели. Выберите модель с окном больше${way(surface, '', ' (/model)')} или дайте меньше материалов.`;
    case 'bad request': return `Провайдер модели отверг запрос в таком виде — повтор не поможет. Выберите другую модель${model} или сообщите разработчикам Lab.`;
    case 'incomplete': return 'Модель оборвала ответ. Повторите.';
    case 'deadline': return 'Модель не ответила за отведённое время. Повторите позже.';
    case 'unavailable': return `Модель недоступна. Проверьте ключ и модель${way(surface, ': agent-lab status.', ' (/login, /model).')}`;
    case 'empty': return 'Модель вернула пустой ответ. Повторите.';
    case 'length': return `Ответ модели упёрся в предел длины. Повторите или выберите модель с большим пределом ответа${way(surface, '.', ' (/model).')}`;
  }
}

/** The agent under test did not answer. The target names the cause in the owner's words where it can; this is the fallback. */
function agentText(error: AgentRequestFailed, surface: Surface): string {
  const doctor = ': agent-lab doctor --connection подключение.json --yes.';
  switch (error.kind) {
    case 'status': return `Агент ответил ошибкой${error.status !== undefined ? ` ${error.status}` : ''}. Посмотрите его журнал и повторите.`;
    case 'unreachable': return forOwner(error.message) ? error.message : `Агент не отвечает. Проверьте, что он запущен и доступен${way(surface, doctor, ', и повторите.')}`;
    case 'timeout': return forOwner(error.message) ? error.message : `Агент не ответил вовремя. Проверьте его${way(surface, doctor, ' и повторите.')}`;
    case 'tls': return forOwner(error.message) ? error.message : `Сертификат агента не прошёл проверку. Укажите корневой сертификат (CA) в NODE_EXTRA_CA_CERTS${way(surface, ' и повторите.', ' и перезапустите Pi.')}`;
  }
}

/** The JavaScript runtime's own exceptions: a defect of the code, whatever their text. */
const RUNTIME_ERRORS = [TypeError, RangeError, ReferenceError, SyntaxError, EvalError, URIError];
/** An error of the system (a file, a process, the network): it names a code such as ENOENT; a surface says what it was given, or it is a defect. */
export const systemError = (error: unknown): error is Error & { code: string; path?: string } =>
  error instanceof Error && typeof (error as { code?: unknown }).code === 'string' && !(error instanceof NoSuchRecord);

/**
 * The owner's words for an error Lab knows — by its type — on `surface`, with `detail`, the original of a failure worth
 * reporting; undefined for Lab's defect and for a system error, which a surface reads by what it was given.
 */
export function ownerText(error: unknown, surface: Surface): { text: string; detail?: string } | undefined {
  if (error instanceof LockedError) {
    return { text: `Папку данных${error.directory ? ` ${error.directory}` : ''} сейчас ведёт другой процесс Agent Lab — ${way(surface, 'например, открытый чат или другая команда', 'другая сессия Pi или команда agent-lab')}. `
      + `Смотреть можно${way(surface, ' (summary, export)', ' здесь')}; запуск и изменения — после его завершения. Если такого процесса точно нет, удалите файл ${error.lockFile} и повторите.` };
  }
  if (error instanceof StaleRevisionError) return { text: error.message };
  if (error instanceof LibraryConflict) return { text: 'Ситуации изменились, пока вы смотрели. Откройте их заново и повторите по свежему состоянию.' };
  if (error instanceof Stopped) return { text: stoppedText(error.reason, surface) };
  if (error instanceof ProviderFailure) return { text: error.kind === 'unavailable' && forOwner(error.message) ? error.message : providerText(error.kind, surface) };
  if (error instanceof AgentRequestFailed) return { text: agentText(error, surface) };
  if (error instanceof StructuredTaskError) {
    return { text: `Модель Lab несколько раз ответила не в том виде; ничего не записано. Повторите позже или выберите другую модель${way(surface, '.', ' (/model).')}`, detail: error.message };
  }
  if (error instanceof ModelCallDefect) {
    const cause = error.cause;
    return { text: error.message, detail: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause) };
  }
  if (error instanceof NoSuchRecord) return { text: `${error.message} ${way(surface, 'Проверьте --id и --data-dir.', 'Возьмите прогон из списка Agent Lab.')}` };
  if (error instanceof UnreadableRecord || error instanceof CommandRefused || error instanceof UnknownReference) return { text: error.message };
  // Any other error Lab wrote for the owner reaches the owner as it is, whatever its class; the runtime's own and the
  // system's are not written for anyone.
  if (error instanceof Error && !RUNTIME_ERRORS.some(type => error instanceof type) && !systemError(error) && forOwner(error.message)) return { text: error.message };
  return undefined;
}

/**
 * The fixed labels lab/operation.ts gives each stop (errors.ts STOP_LABEL), and the English ones records kept before
 * them. A record keeps its stop's label as its error, so a stored stop is read back here by exact equality with these,
 * never by searching the text.
 */
const STOP_LABELS: Readonly<Record<string, Stopped['reason']>> = {
  ...Object.fromEntries(STOP_REASONS.map(reason => [STOP_LABEL[reason], reason])),
  'Model call budget exhausted.': 'budget', 'Experiment time limit reached.': 'time', 'Cancelled by the user.': 'cancelled', 'Application is closing.': 'closing',
};
/** Why a record's work stopped, as the record keeps it, in the owner's words; undefined for none, or for a diagnostic the owner cannot act on. */
export function stopText(error: string | null | undefined, surface: Surface): string | undefined {
  if (!error) return undefined;
  const stop = Object.hasOwn(STOP_LABELS, error) ? STOP_LABELS[error] : undefined;
  return stop ? stoppedText(stop, surface) : forOwner(error) ? error : undefined;
}
/** The same, with a neutral phrase for a diagnostic: what a surface shows under stopped work. Undefined without an error. */
export function recordErrorText(error: string | null | undefined, surface: Surface): string | undefined {
  if (!error) return undefined;
  return stopText(error, surface) ?? 'Работа прервалась из-за внутренней ошибки Agent Lab; сделанное сохранено.';
}
/** Whether a record's work was stopped by the owner's own request (its stop's fixed label). */
export const stoppedByOwner = (error: string | null | undefined): boolean => !!error && Object.hasOwn(STOP_LABELS, error) && STOP_LABELS[error] === 'cancelled';
/** How a record's last work was stopped: its typed stop, or — a record written before it — its stop's fixed label; undefined when no stop cut it short. */
export const stopOf = (record: Pick<Experiment, 'stop' | 'error'>): Stopped['reason'] | undefined =>
  record.stop ?? (record.error && Object.hasOwn(STOP_LABELS, record.error) ? STOP_LABELS[record.error] : undefined);

/** What one zod issue says about a field, in plain words. */
export function problemOf(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'too_big': return issue.origin === 'string' ? `не длиннее ${issue.maximum} знаков` : `не больше ${issue.maximum}`;
    case 'too_small': return issue.origin === 'string' ? Number(issue.minimum) <= 1 ? 'не может быть пустым' : `не короче ${issue.minimum} знаков`
      : issue.origin === 'array' ? `нужно хотя бы ${issue.minimum}` : `не меньше ${issue.minimum}`;
    case 'invalid_format': return 'в недопустимом виде';
    case 'invalid_value': return 'такого значения нет';
    case 'invalid_type': return 'не указано или не того вида';
    case 'unrecognized_keys': return `лишние поля: ${issue.keys.join(', ')}`;
    case 'custom': return forOwner(issue.message) ? issue.message : 'не проходит проверку';
    default: return 'не проходит проверку';
  }
}
