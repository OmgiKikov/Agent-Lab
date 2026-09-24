import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { importBatchSchema, type ImportBatch } from './scenario-contracts.js';
import { scenarioLibrarySchema, type ScenarioLibrary } from './card/schema.js';
import { experimentSchema, fingerprint, type Experiment } from './contracts.js';
import { libraryHash, verifiedAcceptance } from './scenario-library.js';
import { writeFileAtomic } from './fs-atomic.js';
import { isIdentifier, isSha256 } from './ids.js';
import { LibraryConflict, StaleRevisionError } from './errors.js';
import { logVersionJournalSchema, type LogVersionJournal } from './card/calibration.js';

const identifier = (id: string) => {
  if (!isIdentifier(id)) throw new Error('Некорректный идентификатор сценариев');
  return id;
};
async function atomicJson(directory: string, name: string, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFileAtomic(join(directory, name), JSON.stringify(value));
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
/** File operations are internal to the owning ExperimentStore transaction; no independent writer lock. */
export class ScenarioFiles {
  constructor(private readonly directory: string) {}
  async readImport(id: string): Promise<ImportBatch> {
    const value = importBatchSchema.parse(JSON.parse(await readFile(join(this.directory, 'imports', `${identifier(id)}.json`), 'utf8')));
    if (value.id !== id) throw new Error('Идентификатор импорта не совпадает');
    return value;
  }
  async writeImport(raw: ImportBatch): Promise<ImportBatch> {
    const batch = importBatchSchema.parse(raw);
    const previous = await this.readImport(batch.id).catch(error => { if (!missing(error)) throw error; });
    if (previous) {
      if (previous.contentHash !== batch.contentHash || fingerprint({ ...previous, createdAt: undefined }) !== fingerprint({ ...batch, createdAt: undefined })) throw new Error('Неизменный импорт уже существует с другим хешем');
      return previous;
    }
    await atomicJson(join(this.directory, 'imports'), `${identifier(batch.id)}.json`, batch);
    return batch;
  }
  /** The owner's declarations of which agent version wrote an import's logs (card/calibration.ts); undefined before the first one. */
  async readLogVersions(importId: string): Promise<LogVersionJournal | undefined> {
    const raw = await readFile(join(this.directory, 'imports', `${identifier(importId)}.declarations.json`), 'utf8').catch(error => { if (!missing(error)) throw error; });
    if (raw === undefined) return undefined;
    const journal = logVersionJournalSchema.parse(JSON.parse(raw));
    if (journal.importId !== importId) throw new Error('Журнал версий логов не совпадает с импортом');
    return journal;
  }
  /**
   * Writes a journal that is the stored one plus one declaration: the stored one must still be the one the
   * declaration was prepared on (`expectedHash`, null before the first), and every declaration in it stays as it was.
   */
  async writeLogVersions(raw: LogVersionJournal, expectedHash: string | null): Promise<void> {
    const journal = logVersionJournalSchema.parse(raw);
    const current = await this.readLogVersions(journal.importId);
    const currentHash = current ? fingerprint(current) : null;
    if (currentHash !== expectedHash) throw new StaleRevisionError(expectedHash ?? 'none', currentHash ?? 'none', 'Версию логов уже изменили: покажу, что записано сейчас.');
    const kept = current?.declarations ?? [];
    if (current && current.contentHash !== journal.contentHash || journal.declarations.length !== kept.length + 1
      || fingerprint(journal.declarations.slice(0, kept.length)) !== fingerprint(kept)) throw new Error('Журнал версий логов только дописывается.');
    await atomicJson(join(this.directory, 'imports'), `${identifier(journal.importId)}.declarations.json`, journal);
  }
  async readLibrary(id: string, hash?: string): Promise<ScenarioLibrary> {
    if (hash !== undefined && !isSha256(hash)) throw new Error('Некорректный хеш библиотеки');
    const directory = join(this.directory, 'libraries', identifier(id));
    const current = hash ?? JSON.parse(await readFile(join(directory, 'current.json'), 'utf8')).hash;
    if (typeof current !== 'string' || !isSha256(current)) throw new Error('Некорректный хеш библиотеки');
    const library = scenarioLibrarySchema.parse(JSON.parse(await readFile(join(directory, `${current}.json`), 'utf8')));
    if (library.id !== id || libraryHash(library) !== current) throw new Error('Хеш библиотеки не совпадает');
    return library;
  }
  async retainLibrary(raw: ScenarioLibrary): Promise<void> {
    const library = scenarioLibrarySchema.parse(raw);
    if (library.acceptance) verifiedAcceptance(library);
    // A variant library carries its import batches; a card library only references batches already in the store.
    if (library.formatVersion === 1) for (const batch of library.imports) await this.writeImport(batch);
    const directory = join(this.directory, 'libraries', identifier(library.id));
    const hash = libraryHash(library);
    const existing = await this.readLibrary(library.id, hash).catch(error => { if (!missing(error)) throw error; });
    if (existing && fingerprint(existing) !== fingerprint(library)) throw new Error('Неизменная ревизия библиотеки уже существует');
    if (!existing) await atomicJson(directory, `${hash}.json`, library);
    const current = await readFile(join(directory, 'current.json'), 'utf8').catch(error => { if (!missing(error)) throw error; });
    if (current === undefined) await atomicJson(directory, 'current.json', { hash, revision: library.revision });
  }
  async checkLibraryWrite(raw: ScenarioLibrary, expectedHash?: string): Promise<void> {
    const library = scenarioLibrarySchema.parse(raw);
    const previous = await this.readLibrary(library.id).catch(error => { if (!missing(error)) throw error; });
    if (previous ? expectedHash !== libraryHash(previous) : expectedHash !== undefined) throw new LibraryConflict('Библиотека изменилась: хеш устарел');
    if (previous && (library.revision < previous.revision || previous.acceptance && libraryHash(library) !== libraryHash(previous) && library.revision === previous.revision)) throw new Error('Ревизия библиотеки неизменна или устарела');
  }
  async writePublication(record: Experiment, expectedHash?: string): Promise<void> {
    await atomicJson(join(this.directory, 'publications'), `${identifier(record.id)}.json`, { formatVersion: 1, record, ...(expectedHash ? { expectedHash } : {}) });
  }
  async pendingPublications(): Promise<{ record: Experiment; expectedHash?: string }[]> {
    const directory = join(this.directory, 'publications');
    const names = await readdir(directory).catch(error => { if (!missing(error)) throw error; return []; });
    return Promise.all(names.filter(name => /^[A-Za-z0-9_-]+\.json$/.test(name)).map(async name => {
      const value = JSON.parse(await readFile(join(directory, name), 'utf8'));
      if (value.formatVersion !== 1 || value.expectedHash !== undefined && !isSha256(value.expectedHash)) throw new Error('Некорректный журнал публикации');
      const record = experimentSchema.parse(value.record);
      if (name !== `${record.id}.json` || !record.librarySnapshot) throw new Error('Некорректная запись журнала публикации');
      return { record, expectedHash: value.expectedHash as string | undefined };
    }));
  }
  async finishPublication(id: string): Promise<void> { await unlink(join(this.directory, 'publications', `${identifier(id)}.json`)); }
  async writeLibrary(raw: ScenarioLibrary, expectedHash?: string): Promise<void> {
    const library = scenarioLibrarySchema.parse(raw);
    await this.checkLibraryWrite(library, expectedHash);
    await this.retainLibrary(library);
    const directory = join(this.directory, 'libraries', identifier(library.id));
    const hash = libraryHash(library);
    await atomicJson(directory, 'current.json', { hash, revision: library.revision });
  }
}
