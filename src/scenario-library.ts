import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isIdentifier } from './ids.js';
import { IMPORT_BATCH_CHARS, IMPORT_DIALOGUE_LIMIT, LOGGED_CONVERSATION_CHARS, LOGGED_CUSTOMER_MESSAGES, LOGGED_MESSAGE_CHARS } from './limits.js';
import { countLeftOut, issueText, type LeftOutRow } from './log-issues.js';
import { hiddenMessage, MASK_VERSION, maskedThrough, readAlike, type MaskVersion } from './masking.js';
import { fingerprint, type Experiment } from './contracts.js';
import type { LibraryV2, ScenarioLibrary } from './card/schema.js';
import { importBatchSchema, type ImportBatch, type LeftOutIssue, type LibraryV1, type loggedRoleSchema } from './scenario-contracts.js';

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

/**
 * A row read: kept or refused, whether its customer's messages read alike under both tables of masks (masking.ts
 * readAlike), the length of its JSON, and the role names it was read by the owner's word on.
 */
type ReadRow = ({ dialogue: ImportBatch['dialogues'][number] } | { rejected: ImportBatch['rejected'][number] }) & { alike: boolean; chars: number; mapped: ReadonlySet<string> };
type ImportedEvent = ImportBatch['dialogues'][number]['events'][number];
type LoggedRole = z.infer<typeof loggedRoleSchema>['role'];

const EVENT_SCHEMA = importBatchSchema.shape.dialogues.element.shape.events.element;
const EVENT_TYPES: ReadonlySet<unknown> = new Set(['message', 'tool', 'retrieval', 'state']);
const EVENT_ROLES: ReadonlySet<unknown> = new Set(['user', 'assistant', 'tool', 'system']);
/** Who writes a message, as Lab reads it; any other role name is the owner's to map (loggedRoleSchema). */
const MESSAGE_ROLES: ReadonlySet<unknown> = new Set(['user', 'assistant', 'system']);
const OBSERVATIONS: ReadonlySet<unknown> = new Set(['complete', 'partial', 'unknown']);

/**
 * How rows are read besides the import's own rules: the table of masks (masking.ts) and the owner's word on role names
 * Lab does not know. Both decide which rows are usable, so an import records them.
 */
export interface RowReading { maskVersion?: MaskVersion; roles?: ReadonlyMap<string, LoggedRole> }

/**
 * JSON as a parser or a sheet reader makes it — finite numbers, strings, booleans, null, arrays without holes, plain
 * objects of string keys — which the event schema's `json` always takes as it is. Anything else is left to the schema,
 * and so is a `__proto__` key: the schema drops it, and the length it checks is then that of the rest.
 */
function plainJson(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > 32) return false;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (!plainJson(value[i], depth + 1)) return false;
    return true;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length || Object.hasOwn(value, '__proto__')) return false;
  for (const key of Object.keys(value)) if (!plainJson((value as Record<string, unknown>)[key], depth + 1)) return false;
  return true;
}

/**
 * An event as the import keeps it, or undefined when the event schema refuses it. A plain event is checked here by the
 * schema's own rules — a long log read event by event through the schema spent most of its time there — and any
 * other one by the schema itself, so the verdict is the schema's either way. The conversation's own size was checked
 * before (LOGGED_CONVERSATION_CHARS), and it holds every event's data.
 */
function importedEvent(candidate: { index: number; type: unknown; role?: string; content?: string; data: unknown }): ImportedEvent | undefined {
  const { type, role, content, data } = candidate;
  if (EVENT_TYPES.has(type) && (role === undefined || EVENT_ROLES.has(role)) && (content === undefined || content.length >= 1 && content.length <= LOGGED_MESSAGE_CHARS && content.trim() !== '')
    && plainJson(data)) return candidate as ImportedEvent;
  const validated = EVENT_SCHEMA.safeParse(candidate);
  return validated.success ? validated.data : undefined;
}

/** A value of the log as the owner recognises it in a reason: a string as written, anything else as JSON. */
const shown = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)).slice(0, 200);
/** The issues of a row, each once, in the order they were found. */
const once = (issues: readonly LeftOutIssue[]): LeftOutIssue[] =>
  issues.filter((issue, index) => issues.findIndex(other => other.code === issue.code && other.value === issue.value) === index);

/**
 * One row of a log by the import's rules: its id (once per log: `seen` holds the ids of the rows before it), its
 * events verbatim with stable indexes, whether a customer wrote anything a mask left — or every reason it cannot be
 * read, typed (LeftOutIssue). `known` is a reason a reader of another format already found for the row (a spreadsheet
 * row whose text has no role marker, a line of JSON Lines that is not JSON): the row is refused with it and its
 * events are not read. A row larger than LOGGED_CONVERSATION_CHARS is refused before anything else: nothing of it can
 * be kept (logImport keeps such a log's rows out of the batch).
 */
