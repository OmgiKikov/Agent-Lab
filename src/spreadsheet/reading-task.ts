import { z } from 'zod';
import { fingerprint } from '../contracts.js';
import { sha256Schema, text } from '../ids.js';
import type { BuilderModel } from '../miner/topic-map.js';
import type { StructuredTask, TaskRunner } from '../llm/structured.js';
import type { CallContext } from '../runtime.js';
import { readExactly, type CompleteReading, type LayoutChoice } from './exact.js';
import { EVIDENCE_VERSION, REQUEST_CHARS, type TableEvidence } from './evidence.js';
import { FILTER_VALUES, LABEL_LIMIT, REPEAT_JUDGEMENTS, ROLES, tableChoicesSchema, type RepeatJudgement } from './mapping.js';
import type { TableFile, Workbook } from './workbook.js';

/*
 * Lab's model proposes how to read a spreadsheet of logs; the harness applies the proposal to every row and checks
 * it (exact.ts). The model sees the evidence (evidence.ts) and answers with names only: the sheet, columns, markers
 * and category values are enums of exactly what this table holds, the roles and the verdict on copies are fixed
 * words, and a separator is a few characters that are neither letters nor digits — no field can carry a word of a
 * conversation. The numbers of the applied reading are the task's domain check, so a reading that fails goes back
 * with the exact reason; a second failure leaves the table to Lab's own reading and the owner's numbered questions.
 */

export const TABLE_READING_ROLE = `You read the structure of a spreadsheet export of logged conversations between customers and a customer-service agent, so that a harness can read every row the same way and check it. You never see the whole table: each sheet's columns come with counts over all rows — how many cells are filled, how many distinct values, how long a cell is — the most frequent values of a column of categories, and for a column of texts the words that could mark who writes a message (uppercase words and "Label:" words at word boundaries) with how often each occurs. A few rows are shown as written, long cells cut.
Decide how to read the conversations:
- sheet: the sheet that holds them. id: the column that identifies a conversation; a row counter, a date or a category is never an id. text: the column with the text.
- layout "dialogue_per_row" when one cell holds a whole conversation and each message starts with a marker of who writes it. markers: every candidate that starts messages, with role "user" for the customer, "assistant" for the agent or bot, "system" for messages of the platform itself; leave out a candidate that is only a word inside messages (an abbreviation, a product, a part of a longer word) or give it role "text". separator: the characters the export puts between messages, such as "\`", "|" or a line break; null when messages are only joined by spaces and each starts at its marker. Characters inside messages, such as the backticks of Markdown code fences in an agent's reply, are not a separator.
- layout "message_per_row" when each row is one message: role is the column saying who writes it, roles gives each of its values a role, order is a column of message numbers or times when the rows are not already in order, else null.
- repeats: "export_copies" when the export wrote exchanges again right after themselves — the same block of messages two or more times in a row, which the harness then reads once; "said_again" when customers really repeat themselves; "none" when no block stands again right after itself.
- filter: only when ownerRequest says which conversations to evaluate: the category column and its values, exactly as listed, that select them; null when it names none.
The harness applies your reading to every row and checks it with numbers; if it fails, you get the reason and answer again. Answer with names from the evidence only: never copy text of a conversation.`;

/** One proposal and one repair: the owner agrees to this many calls before the first. */
export const READING_CALLS = 2;
/** What a stored proposal was made by: the role, what the model is shown, how often it may answer. */
export const TABLE_READING_VERSION = fingerprint({ role: TABLE_READING_ROLE, evidence: EVIDENCE_VERSION, calls: READING_CALLS });

/** A table to read: the workbook and file the check applies a reading to, and what the model is shown of them. */
export interface TableReadingRequest { workbook: Workbook; file: TableFile; evidence: TableEvidence }
/** The model's reading and its own verdict on copied exchanges, checked. */
export interface TableReadingAnswer { reading: CompleteReading; repeats: RepeatJudgement }
/** A builder model that reads tables: the Pi runtime's, or a test's with scripted replies. */
export interface TableReader { builder: BuilderModel; read(request: TableReadingRequest, ctx: CallContext): Promise<TableReadingAnswer> }

interface Answer { sheet: string; id: string; text: string; layout: LayoutChoice; repeats: RepeatJudgement; filter?: { column: string; values: string[] } | null }

const MARKER_ROLES = [...ROLES, 'text'] as const;
const isSeparatorChar = (char: string) => char.toLowerCase() === char.toUpperCase() && !(char >= '0' && char <= '9');
const separator = z.string().min(1).max(8).refine(value => [...value].every(isSeparatorChar), 'A separator holds no letters or digits: it stands between messages, it is not a word.');
const unique = (items: readonly string[]) => [...new Set(items)];

/**
 * The answer's shape for this table: every name is an enum of what the evidence holds. Undefined when the table
 * gives the model nothing to choose — no word that could mark messages and no column of categories.
 */
