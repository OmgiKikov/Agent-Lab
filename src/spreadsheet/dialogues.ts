import { fingerprint } from '../contracts.js';
import { countLeftOut, leftOutReason } from '../log-issues.js';
import type { ImportBatch, LeftOutCode, LeftOutIssue } from '../scenario-contracts.js';
import { logImport } from '../scenario-library.js';
import { columnLabel, type Column, type Role, type TableMapping } from './mapping.js';
import { splitMessages } from './markers.js';
import { parseOrder } from './order.js';
import { withoutRepeats } from './repeats.js';
import { fencedBlocks, withoutInterfaceMarkup } from '../interface-markup.js';
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
 * One import holds IMPORT_DIALOGUE_LIMIT conversations. A longer log gives the sample every log gives
 * (scenario-library.ts logImport), ordered by a hash of each conversation's id and messages as the sheet
 * labels them: blind to outcomes and to where a row stands in the sheet, and the same for the same logs.
 */

/** Why a conversation of the sheet is not usable, when the spreadsheet itself shows it: typed as the import types its own (log-issues.ts). */
const ROW_ISSUES = {
  noText: { code: 'no_text' }, noMarker: { code: 'no_marker' }, emptyMessage: { code: 'blank' }, noOrder: { code: 'no_order' },
} as const satisfies Record<string, LeftOutIssue>;

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
  /** Why the rest are not usable, the most frequent reason first: each conversation once, under its first reason. */
  rejected: { code: LeftOutCode; reason: string; count: number }[];
  /** Messages of usable conversations by marker or role value. */
  messages: { label: string; role: Role; count: number }[];
  /** The other columns, kept with each conversation as written. */
  kept: string[];
  /**
   * Conversations where a block of messages stands again right after itself, and the messages that are such copies:
   * what the owner's collapseRepeats drops, or dropped. Absent when there are none.
   */
  repeats?: { dialogues: number; messages: number };
  /**
   * Conversations where an agent's message holds a fenced block (```…```: an interface element as the export writes it),
   * and such messages: counted either way; read as interface elements only when the owner confirmed it. Absent when there are none.
   */
  markup?: { dialogues: number; messages: number };
}

/** One conversation on its way into the import: the row the import reads, and the reason the sheet already shows. */
interface SheetDialogue {
  raw: Record<string, unknown>;
  issue?: LeftOutIssue;
  labels: { label: string; role: Role }[];
  /** Messages that are copies of the block right before them: dropped when the owner chose so, counted either way. */
  repeats: number;
  /** The agent's messages holding a fenced block: interface elements when the owner confirmed it, counted either way. */
  markup?: number;
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
  const { batch, verdicts } = logImport(dialogues.map(item => item.raw), { known: new Map(dialogues.flatMap((item, i) => item.issue ? [[i, item.issue] as const] : [])),
    maskVersion: mapping.maskVersion ?? 1, key: (_, i) => dialogues[i]!.key() });
  const usable = dialogues.flatMap((item, i) => verdicts[i] ? [] : [{ item, i }]);
  const reasons = countLeftOut(verdicts.flatMap(verdict => verdict ? [{ issues: verdict }] : []));
  const messages = new Map<string, { label: string; role: Role; count: number }>();
  for (const { item } of usable) for (const { label, role } of item.labels) {
    const entry = messages.get(label) ?? { label, role, count: 0 };
    entry.count++; messages.set(label, entry);
  }
  const repeated = dialogues.filter(item => item.repeats);
  const repeats = { dialogues: repeated.length, messages: repeated.reduce((total, item) => total + item.repeats, 0) };
  const marked = dialogues.filter(item => item.markup);
  const markup = { dialogues: marked.length, messages: marked.reduce((total, item) => total + (item.markup ?? 0), 0) };
  return { batch, preview: {
    rows: rows.length, dialogues: conversations.length, ...mapping.filter ? { selected: chosen.length } : {}, usable: usable.length, taken: batch.dialogues.length,
    rejected: reasons.map(item => ({ code: item.code, reason: leftOutReason(item), count: item.count })),
    messages: [...messages.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    kept: kept.map(item => item.key), ...repeats.dialogues ? { repeats } : {}, ...markup.dialogues ? { markup } : {},
  } };
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
 * chose so — then its row says how many went (`droppedRepeats`), so the evidence shows the sheet held more —, and the
 * interface elements of the agent's messages read as such when the owner confirmed it. `repeats` counts the copies and
 * `markup` the agent's messages with a fenced block either way.
 */
function collapsed<T extends { role?: string; content: string }>(mapping: TableMapping, written: T[]): { messages: T[]; repeats: number; markup: number; dropped: { droppedRepeats?: number } } {
  const markup = written.filter(message => message.role === 'assistant' && fencedBlocks(message.content).length).length;
  // Compare the original messages: two different buttons must not become duplicate turns after both render as a mark.
  const once = withoutRepeats(written);
  const repeats = written.length - once.length;
  const selected = mapping.collapseRepeats ? once : written;
  const messages = mapping.interfaceMarkup === 'fenced' ? selected.map(message => message.role === 'assistant' ? { ...message, content: withoutInterfaceMarkup(message.content) } : message) : selected;
  return { messages, repeats, markup, dropped: mapping.collapseRepeats && repeats ? { droppedRepeats: repeats } : {} };
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
    const duplicate: LeftOutIssue | undefined = id !== '' && seen.has(id) ? { code: 'duplicate', value: id } : undefined;
    seen.add(id);
    if (!text.trim()) return { raw: base, issue: duplicate ?? ROW_ISSUES.noText, labels: [], repeats: 0, key: contentKey(id, [], []) };
    const split = splitMessages(text, separator, tokens);
    if (!split) return { raw: { ...base, text }, issue: duplicate ?? ROW_ISSUES.noMarker, labels: [], repeats: 0, key: contentKey(id, [], []) };
    const { messages, repeats, markup, dropped } = collapsed(mapping, split.map(message => ({ role: roleOf.get(message.marker)!, content: message.content, marker: message.marker })));
    const issue = duplicate ?? (messages.some(message => !message.content) ? ROW_ISSUES.emptyMessage : undefined);
    const labels = messages.map(message => ({ label: message.marker, role: message.role }));
    return { raw: { ...base, messages, ...dropped }, ...issue ? { issue } : {}, labels, repeats, markup, key: contentKey(id, messages, labels) };
  });
}

