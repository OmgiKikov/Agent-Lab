import { countText } from '../plural.js';
import { FILTER_VALUES, VALUE_CHARS, columnLabel, type ColumnInfo, type TableFilter, type TableMapping } from './mapping.js';
import { cellOf, type Sheet } from './sheet.js';

/*
 * Which conversations of a sheet the owner evaluates. Real exports mix what is fair to measure with what is
 * not — a column naming the agents that answered a conversation, where only the conversations one agent
 * answered alone measure that agent. The owner keeps the conversations with given values in one column; the
 * mapping stores the choice, so the same file always gives the same conversations, and the import's sample is
 * drawn from the chosen ones only.
 *
 * A column can choose conversations when it holds categories: at most FILTER_VALUES values, none longer than
 * VALUE_CHARS — never the conversations' text — and one value per conversation. A value is the cell as
 * written: `['A', 'B']` is one value, never a list to take apart.
 */

/** A value of a column and how many conversations have it. */
export interface ValueCount { value: string; dialogues: number }

/** What a conversation is, before any of them is left out. */
type Reading = Omit<TableMapping, 'filter'>;

const quoted = (text: string) => `«${text}»`;
const CONVERSATIONS_OF: [string, string, string] = ['разговора', 'разговоров', 'разговоров'];
const VALUES: [string, string, string] = ['разное значение', 'разных значения', 'разных значений'];

/**
 * The rows of every conversation of the sheet, in the order of the sheet: a row each when a row holds a whole
 * conversation, else the rows that share an id — messages of one conversation may be anywhere in the sheet,
 * and a row without an id stays on its own. A row with neither an id nor a text (a note under the table, an
 * empty line) is no conversation.
 */
export function conversationRows(sheet: Sheet, mapping: Reading, rows: readonly number[]): number[][] {
  const filled = (row: number, index: number) => cellOf(sheet, row, index).trim() !== '';
  const layout = mapping.layout;
  if (layout.kind === 'dialogue_per_row') return rows.filter(row => filled(row, mapping.id.index) || filled(row, mapping.text.index)).map(row => [row]);
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const id = cellOf(sheet, row, mapping.id.index).trim();
    if (!id && !filled(row, layout.role.index) && !filled(row, mapping.text.index)) continue;
    const key = id || `\u0000${row}`, group = groups.get(key);
    if (group) group.push(row); else groups.set(key, [row]);
  }
  return [...groups.values()];
}

/** A conversation's value in a column: the one value its rows write — a blank cell writes none, so all blank is '' — or undefined when they write two. */
function conversationValue(sheet: Sheet, rows: readonly number[], column: number): string | undefined {
  if (rows.length === 1) return cellOf(sheet, rows[0]!, column).trim();
  const written = new Set(rows.map(row => cellOf(sheet, row, column).trim()).filter(Boolean));
  return written.size > 1 ? undefined : [...written][0] ?? '';
}

/** What the mapping already reads a column as; undefined for a column it keeps as written. */
function partOf(mapping: Reading, index: number): string | undefined {
  const layout = mapping.layout;
  if (index === mapping.id.index) return 'id разговора';
  if (index === mapping.text.index) return layout.kind === 'dialogue_per_row' ? 'текст разговора' : 'текст сообщений';
  if (layout.kind === 'message_per_row' && index === layout.role.index) return 'роль того, кто пишет';
  if (layout.kind === 'message_per_row' && index === layout.order?.index) return 'порядок сообщений';
  return undefined;
}

/** Values by the conversations that have them, the most first; ties in code-unit order, so the order is the same on every machine. */
const byConversations = (a: ValueCount, b: ValueCount) => b.dialogues - a.dialogues || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0);

/**
 * How the conversations split by a column — or why the column cannot choose them: the mapping already reads
 * it, the rows of one conversation write two values in it, it holds more than FILTER_VALUES values, or texts.
 */
export function columnSelection(sheet: Sheet, mapping: Reading, conversations: readonly number[][], column: ColumnInfo): { values: ValueCount[] } | { issue: string } {
  const label = quoted(columnLabel(column));
  const part = partOf(mapping, column.index);
  if (part) return { issue: `Колонка ${label} уже выбрана как ${part}.` };
  const counts = new Map<string, number>();
  let mixed = 0;
  for (const rows of conversations) {
    const value = conversationValue(sheet, rows, column.index);
    if (value === undefined) mixed++;
    else counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  if (mixed) return { issue: `В колонке ${label} у ${countText(mixed, CONVERSATIONS_OF)} разные значения в разных строках — по ней не отобрать разговоры целиком.` };
  if (counts.size > FILTER_VALUES) return { issue: `В колонке ${label} ${countText(counts.size, VALUES)} — по ней разговоры не отобрать: подходит колонка, где значений не больше ${FILTER_VALUES}.` };
  if ([...counts.keys()].some(value => value.length > VALUE_CHARS)) return { issue: `В колонке ${label} длинные тексты — по ним разговоры не отбирают.` };
  return { values: [...counts].map(([value, dialogues]) => ({ value, dialogues })).sort(byConversations) };
}

/**
 * The columns worth offering to choose conversations by: those that can choose them and split them — two
 * values or more, one of them shared by several conversations: categories, not one-off values.
 */
export function selectableColumns(sheet: Sheet, mapping: Reading, conversations: readonly number[][], columns: readonly ColumnInfo[]): ColumnInfo[] {
  return columns.filter(column => {
    if (!column.filled) return false;
    const selection = columnSelection(sheet, mapping, conversations, column);
    return 'values' in selection && selection.values.length >= 2 && selection.values.length < conversations.length;
  });
}

/** The conversations the owner's filter keeps, in the order of the sheet. */
export function selectedConversations(sheet: Sheet, conversations: readonly number[][], filter: TableFilter): number[][] {
  const kept = new Set(filter.values);
  return conversations.filter(rows => {
    const value = conversationValue(sheet, rows, filter.column.index);
    return value !== undefined && kept.has(value);
  });
}
