import { isIdentifier } from '../ids.js';
import { countText } from '../plural.js';
import { analyzeSheet, filledValues, isNumeric, type SheetAnalysis } from './analysis.js';
import type { CsvDialect } from './csv.js';
import { importTable, parseOrder, type TablePreview } from './dialogues.js';
import { readExactly } from './exact.js';
import {
  LABEL_LIMIT, columnLabel, findColumn, tableChoicesSchema, tableMappingSchema, toColumn,
  type ColumnInfo, type ExpectedKind, type ReadingBasis, type Role, type TableChoices, type TableLayout, type TableMapping,
} from './mapping.js';
import { boundaryCounts, detectMarkers, type MarkerStructure } from './markers.js';
import { frequentCopies } from './repeats.js';
import { conversationRows, selectableColumns, whereOutcome, type ValueCount } from './selection.js';
import type { Sheet } from './sheet.js';
import type { TableFile, Workbook } from './workbook.js';

/*
 * Lab's own reading of a spreadsheet of logs, by the frequencies of its words and values — the fallback when no
 * model is configured, when none of the model's proposals passed the checks, or when the owner's changes leave the
 * model's reading (import.ts); Lab's model proposes the reading otherwise (reading-task.ts, exact.ts). Either way the
 * owner confirms — nothing is read silently. Every choice comes from the data: the text column whose cells are led
 * by role markers, or the column of a few role values; the id column whose values identify conversations. A choice
 * the owner made is checked against the data and refused with the reason when it cannot be right. What Lab cannot
 * settle alone (a marker it does not know) becomes one question. Which conversations to evaluate is the owner's
 * alone: Lab offers the columns of categories, and a column the owner names asks which of its values to keep. So is
 * dropping exchanges an export copied: Lab asks once when copies are frequent, never drops them itself. The proposal
 * is the typed value the chat question and the command line both render.
 */

/** The one thing Lab asks before it can propose a complete reading. */
export type TableQuestion =
  /** Lab found no conversations: which column holds their text? */
  | { kind: 'text'; columns: ColumnInfo[] }
  /** Which column identifies a conversation? */
  | { kind: 'id'; columns: ColumnInfo[] }
  /** One question per row: which column holds the assessor's expected result — an answer, an article id, an answer code — or none? */
  | { kind: 'expected'; columns: { column: ColumnInfo; kinds: ExpectedKind[] }[] }
  /** Who writes the messages this marker starts in the text column: клиент, агент, служебное — or is it not a marker? */
  | { kind: 'marker'; column: ColumnInfo; token: string; messages: number }
  /** Who writes the messages with this value in the role column? */
  | { kind: 'role'; column: ColumnInfo; value: string; messages: number }
  /**
   * Какие разговоры оценивать? The most frequent values of the column the owner chose, each with its conversations, the
   * most first; `more` values are not listed, and the owner names one of those in words. The answer is one or several values.
   */
  | { kind: 'where'; column: ColumnInfo; values: ValueCount[]; more: number }
  /**
   * В N из M разговоров один и тот же обмен повторяется подряд — убрать повторы? `dialogues` of the `of` conversations
   * considered hold a block of messages again right after itself; `messages` are such copies.
   */
  | { kind: 'repeats'; dialogues: number; of: number; messages: number };

interface ProposalBase {
  file: TableFile;
  /** Every sheet of the workbook; the file itself for CSV. */
  sheets: string[];
  sheet: string;
  csv?: CsvDialect;
  /** The header row as the owner counts rows (1 is the first). */
  headerRow: number;
  columns: ColumnInfo[];
  /** Who proposed the reading: set by the import (import.ts) for what the owner is shown; Lab's own reading alone (detection) carries none. */
  basis?: ReadingBasis;
}
export type TableProposal = ProposalBase & (
  /** `selectable`: the columns of categories the conversations could be chosen by (selection.ts). */
  | { status: 'ready'; mapping: TableMapping; preview: TablePreview; selectable: ColumnInfo[] }
  /** `found`: conversations Lab already sees in the sheet. */
  | { status: 'question'; question: TableQuestion; found: number }
  | { status: 'refused'; choice: keyof TableChoices; reason: string });

type Outcome = { mapping: Omit<TableMapping, 'version' | 'source' | 'headerRow'> } | { question: TableQuestion; found: number } | { refused: keyof TableChoices; reason: string };

