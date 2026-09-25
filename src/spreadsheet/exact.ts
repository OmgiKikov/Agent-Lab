import { MASK_VERSION } from '../masking.js';
import { EVENTS_REASON, MASKED_REASON, NO_CUSTOMER_REASON } from '../scenario-library.js';
import { analyzeSheet, columnNames, type SheetAnalysis } from './analysis.js';
import { importTable, type TablePreview } from './dialogues.js';
import { findColumn, tableMappingSchema, toColumn, type ColumnInfo, type MarkerRole, type RepeatJudgement, type Role, type TableChoices, type TableMapping } from './mapping.js';
import type { TableProposal } from './proposal.js';
import { frequentCopies } from './repeats.js';
import { conversationRows, selectableColumns, whereOutcome, type ValueCount, type WhereChoice } from './selection.js';
import type { Sheet } from './sheet.js';
import type { TableFile, Workbook } from './workbook.js';

/*
 * A reading every part of which is decided — Lab's model proposed it (reading-task.ts), the owner may have changed
 * parts of it — applied to every row exactly as decided: no word is guessed to be a marker and no column is guessed
 * to be anything. Then the numbers say whether it reads the table: both sides of a conversation, neither near zero
 * next to the other; nearly every conversation read, and why the rest are left out; every value of a role column
 * decided; copies not passed over. A reading that fails says why in words its model can act on: the repair loop of
 * the model's task sends them back verbatim.
 *
 * Both readings of a table — this one and Lab's own (proposal.ts) — end the same way (applyReading): the conversations
 * the owner keeps, the copies read once when that was chosen, and the numbers of the import, counted once.
 */

/** How the messages are told apart, every part decided; a marker decided as `text` is a word of the messages. */
export type LayoutChoice =
  | { kind: 'dialogue_per_row'; separator: string | null; markers: { token: string; role: MarkerRole }[] }
  | { kind: 'message_per_row'; role: string; roles: { value: string; role: Role }[]; order: string | null };
/** A complete reading: columns are named by columnNames() (analysis.ts), or as the owner names them (a header or a letter). */
export interface CompleteReading {
  sheet: string;
  id: string;
  text: string;
  layout: LayoutChoice;
  collapseRepeats: boolean;
  where?: { column: string; values?: string[] };
}

/** Each side writes at least this share of the other side's messages: a side near zero was read into the other side's messages. */
const PLAUSIBLE_SIDE = 0.1;
/** A real export has a few odd rows; a reading that leaves out more than this share of the conversations reads the table wrong. */
const LEFT_OUT = 0.1;
/**
 * Reasons that are the data, whatever the reading: customer messages hidden by de-identification, a customer who
 * opened a chat and left, a conversation longer than one import keeps. A reading that misses the customer
 * everywhere is caught by the sides.
 */
const DATA_REASONS: ReadonlySet<string> = new Set([MASKED_REASON, NO_CUSTOMER_REASON, EVENTS_REASON]);

const quoted = (text: string) => `"${text}"`;

/**
 * The model's reading with the owner's own choices over it: a column, the sheet, the conversations to keep or the
 * copies decided by the owner replace the model's; a marker or a role value the owner decided is decided so, the
 * others stay the model's. Undefined when the owner's choices leave the model's layout — markers where the model
 * saw one message per row, or back: that reading is the owner's to finish, never a mix of two.
 */
export function overridden(model: CompleteReading, owner: TableChoices): CompleteReading | undefined {
  const toMarkers = owner.markers !== undefined || owner.separator !== undefined;
  const toMessages = owner.role !== undefined || owner.roles !== undefined || owner.order !== undefined;
  const layout = model.layout;
  if (layout.kind === 'dialogue_per_row' ? toMessages : toMarkers) return undefined;
  const decided = <T, K>(mine: readonly T[], theirs: readonly T[] | undefined, key: (item: T) => K) =>
    [...mine.filter(item => !theirs?.some(next => key(next) === key(item))), ...theirs ?? []];
  return {
    sheet: owner.sheet ?? model.sheet, id: owner.id ?? model.id, text: owner.text ?? model.text,
    layout: layout.kind === 'dialogue_per_row'
      ? { ...layout, separator: owner.separator === undefined ? layout.separator : owner.separator, markers: decided(layout.markers, owner.markers, item => item.token) }
      : { ...layout, role: owner.role ?? layout.role, roles: decided(layout.roles, owner.roles, item => item.value), order: owner.order === undefined ? layout.order : owner.order },
    collapseRepeats: owner.collapseRepeats ?? model.collapseRepeats,
    ...owner.where ?? model.where ? { where: owner.where ?? model.where } : {},
  };
}

type Ready = Extract<TableProposal, { status: 'ready' }>;
type Where = Extract<TableProposal, { status: 'question' }> & { question: { kind: 'where' } };
/** The reading applied: a ready proposal, the owner's question of which values to keep, or why it does not read the table. */
export type ExactOutcome = { proposal: Omit<Ready, 'basis'> | Omit<Where, 'basis'> } | { problem: string };

