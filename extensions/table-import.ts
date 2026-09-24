import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { ImportBatch } from '../src/scenario-contracts.js';
import type { ExperimentStore } from '../src/store.js';
import { questionAnswers, withAnswer } from '../src/spreadsheet/answers.js';
import { readReadingFiles } from '../src/spreadsheet/files.js';
import { confirmTableImport, proposeTableImport } from '../src/spreadsheet/import.js';
import { importedLine, proposalLines } from '../src/spreadsheet/lines.js';
import type { TableChoices } from '../src/spreadsheet/mapping.js';
import { readTableFile } from '../src/spreadsheet/workbook.js';
import { fingerprint } from '../src/contracts.js';
import { safeText } from '../src/text.js';
import { ask } from './lab-ui.ts';

/*
 * A spreadsheet of logs in the chat (chunk I): Lab proposes how to read it; a question it cannot settle alone
 * becomes one native numbered choice; the whole reading is shown once more and only the owner's «Прочитать так»
 * stores the import. The host calls confirmTableImport, never the model; the model only names the file and,
 * when the owner said so in words, the sheet, a column, or the column (and values) that choose the conversations
 * to evaluate — «Какие разговоры оценивать?» is then one more native numbered choice.
 *
 *   propose ──question──► native choice ──► propose again with the answer … ──ready──► «Прочитать так?» ──► stored
 */

/** What became of the table: its import, or why there is none — the owner stepped back, or the file cannot be read that way. */
export type TableImport = { batch: ImportBatch; line: string } | { declined: true } | { refused: string };

/** Whether the owner has already confirmed a reading of this very file (the same bytes) in the data folder `directory`. */
export async function confirmedBefore(path: string, directory: string): Promise<boolean> {
  const { file } = await readTableFile(path);
  return (await readReadingFiles(directory)).some(entry => entry.readings.some(reading => reading.file.sha256 === file.sha256));
}

/** Asks the owner how to read `path` and stores the import they confirm; `choices` are the owner's corrections said in words. */
export async function importTable(ctx: Pick<ExtensionContext, 'ui'>, store: ExperimentStore, path: string, choices: TableChoices = {}): Promise<TableImport> {
  let current = choices;
  const asked = new Set<string>();
  while (true) {
    const proposal = await proposeTableImport(path, current);
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