/** A share of the rows below the header: an id or role column is filled nearly everywhere, a text column at least in half the rows. */
const FILLED = 0.9;
const TEXT_FILLED = 0.5;
/** Ids of the import's shape (letters, digits, `_`, `-`): nearly all values of an id column have it. */
const ID_SHAPE = 0.9;
/** Below this share of distinct values an id column repeats too much to name conversations one per row; a few repeats are rejected row by row. */
const UNIQUE = 0.9;
/** An order column Lab proposes itself agrees with the order of the rows in nearly every conversation. */
const ORDER_AGREES = 0.9;
/** A role value longer than this is text, not a role. */
const ROLE_CHARS = 40;
/** Role words exports use. Lab proposes them; the owner confirms. Anything else is asked. */
const KNOWN_ROLES: ReadonlyMap<string, Role> = new Map([
  ...['client', 'customer', 'user', 'human', 'клиент', 'пользователь', 'абонент'].map(word => [word, 'user'] as const),
  ...['agent', 'bot', 'assistant', 'ai', 'агент', 'бот', 'ассистент'].map(word => [word, 'assistant'] as const),
  ...['system', 'система'].map(word => [word, 'system'] as const),
]);
const knownRole = (label: string): Role | undefined => KNOWN_ROLES.get(label.trim().toLowerCase());

const quoted = (text: string) => `«${text}»`;

/** Proposes how to read `workbook`, honouring the owner's `choices`; the proposal says what is ready, what is asked, or what is refused and why. */
export function proposeTable(workbook: Workbook, file: TableFile, choices: TableChoices = {}): TableProposal {
  const chosen = tableChoicesSchema.parse(choices);
  if (!workbook.sheets.length) throw new Error('В книге нет листов с ячейками.');
  const analyses = new Map<Sheet, Analysis>();
  const analysisOf = (sheet: Sheet) => { let found = analyses.get(sheet); if (!found) analyses.set(sheet, found = analyze(sheet)); return found; };
  const wanted = chosen.sheet;
  const named = wanted === undefined ? undefined : workbook.sheets.find(sheet => sheet.name === wanted) ?? workbook.sheets.find(sheet => sheet.name.toLowerCase() === wanted.toLowerCase());
  // The sheet with conversations, the fullest first; otherwise the fullest sheet.
  const sheet = named ?? workbook.sheets.map(item => ({ sheet: item, structure: hasStructure(analysisOf(item)), rows: analysisOf(item).rows.length }))
    .sort((x, y) => Number(y.structure) - Number(x.structure) || y.rows - x.rows)[0]!.sheet;
  const analysis = analysisOf(sheet);
  const base: ProposalBase = { file, sheets: workbook.sheets.map(item => item.name), sheet: sheet.name, ...workbook.csv ? { csv: workbook.csv } : {}, headerRow: analysis.header + 1, columns: analysis.columns };
  if (wanted !== undefined && !named) return { ...base, status: 'refused', choice: 'sheet', reason: `Листа ${quoted(wanted)} нет. Есть: ${base.sheets.map(quoted).join(', ')}.` };
  if (!analysis.rows.length) return { ...base, status: 'refused', choice: 'sheet', reason: `В листе ${quoted(sheet.name)} нет строк под заголовком.` };
  if (chosen.perRow === 'question' || chosen.answer !== undefined) return questionTable(workbook, file, sheet, chosen, base);
  const outcome = decide(analysis, chosen);
  // A column the owner named that holds no conversation marked message by message holds one question per row.
  const textColumn = chosen.text ? findColumn(chosen.text, analysis.columns) : undefined;
  if ('refused' in outcome && outcome.refused === 'text' && textColumn && !isNumeric(analysis, textColumn) && chosen.markers === undefined && chosen.separator === undefined) {
    return questionTable(workbook, file, sheet, { ...chosen, perRow: 'question' }, base);
  }
  if ('refused' in outcome) return { ...base, status: 'refused', choice: outcome.refused, reason: outcome.reason };
  if ('question' in outcome) return { ...base, status: 'question', question: outcome.question, found: outcome.found };
  const reading = tableMappingSchema.parse({ version: 1, source: workbook.csv ? { format: 'csv', ...workbook.csv } : { format: 'xlsx', sheet: sheet.name },
    headerRow: analysis.header + 1, ...outcome.mapping });
  const conversations = conversationRows(sheet, reading, analysis.rows);
  // decide() refused a column that is not there.
  const where = chosen.where && { column: findColumn(chosen.where.column, analysis.columns)!, ...chosen.where.values ? { values: chosen.where.values } : {} };
  const selection = whereOutcome(sheet, reading, conversations, where);
  if ('issue' in selection) return { ...base, status: 'refused', choice: 'where', reason: selection.issue };
  if ('ask' in selection) return { ...base, status: 'question', question: { kind: 'where', ...selection.ask }, found: conversations.length };
  const asWritten = selection.filter ? tableMappingSchema.parse({ ...reading, filter: selection.filter }) : reading;
  const preview = importTable(sheet, asWritten).preview;
  // Copies are counted over the conversations the owner chose; frequent ones become the question, and only the owner's yes drops them.
  const considered = preview.selected ?? preview.dialogues;
  if (chosen.collapseRepeats === undefined && preview.repeats && frequentCopies(preview.repeats.dialogues, considered)) {
    return { ...base, status: 'question', question: { kind: 'repeats', ...preview.repeats, of: considered }, found: considered };
  }
  const mapping = chosen.collapseRepeats ? tableMappingSchema.parse({ ...asWritten, collapseRepeats: true }) : asWritten;
  return { ...base, status: 'ready', mapping, preview: mapping === asWritten ? preview : importTable(sheet, mapping).preview,
    selectable: selectableColumns(sheet, reading, conversations, analysis.columns) };
}

