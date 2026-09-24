import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isIdentifier } from './ids.js';
import { IMPORT_DIALOGUE_LIMIT } from './limits.js';
import { MASK_VERSION, maskedThrough, readAlike, type MaskVersion } from './masking.js';
import { fingerprint, type Experiment } from './contracts.js';
import type { LibraryV2, ScenarioLibrary } from './card/schema.js';
import { importBatchSchema, type ImportBatch, type LibraryV1 } from './scenario-contracts.js';

/*
 * What a library stands on and what seals it, for both stored formats: the verbatim import of the logs, the hash of
 * a library body, and the proof — by stored hashes alone — that a run runs exactly the situations that were accepted.
 * Nothing here writes a library: cards are made in card/, and a first-format library is only ever read.
 */

/**
 * Keys in one collation on every machine. The process's own locale would order a spreadsheet's Cyrillic and Latin
 * column headers differently under ru and en-US, and the same file would get another hash and import id. Every hash
 * stored before the collation was pinned has ASCII keys, which both locales order alike, so they keep verifying.
 */
const keyOrder = (a: string, b: string): number => a.localeCompare(b, 'en-US');

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => keyOrder(a, b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Why a conversation is refused when de-identification hid every customer message: the data, not the way it was read. */
export const MASKED_REASON = 'Пользовательские реплики полностью замаскированы';
/** Why a conversation is refused when the customer wrote nothing: they opened it and left, or the reading missed them. */
export const NO_CUSTOMER_REASON = 'Нет пользовательских реплик';

/** Why a conversation is refused when it holds no event, or more than one import keeps of it: a long conversation is the data, not the way it was read. */
export const EVENTS_REASON = 'Пустые события или превышен лимит событий';

/** A row read: kept or refused, and whether its customer's messages read alike under both tables of masks (masking.ts readAlike). */
type ReadRow = ({ dialogue: ImportBatch['dialogues'][number] } | { rejected: ImportBatch['rejected'][number] }) & { alike: boolean };

/**
 * One row of a log by the import's rules: its id (once per log: `seen` holds the ids of the rows before it), its
 * events verbatim with stable indexes, whether a customer wrote anything a mask left. `known` is a reason a reader of
 * another format already found for the row (a spreadsheet row whose text has no role marker): the row is refused
 * with it and its events are not read.
 */
function readRow(row: unknown, index: number, seen: Set<string>, known: string | undefined, maskVersion: MaskVersion): ReadRow {
  const reasons: string[] = [];
  const dialogueId = record(row) && typeof row.id === 'string' ? row.id : undefined;
  if (!dialogueId || !isIdentifier(dialogueId)) reasons.push('Некорректный id диалога');
  if (dialogueId && seen.has(dialogueId)) reasons.push('Повторяющийся id диалога');
  if (dialogueId) seen.add(dialogueId);
  const rich = record(row) && Array.isArray(row.events);
  const events = record(row) ? (rich ? row.events : row.messages) : undefined;
  const retained: ImportBatch['dialogues'][number]['events'] = [];
  if (known !== undefined) reasons.push(known);
  else if (!Array.isArray(events) || events.length === 0 || events.length > (rich ? 120 : 60)) reasons.push(EVENTS_REASON);
  else events.forEach((event, eventIndex) => {
    if (!record(event)) { reasons.push(`Событие ${eventIndex}: ожидается объект`); return; }
    const type = rich ? event.type : 'message';
    if (!['message', 'tool', 'retrieval', 'state'].includes(String(type))) { reasons.push(`Событие ${eventIndex}: неизвестный тип`); return; }
    const candidate = { index: eventIndex, type, ...(typeof event.role === 'string' ? { role: event.role } : {}), ...(typeof event.content === 'string' ? { content: event.content } : {}), data: event };
    const validated = importBatchSchema.shape.dialogues.element.shape.events.element.safeParse(candidate);
    if (!validated.success || type === 'message' && (event.role !== 'user' && event.role !== 'assistant' && event.role !== 'system' || typeof event.content !== 'string')) reasons.push(`Событие ${eventIndex}: некорректная роль или пустое содержимое`);
    else retained.push(validated.data);
  });
  const userEvents = retained.filter(event => event.type === 'message' && event.role === 'user');
  if (!userEvents.length && known === undefined) reasons.push(NO_CUSTOMER_REASON);
  if (userEvents.length && userEvents.every(event => maskedThrough(event.content ?? '', maskVersion))) reasons.push(MASKED_REASON);
  const observation = record(row) ? row.observation ?? (rich ? 'unknown' : 'partial') : 'unknown';
  if (!['complete', 'partial', 'unknown'].includes(String(observation))) reasons.push('Некорректная полнота наблюдения');
  // JSON as read: importBatch checks every row it keeps, and the batch before it is returned.
  const original = row as z.infer<ReturnType<typeof z.json>>;
  const alike = userEvents.every(event => readAlike(event.content ?? ''));
  return reasons.length ? { rejected: { index, ...(dialogueId ? { id: dialogueId.slice(0, 200) } : {}), reasons: [...new Set(reasons)].slice(0, 20), original }, alike }
    : { dialogue: { id: dialogueId!, events: retained, observation: observation as 'complete' | 'partial' | 'unknown', original }, alike };
}

/** The rows of a raw import: an array of conversations, or `{ formatVersion?: 1, dialogues: [...] }`. */
function rowsOf(raw: unknown): unknown[] {
  if (raw === undefined) throw new Error('Импорт пуст или превышает 12000000 символов');
  if (record(raw) && raw.formatVersion !== undefined && raw.formatVersion !== 1) throw new Error('Неподдерживаемая версия импорта');
  const rows = Array.isArray(raw) ? raw : record(raw) ? raw.dialogues : undefined;
  if (!Array.isArray(rows)) throw new Error('Ожидается массив диалогов или объект {dialogues: [...]}');
  return rows;
}

/**
 * No inference: ingest source evidence verbatim and give every retained event a stable index. `known` holds reasons
 * a reader of another format already found for rows (by index), see readRow. `maskVersion` is the table of masks the
 * rows are read by (masking.ts). Where a customer's message reads otherwise under it than under the first readings,
 * the batch records it, so its conversations and the topic map of them keep the reading they were made with; where
 * every message reads alike, the batch is the one the first readings made — the same import of the same rows. One
 * batch holds IMPORT_DIALOGUE_LIMIT conversations; a longer log is sampled (logImport).
 */
export function importBatch(raw: unknown, known: ReadonlyMap<number, string> = new Map(), maskVersion: MaskVersion = MASK_VERSION): ImportBatch {
  const serialized = JSON.stringify(raw);
  if (!serialized || serialized.length > 12_000_000) throw new Error('Импорт пуст или превышает 12000000 символов');
  const rows = rowsOf(z.json().parse(raw));
  if (rows.length > IMPORT_DIALOGUE_LIMIT) throw new Error(`В одном импорте не больше ${IMPORT_DIALOGUE_LIMIT} разговоров.`);
  const contentHash = digest(rows);
  const batch: ImportBatch = { formatVersion: 1, id: `import_${contentHash.slice(0, 32)}`, contentHash, createdAt: new Date().toISOString(), dialogues: [], rejected: [] };
  const seen = new Set<string>();
  let alike = true;
  rows.forEach((row, index) => {
    const read = readRow(row, index, seen, known.get(index), maskVersion);
    alike &&= read.alike;
    if ('dialogue' in read) batch.dialogues.push(read.dialogue); else batch.rejected.push(read.rejected);
  });
  return importBatchSchema.parse(maskVersion === 1 || alike ? batch : { ...batch, maskVersion });
}

/** A conversation of a log as the order of a sample sees it: a hash of its id and its messages, never where it stands or how it ended. */
export const conversationKey = (dialogue: ImportBatch['dialogues'][number]): string =>
  fingerprint({ id: dialogue.id, messages: dialogue.events.flatMap(event => event.type === 'message' ? [[event.role ?? '', event.content ?? '']] : []) });

type Dialogue = ImportBatch['dialogues'][number];
/** The order of a sample: `key` of a usable conversation, `index` its row in the log. */
export interface LogOptions { maskVersion?: MaskVersion; key?: (dialogue: Dialogue, index: number) => string }
/** What a log longer than one batch held: its conversations and the usable ones among them. */
export type LogSample = NonNullable<ImportBatch['sample']>;

/**
 * A log read a row at a time by the import's rules, so that a log too long to hold is read in a stream: `read` says why
 * a row is refused (undefined for a usable one), a conversation id taken once in the whole log; `sample` names the rows
 * a batch takes of a log longer than one — IMPORT_DIALOGUE_LIMIT of the usable ones, first in the order of `key` (by
 * default conversationKey, a hash of what each conversation is: blind to outcomes and to where it stands), kept in the
 * log's order. The same log gives the same rows.
 */
export function logReader(options: LogOptions = {}): { read(row: unknown, known?: string): string[] | undefined; sample(): { indexes: number[]; sample: LogSample } } {
  const { maskVersion = MASK_VERSION, key = conversationKey } = options;
  const seen = new Set<string>(), usable: { index: number; key: string }[] = [];
  let rows = 0;
  return {
    read(row, known) {
      const index = rows++;
      const read = readRow(row, index, seen, known, maskVersion);
      if ('rejected' in read) return read.rejected.reasons;
      usable.push({ index, key: key(read.dialogue, index) });
      return undefined;
    },
    sample() {
      const taken = [...usable].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index).slice(0, IMPORT_DIALOGUE_LIMIT);
      return { indexes: taken.map(item => item.index).sort((a, b) => a - b), sample: { dialogues: rows, usable: usable.length } };
    },
  };
}