function readRow(row: unknown, index: number, seen: Set<string>, known: LeftOutIssue | undefined, reading: RowReading): ReadRow {
  const { maskVersion = MASK_VERSION, roles } = reading;
  const chars = JSON.stringify(row)?.length ?? 0;
  const issues: LeftOutIssue[] = known ? [known] : [];
  const dialogueId = record(row) && typeof row.id === 'string' ? row.id : undefined;
  // JSON as read: importBatch checks every row it keeps, and the batch before it is returned.
  const original = row as z.infer<ReturnType<typeof z.json>>;
  const mapped = new Set<string>();
  const refused = (alike = true): ReadRow => ({ rejected: { index, ...(dialogueId ? { id: dialogueId.slice(0, 200) } : {}),
    reasons: [...new Set(issues.map(issueText))].slice(0, 20), issues: once(issues).slice(0, 20), original }, alike, chars, mapped });
  if (chars > LOGGED_CONVERSATION_CHARS) { issues.push({ code: 'large', ...(dialogueId ? { value: dialogueId.slice(0, 200) } : {}) }); return refused(); }
  if (!record(row)) { if (!known) issues.push({ code: 'shape' }); return refused(); }
  if (!dialogueId || !isIdentifier(dialogueId)) issues.push({ code: 'id', ...(row.id === undefined ? {} : { value: shown(row.id) }) });
  else if (seen.has(dialogueId)) issues.push({ code: 'duplicate', value: dialogueId });
  if (dialogueId) seen.add(dialogueId);
  if (known) return refused();
  const rich = Array.isArray(row.events);
  const events = rich ? row.events : row.messages;
  if (!Array.isArray(events)) { issues.push({ code: 'shape' }); return refused(); }
  if (!events.length) { issues.push({ code: 'empty' }); return refused(); }
  const retained: ImportBatch['dialogues'][number]['events'] = [];
  let unread = false;
  events.forEach((event: unknown, eventIndex) => {
    const position = String(eventIndex + 1);
    const skip = (issue: LeftOutIssue) => { issues.push(issue); unread = true; };
    if (!record(event)) return skip({ code: 'event', value: position });
    const type = rich ? event.type : 'message';
    if (!EVENT_TYPES.has(type)) return skip({ code: 'event', value: position });
    const logged = event.role, content = event.content;
    // A message is written by a role Lab reads, or by one the owner said who it is; any other name is theirs to say.
    const role = type !== 'message' || typeof logged !== 'string' || MESSAGE_ROLES.has(logged) ? logged : roles?.get(logged);
    if (type === 'message' && typeof logged === 'string' && role === undefined) return skip({ code: 'roles', value: logged.slice(0, 80) });
    if (role !== logged) mapped.add(logged as string);
    if (type === 'message' && typeof role !== 'string') return skip({ code: 'event', value: position });
    if (typeof content === 'string' && content.length > LOGGED_MESSAGE_CHARS) return skip({ code: 'long_message', value: String(content.length) });
    if (type === 'message' && (typeof content !== 'string' || !content.trim())) return skip({ code: 'blank' });
    const kept = importedEvent({ index: eventIndex, type, ...(typeof role === 'string' ? { role } : {}), ...(typeof content === 'string' ? { content } : {}), data: event });
    if (!kept) return skip({ code: 'event', value: position });
    retained.push(kept);
  });
  const customers = retained.filter(event => event.type === 'message' && event.role === 'user');
  // A customer who wrote nothing is the data only when every message was read: unknown roles hide the customer too.
  if (!customers.length && !unread) issues.push({ code: 'no_customer' });
  if (customers.length && customers.every(event => maskedThrough(event.content ?? '', maskVersion))) issues.push({ code: 'masked' });
  const observation = row.observation ?? (rich ? 'unknown' : 'partial');
  if (!OBSERVATIONS.has(observation)) issues.push({ code: 'observation', value: shown(observation) });
  const alike = maskVersion === 1 || customers.every(event => readAlike(event.content ?? ''));
  return issues.length ? refused(alike)
    : { dialogue: { id: dialogueId!, events: retained, observation: observation as 'complete' | 'partial' | 'unknown', original }, alike, chars, mapped };
}

/**
 * Why no situation can be made of a conversation the import kept: it is still read, sorted into its topic and counted
 * in the traffic (miner/), only no situation stands for it — the customer writes more than a situation holds
 * (LOGGED_CUSTOMER_MESSAGES), or de-identification hid one of their messages whole. `maskVersion` is the table the
 * import was read by.
 */
