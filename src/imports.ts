import { logImport, logReader, sampledBatch } from './scenario-library.js';
import type { ImportBatch } from './scenario-contracts.js';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { dialogueSchema, type Dialogue, type ValidationExclusion } from './contracts.js';
import { IMPORT_DIALOGUE_LIMIT, IMPORT_FILE_BYTES, LOG_CONVERSATIONS, LOGGED_CUSTOMER_MESSAGES, STREAMED_LOG_BYTES } from './limits.js';
import { hiddenMessage, MASK_VERSION, type MaskVersion } from './masking.js';
import { ScenarioFiles } from './scenario-store.js';
import { readConfirmedTable } from './spreadsheet/import.js';
import { TABLE_EXTENSIONS } from './spreadsheet/workbook.js';

/*
 * A file of logged conversations becomes an import: a JSON document read whole (up to IMPORT_FILE_BYTES), JSON Lines
 * read in a stream, a line at a time (up to STREAMED_LOG_BYTES), or a spreadsheet under the reading its owner
 * confirmed. A log longer than one import gives the sample of its usable conversations (scenario-library.ts logImport),
 * the same for the same file. A file that is not what it says is refused with the place and what to do.
 */

/**
 * Whether a logged dialogue can become a situation at all; the scenario miner excludes by it before anything is spent.
 * Drop the whole dialogue: removing one masked turn would silently change its meaning. `maskVersion` is the table of
 * masks its import was read by: a topic map of an import stored before the table left out what the first reading did.
 */
export function validationDialogueIssue(dialogue: Pick<Dialogue, 'messages'>, maskVersion: MaskVersion = MASK_VERSION): Omit<ValidationExclusion, 'dialogueId'> | undefined {
  const users = dialogue.messages.filter(message => message.role === 'user');
  if (!users.length || users.length > LOGGED_CUSTOMER_MESSAGES) return { kind: 'length', reason: users.length ? `клиент пишет больше ${LOGGED_CUSTOMER_MESSAGES} раз` : 'в разговоре нет ни одной реплики клиента' };
  if (users.some(message => hiddenMessage(message.content, maskVersion))) return { kind: 'masked', reason: 'реплика клиента целиком скрыта обезличиванием' };
  return undefined;
}

const isJsonSpace = (char: string | undefined) => char === ' ' || char === '\t' || char === '\n' || char === '\r';
const isDigit = (char: string | undefined) => char !== undefined && char >= '0' && char <= '9';

/**
 * Where `text` stops being JSON (RFC 8259): the offset of the first character the grammar does not allow, or the
 * text's length when it ends too early. Read only after JSON.parse refused the text, to tell the owner the place.
 */
function jsonBreak(text: string): number {
  let at = 0;
  const closers: string[] = [];
  const skip = () => { while (isJsonSpace(text[at])) at++; };
  const string = (): boolean => {
    for (at++; at < text.length; at++) {
      const char = text[at]!;
      if (char === '"') { at++; return true; }
      if (char < ' ') return false;
      if (char !== '\\') continue;
      const escape = text[++at];
      if (escape === 'u') {
        for (let i = 0; i < 4; i++) if (!'0123456789abcdefABCDEF'.includes(text[++at] ?? 'x')) return false;
      } else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) return false;
    }
    return false;
  };
  const digits = (): boolean => { const from = at; while (isDigit(text[at])) at++; return at > from; };
  const number = (): boolean => {
    if (text[at] === '-') at++;
    if (text[at] === '0') at++; else if (!digits()) return false;
    if (text[at] === '.') { at++; if (!digits()) return false; }
    if (text[at] === 'e' || text[at] === 'E') { at++; if (text[at] === '+' || text[at] === '-') at++; if (!digits()) return false; }
    return true;
  };
  const scalar = (): boolean => {
    const char = text[at];
    if (char === '"') return string();
    if (char === '-' || isDigit(char)) return number();
    const word = ['true', 'false', 'null'].find(item => text.startsWith(item, at));
    if (word) at += word.length;
    return word !== undefined;
  };
  let expect: 'value' | 'key' | 'next' = 'value';
  for (;;) {
    skip();
    if (expect === 'value') {
      const char = text[at];
      if (char === '{' || char === '[') {
        at++; skip();
        const closer = char === '{' ? '}' : ']';
        if (text[at] === closer) { at++; expect = 'next'; } else { closers.push(closer); expect = char === '{' ? 'key' : 'value'; }
      } else if (scalar()) expect = 'next';
      else return at;
    } else if (expect === 'key') {
      if (text[at] !== '"' || !string()) return at;
      skip();
      if (text[at] !== ':') return at;
      at++; expect = 'value';
    } else {
      const closer = closers.at(-1);
      if (closer === undefined) return at;
      if (text[at] === ',') { at++; expect = closer === '}' ? 'key' : 'value'; } else if (text[at] === closer) { at++; closers.pop(); } else return at;
    }
  }
}

