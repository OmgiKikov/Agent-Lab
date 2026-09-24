import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isIdentifier } from './ids.js';
import { IMPORT_DIALOGUE_LIMIT } from './limits.js';
import { maskedThrough } from './masking.js';
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

/**
 * No inference: ingest source evidence verbatim and give every retained event a stable index.
 * `known` holds reasons a reader of another format already found for rows (by index): a spreadsheet row
 * whose text has no role marker. Such a row is refused with its reason and its events are not read.
 */
export function importBatch(raw: unknown, known: ReadonlyMap<number, string> = new Map()): ImportBatch {
  const serialized = JSON.stringify(raw);
  if (!serialized || serialized.length > 12_000_000) throw new Error('Импорт пуст или превышает 12000000 символов');
  const parsed = z.json().parse(raw);
  if (record(parsed) && parsed.formatVersion !== undefined && parsed.formatVersion !== 1) throw new Error('Неподдерживаемая версия импорта');
  const rows = Array.isArray(parsed) ? parsed : record(parsed) ? parsed.dialogues : undefined;
  if (!Array.isArray(rows)) throw new Error('Ожидается массив диалогов или объект {dialogues: [...]}');
  if (rows.length > IMPORT_DIALOGUE_LIMIT) throw new Error(`В одном импорте допустимо не больше ${IMPORT_DIALOGUE_LIMIT} диалогов`);
  const contentHash = digest(rows);
  const batch: ImportBatch = { formatVersion: 1, id: `import_${contentHash.slice(0, 32)}`, contentHash, createdAt: new Date().toISOString(), dialogues: [], rejected: [] };
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const reasons: string[] = [];
    const dialogueId = record(row) && typeof row.id === 'string' ? row.id : undefined;
    if (!dialogueId || !isIdentifier(dialogueId)) reasons.push('Некорректный id диалога');
    if (dialogueId && seen.has(dialogueId)) reasons.push('Повторяющийся id диалога');
    if (dialogueId) seen.add(dialogueId);
    const rich = record(row) && Array.isArray(row.events);
    const events = record(row) ? (rich ? row.events : row.messages) : undefined;
    const retained: ImportBatch['dialogues'][number]['events'] = [];
    const issue = known.get(index);
    if (issue !== undefined) reasons.push(issue);
    else if (!Array.isArray(events) || events.length === 0 || events.length > (rich ? 120 : 60)) reasons.push('Пустые события или превышен лимит событий');
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
    if (!userEvents.length && issue === undefined) reasons.push(NO_CUSTOMER_REASON);
    if (userEvents.length && userEvents.every(event => maskedThrough(event.content ?? ''))) reasons.push(MASKED_REASON);
    const observation = record(row) ? row.observation ?? (rich ? 'unknown' : 'partial') : 'unknown';
    if (!['complete', 'partial', 'unknown'].includes(String(observation))) reasons.push('Некорректная полнота наблюдения');
    if (reasons.length) batch.rejected.push({ index, ...(dialogueId ? { id: dialogueId.slice(0, 200) } : {}), reasons: [...new Set(reasons)].slice(0, 20), original: row });
    else batch.dialogues.push({ id: dialogueId!, events: retained, observation: observation as 'complete' | 'partial' | 'unknown', original: row });
  });
  return importBatchSchema.parse(batch);
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
