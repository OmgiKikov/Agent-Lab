import type { BuilderModel } from '../miner/topic-map.js';
import { StructuredTaskError } from '../llm/structured.js';
import { countText } from '../plural.js';
import type { CallContext } from '../runtime.js';
import type { ImportBatch } from '../scenario-contracts.js';
import { ScenarioFiles } from '../scenario-store.js';
import type { ExperimentStore } from '../store.js';
import { importTable, type TablePreview } from './dialogues.js';
import { overridden, readExactly } from './exact.js';
import { rowsShown, tableEvidence } from './evidence.js';
import { readReadingFiles } from './files.js';
import { tableChoicesSchema, tableReadingSchema, type TableChoices, type TableMapping, type TableReading } from './mapping.js';
import { proposeTable, type TableProposal } from './proposal.js';
import {
  canPropose, proposedReadingSchema, READING_CALLS, readingKey, TABLE_READING_VERSION, type ProposedReading, type TableReader, type TableReadingRequest,
} from './reading-task.js';
import { readTableFile, readWorkbook, tableFileOf, type TableFile, type Workbook } from './workbook.js';

/*
 * A spreadsheet of logs becomes an import in steps, and the owner stands between them: Lab's model proposes how
 * to read the file from a few of its rows (a paid step the owner agrees to first), Lab applies the proposal to
 * every row and checks it, the owner confirms — and only then is the import stored, with the file's hash and the
 * mapping, so reading the same file again gives the very same conversations. Without a model, or when none of its
 * proposals passed the checks, Lab reads the table by itself and says so; its questions go to the owner.
 *
 *   plan (free) ──consent──► proposeReading (≤ READING_CALLS calls, stored) ──► proposeTableImport ──yes──► confirmTableImport
 */

/**
 * How Lab would read the file at `path`, with the owner's choices applied — over what Lab's model proposed for this
 * very file when it did, else by Lab's own reading. Reads only.
 */
export async function proposeTableImport(path: string, choices: TableChoices = {}, proposed?: ProposedReading): Promise<TableProposal> {
  const { file, bytes } = await readTableFile(path);
  const chosen = tableChoicesSchema.parse(choices);
  if (chosen.encoding && file.format !== 'csv') throw new Error('Кодировку задают только для CSV: таблица .xlsx хранит текст в Юникоде.');
  return proposeFrom(readWorkbook(bytes, file, chosen.encoding ? { encoding: chosen.encoding } : undefined), file, chosen, proposed);
}

function proposeFrom(workbook: Workbook, file: TableFile, chosen: TableChoices, proposed: ProposedReading | undefined): TableProposal {
  const current = proposed?.file.sha256 === file.sha256 ? proposed : undefined;
  if (current?.outcome.kind === 'read') {
    // The model's verdict on copies is checked while the copies are still its decision, not after the owner decided them.
    const judged = chosen.collapseRepeats === undefined ? current.outcome.repeats : undefined;
    const reading = overridden(current.outcome.reading, chosen);
    const exact = reading && readExactly(workbook, file, reading, judged);
    if (exact && 'proposal' in exact) return { ...exact.proposal, basis: { kind: 'model', model: current.model, key: current.key, rows: current.rows, ...judged ? { repeats: judged } : {} } };
  }
  const why = current?.outcome.kind === 'read' ? 'owner' : current?.outcome.kind === 'failed' ? 'model_failed' : 'no_model';
  return { ...proposeTable(workbook, file, chosen), basis: { kind: 'lab', why } };
}

/** What Lab's model is shown to propose a reading, and the key its proposal is stored under. */
export interface ReadingPlan { file: TableFile; request: TableReadingRequest; key: string; rows: number; words?: string }

/**
 * What Lab's model would read of `path` to propose how to read it, `words` being the owner's own about which
 * conversations to evaluate; undefined when the table gives it nothing to choose. Reads only; nothing is sent.
 */
export async function planTableReading(path: string, builder: BuilderModel, words?: string): Promise<ReadingPlan | undefined> {
  const { file, bytes } = await readTableFile(path);
  const workbook = readWorkbook(bytes, file);
  const evidence = tableEvidence(workbook, words);
  if (!canPropose(evidence)) return undefined;
  return { file, request: { workbook, file, evidence }, key: readingKey(file, builder, evidence.ownerRequest), rows: rowsShown(evidence),
    ...evidence.ownerRequest ? { words: evidence.ownerRequest } : {} };
}

const ROWS_READ: [string, string, string] = ['строку', 'строки', 'строк'];
const CALLS: [string, string, string] = ['вызова', 'вызовов', 'вызовов'];
/** The consent to the model's reading, in the owner's words: what the model reads, the most it may spend, and what follows. */
export function readingConsent(plan: ReadingPlan): { question: string; lines: string[] } {
  return {
    question: `Предложить, как читать таблицу ${plan.file.name}?`,
    lines: [`Модель Lab прочитает названия и частые значения колонок и ${countText(plan.rows, ROWS_READ)} таблицы — не больше ${countText(READING_CALLS, CALLS)} модели.`,
      'По её разметке Lab сам прочитает и проверит каждую строку; таблица загрузится, только когда вы подтвердите разметку.'],
  };
}

/**
 * Lab's model proposes how to read the planned table, within READING_CALLS calls. When no answer passes the checks
 * the proposal is kept as failed — the owner then gets Lab's own reading and questions, never a second charge.
 * A provider's failure is thrown: nothing was proposed, and nothing is kept.
 */