/**
 * One case per row, as the owner said: their columns read exactly, with the same checks as a reading Lab's model
 * proposed. Lab guesses nothing here — the question column is the owner's to name.
 */
function questionTable(workbook: Workbook, file: TableFile, sheet: Sheet, chosen: TableChoices, base: ProposalBase): TableProposal {
  if (!chosen.text) return { ...base, status: 'refused', choice: 'text', reason: 'Назовите колонку с вопросом клиента: одна строка — один вопрос.' };
  if (chosen.expected === undefined) {
    const a = analyzeSheet(sheet);
    const taken = new Set([chosen.text, chosen.answer, chosen.id, chosen.where?.column].flatMap(name => name ? [findColumn(name, a.columns)?.index] : []));
    const columns = a.columns.filter(column => column.filled && !taken.has(column.index)).slice(0, 12).map(column => ({ column, kinds: expectedKinds(a, column) }));
    if (columns.length) return { ...base, status: 'question', question: { kind: 'expected', columns }, found: a.rows.length };
  }
  const outcome = readExactly(workbook, file, { sheet: sheet.name, id: chosen.id ?? null, text: chosen.text,
    layout: { kind: 'question_per_row', answer: chosen.answer ?? null }, collapseRepeats: false,
    ...chosen.where ? { where: chosen.where } : {}, ...chosen.expected?.length ? { expected: chosen.expected } : {} });
  return 'proposal' in outcome ? outcome.proposal as TableProposal : { ...base, status: 'refused', choice: 'text', reason: outcome.problem };
}

/** What a column of the assessor's markup may hold: short single-word values are an article id or an answer code, anything longer an expected answer. */
function expectedKinds(a: SheetAnalysis, column: ColumnInfo): ExpectedKind[] {
  const values = filledValues(a, column);
  return values.length && values.every(value => value.length <= 40 && !/\s/.test(value.trim())) ? ['article', 'code'] : ['answer'];
}

/** A sheet as Lab's own reading sees it: the shared analysis, and the marker structure of each column once it was looked for. */
interface Analysis extends SheetAnalysis {
  markers: Map<number, MarkerStructure | undefined>;
}
const analyze = (sheet: Sheet): Analysis => ({ ...analyzeSheet(sheet), markers: new Map() });

const label = (column: ColumnInfo) => quoted(columnLabel(column));

/** The marker structure of a column's texts, with the owner's separator when given (null: none between messages). */
function structureOf(a: Analysis, column: ColumnInfo, separator?: string | null): MarkerStructure | undefined {
  const texts = filledValues(a, column);
  if (texts.length < a.rows.length * TEXT_FILLED) return undefined;
  if (separator === undefined && !a.markers.has(column.index)) a.markers.set(column.index, detectMarkers(texts));
  const structure = separator === undefined ? a.markers.get(column.index) : detectMarkers(texts, separator);
  return structure && structure.led >= texts.length / 2 ? structure : undefined;
}

