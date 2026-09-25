import { fingerprint } from '../contracts.js';
import { IMPORT_DIALOGUE_LIMIT } from '../limits.js';
import type { ImportBatch } from '../scenario-contracts.js';
import { importBatch } from '../scenario-library.js';
import { columnLabel, type Column, type Role, type TableMapping } from './mapping.js';
import { splitMessages } from './markers.js';
import { withoutRepeats } from './repeats.js';
import { conversationRows, selectedConversations } from './selection.js';
import { cellOf, columnLetter, type Sheet } from './sheet.js';

/*
 * A confirmed mapping applied to a sheet: every conversation becomes a row of the ordinary import
 * (src/scenario-library.ts importBatch), so the miner, preparation, calibration and every screen read
 * spreadsheet logs exactly as they read JSON ones. The import's own rules decide what is usable; a
 * problem only the spreadsheet can see (no marker, an unknown role) is handed to it as the row's reason.
 * Every other column of a conversation travels with it verbatim, as the fields of a JSON row do. When the
 * owner chose to drop copied exchanges (repeats.ts), a conversation's row says how many messages went.
 *
 * The owner's filter (selection.ts) comes first: the conversations it leaves out are not read at all.
 * One import holds IMPORT_DIALOGUE_LIMIT conversations. A longer log gives a sample of its usable
 * conversations taken in the order of a hash of each one's id and messages: blind to outcomes and to
 * where a row stands in the sheet, and the same for the same logs.
 */

/** Why a conversation of the sheet is not usable, when the spreadsheet itself shows it; fixed wording, so the preview can count them. */
const ROW_ISSUES = {
  noText: 'Пустой текст разговора',
  noMarker: 'Текст не начинается с метки роли',
  emptyMessage: 'Пустое сообщение',
  unknownRole: 'Роль сообщения не указана в разметке',
  noOrder: 'У сообщения нет порядкового номера или времени',
  // The import's own wording for the same thing, so both count as one reason.
  duplicate: 'Повторяющийся id диалога',
} as const;

export interface TablePreview {
  /** Rows below the header with anything in them. */
  rows: number;
  /** Conversations the sheet holds under the mapping. */
  dialogues: number;
  /** With the owner's filter: the conversations it keeps. Usable, taken and rejected count only these. */
  selected?: number;
  /** Conversations the import accepts. */
  usable: number;
  /** Conversations in the import: all usable ones, or the sample of them when there are more than one import holds. */
  taken: number;
  /** Why the rest are not usable, the most frequent reason first. */
  rejected: { reason: string; count: number }[];
  /** Messages of usable conversations by marker or role value. */
  messages: { label: string; role: Role; count: number }[];
  /** The other columns, kept with each conversation as written. */
  kept: string[];
  /**
   * Conversations where a block of messages stands again right after itself, and the messages that are such copies:
   * what the owner's collapseRepeats drops, or dropped. Absent when there are none.
   */
  repeats?: { dialogues: number; messages: number };
}

/** One conversation on its way into the import: the row the import reads, and the reason the sheet already shows. */
interface SheetDialogue {
  raw: Record<string, unknown>;
  issue?: string;
  labels: { label: string; role: Role }[];
  /** Messages that are copies of the block right before them: dropped when the owner chose so, counted either way. */
  repeats: number;
  /** What the conversation is — its id and messages, not its place in the sheet: the order of the sample. */
  key: () => string;
}
const contentKey = (id: string, messages: readonly { content: string }[], labels: readonly { label: string }[]) =>
  () => fingerprint({ id, messages: messages.map((message, i) => [labels[i]?.label ?? '', message.content]) });

