import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { dialogueSchema, fingerprint, goldenCaseSchema, type Dialogue } from './contracts.js';

/** Stable outcome-blind sample of real conversations that can be replayed without a simulator. */
export function selectValidationDialogues(dialogues: Dialogue[], count = 15): Dialogue[] {
  if (!Number.isInteger(count) || count < 1 || count > 40) throw new Error('В validation set может быть от 1 до 40 карточек.');
  return [...dialogues]
    .filter(dialogue => {
      const users = dialogue.messages.filter(message => message.role === 'user').length;
      return users > 0 && users <= 16;
    })
    .sort((a, b) => fingerprint({ id: a.id, messages: a.messages }).localeCompare(fingerprint({ id: b.id, messages: b.messages })) || a.id.localeCompare(b.id))
    .slice(0, count);
}

/** Local JSON arrays or one validated item per JSONL line. Origin labels are assigned later by ExperimentLab. */
export async function readData(file: string, kind: 'golden' | 'dialogues', options: { maxItems?: number } = {}) {
  if ((await stat(file)).size > 4_000_000) throw new Error('Файл импорта превышает 4 МБ. Выберите меньшую выборку.');
  const text = await readFile(file, 'utf8');
  const data: unknown = file.endsWith('.jsonl') ? text.split(/\r?\n/).filter(line => line.trim()).map((line, i) => {
    try { return JSON.parse(line); } catch { throw new Error(`Некорректный JSON в строке ${i + 1}.`); }
  }) : JSON.parse(text);
  return kind === 'golden' ? z.array(goldenCaseSchema).min(1).max(40).parse(data)
    : z.array(dialogueSchema).min(1).max(options.maxItems ?? 200).parse(data);
}