/** The column whose texts hold the most messages led by markers. */
function markerColumn(a: Analysis, separator?: string | null): { column: ColumnInfo; structure: MarkerStructure } | undefined {
  let best: { column: ColumnInfo; structure: MarkerStructure; messages: number } | undefined;
  for (const column of a.columns) {
    const structure = structureOf(a, column, separator);
    const messages = structure?.markers.reduce((sum, marker) => sum + marker.messages, 0) ?? 0;
    if (structure && messages > (best?.messages ?? 0)) best = { column, structure, messages };
  }
  return best;
}

/** Why a column cannot tell who writes a message; undefined when it can. */
function roleColumnIssue(a: Analysis, column: ColumnInfo): string | undefined {
  if (column.distinct > LABEL_LIMIT) return `В колонке ${label(column)} ${countText(column.distinct, ['разное значение', 'разных значения', 'разных значений'])} — это не роль того, кто пишет.`;
  if (column.filled && isNumeric(a, column)) return `В колонке ${label(column)} числа или даты — это не роль того, кто пишет.`;
  if (column.distinct < 2) return `В колонке ${label(column)} ${column.distinct ? 'одно значение' : 'нет значений'} — по ней не отличить клиента от агента.`;
  if (filledValues(a, column).some(value => value.length > ROLE_CHARS)) return `В колонке ${label(column)} длинные тексты — это не роль того, кто пишет.`;
  return undefined;
}

/** Columns that could hold who writes each message, the one naming the most known roles first. */
function roleColumns(a: Analysis): ColumnInfo[] {
  const known = (column: ColumnInfo) => new Set(filledValues(a, column).filter(value => knownRole(value))).size;
  return a.columns.filter(column => column.filled >= a.rows.length * FILLED && !roleColumnIssue(a, column) && known(column) > 0)
    .sort((x, y) => known(y) - known(x) || x.distinct - y.distinct || x.index - y.index);
}

const hasStructure = (a: Analysis) => a.rows.length > 0 && (markerColumn(a) !== undefined || roleColumns(a).length > 0);

function decide(a: Analysis, c: TableChoices): Outcome {
  const markersWanted = c.markers !== undefined || c.separator !== undefined;
  const rolesWanted = c.role !== undefined || c.roles !== undefined || c.order !== undefined;
  if (markersWanted && rolesWanted) return { refused: 'role', reason: 'Выберите одно: метки ролей в тексте разговора или колонку с ролью того, кто пишет.' };
  for (const [key, name] of [['id', c.id], ['text', c.text], ['role', c.role], ['order', c.order], ['where', c.where?.column]] as const) {
    if (name && !findColumn(name, a.columns)) return { refused: key, reason: `Колонки ${quoted(name)} нет в листе ${quoted(a.sheet.name)}. Есть: ${a.columns.filter(column => column.filled).map(label).join(', ')}.` };
  }
  if (markersWanted) return rowLayout(a, c);
  if (rolesWanted) return messageLayout(a, c);
  const text = c.text ? findColumn(c.text, a.columns)! : undefined;
  if (text ? structureOf(a, text) : markerColumn(a)) return rowLayout(a, c);
  if (roleColumns(a).length) return messageLayout(a, c);
  if (text) return { refused: 'text', reason: noMarkers(text) };
  return { question: { kind: 'text', columns: textColumns(a) }, found: 0 };
}

const noMarkers = (column: ColumnInfo) => `В колонке ${label(column)} нет разговоров: строки не начинаются с метки роли — слова заглавными буквами, вроде CLIENT или AGENT.`;
/** Why the owner's separator — or the owner's word that there is none — does not read the column `column`, or any column. */
const noSeparated = (separator: string | null, column?: ColumnInfo) => separator === null
  ? `${column ? `В колонке ${label(column)}` : 'Ни в одной колонке'} нет разговоров из нескольких сообщений, каждое из которых начинается с метки роли.`
  : `${column ? `В колонке ${label(column)}` : 'Ни в одной колонке'} сообщения не отделены знаком ${quoted(separator)} с меткой роли после него.`;