/** What every proposal of a sheet says of the file: its sheets, the header row, the columns. */
export function proposalBase(workbook: Workbook, file: TableFile, sheet: Sheet, a: SheetAnalysis): Omit<Ready, 'status' | 'mapping' | 'preview' | 'selectable' | 'basis'> {
  return { file, sheets: workbook.sheets.map(item => item.name), sheet: sheet.name, ...workbook.csv ? { csv: workbook.csv } : {}, headerRow: a.header + 1, columns: a.columns };
}

/** A mapping of `sheet` in its file's format, read by today's table of masks; undefined parts are the caller's to check. */
export const sheetMapping = (workbook: Workbook, sheet: Sheet, a: SheetAnalysis, parts: Pick<TableMapping, 'id' | 'text' | 'layout'>): unknown =>
  ({ version: 1, source: workbook.csv ? { format: 'csv', ...workbook.csv } : { format: 'xlsx', sheet: sheet.name }, headerRow: a.header + 1, ...parts, maskVersion: MASK_VERSION });

/** A reading applied: the owner's choice of conversations refused (`issue`) or asked (`ask`), or the mapping and what it reads. */
export type AppliedReading =
  | { issue: string }
  | { ask: { column: ColumnInfo; values: ValueCount[]; more: number }; found: number }
  | { mapping: TableMapping; preview: TablePreview; selectable: ColumnInfo[] };

/**
 * A complete reading of `sheet` applied once: the owner's choice of conversations (`where`), then every row read —
 * with copied exchanges read once when `collapse` says so, which is how its numbers are counted and checked. Collapsing
 * where nothing is copied changes nothing: the mapping records it only when copies were dropped.
 */
export function applyReading(sheet: Sheet, a: SheetAnalysis, reading: TableMapping, where: WhereChoice | undefined, collapse: boolean | undefined): AppliedReading {
  const conversations = conversationRows(sheet, reading, a.rows);
  const selection = whereOutcome(sheet, reading, conversations, where);
  if ('issue' in selection) return selection;
  if ('ask' in selection) return { ask: selection.ask, found: conversations.length };
  const chosen = selection.filter ? tableMappingSchema.parse({ ...reading, filter: selection.filter }) : reading;
  const trial = collapse ? tableMappingSchema.parse({ ...chosen, collapseRepeats: true }) : chosen;
  const { preview } = importTable(sheet, trial);
  return { mapping: collapse && preview.repeats ? trial : chosen, preview, selectable: selectableColumns(sheet, reading, conversations, a.columns) };
}

/**
 * Applies `reading` to every row of its sheet and checks the outcome. `judged` is the model's own conclusion about
 * copies, checked against the counted copies; absent when the owner decided them.
 */
export function readExactly(workbook: Workbook, file: TableFile, reading: CompleteReading, judged?: RepeatJudgement): ExactOutcome {
  const sheet = workbook.sheets.find(item => item.name === reading.sheet) ?? workbook.sheets.find(item => item.name.toLowerCase() === reading.sheet.toLowerCase());
  if (!sheet) return { problem: `Sheet ${quoted(reading.sheet)} is not in the workbook; its sheets are ${workbook.sheets.map(item => quoted(item.name)).join(', ')}.` };
  const a = analyzeSheet(sheet);
  const resolved = resolve(a, reading);
  if ('problem' in resolved) return resolved;
  const parsed = tableMappingSchema.safeParse(sheetMapping(workbook, sheet, a, { id: toColumn(resolved.id), text: toColumn(resolved.text), layout: resolved.layout }));
  if (!parsed.success) return { problem: `This reading is not possible: ${parsed.error.issues.map(issue => issue.message).join('; ')}.` };
  const applied = applyReading(sheet, a, parsed.data, resolved.where, reading.collapseRepeats);
  const base = proposalBase(workbook, file, sheet, a);
  if ('issue' in applied) return { problem: `The conversations cannot be chosen that way: ${applied.issue}` };
  if ('ask' in applied) return { proposal: { ...base, status: 'question', question: { kind: 'where', ...applied.ask }, found: applied.found } };
  const problem = readingProblem(a, applied.mapping, applied.preview, judged);
  return problem ? { problem } : { proposal: { ...base, status: 'ready', mapping: applied.mapping, preview: applied.preview, selectable: applied.selectable } };
}