/** What stands at the place JSON breaks, in the owner's words. */
function brokenAt(text: string, offset: number): string {
  const char = text[offset];
  if (char === undefined) return 'текст обрывается';
  const shown = char === '\n' || char === '\r' ? 'перенос строки' : char === '\t' ? 'табуляция' : char < ' ' ? `знак с кодом ${char.charCodeAt(0)}` : `«${char}»`;
  return `неожиданно стоит ${shown}`;
}

/** The value of a JSON text; refused in the owner's words with the line and the character where it breaks. */
function parseJson(text: string, line?: number): unknown {
  try { return JSON.parse(text); } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const offset = jsonBreak(text), before = text.slice(0, offset);
    const row = (line ?? 1) + before.split('\n').length - 1, column = offset - before.lastIndexOf('\n');
    if (line !== undefined) throw new Error(`Файл логов не читается: в строке ${row} (знак ${column}) ${brokenAt(text, offset)}. В файле .jsonl каждая непустая строка — один разговор в JSON.`);
    throw new Error(`Файл логов не читается как JSON: в строке ${row} (знак ${column}) ${brokenAt(text, offset)}. Проверьте там запятые, кавычки и скобки.`);
  }
}

/** The lines of JSON Lines as the owner counts them: every line break counts, a line of spaces is skipped. */
function eachLine(text: string, visit: (line: string, number: number) => void): void {
  let number = 0, from = 0;
  for (;;) {
    const end = text.indexOf('\n', from);
    const line = text.slice(from, end === -1 ? text.length : end);
    number++;
    if (line.trim()) visit(line.endsWith('\r') ? line.slice(0, -1) : line, number);
    if (end === -1) return;
    from = end + 1;
  }
}

/** A JSON document, or JSON Lines: one row per non-empty line. The one reading of an import file, shared with project detection. */
export function parseImportText(text: string, jsonl: boolean): unknown {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (!body.trim()) throw new Error('Файл логов пуст.');
  if (!jsonl) return parseJson(body);
  const rows: unknown[] = [];
  eachLine(body, (line, number) => rows.push(parseJson(line, number)));
  return rows;
}

const notUtf8 = () => new Error('Файл логов не в кодировке UTF-8: сохраните его в UTF-8 — так пишут JSON.');
/** The text of a log file: UTF-8 is what JSON is written in; anything else would be read as garbled words. */
function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw notUtf8(); }
}

const isTable = (file: string) => TABLE_EXTENSIONS.has(extname(file).toLowerCase());
const isLines = (file: string) => extname(file).toLowerCase() === '.jsonl';
/** A table is read only through the mapping its owner confirmed; without the data folder that holds it, nothing is guessed. */
const unconfirmedTable = (file: string) => new Error(`Таблицу Lab читает только так, как вы подтвердили: посмотрите разметку и подтвердите её (agent-lab import --file ${file}).`);
const tooManyConversations = () => new Error(`В файле логов больше ${LOG_CONVERSATIONS.toLocaleString('ru-RU')} разговоров — это архив, а не логи одного периода. Выгрузите из системы период поменьше.`);

/** A JSON document read whole. */
async function readJsonFile(file: string): Promise<ImportBatch> {
  if ((await stat(file)).size > IMPORT_FILE_BYTES) {
    throw new Error(`Файл логов больше ${IMPORT_FILE_BYTES / 1_000_000} МБ: документ JSON Lab читает только целиком. Сохраните логи в JSON Lines (.jsonl) — по одному разговору в строке: такой файл Lab читает построчно, до ${STREAMED_LOG_BYTES / 1_000_000} МБ, и сам берёт выборку.`);
  }
  return logImport(parseImportText(utf8(await readFile(file)), false)).batch;
}

/**
 * JSON Lines read in a stream, a line at a time: every line parsed and read by the import's rules, only the rows of a
 * short log kept. A longer log is read a second time for the rows of its sample; a file that changed in between is refused.
 */
