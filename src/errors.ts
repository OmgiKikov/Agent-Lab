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
  constructor(readonly what: 'card' | 'fact' | 'expectation' | 'choice' | 'requirement', readonly allowed: string[], message: string) { super(message); }
}

/** Another Agent Lab process holds the writer lock of this data directory. */
export class LockedError extends Error {
  constructor() { super('This data directory is already open in another Agent Lab instance. Просмотр и экспорт остаются доступны.'); }
}

/** Why a running operation was stopped; the abort reason of its signal. */
export class Stopped extends Error {
  constructor(readonly reason: 'cancelled' | 'closing' | 'time' | 'budget', message: string) { super(message); }
}
