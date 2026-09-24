import { importBatch } from './scenario-library.js';
import type { ImportBatch } from './scenario-contracts.js';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { dialogueSchema, type Dialogue, type ValidationExclusion } from './contracts.js';
import { IMPORT_FILE_BYTES } from './limits.js';
import { hiddenBySymbols } from './masking.js';
import { readConfirmedTable } from './spreadsheet/import.js';
import { TABLE_EXTENSIONS } from './spreadsheet/workbook.js';

/**
 * Whether a logged dialogue can become a situation at all; the scenario miner excludes by it before anything is spent.
 * Drop the whole dialogue: removing one masked turn would silently change its meaning.
 */
export function validationDialogueIssue(dialogue: Pick<Dialogue, 'messages'>): Omit<ValidationExclusion, 'dialogueId'> | undefined {
  const users = dialogue.messages.filter(message => message.role === 'user');
  if (!users.length || users.length > 16) return { kind: 'length', reason: 'нужны 1–16 реплик клиента' };
  if (users.some(message => hiddenBySymbols(message.content))) return { kind: 'masked', reason: 'реплика клиента целиком скрыта обезличиванием' };
  return undefined;
}

/** A JSON document, or JSON Lines: one row per non-empty line. The one reading of an import file, shared with project detection. */
export function parseImportText(text: string, jsonl: boolean): unknown {
  return jsonl ? text.split(/\r?\n/).filter(line => line.trim()).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`Некорректный JSON в строке ${i + 1}.`); }
  }) : JSON.parse(text);
}

const isTable = (file: string) => TABLE_EXTENSIONS.has(extname(file).toLowerCase());
/** A table is read only through the mapping its owner confirmed; without the data folder that holds it, nothing is guessed. */
const unconfirmedTable = (file: string) => new Error(`Таблицу Lab читает только так, как вы подтвердили: посмотрите разметку и подтвердите её (agent-lab import --file ${file}).`);

async function readRawData(file: string): Promise<unknown> {
  if (isTable(file)) throw unconfirmedTable(file);
  if ((await stat(file)).size > IMPORT_FILE_BYTES) throw new Error('Файл импорта превышает 4 МБ. Выберите меньшую выборку.');
  return parseImportText(await readFile(file, 'utf8'), file.endsWith('.jsonl'));
}

/** The bounded legacy projection old views use: user and agent messages only. */
function dialoguesOf(originalImport: ImportBatch): Dialogue[] {
  return originalImport.dialogues.flatMap(dialogue => {
    const parsed = dialogueSchema.safeParse({ id: dialogue.id, messages: dialogue.events.filter(event => event.type === 'message' && (event.role === 'user' || event.role === 'assistant')).map(event => ({ role: event.role, content: event.content })) });
    return parsed.success ? [parsed.data] : [];
  });
}

/** Retain full raw evidence before a bounded legacy projection used by old views. */
export function importDialogues(raw: unknown): { originalImport: ImportBatch; dialogues: Dialogue[] } {
  const originalImport = importBatch(raw);
  return { originalImport, dialogues: dialoguesOf(originalImport) };
}
/**
 * A file of logged conversations: JSON or JSONL as written, or a spreadsheet (.xlsx, .csv) under the
 * reading its owner confirmed, found in the data folder `directory`.
 */
export async function readDialogueImport(file: string, options: { directory?: string } = {}): Promise<ReturnType<typeof importDialogues>> {
  if (!isTable(file)) return importDialogues(await readRawData(file));
  if (!options.directory) throw unconfirmedTable(file);
  const originalImport = await readConfirmedTable(file, options.directory);
  return { originalImport, dialogues: dialoguesOf(originalImport) };
}