function answerSchema(evidence: TableEvidence): z.ZodType<Answer> | undefined {
  const columns = evidence.sheets.flatMap(sheet => sheet.columns);
  const tokens = unique(columns.flatMap(column => column.markers?.map(marker => marker.token) ?? []));
  const categories = columns.filter(column => column.values);
  const values = unique(categories.flatMap(column => column.values!.map(item => item.value)));
  const column = z.enum(unique(columns.map(item => item.name)), { error: 'Not a column of the evidence: use a column name as listed.' });
  const dialogue = z.strictObject({
    kind: z.literal('dialogue_per_row'), separator: separator.nullable(),
    markers: z.array(z.strictObject({ token: z.enum(tokens, { error: 'Not a candidate marker: use a word from the markers of the text column.' }), role: z.enum(MARKER_ROLES) })).min(2).max(LABEL_LIMIT),
  });
  const message = z.strictObject({
    kind: z.literal('message_per_row'), role: column,
    roles: z.array(z.strictObject({ value: z.enum(values, { error: 'Not a listed value: use values of the role column as listed.' }), role: z.enum(ROLES) })).min(2).max(LABEL_LIMIT),
    order: column.nullable(),
  });
  const layout = tokens.length && values.length >= 2 ? z.discriminatedUnion('kind', [dialogue, message]) : tokens.length ? dialogue : values.length >= 2 ? message : undefined;
  if (!layout) return undefined;
  const shape = { sheet: z.enum(evidence.sheets.map(sheet => sheet.name)), id: column, text: column, layout, repeats: z.enum(REPEAT_JUDGEMENTS) };
  // Which conversations to evaluate is the owner's choice: the model may name a filter only for the owner's own words.
  if (!evidence.ownerRequest || !categories.length) return z.strictObject(shape);
  return z.strictObject({ ...shape, filter: z.strictObject({
    column: z.enum(categories.map(item => item.name)),
    values: z.array(z.enum(values, { error: 'Not a listed value: use values of the filter column as listed.' })).min(1).max(FILTER_VALUES),
  }).nullable() });
}

/** Whether Lab's model has anything to choose from in this table; otherwise only Lab's own reading can be offered. */
export const canPropose = (evidence: TableEvidence): boolean => answerSchema(evidence) !== undefined;

const readingOf = (answer: Answer): CompleteReading => ({
  sheet: answer.sheet, id: answer.id, text: answer.text, layout: answer.layout, collapseRepeats: answer.repeats === 'export_copies',
  ...answer.filter ? { where: { column: answer.filter.column, values: answer.filter.values } } : {},
});

/** The task of one table: its answer's enums, and the reading applied to every row as the domain check. */
function readingTask(request: TableReadingRequest, output: z.ZodType<Answer>): StructuredTask<Answer> {
  return {
    id: 'table-reading', label: 'Как читать таблицу', role: 'builder', instructions: TABLE_READING_ROLE, output, attempts: READING_CALLS,
    check: answer => {
      const outcome = readExactly(request.workbook, request.file, readingOf(answer), answer.repeats);
      if ('problem' in outcome) return outcome.problem;
      // A filter of the model always names its values, so the owner is never asked which to keep here.
      return outcome.proposal.status === 'ready' ? undefined : 'Name the values of the filter column that select the conversations.';
    },
  };
}

/** Asks `run`'s builder model how to read the table; throws StructuredTaskError when no answer passed the checks. */
export async function readTableWithModel(request: TableReadingRequest, { run, ctx }: { run: TaskRunner; ctx: CallContext }): Promise<TableReadingAnswer> {
  const output = answerSchema(request.evidence);
  if (!output) throw new Error('В таблице нет ни слов, которыми можно отметить сообщения, ни колонки категорий: предложить разметку модели не из чего.');
  const answer = await run(readingTask(request, output), request.evidence, ctx);
  return { reading: readingOf(answer), repeats: answer.repeats };
}

const choice = tableChoicesSchema.shape;
export const completeReadingSchema = z.strictObject({
  sheet: choice.sheet.unwrap(), id: choice.id.unwrap(), text: choice.text.unwrap(),
  layout: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('dialogue_per_row'), separator: choice.separator.unwrap(), markers: choice.markers.unwrap() }),
    z.strictObject({ kind: z.literal('message_per_row'), role: choice.role.unwrap(), roles: choice.roles.unwrap(), order: choice.order.unwrap() }),
  ]),
  collapseRepeats: z.boolean(),
  where: choice.where,
});

/**
 * What Lab's model proposed for one file, stored so that the owner's next look at the same file — the command
 * repeated with --yes, the chat asked again — costs nothing: the reading and the model's verdict on copies, or why
 * no reading passed the checks. `rows` is how many rows of the table the model was shown.
 */
export const proposedReadingSchema = z.strictObject({
  formatVersion: z.literal(1),
  key: sha256Schema,
  file: z.strictObject({ name: text(260), sha256: sha256Schema }),
  model: text(300),
  version: sha256Schema,
  request: z.string().max(REQUEST_CHARS).optional(),
  rows: z.number().int().nonnegative().max(1000),
  outcome: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('read'), reading: completeReadingSchema, repeats: z.enum(REPEAT_JUDGEMENTS) }),
    z.strictObject({ kind: z.literal('failed'), reason: z.string().max(20_000) }),
  ]),
  usage: z.strictObject({ calls: z.number().int().nonnegative(), costUsd: z.number().nonnegative().nullable() }),
  createdAt: z.iso.datetime(),
});
export type ProposedReading = z.infer<typeof proposedReadingSchema>;

/** One stored proposal per file, model, version of the task and the owner's words about which conversations to evaluate. */
export const readingKey = (file: Pick<TableFile, 'sha256'>, builder: BuilderModel, request: string | undefined): string =>
  fingerprint({ file: file.sha256, model: `${builder.provider}/${builder.id}`, version: TABLE_READING_VERSION, request: request ?? null });