/** Columns that may hold text, the longest texts first: numbers and dates are not messages. */
const textColumns = (a: Analysis) => a.columns.filter(column => column.filled && !isNumeric(a, column))
  .map(column => ({ column, length: filledValues(a, column).reduce((sum, value) => sum + value.length, 0) / column.filled }))
  .sort((x, y) => y.length - x.length).slice(0, 10).map(item => item.column);

/** One conversation per row: the text column and its markers, then the id column. */
function rowLayout(a: Analysis, c: TableChoices): Outcome {
  let text: ColumnInfo, structure: MarkerStructure | undefined;
  if (c.text) {
    text = findColumn(c.text, a.columns)!;
    structure = structureOf(a, text, c.separator);
    if (!structure) return { refused: c.separator === undefined ? 'text' : 'separator', reason: c.separator === undefined ? noMarkers(text) : noSeparated(c.separator, text) };
  } else {
    const found = markerColumn(a, c.separator);
    if (!found) return c.separator === undefined ? { question: { kind: 'text', columns: textColumns(a) }, found: 0 } : { refused: 'separator', reason: noSeparated(c.separator) };
    ({ column: text, structure } = found);
  }
  const texts = filledValues(a, text);
  const decided = new Map(c.markers?.map(item => [item.token, item.role]));
  const named = [...decided.keys()].filter(token => decided.get(token) !== 'text');
  const counts = boundaryCounts(texts, structure.separator, [...structure.markers.map(item => item.token), ...named]);
  const missing = named.find(token => !counts.get(token));
  if (missing) return { refused: 'markers', reason: `Метка ${quoted(missing)} не встречается в начале сообщений колонки ${label(text)}.` };
  const tokens = [...new Set([...structure.markers.map(item => item.token), ...named])].filter(token => decided.get(token) !== 'text');
  if (tokens.length > LABEL_LIMIT) return { refused: 'markers', reason: `Меток больше ${LABEL_LIMIT} — так не размечают, кто пишет. Укажите метки сами.` };
  const markers: { token: string; role: Role }[] = [];
  for (const token of tokens) {
    const role = decided.get(token) ?? knownRole(token);
    if (role === undefined) return { question: { kind: 'marker', column: text, token, messages: counts.get(token) ?? 0 }, found: texts.length };
    if (role !== 'text') markers.push({ token, role });
  }
  const who = missingParty(markers.map(item => item.role), 'какой меткой');
  if (who) return { refused: 'markers', reason: who };
  const id = c.id ? findColumn(c.id, a.columns)! : rowIdColumns(a, text)[0];
  if (!id) return { question: { kind: 'id', columns: idOptions(a, [text]) }, found: texts.length };
  const why = rowIdIssue(a, id, text);
  if (why) return { refused: 'id', reason: why };
  const layout: TableLayout = { kind: 'dialogue_per_row', ...structure.separator === undefined ? {} : { separator: structure.separator }, markers };
  return { mapping: { id: toColumn(id), text: toColumn(text), layout } };
}