/** How a sample is taken, in the owner's words: every surface that shows one says it so. */
export const sampleWords = (taken: number, usable: number): string => `Lab возьмёт ${taken} из ${usable} подходящих — по хешу содержимого, без отбора по исходу`;

/** The batch of a log's sample: the rows taken, in the log's order, and what the log held. */
export const sampledBatch = (rows: readonly unknown[], sample: LogSample, maskVersion: MaskVersion = MASK_VERSION): ImportBatch =>
  importBatchSchema.parse({ ...importBatch(rows, new Map(), maskVersion), sample });

/** A log read whole: the import, and why each row of the log is refused (undefined for a usable one), in the log's order. */
export interface LogImport { batch: ImportBatch; verdicts: (string[] | undefined)[] }

/**
 * The import of a log of any length, the same for the same log: at most IMPORT_DIALOGUE_LIMIT rows are one batch
 * (importBatch); a longer log gives the batch of its sample (logReader), which records how many conversations the log
 * held and how many were usable. `known` holds reasons another format's reader found for rows (readRow).
 */
export function logImport(raw: unknown, options: LogOptions & { known?: ReadonlyMap<number, string> } = {}): LogImport {
  const { known = new Map(), maskVersion = MASK_VERSION } = options;
  const rows = rowsOf(raw);
  if (rows.length <= IMPORT_DIALOGUE_LIMIT) {
    const batch = importBatch(raw, known, maskVersion);
    const reasons = new Map(batch.rejected.map(item => [item.index, item.reasons]));
    return { batch, verdicts: rows.map((_, index) => reasons.get(index)) };
  }
  const reader = logReader(options);
  const verdicts = rows.map((row, index) => reader.read(row, known.get(index)));
  const { indexes, sample } = reader.sample();
  return { batch: sampledBatch(indexes.map(index => rows[index]), sample, maskVersion), verdicts };
}

