import { countText } from '../plural.js';
import { FILTER_VALUES, VALUE_CHARS, columnLabel, toColumn, type ColumnInfo, type TableFilter, type TableMapping } from './mapping.js';
import { parseOrder } from './order.js';
import { cellOf, type Sheet } from './sheet.js';

/*
 * Which conversations of a sheet the owner evaluates. Real exports mix what is fair to measure with what is
 * not — a column naming the agents that answered a conversation, where only the conversations one agent
 * answered alone measure that agent. The owner keeps the conversations with given values in one column; the
 * mapping stores the choice, so the same file always gives the same conversations, and the import's sample is
 * drawn from the chosen ones only.
 *
 * Any column the mapping does not read as the conversation can choose them, as long as each conversation writes one
 * value in it. The owner names the values to keep, or Lab asks: «Какие разговоры оценивать?» lists the FILTER_VALUES
 * most frequent values and says how many more there are, so an export with dozens of agent combinations is still
 * chosen by the one value that matters. A column of texts is never listed — its values are what customers wrote —
 * but a value the owner names (at most VALUE_CHARS) is looked for there too. A value is the cell as written:
 * `['A', 'B']` is one value, never a list to take apart.
 */

/** A value of a column and how many conversations have it. */
export interface ValueCount { value: string; dialogues: number }

/** What a conversation is, before any of them is left out. */
type Reading = Omit<TableMapping, 'filter'>;

const quoted = (text: string) => `«${text}»`;
const CONVERSATIONS_OF: [string, string, string] = ['разговора', 'разговоров', 'разговоров'];

/** A sheet that keeps each conversation's rows together in nearly all of them: a conversation whose rows stand apart is two. */
const TOGETHER = 0.9;
/** Two messages of one id on different days this far apart are two conversations, not one that went on past midnight. */
const APART_MS = 12 * 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The rows of every conversation of the sheet, in the order of the sheet: a row each when a row holds a whole
 * conversation, else the rows that share an id — messages of one conversation may be anywhere in the sheet, and a
 * row without an id stays on its own. A row with neither an id nor a text (a note under the table, an empty line) is
 * no conversation. One id written on different conversations is told apart, as a JSON log tells a repeated id: where
 * the sheet keeps conversations together (TOGETHER of them), rows of one id that stand apart are another conversation;
 * where the order column writes dates, so are messages of one id on another day, APART_MS or more after the one
 * before. The first stays the conversation of that id; each later one is a conversation of its own under the same id,
 * which the reading refuses as such (dialogues.ts).
 */
export function conversationRows(sheet: Sheet, mapping: Reading, rows: readonly number[]): number[][] {
  const filled = (row: number, index: number) => cellOf(sheet, row, index).trim() !== '';
  const layout = mapping.layout;
  if (layout.kind === 'question_per_row') return rows.filter(row => filled(row, mapping.text.index)).map(row => [row]);
  if (layout.kind === 'dialogue_per_row') return rows.filter(row => filled(row, mapping.id!.index) || filled(row, mapping.text.index)).map(row => [row]);
  const groups = new Map<string, number[]>();
  const position = new Map<number, number>();
  for (const row of rows) {
    const id = cellOf(sheet, row, mapping.id!.index).trim();
    if (!id && !filled(row, layout.role.index) && !filled(row, mapping.text.index)) continue;
    position.set(row, position.size);
    const key = id || `\u0000${row}`, group = groups.get(key);
    if (group) group.push(row); else groups.set(key, [row]);
  }
  // A run: rows of one id with no other conversation's row between them (empty lines aside).
  const runs = (group: readonly number[]) => group.filter((row, i) => i === 0 || position.get(row)! !== position.get(group[i - 1]!)! + 1).length;
  const several = [...groups.values()].filter(group => group.length > 1);
  const together = several.length > 0 && several.filter(group => runs(group) === 1).length >= several.length * TOGETHER;
  const day = (row: number): number | undefined => {
    const order = layout.order && parseOrder(cellOf(sheet, row, layout.order.index));
    return order?.kind === 'date' ? order.value : undefined;
  };
  return [...groups.values()].flatMap(group => {
    const parts: number[][] = [[group[0]!]];
    for (let i = 1; i < group.length; i++) {
      const row = group[i]!, before = group[i - 1]!;
      const [at, last] = [day(row), day(before)];
      const apart = together && position.get(row)! !== position.get(before)! + 1
        || at !== undefined && last !== undefined && Math.floor(at / DAY_MS) !== Math.floor(last / DAY_MS) && Math.abs(at - last) >= APART_MS;
      if (apart) parts.push([row]); else parts.at(-1)!.push(row);
    }
    return parts;
  });
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
  if (index === mapping.id?.index) return 'id разговора';
  if (index === mapping.text.index) return layout.kind === 'dialogue_per_row' ? 'текст разговора' : layout.kind === 'question_per_row' ? 'вопрос клиента' : 'текст сообщений';
  if (layout.kind === 'question_per_row' && index === layout.answer?.index) return 'ответ агента';
  if (mapping.expected?.some(item => item.column.index === index)) return 'ожидание асессора';
  if (layout.kind === 'message_per_row' && index === layout.role.index) return 'роль того, кто пишет';
  if (layout.kind === 'message_per_row' && index === layout.order?.index) return 'порядок сообщений';
  return undefined;
}

