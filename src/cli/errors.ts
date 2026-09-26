import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod';
import { ownerText, problemOf, stopText as storedStopText, systemError } from '../error-text.js';
import { UsageError } from './args.js';

/*
 * Why a command did not do what it was asked, in the owner's words and with the next step (docs/design/ui-spec.md §2).
 * What only the command line has is read here — the command line itself, the files its flags named, a task file that is
 * not Lab's format —; every failure Lab knows by its type is said by the one translator (error-text.ts) in the command
 * line's terms. Anything else is a defect of Lab: a plain sentence first, then the original for whoever reports it.
 */

/** What the command was given to read: the file flags the owner typed, by their resolved path. */
export interface ErrorContext { directory: string; files: Readonly<Record<string, string | undefined>> }

/** A file the system could not open, named the way the owner named it, and what to check. */
function fileText(error: Error & { code: string; path?: string }, context: ErrorContext): string | undefined {
  const path = error.path;
  if (!path) return undefined;
  const flag = Object.entries(context.files).find(([, value]) => value !== undefined && resolve(value) === resolve(path))?.[0];
  const what = flag ? `Файл из --${flag} (${path})` : `Файл ${path}`;
  switch (error.code) {
    case 'ENOENT':
      // A record the owner named by --id and the folder does not hold.
      if (!flag && resolve(dirname(path)) === resolve(context.directory) && path.endsWith('.json')) return `Нет такого прогона или черновика: «${basename(path, '.json')}» в папке данных ${context.directory}. Проверьте --id и --data-dir.`;
      return `${what} не найден. Проверьте путь.`;
    case 'EACCES': case 'EPERM': return `${what}: нет доступа. Проверьте права на файл и папку.`;
    case 'EISDIR': return `${flag ? `В --${flag} указана папка` : `${path} — папка`}, а нужен файл.`;
    case 'ENOTDIR': return `В пути ${path} файл стоит там, где нужна папка. Проверьте путь.`;
    default: return undefined;
  }
}

/** Why a record's work stopped, as the record keeps it, in the command line's words; undefined for a diagnostic the owner cannot act on. */
export const stopText = (error: string | null | undefined): string | undefined => storedStopText(error, 'cli');

/** The owner's words for why a command failed; `detail` is the original when the failure is a defect of Lab. */
export function errorText(error: unknown, context: ErrorContext): { text: string; detail?: string } {
  if (error instanceof UsageError) return { text: error.message };
  // A file the owner gave that is not in Lab's format: the field and what is wrong with it.
  if (error instanceof z.ZodError) return { text: `Файл не в формате Agent Lab: ${error.issues.slice(0, 3).map(issue => `${issue.path.length ? issue.path.join('.') : 'файл'} — ${problemOf(issue)}`).join('; ')}. Исправьте файл и повторите.` };
  if (systemError(error)) {
    const text = fileText(error, context);
    if (text) return { text };
    // The command line itself, when node:util could not read it.
    if (error.code.startsWith('ERR_PARSE_ARGS')) return { text: 'Не удалось разобрать командную строку. Подробно: agent-lab --help.', detail: error.message };
  }
  const known = ownerText(error, 'cli');
  if (known) return known;
  return { text: 'Не получилось из-за внутренней ошибки Agent Lab. Подробности — строкой ниже; пришлите их разработчикам.', detail: error instanceof Error ? error.message : String(error) };
}