/** One message per row: `conversations` holds the rows of each conversation (selection.ts conversationRows). */
function messageDialogues(sheet: Sheet, mapping: TableMapping, conversations: readonly number[][], kept: readonly KeptColumn[]): SheetDialogue[] {
  const layout = mapping.layout;
  if (layout.kind !== 'message_per_row') return [];
  const roleOf = new Map(layout.roles.map(item => [item.value, item.role]));
  const seen = new Set<string>();
  return conversations.map((group): SheetDialogue => {
    const id = cellText(sheet, group[0]!, mapping.id!).trim();
    // One id on a second conversation of the sheet (selection.ts conversationRows): refused as a JSON log refuses a repeated id.
    const shared: LeftOutIssue | undefined = id !== '' && seen.has(id) ? { code: 'shared', value: id } : undefined;
    seen.add(id);
    const ordered = layout.order ? group.map(row => ({ row, key: parseOrder(cellText(sheet, row, layout.order!)) })) : group.map(row => ({ row, key: undefined }));
    // A message without its place, or a column mixing numbers and dates, leaves the order unknown: never guessed.
    const unordered = layout.order !== undefined && (ordered.some(item => item.key === undefined) || new Set(ordered.map(item => item.key?.kind)).size > 1);
    if (!unordered) ordered.sort((a, b) => (a.key?.value ?? 0) - (b.key?.value ?? 0) || a.row - b.row);
    const { messages, repeats, markup, dropped } = collapsed(mapping, ordered.map(({ row }) => {
      const value = cellText(sheet, row, layout.role).trim(), role = roleOf.get(value), columns = keptCells(sheet, row, kept);
      return { ...role ? { role } : {}, content: cellText(sheet, row, mapping.text).trim(), row: row + 1, value,
        ...layout.order ? { order: cellText(sheet, row, layout.order) } : {}, ...columns ? { columns } : {} };
    }));
    const unmapped = messages.find(message => !message.role);
    const issue: LeftOutIssue | undefined = shared ?? (unmapped ? { code: 'unmapped', value: unmapped.value.slice(0, 200) } : unordered ? ROW_ISSUES.noOrder
      : messages.some(message => !message.content) ? ROW_ISSUES.emptyMessage : undefined);
    const labels = messages.flatMap(message => message.role ? [{ label: message.value, role: message.role }] : []);
    return { raw: { id, rows: group.map(row => row + 1), messages, ...dropped }, ...issue ? { issue } : {}, labels, repeats, markup, key: contentKey(id, messages, labels) };
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