export async function proposeReading(plan: ReadingPlan, reader: TableReader, options: { timeoutMs: number; signal?: AbortSignal }): Promise<ProposedReading> {
  const signal = options.signal ?? new AbortController().signal;
  const usage = { calls: 0, costUsd: 0 as number | null };
  const ctx: CallContext = { signal, timeoutMs: options.timeoutMs,
    beforeCall() {
      signal.throwIfAborted();
      if (usage.calls >= READING_CALLS) throw new Error(`Разметка таблицы: больше ${countText(READING_CALLS, CALLS)} модели не согласовано.`);
      usage.calls++;
    },
    addUsage(value) { usage.costUsd = usage.costUsd === null || value.costUsd === null ? null : usage.costUsd + value.costUsd; },
  };
  let outcome: ProposedReading['outcome'];
  try {
    const answer = await reader.read(plan.request, ctx);
    outcome = { kind: 'read', reading: answer.reading, repeats: answer.repeats };
  } catch (error) {
    if (!(error instanceof StructuredTaskError)) throw error;
    outcome = { kind: 'failed', reason: error.message.slice(0, 20_000) };
  }
  return proposedReadingSchema.parse({ formatVersion: 1, key: plan.key, file: { name: plan.file.name, sha256: plan.file.sha256 },
    model: `${reader.builder.provider}/${reader.builder.id}`, version: TABLE_READING_VERSION, ...plan.words ? { request: plan.words } : {},
    rows: plan.rows, outcome, usage, createdAt: new Date().toISOString() });
}

/** The same proposal from bytes the caller already read within its own limits (project detection). */
export function proposeTableBytes(path: string, bytes: Buffer): TableProposal {
  const file = tableFileOf(path, bytes);
  return proposeTable(readWorkbook(bytes, file), file);
}

/** The conversations of a file read with a mapping: an ordinary import and what the owner is shown about it. */
function readWithMapping(bytes: Buffer, file: TableFile, mapping: TableMapping): { batch: ImportBatch; preview: TablePreview } {
  const source = mapping.source;
  const workbook = readWorkbook(bytes, file, source.format === 'csv' ? { delimiter: source.delimiter, encoding: source.encoding } : undefined);
  const sheet = source.format === 'xlsx' ? workbook.sheets.find(item => item.name === source.sheet) : workbook.sheets[0];
  if (!sheet) throw new Error(`В файле «${file.name}» нет листа «${source.format === 'xlsx' ? source.sheet : file.name}».`);
  return importTable(sheet, mapping);
}

/**
 * Stores the import the owner confirmed. Only the host calls this, after the owner said yes to exactly
 * this proposal: the file must still be the one the proposal was made from.
 */
export async function confirmTableImport(store: ExperimentStore, path: string, proposal: TableProposal): Promise<{ batch: ImportBatch; reading: TableReading }> {
  if (proposal.status !== 'ready') throw new Error('Как читать таблицу, ещё не решено: сначала ответьте на вопрос Lab.');
  const { file, bytes } = await readTableFile(path);
  if (file.sha256 !== proposal.file.sha256) throw new Error(`Файл «${file.name}» изменился после того, как Lab показал разметку. Посмотрите её заново.`);
  const { batch, preview } = readWithMapping(bytes, file, proposal.mapping);
  if (!batch.dialogues.length) throw new Error('Загружать нечего: ни один разговор из таблицы не подошёл.');
  const reading = tableReadingSchema.parse({ file, mapping: proposal.mapping, confirmedAt: new Date().toISOString(),
    sheet: { dialogues: preview.dialogues, ...preview.selected === undefined ? {} : { selected: preview.selected }, usable: preview.usable, taken: preview.taken, rejected: preview.rejected,
      ...proposal.mapping.collapseRepeats && preview.repeats ? { repeats: preview.repeats } : {} },
    ...proposal.basis ? { proposedBy: proposal.basis } : {} });
  return { batch: await store.writeTableImport(await keptImport(store, batch), reading), reading };
}

/**
 * The import the data folder already keeps for the same conversations, else `batch`: the same rows read again by a
 * newer reading of them — the table of masks, a sample's record — stay the import situations were made from.
 */
async function keptImport(store: Pick<ExperimentStore, 'readImport'>, batch: ImportBatch): Promise<ImportBatch> {
  const stored = await store.readImport(batch.id).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
  return stored?.contentHash === batch.contentHash ? stored : batch;
}

/**
 * The import of a spreadsheet under the reading its owner confirmed last, from the data folder `directory`.
 * The same file gives the same import; a file never confirmed is refused, never guessed.
 */
export async function readConfirmedTable(path: string, directory: string): Promise<ImportBatch> {
  const { file, bytes } = await readTableFile(path);
  const confirmed = (await readReadingFiles(directory))
    .flatMap(entry => entry.readings.filter(reading => reading.file.sha256 === file.sha256).map(reading => ({ entry, reading })))
    .sort((a, b) => b.reading.confirmedAt.localeCompare(a.reading.confirmedAt) || a.entry.importId.localeCompare(b.entry.importId))[0];
  if (!confirmed) throw new Error(`Как читать таблицу «${file.name}», ещё не подтверждено: посмотрите разметку и подтвердите её (agent-lab import --file ${path}).`);
  const { batch } = readWithMapping(bytes, file, confirmed.reading.mapping);
  if (batch.id !== confirmed.entry.importId || batch.contentHash !== confirmed.entry.contentHash) {
    throw new Error(`Таблица «${file.name}» прочиталась не так, как при подтверждении. Подтвердите разметку заново.`);
  }
  return keptImport(new ScenarioFiles(directory), batch);
}