/**
 * A batch that arrives from outside the store (a saved suite carries its logs), checked rather than trusted: it
 * parses, its content hash is the hash of the rows it was read from — every dialogue's and every refused row's
 * original, each in its place — and its id follows from that hash. What was read from the rows is the reader's
 * record, as it is in the store.
 */
export function verifiedImport(raw: unknown): ImportBatch {
  const damaged = () => new Error('Логи повреждены: разговоры в них не совпадают с их хешем.');
  const parsed = importBatchSchema.safeParse(raw);
  if (!parsed.success) throw damaged();
  const batch = parsed.data;
  const refused = new Map(batch.rejected.map(row => [row.index, row.original] as const));
  const count = batch.dialogues.length + batch.rejected.length;
  const rows: unknown[] = [];
  let read = 0;
  for (let index = 0; index < count; index++) {
    if (refused.has(index)) rows.push(refused.get(index));
    else if (read < batch.dialogues.length) rows.push(batch.dialogues[read++]!.original);
  }
  // A refused row named twice, or placed beyond the rows, leaves the order of the rows unknown.
  const contentHash = refused.size === batch.rejected.length && rows.length === count ? digest(rows) : undefined;
  if (!contentHash || contentHash !== batch.contentHash || batch.id !== `import_${contentHash.slice(0, 32)}`) throw damaged();
  return batch;
}