/** One message per row: the role column, the id column that groups messages, the text, the order, then who each role value is. */
function messageLayout(a: Analysis, c: TableChoices): Outcome {
  const role = c.role ? findColumn(c.role, a.columns)! : roleColumns(a)[0];
  if (!role) return { refused: 'role', reason: 'В листе нет колонки с ролью того, кто пишет: в ней два-три коротких значения вроде «клиент» и «бот».' };
  const roleIssue = roleColumnIssue(a, role);
  if (roleIssue) return { refused: 'role', reason: roleIssue };
  const id = c.id ? findColumn(c.id, a.columns)! : groupIdColumns(a, [role])[0];
  if (!id) return { question: { kind: 'id', columns: idOptions(a, [role]) }, found: a.rows.length };
  const idIssue = id.index === role.index ? `Колонка ${label(id)} уже выбрана как роль.` : groupIdIssue(a, id);
  if (idIssue) return { refused: 'id', reason: idIssue };
  const text = c.text ? findColumn(c.text, a.columns)! : textColumns(a).find(column => column.index !== id.index && column.index !== role.index);
  if (!text) return { question: { kind: 'text', columns: textColumns(a) }, found: id.distinct };
  const textIssue = [id.index, role.index].includes(text.index) ? `Колонка ${label(text)} уже выбрана как ${text.index === id.index ? 'id разговора' : 'роль'}.`
    : isNumeric(a, text) ? `В колонке ${label(text)} числа или даты, а не текст сообщений.` : undefined;
  if (textIssue) return { refused: 'text', reason: textIssue };
  let order: ColumnInfo | undefined;
  if (c.order) {
    order = findColumn(c.order, a.columns)!;
    const orderIssue = [id.index, role.index, text.index].includes(order.index) ? `Колонка ${label(order)} уже выбрана для другого.`
      : !orderKind(a, order) ? `В колонке ${label(order)} не числа и не даты — по ней нельзя упорядочить сообщения.` : undefined;
    if (orderIssue) return { refused: 'order', reason: orderIssue };
  } else if (c.order === undefined) order = orderColumn(a, id, [id.index, role.index, text.index]);
  const counts = new Map<string, number>();
  for (const value of filledValues(a, role)) counts.set(value, (counts.get(value) ?? 0) + 1);
  const decided = new Map(c.roles?.map(item => [item.value, item.role]));
  const absent = [...decided.keys()].find(value => !counts.has(value));
  if (absent) return { refused: 'roles', reason: `В колонке ${label(role)} нет значения ${quoted(absent)}.` };
  const roles: { value: string; role: Role }[] = [];
  for (const [value, messages] of [...counts].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))) {
    const decision = decided.get(value) ?? knownRole(value);
    if (!decision) return { question: { kind: 'role', column: role, value, messages }, found: id.distinct };
    roles.push({ value, role: decision });
  }
  const who = missingParty(roles.map(item => item.role), 'каким значением');
  if (who) return { refused: 'roles', reason: who };
  const layout: TableLayout = { kind: 'message_per_row', role: toColumn(role), roles, ...order ? { order: toColumn(order) } : {} };
  return { mapping: { id: toColumn(id), text: toColumn(text), layout } };
}

function missingParty(roles: Role[], by: 'какой меткой' | 'каким значением'): string | undefined {
  if (!roles.includes('user')) return `Не видно сообщений клиента: укажите, ${by} они отмечены.`;
  if (!roles.includes('assistant')) return `Не видно сообщений агента: укажите, ${by} они отмечены.`;
  return undefined;
}

const idShaped = (a: Analysis, column: ColumnInfo) => filledValues(a, column).filter(isIdentifier).length >= column.filled * ID_SHAPE;

/** Why a column cannot name conversations one per row; undefined when it can. */
function rowIdIssue(a: Analysis, column: ColumnInfo, text: ColumnInfo): string | undefined {
  if (column.index === text.index) return `Колонка ${label(column)} уже выбрана как текст разговора.`;
  if (!column.filled) return `Колонка ${label(column)} пустая.`;
  if (!idShaped(a, column)) return badIds(column);
  if (column.distinct < column.filled * UNIQUE) return `В колонке ${label(column)} значения повторяются: ${countText(column.distinct, ['разное значение', 'разных значения', 'разных значений'])} на ${countText(column.filled, ['строку', 'строки', 'строк'])} — это не id разговора.`;
  return undefined;
}
const badIds = (column: ColumnInfo) => `Значения колонки ${label(column)} не годятся как id разговора: нужны латинские буквы, цифры, «_» и «-», до 80 знаков.`;

/** Why a column cannot group messages into conversations; undefined when it can. */
function groupIdIssue(a: Analysis, column: ColumnInfo): string | undefined {
  if (!column.filled) return `Колонка ${label(column)} пустая.`;
  if (!idShaped(a, column)) return badIds(column);
  if (column.filled > 2 && column.distinct === column.filled) return `В колонке ${label(column)} у каждой строки своё значение — тогда в каждом разговоре одно сообщение. Нужна колонка с id разговора.`;
  return undefined;
}

/**
 * Candidates for a one-per-row id: filled wherever there is a conversation text (a note under the table has
 * neither), id-shaped, nearly unique; a header naming an id first, a row counter (1, 2, 3…) last.
 */
function rowIdColumns(a: Analysis, text: ColumnInfo): ColumnInfo[] {
  return a.columns.filter(column => column.index !== text.index && column.filled >= text.filled * FILLED && column.distinct >= column.filled * UNIQUE && idShaped(a, column))
    .sort((x, y) => Number(namesId(y.header)) - Number(namesId(x.header)) || Number(isCounter(a, x)) - Number(isCounter(a, y)) || x.index - y.index);
}

