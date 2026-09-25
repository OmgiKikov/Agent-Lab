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

/** A library as the store admits it: validated, with its hash. */
export interface AdmittedLibrary { library: ScenarioLibrary; hash: string }
type Admission = AdmittedLibrary & { shape: unknown[]; acceptanceVerified?: true };
/** The top level of a library: its fields, and the length of each list, so a change made in place there is seen. */
const shapeOf = (library: object): unknown[] => Object.entries(library).flatMap(([key, value]) => [key, value, Array.isArray(value) ? value.length : undefined]);
const sameShape = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, index) => value === b[index]);
/** What a stored revision carries besides the body its name hashes: its acceptance. */
const acceptanceOf = (library: ScenarioLibrary): string => fingerprint(library.acceptance ?? null);

/**
 * What one writer knows of its libraries, so a save does not validate, hash and read back what did not change: a
 * library at 4 MB of materials costs ~25 ms per hash and ~15 ms per fingerprint, and every checkpoint of a run saves the
 * same accepted snapshot again.
 *
 * - By identity: a library object's validated copy and hash. Libraries are values — every change makes a new object
 *   (card/library.ts) — and a change made in place at the top level (a field, a list's length) is still seen.
 * - By hash: revision files this writer wrote or read and checked. They are content-addressed, so they never go stale
 *   while the writer holds the folder; the heads and the names are the ones only this writer changes.
 */
export class LibraryMemo {
  private readonly admitted = new WeakMap<object, Admission>();
  /** `${id}/${hash}` → the acceptance the revision file holds. */
  readonly revisions = new Map<string, string>();
  /** Libraries whose `current.json` exists. */
  readonly named = new Set<string>();
  /** The head of each library as this writer last read or wrote it. */
  readonly heads = new Map<string, { hash: string; revision: number; accepted: boolean }>();

  /** The validated copy of `raw` and its hash, computed once per library object; `validated`: its copy already parsed. */
  admit(raw: ScenarioLibrary, validated?: ScenarioLibrary): AdmittedLibrary {
    const known = this.admitted.get(raw);
    if (known && sameShape(known.shape, shapeOf(raw))) return known;
    const library = validated ?? scenarioLibrarySchema.parse(raw);
    const hash = libraryHash(library);
    const admission: Admission = { library, hash, shape: shapeOf(raw) };
    this.admitted.set(raw, admission);
    this.admitted.set(library, { library, hash, shape: shapeOf(library) });
    return admission;
  }

  /** Verifies an admitted library's acceptance once: the receipt is checked against the very object that is saved. */
  verifyAcceptance(raw: ScenarioLibrary): void {
    const admission = this.admitted.get(raw);
    if (admission?.acceptanceVerified) return;
    verifiedAcceptance(admission?.library ?? raw);
    if (admission) admission.acceptanceVerified = true;
  }

  /** Forgets what holds only while this writer owns the folder. */
  forget(): void { this.revisions.clear(); this.named.clear(); this.heads.clear(); }
}

/** File operations are internal to the owning ExperimentStore transaction; no independent writer lock. */
export class ScenarioFiles {
  /** `memo`: the writer's (store.ts); a reader reads every file afresh. */
  constructor(private readonly directory: string, private readonly memo?: LibraryMemo) {}
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
  async readLibrary(id: string, hash?: string): Promise<ScenarioLibrary> { return (await this.readChecked(id, hash)).library; }
  /** A stored revision — the head, or the one named by `hash` — checked against its name. */
  private async readChecked(id: string, hash?: string): Promise<AdmittedLibrary> {
    if (hash !== undefined && !isSha256(hash)) throw new Error('Некорректный хеш библиотеки');
    const directory = join(this.directory, 'libraries', identifier(id));
    const current = hash ?? JSON.parse(await readFile(join(directory, 'current.json'), 'utf8')).hash;
    if (typeof current !== 'string' || !isSha256(current)) throw new Error('Некорректный хеш библиотеки');
    const library = scenarioLibrarySchema.parse(JSON.parse(await readFile(join(directory, `${current}.json`), 'utf8')));
    if (library.id !== id || libraryHash(library) !== current) throw new Error('Хеш библиотеки не совпадает');
    this.memo?.revisions.set(`${id}/${current}`, acceptanceOf(library));
    return { library, hash: current };
  }
  private admit(raw: ScenarioLibrary): AdmittedLibrary {
    if (this.memo) return this.memo.admit(raw);
    const library = scenarioLibrarySchema.parse(raw);
    return { library, hash: libraryHash(library) };
  }
  async retainLibrary(raw: ScenarioLibrary): Promise<void> {
    const { library, hash } = this.admit(raw);
    if (library.acceptance) { if (this.memo) this.memo.verifyAcceptance(library); else verifiedAcceptance(library); }
    const directory = join(this.directory, 'libraries', identifier(library.id));
    const known = this.memo?.revisions.get(`${library.id}/${hash}`);
    // A revision is named by its body alone: the same body stored with another acceptance is refused.
    if (known !== undefined && known !== acceptanceOf(library)) throw new Error('Неизменная ревизия библиотеки уже существует');
    if (known === undefined) {
      // A variant library carries its import batches; a card library only references batches already in the store.
      if (library.formatVersion === 1) for (const batch of library.imports) await this.writeImport(batch);
      const existing = await this.readChecked(library.id, hash).catch(error => { if (!missing(error)) throw error; });
      if (existing && acceptanceOf(existing.library) !== acceptanceOf(library)) throw new Error('Неизменная ревизия библиотеки уже существует');
      if (!existing) await atomicJson(directory, `${hash}.json`, library);
      this.memo?.revisions.set(`${library.id}/${hash}`, acceptanceOf(library));
    }
    if (this.memo?.named.has(library.id)) return;
    const current = await readFile(join(directory, 'current.json'), 'utf8').catch(error => { if (!missing(error)) throw error; });
    if (current === undefined) {
      await atomicJson(directory, 'current.json', { hash, revision: library.revision });
      this.memo?.heads.set(library.id, { hash, revision: library.revision, accepted: !!library.acceptance });
    }
    this.memo?.named.add(library.id);
  }
  /** The head of a library: this writer's own knowledge of it, or the stored one, read and checked once. */
  private async head(id: string): Promise<{ hash: string; revision: number; accepted: boolean } | undefined> {
    const known = this.memo?.heads.get(id);
    if (known) return known;
    const previous = await this.readChecked(id).catch(error => { if (!missing(error)) throw error; });
    if (!previous) return undefined;
    const head = { hash: previous.hash, revision: previous.library.revision, accepted: !!previous.library.acceptance };
    this.memo?.heads.set(id, head);
    this.memo?.named.add(id);
    return head;
  }
  async checkLibraryWrite(raw: ScenarioLibrary, expectedHash?: string): Promise<void> {
    const { library, hash } = this.admit(raw);
    const previous = await this.head(library.id);
    if (previous ? expectedHash !== previous.hash : expectedHash !== undefined) throw new LibraryConflict('Библиотека изменилась: хеш устарел');
    if (previous && (library.revision < previous.revision || previous.accepted && hash !== previous.hash && library.revision === previous.revision)) throw new Error('Ревизия библиотеки неизменна или устарела');
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
    const { library, hash } = this.admit(raw);
    await this.checkLibraryWrite(library, expectedHash);
    await this.retainLibrary(library);
    const directory = join(this.directory, 'libraries', identifier(library.id));
    await atomicJson(directory, 'current.json', { hash, revision: library.revision });
    this.memo?.heads.set(library.id, { hash, revision: library.revision, accepted: !!library.acceptance });
    this.memo?.named.add(library.id);
  }
}
