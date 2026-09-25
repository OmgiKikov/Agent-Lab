import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';
import { AgentRequestFailed, CommandRefused, LibraryConflict, LockedError, STOP_LABEL, STOP_REASONS, Stopped, UnknownReference } from '../errors.js';
import { ProviderFailure, type ProviderFailureKind } from '../llm/model-call.js';
import { StructuredTaskError } from '../llm/structured.js';
import { UsageError } from './args.js';

/*
 * Why a command did not do what it was asked, in the owner's words and with the next step (docs/design/ui-spec.md §2):
 * failures Lab knows by their kind — a missing file by its code, a run that is not there, a folder another process
 * writes, a model or an agent that did not answer —, the engine's own refusals as they are. Anything else is a defect
 * of Lab: a plain sentence first, then the original for whoever reports it. Never matched by the text of a message.
 */

const PROVIDER: Record<ProviderFailureKind, string> = {
  'rate limit': 'Провайдер модели ограничил частоту запросов. Подождите минуту и повторите.',
  overloaded: 'Провайдер модели перегружен или временно недоступен. Повторите через минуту.',
  'insufficient credit': 'У провайдера модели закончились средства. Пополните счёт или выберите другую модель в задаче.',
  'access denied': 'Провайдер модели отказал в доступе. Проверьте ключ и права на модель: agent-lab status.',
  timeout: 'Модель не ответила вовремя. Повторите позже.',
  'connection failure': 'Нет связи с провайдером модели. Проверьте сеть и повторите.',
  'context limit': 'Запрос не поместился в окно модели. Выберите модель с окном больше или дайте меньше материалов.',
  incomplete: 'Модель оборвала ответ. Повторите.',
  deadline: 'Модель не ответила за отведённое время. Повторите позже.',
  unavailable: 'Модель недоступна. Проверьте ключ и модель: agent-lab status.',
  empty: 'Модель вернула пустой ответ. Повторите.',
  length: 'Ответ модели упёрся в предел длины. Повторите или выберите модель с большим пределом ответа.',
};
const AGENT: Record<AgentRequestFailed['kind'], string> = {
  unreachable: 'Агент не отвечает. Проверьте, что он запущен и доступен: agent-lab doctor --connection подключение.json --yes.',
  tls: 'Сертификат агента не прошёл проверку. Укажите корневой сертификат (CA) в NODE_EXTRA_CA_CERTS и повторите.',
  timeout: 'Агент не ответил вовремя. Проверьте его: agent-lab doctor --connection подключение.json --yes.',
  status: 'Агент ответил ошибкой. Посмотрите его журнал и повторите.',
};
const STOPPED: Record<Stopped['reason'], string> = {
  budget: 'Закончился лимит вызовов модели; сделанное сохранено. Поднимите settings.maxCalls в задаче и повторите.',
  time: 'Закончилось время, отведённое на эту работу; сделанное сохранено.',
  cancelled: 'Остановлено; сделанное сохранено.',
  closing: 'Работа остановилась при закрытии Agent Lab; сделанное сохранено.',
};

/** Whether a message was written for the owner: everything Lab says to a person is Russian, an English message is a diagnostic. */
const forOwner = (message: string): boolean => [...message].some(char => (char >= 'А' && char <= 'я') || char === 'ё' || char === 'Ё');

/**
 * The fixed labels lab/operation.ts gives each stop (errors.ts STOP_LABEL), and the English ones records kept before
 * them; a record keeps its stop's label, read back here by exact equality.
 */
const STOP_LABELS: Readonly<Record<string, Stopped['reason']>> = {
  ...Object.fromEntries(STOP_REASONS.map(reason => [STOP_LABEL[reason], reason])),
  'Model call budget exhausted.': 'budget', 'Experiment time limit reached.': 'time', 'Cancelled by the user.': 'cancelled', 'Application is closing.': 'closing',
};
/** Why a record's work stopped, as the record keeps it, in the owner's words; undefined for a diagnostic the owner cannot act on. */
export function stopText(error: string | null | undefined): string | undefined {
  if (!error) return undefined;
  const stop = Object.hasOwn(STOP_LABELS, error) ? STOP_LABELS[error] : undefined;
  return stop ? STOPPED[stop] : forOwner(error) ? error : undefined;
}

