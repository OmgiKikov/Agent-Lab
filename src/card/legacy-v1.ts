import type { LibraryV1 } from '../scenario-contracts.js';
import type { ScenarioLibrary } from './schema.js';

/*
 * The first library format: business groups of variants. Old libraries, drafts and runs are read as
 * they are, never migrated; the variant editor and the screens built on it know only this format.
 */

/** The record's library when it is in the first format. */
export function libraryV1Of(record: { librarySnapshot?: ScenarioLibrary }): LibraryV1 | undefined {
  return record.librarySnapshot?.formatVersion === 1 ? record.librarySnapshot : undefined;
}

/** For a variant-editor operation: a card library is never changed by it. */
export function requireLibraryV1(library: ScenarioLibrary): LibraryV1 {
  if (library.formatVersion !== 1) throw new Error('Этот набор ситуаций в новом формате: старый редактор его не меняет.');
  return library;
}
