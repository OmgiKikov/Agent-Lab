import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ImportBatch } from '../src/scenario-contracts.js';
import type { ExperimentStore } from '../src/store.js';
import { questionAnswers, withAnswer } from '../src/spreadsheet/answers.js';
import { readReadingFiles } from '../src/spreadsheet/files.js';
import { confirmTableImport, planTableReading, proposeReading, proposeTableImport, readingConsent } from '../src/spreadsheet/import.js';
import { importedLine, proposalLines } from '../src/spreadsheet/lines.js';
import type { TableChoices } from '../src/spreadsheet/mapping.js';
import type { ProposedReading, TableReader } from '../src/spreadsheet/reading-task.js';
import { readTableFile } from '../src/spreadsheet/workbook.js';
import { fingerprint } from '../src/contracts.js';
import { safeText } from '../src/text.js';
import { ask } from './lab-ui.ts';

/*
 * A spreadsheet of logs in the chat: Lab's model proposes how to read it after the owner's native consent to its
 * one or two calls, and Lab applies the proposal to every row and checks it; a question neither can settle becomes
 * one native numbered choice; the whole reading is shown once more and only the owner's «Прочитать так» stores the
 * import. The host calls confirmTableImport, never the model; the chat's model only names the file and, when the
 * owner said so in words, the sheet, a column, the copies, or which conversations to evaluate — the column (and
 * values) when the owner named them, else the owner's own words for Lab's model to find them by.
 *
 *   consent ──► the model proposes (stored) ──► reading ──question──► native choice ──► reading again … ──ready──► «Прочитать так?» ──► stored
 */

/** What became of the table: its import, or why there is none — the owner stepped back, or the file cannot be read that way. */
export type TableImport = { batch: ImportBatch; line: string } | { declined: true } | { refused: string };
/** Lab's model for the reading, and the owner's words about which conversations to evaluate, when they said any. */
export interface TableModel { reader: TableReader; timeoutMs: number; signal?: AbortSignal; words?: string }

/** Whether the owner has already confirmed a reading of this very file (the same bytes) in the data folder `directory`. */
export async function confirmedBefore(path: string, directory: string): Promise<boolean> {
  const { file } = await readTableFile(path);
  return (await readReadingFiles(directory)).some(entry => entry.readings.some(reading => reading.file.sha256 === file.sha256));
}

/** What Lab's model proposed for `path`: stored before, or asked now after the owner's consent; `declined` when the owner said no, undefined when the table gives the model nothing to choose. */
async function modelProposal(ctx: Pick<ExtensionContext, 'ui'>, store: ExperimentStore, path: string, model: TableModel): Promise<ProposedReading | 'declined' | undefined> {
  const plan = await planTableReading(path, model.reader.builder, model.words);
  if (!plan) return undefined;
  const stored = await store.readProposedReading(plan.key);
  if (stored) return stored;
  const consent = readingConsent(plan);
  if (!await ask(ctx, consent.question, consent.lines, 'Предложить')) return 'declined';
  const proposed = await proposeReading(plan, model.reader, { timeoutMs: model.timeoutMs, ...model.signal ? { signal: model.signal } : {} });
  await store.writeProposedReading(proposed);
  return proposed;
}

/** Asks the owner how to read `path` and stores the import they confirm; `choices` are the owner's corrections said in words. */
export async function importTable(ctx: Pick<ExtensionContext, 'ui'>, store: ExperimentStore, path: string, choices: TableChoices = {}, model?: TableModel): Promise<TableImport> {
  const proposed = model ? await modelProposal(ctx, store, path, model) : undefined;
  if (proposed === 'declined') return { declined: true };
  let current = choices;
  const asked = new Set<string>();
  while (true) {
    const proposal = await proposeTableImport(path, current, proposed);
    if (proposal.status === 'refused') return { refused: proposal.reason };
    if (proposal.status === 'ready') {
      if (!await ask(ctx, 'Прочитать таблицу так?', proposalLines(proposal), 'Прочитать так')) return { declined: true };
      const { batch } = await confirmTableImport(store, path, proposal);
      return { batch, line: importedLine(batch) };
    }
    // Each answer settles what was asked; the same question again would mean the answer changed nothing.
    const key = fingerprint(proposal.question);
    if (asked.has(key)) throw new Error('Ответ не изменил, как Lab читает таблицу. Разметку можно задать в командной строке: agent-lab import --file … с флагами колонок и меток.');
    asked.add(key);
    const answers = questionAnswers(proposal.question);
    const labels = answers.map((answer, index) => `${index + 1}  ${answer.label}`);
    const picked = await ctx.ui.select(safeText(proposalLines(proposal).join('\n')), [...labels, 'Не сейчас']);
    const answer = answers[labels.indexOf(picked ?? '')];
    if (!answer) return { declined: true };
    current = withAnswer(current, answer.choices);
  }
}
