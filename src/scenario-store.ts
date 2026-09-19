import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { importBatchSchema, scenarioLibrarySchema, type ImportBatch, type ScenarioLibrary } from './scenario-contracts.js';
import { fingerprint } from './contracts.js';
import { libraryHash, librarySnapshot } from './scenario-library.js';

const identifier = (id: string) => {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('Некорректный идентификатор сценариев');
  return id;
};
async function atomicJson(directory: string, name: string, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, name), temporary = `${target}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => {}); }
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
  async readLibrary(id: string, hash?: string): Promise<ScenarioLibrary> {
    if (hash !== undefined && !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Некорректный хеш библиотеки');
    const directory = join(this.directory, 'libraries', identifier(id));
    const current = hash ?? JSON.parse(await readFile(join(directory, 'current.json'), 'utf8')).hash;
    if (typeof current !== 'string' || !/^[a-f0-9]{64}$/.test(current)) throw new Error('Некорректный хеш библиотеки');
    const library = scenarioLibrarySchema.parse(JSON.parse(await readFile(join(directory, `${current}.json`), 'utf8')));
    if (library.id !== id || libraryHash(library) !== current) throw new Error('Хеш библиотеки не совпадает');
    return library;
  }
  async retainLibrary(raw: ScenarioLibrary): Promise<void> {
    const library = scenarioLibrarySchema.parse(raw);
    if (library.acceptance) librarySnapshot(library);
    for (const batch of library.imports) await this.writeImport(batch);
    const directory = join(this.directory, 'libraries', identifier(library.id));
    const hash = libraryHash(library);
    const existing = await this.readLibrary(library.id, hash).catch(error => { if (!missing(error)) throw error; });
    if (existing && fingerprint(existing) !== fingerprint(library)) throw new Error('Неизменная ревизия библиотеки уже существует');
    if (!existing) await atomicJson(directory, `${hash}.json`, library);
    const current = await readFile(join(directory, 'current.json'), 'utf8').catch(error => { if (!missing(error)) throw error; });
    if (current === undefined) await atomicJson(directory, 'current.json', { hash, revision: library.revision });
  }
  async writeLibrary(raw: ScenarioLibrary, expectedHash?: string): Promise<void> {
    const library = scenarioLibrarySchema.parse(raw);
    const previous = await this.readLibrary(library.id).catch(error => { if (!missing(error)) throw error; });
    if (previous ? expectedHash !== libraryHash(previous) : expectedHash !== undefined) throw new Error('Библиотека изменилась: хеш устарел');
    if (previous && (library.revision < previous.revision || previous.acceptance && libraryHash(library) !== libraryHash(previous) && library.revision === previous.revision)) throw new Error('Ревизия библиотеки неизменна или устарела');
    await this.retainLibrary(library);
    const directory = join(this.directory, 'libraries', identifier(library.id));
    const hash = libraryHash(library);
    await atomicJson(directory, 'current.json', { hash, revision: library.revision });
  }
}
