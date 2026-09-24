import { z } from 'zod';
import { identifierSchema, sha256Schema, text } from '../ids.js';
import { DELIMITERS, ENCODINGS } from './csv.js';
import { SHEET_COLUMNS, columnIndex, columnLetter } from './sheet.js';
import { TABLE_FORMATS } from './workbook.js';

/*
 * How a spreadsheet of logs is read, as the owner confirmed it: which sheet, which column is the
 * conversation id, which holds the text, and how messages are told apart — role markers inside one
 * text per conversation, or one message per row with a role column and an optional order column —
 * and, when the owner chose so, which conversations to evaluate: those with given values in one
 * column (selection.ts). Lab proposes every choice from the file; nothing is read until the owner
 * confirms. The confirmed mapping is stored next to the import with the file's hash, so the same
 * file always reads the same.
 */

export const ROLES = ['user', 'assistant', 'system'] as const;
export type Role = typeof ROLES[number];
/** A decision about a marker: who writes the messages it starts, or `text` — «not a marker, a word of the message». */
export type MarkerRole = Role | 'text';
/** The owner's words for who writes a message; `text` answers «this is not a marker» for a word Lab took for one. */
export const ROLE_WORDS: Readonly<Record<MarkerRole, string>> = { user: 'клиент', assistant: 'агент', system: 'служебное', text: 'не метка' };
/** Header rows are looked for among the first rows only: a title above the table is common, twenty lines of it are not. */
export const HEADER_SCAN = 20;
/** More distinct markers or role values than this is not a way of telling who speaks. */
export const LABEL_LIMIT = 12;
/** A column that chooses conversations holds categories: at most this many values, each one a numbered answer of one question. */
export const FILTER_VALUES = 30;
/** A category is a code or a short label; a longer value is text, and its values are never listed. */
export const VALUE_CHARS = 120;

const role = z.enum(ROLES);
const column = z.strictObject({ index: z.number().int().min(0).max(SHEET_COLUMNS - 1), header: z.string().max(1000) });
export type Column = z.infer<typeof column>;
/** A value of a column that chooses conversations: the cell as written, the spaces around it aside; '' is an empty cell. */
const cellValue = z.string().trim().max(VALUE_CHARS);

export const tableMappingSchema = z.strictObject({
  version: z.literal(1),
  source: z.discriminatedUnion('format', [
    z.strictObject({ format: z.literal('xlsx'), sheet: text(100) }),
    z.strictObject({ format: z.literal('csv'), delimiter: z.enum(DELIMITERS), encoding: z.enum(ENCODINGS) }),
  ]),
  /** The row with the column names, counted as the owner sees it (1 is the first row). */
  headerRow: z.number().int().min(1).max(HEADER_SCAN),
  id: column,
  text: column,
  layout: z.discriminatedUnion('kind', [
    /** One conversation per row: its whole text in one cell, each message after the separator starting with a marker. */
    z.strictObject({ kind: z.literal('dialogue_per_row'), separator: z.string().min(1).max(8),
      markers: z.array(z.strictObject({ token: text(40), role })).min(2).max(LABEL_LIMIT) }),
    /** One message per row: who writes it in a role column; order by a column of numbers or dates, or by the rows themselves. */
    z.strictObject({ kind: z.literal('message_per_row'), role: column,
      roles: z.array(z.strictObject({ value: text(80), role })).min(2).max(LABEL_LIMIT), order: column.optional() }),
  ]),
  /** Only the conversations with one of these values in this column go into the import: the owner's choice of what to evaluate. */
  filter: z.strictObject({ column, values: z.array(cellValue).min(1).max(FILTER_VALUES) }).optional(),
}).superRefine((mapping, ctx) => {
  const layout = mapping.layout;
  const columns = [mapping.id.index, mapping.text.index, ...layout.kind === 'message_per_row' ? [layout.role.index, ...layout.order ? [layout.order.index] : []] : [],
    ...mapping.filter ? [mapping.filter.column.index] : []];
  if (new Set(columns).size !== columns.length) ctx.addIssue({ code: 'custom', message: 'One column cannot play two parts' });
  const labels = layout.kind === 'dialogue_per_row' ? layout.markers.map(item => ({ label: item.token, role: item.role })) : layout.roles.map(item => ({ label: item.value, role: item.role }));
  if (new Set(labels.map(item => item.label)).size !== labels.length) ctx.addIssue({ code: 'custom', message: 'Duplicate markers or role values' });
  if (!labels.some(item => item.role === 'user') || !labels.some(item => item.role === 'assistant')) ctx.addIssue({ code: 'custom', message: 'A conversation needs a customer and an agent' });
  if (mapping.filter && new Set(mapping.filter.values).size !== mapping.filter.values.length) ctx.addIssue({ code: 'custom', message: 'Duplicate filter values' });
});
export type TableMapping = z.infer<typeof tableMappingSchema>;
export type TableLayout = TableMapping['layout'];
export type TableFilter = NonNullable<TableMapping['filter']>;