/** Includes all source evidence and drafts; acceptance is a receipt over this document. */
export function libraryHash(library: ScenarioLibrary): string {
  const { acceptance: _acceptance, ...body } = library;
  return digest(body);
}

/** What an acceptance fixes besides the library body: the accepted selection and, for cards, each compiled definition. */
type AcceptanceSeal = { libraryHash: string } & ({ variantIds: string[] } | Pick<NonNullable<LibraryV2['acceptance']>, 'cardIds' | 'definitions'>);

/** The digest an acceptance receipt stores as `snapshotHash`. The first format's formula is frozen: old receipts keep verifying. */
export function snapshotDigest(library: ScenarioLibrary, seal: AcceptanceSeal): string {
  return digest({ libraryId: library.id, revision: library.revision, libraryHash: seal.libraryHash,
    ...('variantIds' in seal ? { variantIds: seal.variantIds } : { cardIds: seal.cardIds, definitions: seal.definitions }) });
}

/**
 * The acceptance receipt of a library, checked against the library itself: same revision, same body,
 * same selection, every accepted card present. Integrity only: quality was judged once, at acceptance,
 * and today's quality rules never re-grade an accepted snapshot.
 */
export function verifiedAcceptance(library: LibraryV1): NonNullable<LibraryV1['acceptance']>;
export function verifiedAcceptance(library: LibraryV2): NonNullable<LibraryV2['acceptance']>;
export function verifiedAcceptance(library: ScenarioLibrary): NonNullable<ScenarioLibrary['acceptance']>;
export function verifiedAcceptance(library: ScenarioLibrary): NonNullable<ScenarioLibrary['acceptance']> {
  const acceptance = library.acceptance;
  if (!acceptance) throw new Error('Ситуации ещё не утверждены для прогона.');
  const accepted = 'variantIds' in acceptance ? acceptance.variantIds : acceptance.cardIds;
  const present = new Set(library.formatVersion === 1 ? library.variants.map(variant => variant.id) : library.cards.map(card => card.id));
  if (acceptance.revision !== library.revision || acceptance.libraryHash !== libraryHash(library) || acceptance.snapshotHash !== snapshotDigest(library, acceptance)
    || accepted.some(id => !present.has(id))) throw new Error('Утверждённые ситуации изменены после утверждения — прогон по ним невозможен.');
  return acceptance;
}

/**
 * A run of an accepted library runs exactly what was accepted, proven by stored hashes alone: the library
 * against its receipt, the run's materials against the library's, every card against the definition hash
 * fixed at acceptance. Nothing is recompiled, so a later change of the compiler or its prompts never makes
 * an old run unrepeatable or unassessable.
 */
export function verifyAcceptedRun(record: Experiment): void {
  const library = record.librarySnapshot;
  if (!library) return;
  const acceptance = verifiedAcceptance(library);
  if (fingerprint(record.requirements) !== fingerprint(library.requirements) || fingerprint(record.sources) !== fingerprint(library.sources)) throw new Error('Правила изменились после утверждения ситуаций: подготовьте и утвердите ситуации заново.');
  // A card library seals every definition hash in its receipt; the first format did not, so there the run's acceptance entries of the accepted variants hold them.
  const definitions = new Map('definitions' in acceptance
    ? acceptance.definitions.map(definition => [definition.cardId, definition.definitionHash])
    : (record.acceptedTests ?? []).filter(test => acceptance.variantIds.includes(test.scenarioId)).map(test => [test.scenarioId, test.definitionHash]));
  for (const scenario of record.scenarios) if (definitions.get(scenario.id) !== fingerprint(scenario)) throw new Error('Ситуация отличается от утверждённой — прогон по ней невозможен.');
}