type Resolved = { id: ColumnInfo; text: ColumnInfo; layout: TableMapping['layout']; where?: { column: ColumnInfo; values?: string[] } };
/** The reading's columns in its sheet: by the names Lab gives them, else as the owner names them. */
function resolve(a: SheetAnalysis, reading: CompleteReading): Resolved | { problem: string } {
  const named = columnNames(a.columns);
  const choice = reading.layout;
  const names = [reading.id, reading.text, ...choice.kind === 'message_per_row' ? [choice.role, ...choice.order === null ? [] : [choice.order]] : [],
    ...reading.where ? [reading.where.column] : []];
  const found = new Map(names.map(name => [name, named.get(name) ?? findColumn(name, a.columns)]));
  const missing = [...new Set(names.filter(name => !found.get(name)))];
  if (missing.length) return { problem: `${missing.map(quoted).join(', ')} ${missing.length === 1 ? 'is not a column' : 'are not columns'} of sheet ${quoted(a.sheet.name)}.` };
  const column = (name: string) => found.get(name)!;
  const layout: TableMapping['layout'] = choice.kind === 'dialogue_per_row'
    ? { kind: 'dialogue_per_row', ...choice.separator === null ? {} : { separator: choice.separator },
      markers: choice.markers.flatMap(item => item.role === 'text' ? [] : [{ token: item.token, role: item.role }]) }
    : { kind: 'message_per_row', role: toColumn(column(choice.role)), roles: choice.roles, ...choice.order === null ? {} : { order: toColumn(column(choice.order)) } };
  return { id: column(reading.id), text: column(reading.text), layout,
    ...reading.where ? { where: { column: column(reading.where.column), ...reading.where.values ? { values: reading.where.values } : {} } } : {} };
}

/**
 * Why the outcome of a reading shows it does not read the table, in the order a fix should take: every role value
 * decided, the conversations read, both sides present and plausible, every marker used, copies decided on. The
 * outcome is the one the mapping reads: with the copies read once when the reading drops them.
 */
function readingProblem(a: SheetAnalysis, mapping: TableMapping, preview: TablePreview, judged: RepeatJudgement | undefined): string | undefined {
  const layout = mapping.layout;
  const considered = preview.selected ?? preview.dialogues;
  if (!considered) return `No conversation is found under this reading in sheet ${quoted(a.sheet.name)}.`;
  if (layout.kind === 'message_per_row') {
    const written = new Set(a.values[layout.role.index]!.filter(Boolean));
    const decided = new Set(layout.roles.map(item => item.value));
    const foreign = [...decided].filter(value => !written.has(value));
    if (foreign.length) return `${foreign.slice(0, 12).map(quoted).join(', ')} ${foreign.length === 1 ? 'is not a value' : 'are not values'} of the role column ${quoted(layout.role.header)}: roles holds only its values.`;
    const undecided = [...written].filter(value => !decided.has(value));
    if (undecided.length) return `Values ${undecided.slice(0, 12).map(quoted).join(', ')} of the role column ${quoted(layout.role.header)} have no role in roles: give each of them one.`;
  }
  const reasons = preview.rejected.filter(item => !DATA_REASONS.has(item.reason));
  const left = reasons.reduce((sum, item) => sum + item.count, 0);
  if (left > considered * LEFT_OUT) {
    return `This reading leaves out ${left} of ${considered} conversations: ${reasons.slice(0, 5).map(item => `${quoted(item.reason)} — ${item.count}`).join('; ')}. `
      + (layout.kind === 'dialogue_per_row'
        ? 'Every conversation needs its own id of letters, digits, "_" and "-" in the id column, and a text that starts with one of the markers, with no marker right before another or at the end.'
        : 'Every message needs the id of its conversation (letters, digits, "_" and "-") in the id column, a decided role and, with an order column, a number or a time.');
  }
  const count = (role: Role) => preview.messages.filter(item => item.role === role).reduce((sum, item) => sum + item.count, 0);
  const customer = count('user'), agent = count('assistant');
  const where = layout.kind === 'dialogue_per_row' ? 'the markers and the separator' : 'the role column and its roles';
  if (!customer || !agent) return `Under this reading no message is the ${customer ? "agent's (assistant)" : "customer's (user)"}: ${customer} customer and ${agent} agent messages. Check ${where}.`;
  if (Math.min(customer, agent) < Math.max(customer, agent) * PLAUSIBLE_SIDE) {
    return `Under this reading ${customer} messages are the customer's and ${agent} the agent's: one side is read into the other side's messages. Check ${where}.`;
  }
  if (layout.kind === 'dialogue_per_row') {
    const unused = layout.markers.filter(marker => !preview.messages.some(item => item.label === marker.token));
    if (unused.length) return `${unused.map(marker => quoted(marker.token)).join(', ')} ${unused.length === 1 ? 'starts' : 'start'} no message under this reading: drop ${unused.length === 1 ? 'it' : 'them'} from markers, or fix the separator.`;
  }
  if (judged === 'none' && preview.repeats && frequentCopies(preview.repeats.dialogues, considered)) {
    return `In ${preview.repeats.dialogues} of ${considered} conversations a block of messages stands again right after itself (${preview.repeats.messages} copied messages), but repeats is "none". `
      + 'Answer "export_copies" if the export wrote exchanges again, or "said_again" if the customers really repeated themselves.';
  }
  return undefined;
}
