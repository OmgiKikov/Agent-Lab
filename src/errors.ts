/*
 * Failures a caller reacts to by kind, not by reading the message. The messages themselves stay
 * as they were: people read them, and records keep them as text.
 */

/** The scenario library is not the revision the caller read: re-read it and decide again. */
export class LibraryConflict extends Error {}

/** Another Agent Lab process holds the writer lock of this data directory. */
export class LockedError extends Error {
  constructor() { super('This data directory is already open in another Agent Lab instance. Просмотр и экспорт остаются доступны.'); }
}

/** Why a running operation was stopped; the abort reason of its signal. */
export class Stopped extends Error {
  constructor(readonly reason: 'cancelled' | 'closing' | 'time' | 'budget', message: string) { super(message); }
}