/**
 * Candidates for the id that groups messages: filled, id-shaped, repeating. A header naming an id comes first,
 * then the column whose values keep their rows together (a message counter 1, 2, 3 restarts in every
 * conversation), then the one naming more conversations.
 */
function groupIdColumns(a: Analysis, taken: ColumnInfo[]): ColumnInfo[] {
  const together = new Map(a.columns.map(column => [column.index, contiguity(a.values[column.index]!)]));
  return a.columns.filter(column => !taken.some(other => other.index === column.index) && column.filled >= a.rows.length * FILLED && column.distinct < column.filled && idShaped(a, column))
    .sort((x, y) => Number(namesId(y.header)) - Number(namesId(x.header)) || together.get(y.index)! - together.get(x.index)! || y.distinct - x.distinct || x.index - y.index);
}

/** The share of a column's values whose rows form one unbroken run. */
function contiguity(values: readonly string[]): number {
  const runs = new Map<string, number>();
  values.forEach((value, i) => { if (value && value !== values[i - 1]) runs.set(value, (runs.get(value) ?? 0) + 1); });
  return runs.size ? [...runs.values()].filter(count => count === 1).length / runs.size : 0;
}

const idOptions = (a: Analysis, taken: ColumnInfo[]) => {
  const free = a.columns.filter(column => column.filled && !taken.some(other => other.index === column.index));
  const shaped = free.filter(column => idShaped(a, column));
  return (shaped.length ? shaped : free).sort((x, y) => y.distinct - x.distinct).slice(0, 10);
};

/** 1, 2, 3… down the rows: a row number the export added, not an id of the conversation. */
function isCounter(a: Analysis, column: ColumnInfo): boolean {
  const numbers = filledValues(a, column).map(Number);
  let steps = 0;
  for (let i = 1; i < numbers.length; i++) if (numbers[i] === numbers[i - 1]! + 1) steps++;
  return numbers.length > 2 && steps >= (numbers.length - 1) * 0.9;
}

/** Whether a header names an identifier: «Id диалога», «dialog_id», «SessionId», «Идентификатор». Only breaks ties between columns the data already qualifies. */
function namesId(header: string): boolean {
  const words: string[] = [];
  let word = '';
  for (const char of header) {
    const letter = char.toLowerCase() !== char.toUpperCase(), digit = char >= '0' && char <= '9';
    if (!letter && !digit) { if (word) words.push(word); word = ''; continue; }
    // SessionId: a capital after a small letter starts a word.
    if (word && letter && char === char.toUpperCase() && word.at(-1)! !== word.at(-1)!.toUpperCase()) { words.push(word); word = ''; }
    word += char;
  }
  if (word) words.push(word);
  return words.some(item => ['id', 'ид'].includes(item.toLowerCase()) || item.toLowerCase().startsWith('идентификатор'));
}

/** The one kind of an order column's values (numbers or dates), when nearly all of them have it. */
function orderKind(a: Analysis, column: ColumnInfo): 'number' | 'date' | undefined {
  const parsed = filledValues(a, column).map(parseOrder);
  const kinds = new Set(parsed.map(item => item?.kind));
  const kind = kinds.size === 1 ? [...kinds][0] : undefined;
  return column.filled >= a.rows.length * FILLED && kind ? kind : undefined;
}

/**
 * An order column Lab proposes itself only when it agrees with the rows in nearly every conversation: it
 * then settles ties and the odd row out, and can never reorder a log against the sheet. Otherwise messages
 * follow the rows, and the owner may name a column.
 */
function orderColumn(a: Analysis, id: ColumnInfo, taken: number[]): ColumnInfo | undefined {
  const groups = new Map<string, number[]>();
  a.values[id.index]!.forEach((value, i) => { if (!value) return; const group = groups.get(value); if (group) group.push(i); else groups.set(value, [i]); });
  const conversations = [...groups.values()].filter(group => group.length > 1);
  return a.columns.filter(column => !taken.includes(column.index) && orderKind(a, column)).find(column => {
    const position = (row: number) => parseOrder(a.values[column.index]![row]!)?.value ?? NaN;
    // Strictly increasing down the rows; a missing value (NaN) never compares as greater.
    const agrees = conversations.filter(group => group.every((row, i) => i === 0 || position(row) > position(group[i - 1]!))).length;
    return conversations.length > 0 && agrees >= conversations.length * ORDER_AGREES;
  });
}
