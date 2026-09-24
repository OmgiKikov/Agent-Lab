import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fingerprint } from '../contracts.js';
import { writeFileAtomic } from '../fs-atomic.js';
import { isIdentifier } from '../ids.js';
import { importReadingsSchema, type ImportReadings, type TableReading } from './mapping.js';

/*
 * How each spreadsheet was read lives next to the import it produced — `imports/<importId>.mapping.json`,
 * private like the import itself. A reading is only ever added: an import keeps every file and mapping
 * that produced it. Writing is the store's job, under its writer lock; reading needs no lock.
 */

const SUFFIX = '.mapping.json';
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

function readingsPath(directory: string, importId: string): string {
  if (!isIdentifier(importId)) throw new Error('Некорректный идентификатор импорта');
  return join(directory, 'imports', `${importId}${SUFFIX}`);
}

/** Adds a confirmed reading of `importId`; the same file read the same way is recorded once. */
export async function writeReadingFile(directory: string, importId: string, contentHash: string, reading: TableReading): Promise<void> {
  const path = readingsPath(directory, importId);
  const existing = await readFile(path, 'utf8').then(text => importReadingsSchema.parse(JSON.parse(text)), error => { if (missing(error)) return undefined; throw error; });
  if (existing && existing.contentHash !== contentHash) throw new Error('Разметка таблицы записана для другого содержимого импорта.');
  if (existing?.readings.some(item => item.file.sha256 === reading.file.sha256 && fingerprint(item.mapping) === fingerprint(reading.mapping))) return;
  const next = importReadingsSchema.parse({ formatVersion: 1, importId, contentHash, readings: [...existing?.readings ?? [], reading] });
  await mkdir(join(directory, 'imports'), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, JSON.stringify(next));
}

/** Every confirmed reading in the data folder, grouped by import. A damaged file is an error, never a quiet gap. */
export async function readReadingFiles(directory: string): Promise<ImportReadings[]> {
  const names = await readdir(join(directory, 'imports')).catch(error => { if (missing(error)) return []; throw error; });
  return Promise.all(names.filter(name => name.endsWith(SUFFIX)).sort().map(async name => {
    const value = importReadingsSchema.parse(JSON.parse(await readFile(join(directory, 'imports', name), 'utf8')));
    if (name !== `${value.importId}${SUFFIX}`) throw new Error(`Разметка таблицы ${name} не совпадает со своим импортом.`);
    return value;
  }));
}
