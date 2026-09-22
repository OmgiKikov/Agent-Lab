import { importBatch } from './scenario-library.js';
import type { ImportBatch } from './scenario-contracts.js';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { dialogueSchema, fingerprint, type Dialogue, type ValidationExclusion } from './contracts.js';

/** Drop the whole dialogue: removing one masked turn would silently change its meaning. */
export function validationDialogueIssue(dialogue: Dialogue): Omit<ValidationExclusion, 'dialogueId'> | undefined {
  const users = dialogue.messages.filter(message => message.role === 'user');
  if (!users.length || users.length > 16) return { kind: 'length', reason: 'нужны 1–16 реплик клиента' };
  if (users.some(message => /[*#]/u.test(message.content) && !/[\p{L}\p{N}]/u.test(message.content))) return { kind: 'masked', reason: 'реплика клиента целиком скрыта обезличиванием' };
  return undefined;
}

/** Stable outcome-blind sample; the live simulator later answers from the recorded user facts. */
export function selectValidationDialogues(dialogues: Dialogue[], count = 15): Dialogue[] {
  if (!Number.isInteger(count) || count < 1 || count > 40) throw new Error('В validation set может быть от 1 до 40 карточек.');
  return [...dialogues]
    .filter(dialogue => !validationDialogueIssue(dialogue))
    .sort((a, b) => fingerprint({ id: a.id, messages: a.messages }).localeCompare(fingerprint({ id: b.id, messages: b.messages })) || a.id.localeCompare(b.id))
    .slice(0, count);
}

async function readRawData(file: string): Promise<unknown> {
  if ((await stat(file)).size > 4_000_000) throw new Error('Файл импорта превышает 4 МБ. Выберите меньшую выборку.');
  const text = await readFile(file, 'utf8');
  const data: unknown = file.endsWith('.jsonl') ? text.split(/\r?\n/).filter(line => line.trim()).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`Некорректный JSON в строке ${i + 1}.`); }
  }) : JSON.parse(text);
  return data;
}

/** Retain full raw evidence before a bounded legacy projection used by old views. */
export function importDialogues(raw: unknown): { originalImport: ImportBatch; dialogues: Dialogue[] } {
  const originalImport = importBatch(raw);
  const dialogues = originalImport.dialogues.flatMap(dialogue => {
    const parsed = dialogueSchema.safeParse({ id: dialogue.id, messages: dialogue.events.filter(event => event.type === 'message' && (event.role === 'user' || event.role === 'assistant')).map(event => ({ role: event.role, content: event.content })) });
    return parsed.success ? [parsed.data] : [];
  });
  return { originalImport, dialogues };
}
export async function readDialogueImport(file: string): Promise<ReturnType<typeof importDialogues>> {
  return importDialogues(await readRawData(file));
}

/** Strict dialogue rows; library consumers use readDialogueImport. */
export async function readData(file: string, options: { maxItems?: number } = {}) {
  return z.array(dialogueSchema).min(1).max(options.maxItems ?? 200).parse(await readRawData(file));
}