/** Values by the conversations that have them, the most first; ties in code-unit order, so the order is the same on every machine. */
const byConversations = (a: ValueCount, b: ValueCount) => b.dialogues - a.dialogues || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0);

/**
 * How the conversations split by a column, every value with its conversations, the most first — or why the column
 * cannot choose them: the mapping already reads it, or the rows of one conversation write two values in it.
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
  return { values: [...counts].map(([value, dialogues]) => ({ value, dialogues })).sort(byConversations) };
}

/** A column of texts: some value longer than a category's, so its values are what was written, never listed. */
const texts = (values: readonly ValueCount[]) => values.some(item => item.value.length > VALUE_CHARS);

/**
 * What «Какие разговоры оценивать?» lists for a column: its FILTER_VALUES most frequent values and how many more
 * there are, which the owner names in words — or why nothing is listed: the column holds texts.
 */
export function listedValues(column: ColumnInfo, values: readonly ValueCount[]): { values: ValueCount[]; more: number } | { issue: string } {
  if (texts(values)) return { issue: `В колонке ${quoted(columnLabel(column))} длинные тексты — по ним разговоры не отбирают.` };
  return { values: values.slice(0, FILTER_VALUES), more: Math.max(0, values.length - FILTER_VALUES) };
}

/**
 * The columns worth offering to choose conversations by: those that can choose them and split them — two
 * values or more, one of them shared by several conversations: categories, not one-off values.
 */
export function selectableColumns(sheet: Sheet, mapping: Reading, conversations: readonly number[][], columns: readonly ColumnInfo[]): ColumnInfo[] {
  return columns.filter(column => {
    if (!column.filled) return false;
    const selection = columnSelection(sheet, mapping, conversations, column);
    return 'values' in selection && !texts(selection.values) && selection.values.length >= 2 && selection.values.length < conversations.length;
  });
}

/** The owner's choice of conversations: a column of the sheet, and the values to keep when they were named. */
export interface WhereChoice { column: ColumnInfo; values?: readonly string[] }

/**
 * The owner's choice of conversations, checked against the sheet once the reading is complete: the column must give
 * each conversation one value; a column alone asks which values to keep (`ask`); named values must be values of that
 * column, and the filter keeps them in the order of their conversations, the most first, so one choice is one mapping.
 */
export function whereOutcome(sheet: Sheet, mapping: Reading, conversations: readonly number[][], where: WhereChoice | undefined):
  { filter?: TableFilter } | { ask: { column: ColumnInfo; values: ValueCount[]; more: number } } | { issue: string } {
  if (!where) return {};
  const { column, values } = where;
  const split = columnSelection(sheet, mapping, conversations, column);
  if ('issue' in split) return split;
  if (!values) {
    const listed = listedValues(column, split.values);
    return 'issue' in listed ? listed : { ask: { column, ...listed } };
  }
  const label = quoted(columnLabel(column));
  const absent = values.find(value => !split.values.some(item => item.value === value));
  if (absent !== undefined) return { issue: absent ? `В колонке ${label} нет значения ${quoted(absent)}.` : `В колонке ${label} нет пустых ячеек.` };
  const wanted = new Set(values);
  return { filter: { column: toColumn(column), values: split.values.flatMap(item => wanted.has(item.value) ? [item.value] : []) } };
}

/** The conversations the owner's filter keeps, in the order of the sheet. */
export function selectedConversations(sheet: Sheet, conversations: readonly number[][], filter: TableFilter): number[][] {
  const kept = new Set(filter.values);
  return conversations.filter(rows => {
    const value = conversationValue(sheet, rows, filter.column.index);
    return value !== undefined && kept.has(value);
  });
}