const columnChoice = z.string().trim().min(1).max(200);
/**
 * The owner's own choices, each overriding what Lab would propose: from the command line or from the
 * chat. A column is named by its header or its letter. Markers and role values are decided one by one:
 * those not named keep Lab's proposal. `order: null` orders messages by the rows of the sheet. `where`
 * chooses the conversations to evaluate: a column alone asks which of its values to keep; a column with
 * values keeps the conversations whose cell is exactly one of them.
 */
export const tableChoicesSchema = z.strictObject({
  sheet: z.string().trim().min(1).max(100).optional(),
  id: columnChoice.optional(),
  text: columnChoice.optional(),
  separator: z.string().min(1).max(8).optional(),
  markers: z.array(z.strictObject({ token: z.string().trim().min(1).max(40), role: z.enum([...ROLES, 'text']) })).min(1).max(20).optional(),
  role: columnChoice.optional(),
  roles: z.array(z.strictObject({ value: z.string().trim().min(1).max(80), role })).min(1).max(20).optional(),
  order: columnChoice.nullable().optional(),
  where: z.strictObject({ column: columnChoice, values: z.array(cellValue).min(1).max(FILTER_VALUES).optional() }).optional(),
});
export type TableChoices = z.infer<typeof tableChoicesSchema>;

/** A column as the owner sees it: its letter and header, and how many rows below the header fill it. */
export interface ColumnInfo { index: number; letter: string; header: string; filled: number; distinct: number }

/** How the owner recognises a column: «Текст», or «C» when the header is empty. */
export const columnLabel = (column: Pick<Column, 'index' | 'header'>): string => column.header.trim() || columnLetter(column.index);
export const toColumn = (info: ColumnInfo): Column => ({ index: info.index, header: info.header });

/** The column the owner named: by its header (exact, then ignoring case), else by its letter. */
export function findColumn(choice: string, columns: readonly ColumnInfo[]): ColumnInfo | undefined {
  const wanted = choice.trim();
  const byHeader = columns.find(item => item.header === wanted) ?? columns.find(item => item.header.toLowerCase() === wanted.toLowerCase());
  if (byHeader) return byHeader;
  const index = columnIndex(wanted);
  return index === undefined ? undefined : columns.find(item => item.index === index);
}

const count = z.number().int().nonnegative();
/** One confirmation of how a file reads into an import: the exact file, the mapping, and what the owner was shown. */
export const tableReadingSchema = z.strictObject({
  file: z.strictObject({ name: text(260), bytes: z.number().int().positive(), sha256: sha256Schema, format: z.enum(TABLE_FORMATS) }),
  mapping: tableMappingSchema,
  confirmedAt: z.iso.datetime(),
  /** `dialogues`: every conversation of the sheet; `selected`: those the owner's filter kept, when there is one; usable and taken are among them. */
  sheet: z.strictObject({ dialogues: count, selected: count.optional(), usable: count, taken: count,
    rejected: z.array(z.strictObject({ reason: text(2000), count: z.number().int().positive() })).max(100) }),
});
export type TableReading = z.infer<typeof tableReadingSchema>;
/** The readings confirmed for one import: two files, or two mappings, may produce the very same conversations. */
export const importReadingsSchema = z.strictObject({
  formatVersion: z.literal(1), importId: identifierSchema, contentHash: sha256Schema, readings: z.array(tableReadingSchema).min(1).max(100),
});
export type ImportReadings = z.infer<typeof importReadingsSchema>;
