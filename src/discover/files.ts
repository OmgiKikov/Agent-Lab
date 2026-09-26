import { mkdirSync } from 'node:fs';
import { mkdir, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { judgeAuditSchema, type JudgeAudit } from '../assessment.js';
import { writeFileAtomic, writeFileAtomicSync } from '../fs-atomic.js';
import { isIdentifier } from '../ids.js';
import { analysisSchema, type LogAnalysis } from './schema.js';

/*
 * Where log analyses live: `analyses/{id}.json` — the record, replaced whole at every step — and the judge's audit of
 * each finding in `analyses/{id}.judge/{key}.json`, next to it. Apart from the runs at the folder's top, so no run's
 * listing ever reads an analysis. Only the store's writer writes here (store.ts), atomically and 0600 in 0700 folders;
 * anyone reads.
 */

const AREA = 'analyses';

function recordPath(directory: string, id: string): string {
  if (!isIdentifier(id)) throw new Error(`Разбора логов «${id}» нет.`);
  return join(directory, AREA, `${id}.json`);
}
function auditFolder(directory: string, id: string): string {
  if (!isIdentifier(id)) throw new Error(`Разбора логов «${id}» нет.`);
  return join(directory, AREA, `${id}.judge`);
}

/** Replaces the stored analysis with this one, validated first. */
export async function writeAnalysisFile(directory: string, analysis: LogAnalysis): Promise<void> {
  const validated = analysisSchema.parse(analysis);
  await mkdir(join(directory, AREA), { recursive: true, mode: 0o700 });
  await writeFileAtomic(recordPath(directory, validated.id), JSON.stringify(validated, null, 2));
}

/** The stored analysis; an id it does not know is said in the owner's words. */
export async function readAnalysisFile(directory: string, id: string): Promise<LogAnalysis> {
  const path = recordPath(directory, id);
  const file = await open(path, 'r').catch(error => {
    throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`Разбора логов «${id}» нет.`) : error;
  });
  try {
    if ((await file.stat()).size > 50_000_000) throw new Error(`Разбор логов «${id}» не читается: файл больше 50 МБ.`);
    return analysisSchema.parse(JSON.parse(await file.readFile('utf8')));
  } finally { await file.close(); }
}

/** Every stored analysis that reads, newest first; one that does not is left out of the listing, never the listing out. */
export async function listAnalysisFiles(directory: string): Promise<LogAnalysis[]> {
  let names: string[];
  try { names = await readdir(join(directory, AREA)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const ids = names.filter(name => name.endsWith('.json') && isIdentifier(name.slice(0, -5))).map(name => name.slice(0, -5));
  const read = await Promise.allSettled(ids.map(id => readAnalysisFile(directory, id)));
  return read.flatMap(result => result.status === 'fulfilled' ? [result.value] : []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** The judge's audit of one finding. Synchronous on purpose: a judgment reports every change synchronously, and a crash must leave the last whole audit. */
export function writeAnalysisAuditFile(directory: string, id: string, key: string, audit: JudgeAudit): void {
  if (!isIdentifier(key)) throw new Error('Invalid finding key');
  const folder = auditFolder(directory, id);
  const content = JSON.stringify(judgeAuditSchema.parse(audit));
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileAtomicSync(join(folder, `${key}.json`), content);
}

/** The judge's audit of one finding; null when there is none. */
export async function readAnalysisAuditFile(directory: string, id: string, key: string): Promise<JudgeAudit | null> {
  if (!isIdentifier(key)) throw new Error('Invalid finding key');
  let file;
  try { file = await open(join(auditFolder(directory, id), `${key}.json`), 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    if ((await file.stat()).size > 20_000_000) throw new Error('Judge audit exceeds 20 MB');
    return judgeAuditSchema.parse(JSON.parse(await file.readFile('utf8')));
  } finally { await file.close(); }
}