export function situationIssue(dialogue: Pick<ImportBatch['dialogues'][number], 'events'>, maskVersion: MaskVersion = MASK_VERSION): LeftOutIssue | undefined {
  const customer = dialogue.events.flatMap(event => event.type === 'message' && event.role === 'user' && event.content !== undefined ? [event.content] : []);
  if (!customer.length) return { code: 'no_customer' };
  if (customer.length > LOGGED_CUSTOMER_MESSAGES) return { code: 'long', value: String(customer.length) };
  if (customer.some(content => hiddenMessage(content, maskVersion))) return { code: 'hidden' };
  return undefined;
}

/** The rows of a raw import: an array of conversations, or `{ formatVersion?: 1, dialogues: [...] }`. */
function rowsOf(raw: unknown): unknown[] {
  if (raw === undefined) throw new Error('Импорт пуст.');
  if (record(raw) && raw.formatVersion !== undefined && raw.formatVersion !== 1) throw new Error('Неподдерживаемая версия импорта');
  const rows = Array.isArray(raw) ? raw : record(raw) ? raw.dialogues : undefined;
  if (!Array.isArray(rows)) throw new Error('Ожидается массив диалогов или объект {dialogues: [...]}');
  return rows;
}

/** What seals an import: its rows, and the owner's word on role names when it was read by one. */
const importContent = (rows: readonly unknown[], roles: ImportBatch['roles']): unknown => roles ? { rows, roles } : rows;

/**
 * No inference: ingest source evidence verbatim and give every retained event a stable index. `known` holds reasons
 * a reader of another format already found for rows (by index), see readRow. `reading` is the table of masks the rows
 * are read by (masking.ts) and the owner's word on role names. Where a customer's message reads otherwise under the
 * table than under the first readings, the batch records it, so its conversations and the topic map of them keep the
 * reading they were made with; where every message reads alike, the batch is the one the first readings made — the
 * same import of the same rows. The role names the owner mapped and the rows used are recorded and sealed with the
 * rows. One batch holds IMPORT_DIALOGUE_LIMIT conversations of IMPORT_BATCH_CHARS at most, each within
 * LOGGED_CONVERSATION_CHARS; a larger log is sampled (logImport).
 */
export function importBatch(raw: unknown, known: ReadonlyMap<number, LeftOutIssue> = new Map(), reading: RowReading = {}): ImportBatch {
  const { maskVersion = MASK_VERSION } = reading;
  const rows = rowsOf(z.json().parse(raw));
  if (rows.length > IMPORT_DIALOGUE_LIMIT) throw new Error(`В одном импорте не больше ${IMPORT_DIALOGUE_LIMIT} разговоров.`);
  if ((JSON.stringify(rows)?.length ?? 0) > IMPORT_BATCH_CHARS) throw new Error(`Разговоры одного импорта занимают больше ${IMPORT_BATCH_CHARS.toLocaleString('ru-RU')} знаков. Загрузите их файлом логов: из большого Lab сам возьмёт выборку.`);
  const used = new Set<string>();
  const batch: Omit<ImportBatch, 'id' | 'contentHash'> = { formatVersion: 1, createdAt: new Date().toISOString(), dialogues: [], rejected: [] };
  const seen = new Set<string>();
  let alike = true;
  rows.forEach((row, index) => {
    const read = readRow(row, index, seen, known.get(index), reading);
    alike &&= read.alike;
    for (const value of read.mapped) used.add(value);
    if ('dialogue' in read) batch.dialogues.push(read.dialogue); else batch.rejected.push(read.rejected);
  });
  // Only the names the rows were read by: a mapping that names more reads the same log to the same import.
  const roles = used.size ? [...used].sort().map(value => ({ value, role: reading.roles!.get(value)! })) : undefined;
  const contentHash = digest(importContent(rows, roles));
  return importBatchSchema.parse({ ...batch, id: `import_${contentHash.slice(0, 32)}`, contentHash, ...(roles ? { roles } : {}),
    ...(maskVersion === 1 || alike ? {} : { maskVersion }) });
}

/** A conversation of a log as the order of a sample sees it: a hash of its id and its messages, never where it stands or how it ended. */
export const conversationKey = (dialogue: ImportBatch['dialogues'][number]): string =>
  fingerprint({ id: dialogue.id, messages: dialogue.events.flatMap(event => event.type === 'message' ? [[event.role ?? '', event.content ?? '']] : []) });

type Dialogue = ImportBatch['dialogues'][number];
/** The order of a sample: `key` of a usable conversation, `index` its row in the log. */
export interface LogOptions extends RowReading { key?: (dialogue: Dialogue, index: number) => string }
/** What a log larger than one batch held: its conversations, the readable ones, and why the others make no situation. */
export type LogSample = NonNullable<ImportBatch['sample']>;
/** Why a row of a log is refused, typed; undefined for a row the import reads. */
export type Verdict = LeftOutIssue[] | undefined;