export function importTable(sheet: Sheet, mapping: TableMapping): { batch: ImportBatch; preview: TablePreview } {
  const header = mapping.headerRow - 1;
  const rows = sheet.rows.flatMap((cells, index) => index > header && cells.some(cell => cell.trim()) ? [index] : []);
  const kept = keptColumns(sheet, mapping, rows);
  const conversations = conversationRows(sheet, mapping, rows);
  const chosen = mapping.filter ? selectedConversations(sheet, conversations, mapping.filter) : conversations;
  const read = mapping.layout.kind === 'dialogue_per_row' ? rowDialogues(sheet, mapping, chosen, kept)
    : mapping.layout.kind === 'question_per_row' ? questionDialogues(sheet, mapping, chosen, kept) : messageDialogues(sheet, mapping, chosen, kept);
  const dialogues = mapping.expected ? read.map((item, i) => withExpected(item, sheet, mapping.expected!, chosen[i]!)) : read;
  const verdicts: (string[] | undefined)[] = [];
  let whole: ImportBatch | undefined;
  for (let start = 0; start < dialogues.length; start += IMPORT_DIALOGUE_LIMIT) {
    const chunk = dialogues.slice(start, start + IMPORT_DIALOGUE_LIMIT);
    const batch = importBatch(chunk.map(item => item.raw), new Map(chunk.flatMap((item, i) => item.issue ? [[i, item.issue] as const] : [])));
    const reasons = new Map(batch.rejected.map(item => [item.index, item.reasons]));
    chunk.forEach((_, i) => verdicts.push(reasons.get(i)));
    if (dialogues.length <= IMPORT_DIALOGUE_LIMIT) whole = batch;
  }
  const usable = dialogues.flatMap((item, i) => verdicts[i] ? [] : [{ item, i }]);
  const batch = whole ?? importBatch(sample(usable).map(entry => entry.item.raw));
  const reasons = new Map<string, number>();
  for (const verdict of verdicts) if (verdict?.[0]) reasons.set(verdict[0], (reasons.get(verdict[0]) ?? 0) + 1);
  const messages = new Map<string, { label: string; role: Role; count: number }>();
  for (const { item } of usable) for (const { label, role } of item.labels) {
    const entry = messages.get(label) ?? { label, role, count: 0 };
    entry.count++; messages.set(label, entry);
  }
  const repeated = dialogues.filter(item => item.repeats);
  const repeats = { dialogues: repeated.length, messages: repeated.reduce((total, item) => total + item.repeats, 0) };
  return { batch, preview: {
    rows: rows.length, dialogues: conversations.length, ...mapping.filter ? { selected: chosen.length } : {}, usable: usable.length, taken: batch.dialogues.length,
    rejected: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    messages: [...messages.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    kept: kept.map(item => item.key), ...repeats.dialogues ? { repeats } : {},
  } };
}

/** IMPORT_DIALOGUE_LIMIT of the usable conversations, first by content hash, kept in the order of the sheet. */
function sample<T extends { item: SheetDialogue; i: number }>(usable: readonly T[]): T[] {
  return usable.map(entry => ({ entry, key: entry.item.key() })).sort((a, b) => a.key.localeCompare(b.key))
    .slice(0, IMPORT_DIALOGUE_LIMIT).map(({ entry }) => entry).sort((a, b) => a.i - b.i);
}

interface KeptColumn { index: number; key: string }

/** Columns the mapping does not read that hold anything, each under the name it has in the header (the letter when that is empty or repeated). */
function keptColumns(sheet: Sheet, mapping: TableMapping, rows: number[]): KeptColumn[] {
  const layout = mapping.layout;
  const used = new Set([...mapping.id ? [mapping.id.index] : [], mapping.text.index, ...layout.kind === 'message_per_row' ? [layout.role.index, ...layout.order ? [layout.order.index] : []] : [],
    ...layout.kind === 'question_per_row' && layout.answer ? [layout.answer.index] : [], ...(mapping.expected ?? []).map(item => item.column.index)]);
  const header = sheet.rows[mapping.headerRow - 1] ?? [];
  let width = header.length;
  for (const row of rows) width = Math.max(width, sheet.rows[row]!.length);
  const names = Array.from({ length: width }, (_, index) => columnLabel({ index, header: header[index] ?? '' }));
  return names.flatMap((name, index) => used.has(index) || !rows.some(row => cellOf(sheet, row, index).trim()) ? []
    : [{ index, key: names.indexOf(name) === names.lastIndexOf(name) ? name : `${name} (${columnLetter(index)})` }]);
}

/** The kept cells of one row that hold anything; undefined when none do. */
function keptCells(sheet: Sheet, row: number, kept: readonly KeptColumn[]): Record<string, string> | undefined {
  const cells = kept.flatMap(column => { const value = cellOf(sheet, row, column.index); return value.trim() ? [[column.key, value] as const] : []; });
  return cells.length ? Object.fromEntries(cells) : undefined;
}

const cellText = (sheet: Sheet, row: number, column: Column) => cellOf(sheet, row, column.index);

/**
 * A conversation's messages as the import takes them: as written, or with copied blocks dropped when the owner
 * chose so — then its row says how many went (`droppedRepeats`), so the evidence shows the sheet held more.
 * `repeats` counts the copies either way.
 */
function collapsed<T extends { role?: string; content: string }>(mapping: TableMapping, written: T[]): { messages: T[]; repeats: number; dropped: { droppedRepeats?: number } } {
  const once = withoutRepeats(written);
  const repeats = written.length - once.length;
  return mapping.collapseRepeats ? { messages: once, repeats, dropped: repeats ? { droppedRepeats: repeats } : {} } : { messages: written, repeats, dropped: {} };
}

/** One conversation per row: `conversations` holds each conversation's one row (selection.ts conversationRows). */
function rowDialogues(sheet: Sheet, mapping: TableMapping, conversations: readonly number[][], kept: readonly KeptColumn[]): SheetDialogue[] {
  if (mapping.layout.kind !== 'dialogue_per_row') return [];
  const { separator, markers } = mapping.layout;
  const roleOf = new Map(markers.map(item => [item.token, item.role]));
  const tokens = markers.map(item => item.token);
  const seen = new Set<string>();
  return conversations.map((rows): SheetDialogue => {
    const row = rows[0]!, id = cellText(sheet, row, mapping.id!).trim(), text = cellText(sheet, row, mapping.text);
    const columns = keptCells(sheet, row, kept);
    const base = { id, row: row + 1, ...columns ? { columns } : {} };
    const duplicate = id !== '' && seen.has(id) ? ROW_ISSUES.duplicate : undefined;
    seen.add(id);
    if (!text.trim()) return { raw: base, issue: duplicate ?? ROW_ISSUES.noText, labels: [], repeats: 0, key: contentKey(id, [], []) };
    const split = splitMessages(text, separator, tokens);
    if (!split) return { raw: { ...base, text }, issue: duplicate ?? ROW_ISSUES.noMarker, labels: [], repeats: 0, key: contentKey(id, [], []) };
    const { messages, repeats, dropped } = collapsed(mapping, split.map(message => ({ role: roleOf.get(message.marker)!, content: message.content, marker: message.marker })));
    const issue = duplicate ?? (messages.some(message => !message.content) ? ROW_ISSUES.emptyMessage : undefined);
    const labels = messages.map(message => ({ label: message.marker, role: message.role }));
    return { raw: { ...base, messages, ...dropped }, ...issue ? { issue } : {}, labels, repeats, key: contentKey(id, messages, labels) };
  });
}

/** One message per row: `conversations` holds the rows of each conversation (selection.ts conversationRows). */
function messageDialogues(sheet: Sheet, mapping: TableMapping, conversations: readonly number[][], kept: readonly KeptColumn[]): SheetDialogue[] {
  const layout = mapping.layout;
  if (layout.kind !== 'message_per_row') return [];
  const roleOf = new Map(layout.roles.map(item => [item.value, item.role]));
  return conversations.map((group): SheetDialogue => {
    const id = cellText(sheet, group[0]!, mapping.id!).trim();
    const ordered = layout.order ? group.map(row => ({ row, key: parseOrder(cellText(sheet, row, layout.order!)) })) : group.map(row => ({ row, key: undefined }));
    // A message without its place, or a column mixing numbers and dates, leaves the order unknown: never guessed.
    const unordered = layout.order !== undefined && (ordered.some(item => item.key === undefined) || new Set(ordered.map(item => item.key?.kind)).size > 1);
    if (!unordered) ordered.sort((a, b) => (a.key?.value ?? 0) - (b.key?.value ?? 0) || a.row - b.row);
    const { messages, repeats, dropped } = collapsed(mapping, ordered.map(({ row }) => {
      const value = cellText(sheet, row, layout.role).trim(), role = roleOf.get(value), columns = keptCells(sheet, row, kept);
      return { ...role ? { role } : {}, content: cellText(sheet, row, mapping.text).trim(), row: row + 1, value,
        ...layout.order ? { order: cellText(sheet, row, layout.order) } : {}, ...columns ? { columns } : {} };
    }));
    const issue = messages.some(message => !message.role) ? ROW_ISSUES.unknownRole : unordered ? ROW_ISSUES.noOrder
      : messages.some(message => !message.content) ? ROW_ISSUES.emptyMessage : undefined;
    const labels = messages.flatMap(message => message.role ? [{ label: message.value, role: message.role }] : []);
    return { raw: { id, rows: group.map(row => row + 1), messages, ...dropped }, ...issue ? { issue } : {}, labels, repeats, key: contentKey(id, messages, labels) };
  });
}

/**
 * One case per row: the customer's message as written, and the agent's reply the log kept when there is a column of
 * it. A row names its conversation by its id cell, or, with no id column, by its own row: two rows asking the same
 * question are two cases, never one conversation.
 */
function questionDialogues(sheet: Sheet, mapping: TableMapping, conversations: readonly number[][], kept: readonly KeptColumn[]): SheetDialogue[] {
  const layout = mapping.layout;
  if (layout.kind !== 'question_per_row') return [];
  return conversations.map((rows): SheetDialogue => {
    const row = rows[0]!, id = mapping.id ? cellText(sheet, row, mapping.id).trim() : `row_${row + 1}`;
    const question = cellText(sheet, row, mapping.text).trim(), answer = layout.answer ? cellText(sheet, row, layout.answer).trim() : '';
    const columns = keptCells(sheet, row, kept);
    const messages = [{ role: 'user' as const, content: question }, ...answer ? [{ role: 'assistant' as const, content: answer }] : []];
    const labels = messages.map(message => ({ label: message.role === 'user' ? 'вопрос' : 'ответ', role: message.role }));
    return { raw: { id, row: row + 1, ...columns ? { columns } : {}, messages }, ...question ? {} : { issue: ROW_ISSUES.noText }, labels, repeats: 0,
      key: contentKey(id, messages, labels) };
  });
}

/** The assessor's expected result of one conversation, as its rows write it: carried with the conversation to its situation. */
function withExpected(dialogue: SheetDialogue, sheet: Sheet, expected: NonNullable<TableMapping['expected']>, rows: readonly number[]): SheetDialogue {
  const values = expected.flatMap(item => {
    const value = rows.map(row => cellText(sheet, row, item.column).trim()).find(Boolean);
    return value ? [{ kind: item.kind, value }] : [];
  });
  return values.length ? { ...dialogue, raw: { ...dialogue.raw, expected: values } } : dialogue;
}

const NUMBER = /^[+-]?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?$/;
const DOTTED_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3}))?)?)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * The position a cell of an order column gives a message: a number (a sequence number, or Excel's day
 * count of a date cell) or a written date and time (ISO or DD.MM.YYYY). Undefined when it is neither.
 */
export function parseOrder(text: string): { kind: 'number' | 'date'; value: number } | undefined {
  const value = text.trim();
  if (NUMBER.test(value)) return { kind: 'number', value: Number(value.replace(',', '.')) };
  const dotted = DOTTED_DATE.exec(value);
  if (dotted) {
    const part = (group: number) => Number(dotted[group] ?? 0);
    const time = Date.UTC(part(3), part(2) - 1, part(1), part(4), part(5), part(6), Number((dotted[7] ?? '0').padEnd(3, '0')));
    const date = new Date(time);
    // 31.02.2026 is not a date: Date.UTC would quietly make it March.
    return date.getUTCDate() === part(1) && date.getUTCMonth() === part(2) - 1 ? { kind: 'date', value: time } : undefined;
  }
  const iso = ISO_DATE.test(value) ? Date.parse(value.replace(' ', 'T')) : NaN;
  return Number.isFinite(iso) ? { kind: 'date', value: iso } : undefined;
}