async function readJsonLines(file: string): Promise<ImportBatch> {
  const before = await stat(file);
  if (before.size > STREAMED_LOG_BYTES) throw new Error(`Файл логов больше ${STREAMED_LOG_BYTES / 1_000_000} МБ — выгрузите из системы период поменьше.`);
  const reader = logReader();
  const head: unknown[] = [];
  let rows = 0;
  await eachLineOf(file, (text, number) => {
    const row = parseJson(text, number);
    if (++rows > LOG_CONVERSATIONS) throw tooManyConversations();
    if (rows <= IMPORT_DIALOGUE_LIMIT) head.push(row); else head.length = 0;
    reader.read(row);
  });
  if (!rows) throw new Error('Файл логов пуст.');
  if (rows <= IMPORT_DIALOGUE_LIMIT) return logImport(head).batch;
  const { indexes, sample } = reader.sample();
  const wanted = new Set(indexes), taken: unknown[] = [];
  let index = 0;
  await eachLineOf(file, (text, number) => { if (wanted.has(index++)) taken.push(parseJson(text, number)); });
  const after = await stat(file);
  if (index !== rows || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Файл логов изменился, пока Lab его читал. Загрузите его ещё раз.');
  return sampledBatch(taken, sample);
}

/** Each non-empty line of a file read in a stream, with its number as the owner counts lines: every line break counts. */
async function eachLineOf(file: string, visit: (line: string, number: number) => void): Promise<void> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let rest = '', number = 0;
  const line = (text: string) => {
    number++;
    if (text.trim()) visit(text.endsWith('\r') ? text.slice(0, -1) : text, number);
  };
  try {
    for await (const chunk of createReadStream(file)) {
      const text = rest + decoder.decode(chunk as Buffer, { stream: true });
      let from = 0;
      for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', from)) { line(text.slice(from, end)); from = end + 1; }
      rest = text.slice(from);
      if (rest.length > IMPORT_FILE_BYTES) throw new Error(`Файл логов не читается: строка ${number + 1} длиннее ${IMPORT_FILE_BYTES / 1_000_000} МБ, а в файле .jsonl строка — один разговор.`);
    }
    rest += decoder.decode();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_ENCODING_INVALID_ENCODED_DATA') throw notUtf8();
    throw error;
  }
  line(rest);
}

/** The bounded legacy projection old views use: user and agent messages only. */
function dialoguesOf(originalImport: ImportBatch): Dialogue[] {
  return originalImport.dialogues.flatMap(dialogue => {
    const parsed = dialogueSchema.safeParse({ id: dialogue.id, messages: dialogue.events.filter(event => event.type === 'message' && (event.role === 'user' || event.role === 'assistant')).map(event => ({ role: event.role, content: event.content })) });
    return parsed.success ? [parsed.data] : [];
  });
}

/** Retain full raw evidence before a bounded legacy projection used by old views; a log longer than one import gives its sample. */
export function importDialogues(raw: unknown): { originalImport: ImportBatch; dialogues: Dialogue[] } {
  const originalImport = logImport(raw).batch;
  return { originalImport, dialogues: dialoguesOf(originalImport) };
}

/**
 * The import the data folder already keeps for the same conversations: it was read when they first came, maybe by a
 * reading older than today's, and stays the import of them — so the same file always gives the same import.
 */
async function storedImport(batch: ImportBatch, directory: string | undefined): Promise<ImportBatch> {
  if (!directory) return batch;
  const stored = await new ScenarioFiles(directory).readImport(batch.id).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
  return stored && stored.contentHash === batch.contentHash ? stored : batch;
}

/**
 * A file of logged conversations: JSON or JSONL as written, or a spreadsheet (.xlsx, .csv) under the
 * reading its owner confirmed, found in the data folder `directory`. What the folder already keeps of the
 * same conversations is that import.
 */
export async function readDialogueImport(file: string, options: { directory?: string } = {}): Promise<ReturnType<typeof importDialogues>> {
  if (isTable(file) && !options.directory) throw unconfirmedTable(file);
  const read = isTable(file) ? await readConfirmedTable(file, options.directory!) : isLines(file) ? await readJsonLines(file) : await readJsonFile(file);
  const originalImport = await storedImport(read, options.directory);
  return { originalImport, dialogues: dialoguesOf(originalImport) };
}