/**
 * A log read a row at a time by the import's rules, so that a log too large to hold is read in a stream: `read` says why
 * a row is refused (undefined for a readable one), a conversation id taken once in the whole log; `skip` counts a row
 * too large to hold at all. Every conversation of the log no situation can be made of is counted with its reason — the
 * rows refused, and the ones read that no situation stands for (situationIssue). `sample` names the rows a batch takes
 * of a log larger than one — the readable ones first in the order of `key` (by default conversationKey, a hash of what
 * each conversation is: blind to outcomes, to length and to where it stands), up to IMPORT_DIALOGUE_LIMIT of them and
 * cut where the next would take the batch past IMPORT_BATCH_CHARS, kept in the log's order. Cutting, never skipping a
 * large conversation for smaller ones after it, keeps the sample blind to length. The same log gives the same rows.
 */
export function logReader(options: LogOptions = {}): { read(row: unknown, known?: LeftOutIssue): Verdict; skip(issue: LeftOutIssue): void; sample(): { indexes: number[]; sample: LogSample } } {
  const { maskVersion = MASK_VERSION, key = conversationKey } = options;
  const seen = new Set<string>(), usable: { index: number; key: string; chars: number }[] = [], left: LeftOutRow[] = [];
  let rows = 0;
  return {
    read(row, known) {
      const index = rows++;
      const read = readRow(row, index, seen, known, options);
      if ('rejected' in read) {
        left.push({ issues: read.rejected.issues ?? [], ...(read.rejected.id ? { id: read.rejected.id } : {}) });
        return read.rejected.issues;
      }
      const issue = situationIssue(read.dialogue, maskVersion);
      if (issue) left.push({ issues: [issue], id: read.dialogue.id });
      usable.push({ index, key: key(read.dialogue, index), chars: read.chars });
      return undefined;
    },
    skip(issue) { rows++; left.push({ issues: [issue] }); },
    sample() {
      const ordered = [...usable].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index);
      // The JSON of the taken rows as one array: its brackets, and each row with the comma before the next.
      let chars = 1, count = 0;
      while (count < ordered.length && count < IMPORT_DIALOGUE_LIMIT && chars + ordered[count]!.chars + 1 <= IMPORT_BATCH_CHARS) chars += ordered[count++]!.chars + 1;
      return { indexes: ordered.slice(0, count).map(item => item.index).sort((a, b) => a - b),
        sample: { dialogues: rows, usable: usable.length, ...(left.length ? { left: countLeftOut(left) } : {}) } };
    },
  };
}

/** How a sample is taken, in the owner's words: every surface that shows one says it so. */
export const sampleWords = (taken: number, usable: number): string => `Lab возьмёт ${taken} из ${usable} подходящих — по хешу содержимого, без отбора по исходу`;

/** The batch of a log's sample: the rows taken, in the log's order, and what the log held. */
export const sampledBatch = (rows: readonly unknown[], sample: LogSample, reading: RowReading = {}): ImportBatch =>
  importBatchSchema.parse({ ...importBatch(rows, new Map(), reading), sample });

/** A log read whole: the import, and why each row of the log is refused (undefined for a readable one), in the log's order. */
export interface LogImport { batch: ImportBatch; verdicts: Verdict[] }

/**
 * The import of a log of any size, the same for the same log: a log of at most IMPORT_DIALOGUE_LIMIT rows, each within
 * LOGGED_CONVERSATION_CHARS and all within IMPORT_BATCH_CHARS, is one batch that keeps every row, refused ones with
 * their reasons (importBatch); any other log gives the batch of its sample (logReader), which records how many
 * conversations the log held, how many were readable and why the others make no situation. `known` holds reasons
 * another format's reader found for rows (readRow).
 */
export function logImport(raw: unknown, options: LogOptions & { known?: ReadonlyMap<number, LeftOutIssue> } = {}): LogImport {
  const { known = new Map() } = options;
  const rows = rowsOf(raw);
  const sizes = rows.map(row => JSON.stringify(row)?.length ?? 0);
  if (rows.length <= IMPORT_DIALOGUE_LIMIT && sizes.every(size => size <= LOGGED_CONVERSATION_CHARS) && sizes.reduce((sum, size) => sum + size + 1, 1) <= IMPORT_BATCH_CHARS) {
    const batch = importBatch(raw, known, options);
    const issues = new Map(batch.rejected.map(item => [item.index, item.issues]));
    return { batch, verdicts: rows.map((_, index) => issues.get(index)) };
  }
  const reader = logReader(options);
  const verdicts = rows.map((row, index) => reader.read(row, known.get(index)));
  const { indexes, sample } = reader.sample();
  return { batch: sampledBatch(indexes.map(index => rows[index]), sample, options), verdicts };
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
  const contentHash = refused.size === batch.rejected.length && rows.length === count ? digest(importContent(rows, batch.roles)) : undefined;
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
