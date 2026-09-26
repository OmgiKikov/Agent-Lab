import { join } from 'node:path';
import { countText } from './plural.js';

/*
 * Failures a caller reacts to by kind, not by reading the message. The messages themselves stay
 * as they were: people read them, and records keep them as text.
 */

/** The scenario library is not the revision the caller read: re-read it and decide again. */
export class LibraryConflict extends Error {}

/**
 * An owner command was prepared on one state of the card library and the library has moved since: the
 * preview the owner saw is not what would be applied. The caller shows the fresh state and asks again.
 */
export class StaleRevisionError extends LibraryConflict {
  constructor(readonly expectedHash: string, readonly actualHash: string, message = 'Ситуации изменились, пока вы смотрели: покажу свежее состояние.') { super(message); }
}

/** An owner command that cannot be applied as asked; the message tells the owner why and what to do first. Nothing was written. */
export class CommandRefused extends Error {}

/** A command names a card, fact, duty or answer that is not there; `allowed` lists what is, in the caller's own terms. */
export class UnknownReference extends Error {
  constructor(readonly what: 'card' | 'fact' | 'expectation' | 'choice' | 'requirement' | 'scenario', readonly allowed: string[], message: string) { super(message); }
}

/**
 * Another Agent Lab process holds the writer lock of the data folder `directory`, and Lab could not prove it dead
 * (folder-lock.ts). The message names the folder and the lock file, and how a person clears a lock whose process is gone.
 */
export class LockedError extends Error {
  readonly lockFile: string;
  constructor(readonly directory = '') {
    const lockFile = join(directory || '.agent-lab', '.lock');
    super(`Папку данных ${directory || '.agent-lab'} сейчас ведёт другой процесс Agent Lab — например, открытый чат или команда agent-lab. Если такого процесса точно нет, удалите файл ${lockFile} и повторите.`);
    this.lockFile = lockFile;
  }
}

/** How work was stopped before it ended by itself: the owner asked, Lab was closing, its time or its budget ran out. */
export const STOP_REASONS = ['cancelled', 'closing', 'time', 'budget'] as const;
export type StopReason = typeof STOP_REASONS[number];

/**
 * What a record keeps as its error when a stop cut its work short: one fixed line per reason, in the owner's words. A
 * surface reads a stored stop by exact equality with these (extensions/lab-ui.ts), never by searching the text; records
 * written before them keep the English labels, which the same table reads.
 */
export const STOP_LABEL: Readonly<Record<StopReason, string>> = {
  cancelled: 'Остановлено по просьбе владельца.',
  closing: 'Работа остановлена: Agent Lab закрывается.',
  time: 'Закончилось время, отведённое на эту работу.',
  budget: 'Закончился лимит вызовов модели.',
};

/** Why a running operation was stopped: the abort reason of its signal, or — for the budget — the refusal of a new call. */
export class Stopped extends Error {
  constructor(readonly reason: StopReason, message: string = STOP_LABEL[reason]) { super(message); }
}

/**
 * A new model call past the operation's budget, refused before it was sent. The operation's signal is not aborted: the
 * calls already under way finish, every later call is refused the same way, and the operation ends as a budget stop once
 * its work returns (lab/operation.ts). A pool tells this — the ceiling, the new call never started — from a stop that cut
 * calls short, which aborts the signal.
 */
export class BudgetExhausted extends Stopped {
  constructor(message: string = STOP_LABEL.budget) { super('budget', message); }
}

/**
 * The record is not a draft this work may start on: work is going on on it, or it already ran or stopped. Nothing was
 * written and nothing changed while the caller looked: reading it again changes nothing; the message says why.
 */
export class NotADraft extends CommandRefused {}

/**
 * An HTTP agent's request did not come back: it was not reached, its certificate was not trusted, it took too long, or
 * it answered with an error status. `code` is the network's own code of the cause (ECONNREFUSED, SELF_SIGNED_CERT_IN_CHAIN).
 */
export class AgentRequestFailed extends Error {
  constructor(readonly kind: 'unreachable' | 'tls' | 'timeout' | 'status', message: string, readonly status?: number, readonly code?: string) { super(message); }
}

/**
 * A record file the store cannot read, and why, in the owner's words: written by a newer Lab (fields or values this one
 * does not know — «обновите Lab»), or damaged. Lists show it instead of dropping it; the file stays as it is.
 */
export class UnreadableRecord extends Error {
  constructor(readonly id: string, readonly newer: boolean, readonly reason: string) {
    super(newer ? `Запись ${id}.json от более новой версии Agent Lab — обновите Lab, чтобы её открыть.`
      : `Запись ${id}.json не читается: ${reason}. Файл оставлен как есть.`);
  }
}

/** The records a listing could not read, in the owner's words: those of a newer Lab together, the damaged ones with the first reason. */
export function unreadableLines(unreadable: readonly UnreadableRecord[]): string[] {
  const records = (n: number) => countText(n, ['запись', 'записи', 'записей']);
  const newer = unreadable.filter(item => item.newer), damaged = unreadable.filter(item => !item.newer);
  return [
    ...(newer.length ? [`Не открывается ${records(newer.length)} от более новой версии Agent Lab — обновите Lab, чтобы ${newer.length === 1 ? 'её' : 'их'} открыть.`] : []),
    ...(damaged.length ? [`Не читается ${records(damaged.length)}: ${damaged[0]!.reason}${damaged.length > 1 ? ' и другое' : ''}. Файлы оставлены как есть.`] : []),
  ];
}

/**
 * No run or draft by that id in the data folder: an id that is not one (`../x`), or a record that is not there. It keeps
 * a missing file's code, ENOENT, so a reader that falls back when a record is not written (a preview, an embedded source
 * run) still does.
 */
export class NoSuchRecord extends Error {
  readonly code = 'ENOENT';
  constructor(readonly id: string, readonly directory: string) {
    super(`Нет такого прогона или черновика: «${id.length > 80 ? `${id.slice(0, 80)}…` : id}» в папке данных ${directory}.`);
  }
}