/** What one zod issue says about a field of the owner's file. */
function problemOf(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case 'too_big': return issue.origin === 'string' ? `не длиннее ${issue.maximum} знаков` : `не больше ${issue.maximum}`;
    case 'too_small': return issue.origin === 'string' && Number(issue.minimum) <= 1 ? 'не может быть пустым' : `не меньше ${issue.minimum}`;
    case 'invalid_type': return 'не указано или не того вида';
    case 'invalid_value': return 'такого значения нет';
    case 'unrecognized_keys': return `лишние поля: ${issue.keys.join(', ')}`;
    default: return forOwner(issue.message) ? issue.message : 'в недопустимом виде';
  }
}

/** What the command was given to read: the file flags the owner typed, by their resolved path. */
export interface ErrorContext { directory: string; files: Readonly<Record<string, string | undefined>> }

type SystemError = Error & { code: string; path?: string };
const systemError = (error: unknown): error is SystemError => error instanceof Error && typeof (error as { code?: unknown }).code === 'string';

/** A file the system could not open, named the way the owner named it, and what to check. */
function fileText(error: SystemError, context: ErrorContext): string | undefined {
  const path = error.path;
  if (!path) return undefined;
  const flag = Object.entries(context.files).find(([, value]) => value !== undefined && resolve(value) === resolve(path))?.[0];
  const what = flag ? `Файл из --${flag} (${path})` : `Файл ${path}`;
  switch (error.code) {
    case 'ENOENT':
      // A record the owner named by --id and the folder does not hold.
      if (!flag && resolve(dirname(path)) === resolve(context.directory) && path.endsWith('.json')) return `Прогона «${basename(path, '.json')}» нет в папке данных ${context.directory}. Проверьте --id и --data-dir.`;
      return `${what} не найден. Проверьте путь.`;
    case 'EACCES': case 'EPERM': return `${what}: нет доступа. Проверьте права на файл и папку.`;
    case 'EISDIR': return `${flag ? `В --${flag} указана папка` : `${path} — папка`}, а нужен файл.`;
    case 'ENOTDIR': return `В пути ${path} файл стоит там, где нужна папка. Проверьте путь.`;
    default: return undefined;
  }
}

/** The owner's words for why a command failed; `detail` is the original when the failure is a defect of Lab. */
export function errorText(error: unknown, context: ErrorContext): { text: string; detail?: string } {
  if (error instanceof UsageError) return { text: error.message };
  if (error instanceof LockedError) return { text: 'Папку данных сейчас ведёт другой процесс Agent Lab — например, открытый чат. Смотреть можно (summary, export); запуск и изменения — после его завершения.' };
  if (error instanceof LibraryConflict || error instanceof CommandRefused || error instanceof UnknownReference) return { text: error.message };
  if (error instanceof Stopped) return { text: STOPPED[error.reason] };
  if (error instanceof ProviderFailure) return { text: error.kind === 'unavailable' && forOwner(error.message) ? error.message : PROVIDER[error.kind] };
  // The target names the cause in the owner's words (an expired or untrusted certificate, a refused port); the table is the fallback.
  if (error instanceof AgentRequestFailed) return { text: error.kind === 'status' ? (error.status !== undefined ? `Агент ответил ошибкой ${error.status}. Посмотрите его журнал и повторите.` : AGENT.status)
    : forOwner(error.message) ? error.message : AGENT[error.kind] };
  if (error instanceof StructuredTaskError) return { text: 'Модель несколько раз ответила не в том виде; ничего не записано. Повторите позже или выберите другую модель.', detail: error.message };
  if (error instanceof z.ZodError) return { text: `Файл не в формате Agent Lab: ${error.issues.slice(0, 3).map(issue => `${issue.path.length ? issue.path.join('.') : 'файл'} — ${problemOf(issue)}`).join('; ')}. Исправьте файл и повторите.` };
  if (systemError(error)) {
    const text = fileText(error, context);
    if (text) return { text };
    // The command line itself, when node:util could not read it.
    if (error.code.startsWith('ERR_PARSE_ARGS')) return { text: 'Не удалось разобрать командную строку. Подробно: agent-lab --help.', detail: error.message };
  }
  // The engine's own refusals are plain errors worded for the owner; a plain error in English is a diagnostic.
  if (error instanceof Error && forOwner(error.message)) return { text: error.message };
  return { text: 'Не получилось из-за внутренней ошибки Agent Lab. Подробности — строкой ниже; пришлите их разработчикам.', detail: error instanceof Error ? error.message : String(error) };
}
