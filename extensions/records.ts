import { isRunning, type Experiment } from '../src/contracts.js';
import { accuracyParts, whenText } from '../src/result-text.js';
import { buildResultView, type ResultView } from '../src/result-view.js';
import { plannedTrials } from '../src/run.js';
import { agentLine } from '../src/workspace.js';
import { countText } from '../src/plural.js';
import { clip } from '../src/text.js';
import { NeedsOwner } from './lab-ui.ts';

/*
 * Which stored record a request is about. The model names a run by the exact id it read in an earlier result; a
 * request that names none means what the project works on now, read from the records — never from the conversation:
 *
 *   situations (cards, edit, decide, run) ──► the newest record that holds situations or is going on now
 *   results    (results, explain, agree)  ──► the newest record with recorded conversations
 *
 * There are no fuzzy references: no title fragments, no id prefixes, no «the second one» remembered across calls.
 */

export type Want = 'situations' | 'results';

/** A record as the model reads it in a list: its id, when, the agent and where it stands. */
export function recordEntry(record: Experiment, now?: Date) {
  return { id: record.id, when: whenText(record.createdAt, now), agent: agentLine(record), state: standing(record) };
}

/** A run in one phrase: its accuracy, or where it stands; `view` when the caller has built it. */
export function standing(record: Experiment, view?: ResultView): string {
  if (record.trials.length && !isRunning(record.phase)) {
    const { value, tail } = accuracyParts(view ?? buildResultView(record));
    return value ? `точность ${value}` : tail;
  }
  if (record.phase === 'preparing') return 'ситуации готовятся';
  if (record.phase === 'evaluating') return `идёт прогон: ${record.trials.length} из ${countText(plannedTrials(record), ['разговора', 'разговоров', 'разговоров'])}`;
  const library = record.librarySnapshot;
  const size = library?.formatVersion === 2 ? library.cards.length : library?.formatVersion === 1 ? library.variants.length : record.scenarios.length;
  const situations = countText(size, ['ситуация', 'ситуации', 'ситуаций']);
  if (record.phase === 'review') return `черновик: ${situations}${library?.acceptance ? ', утверждены' : ''}`;
  return record.phase === 'error' || record.phase === 'interrupted' || record.phase === 'cancelled' ? 'остановлен до результата' : situations;
}

const holdsSituations = (record: Experiment) => !!record.librarySnapshot || record.scenarios.length > 0 || isRunning(record.phase);

/** The record a request means: `id` exactly, or — with none — what the project works on now. `records` come newest first. */
export function recordFor(records: readonly Experiment[], id: string | undefined, want: Want): Experiment {
  if (id !== undefined) {
    const found = records.find(record => record.id === id);
    if (found) return found;
    const known = records.slice(0, 12).map(record => `${record.id} — ${whenText(record.createdAt)}, ${standing(record)}`);
    throw new NeedsOwner('unknown_reference', `Прогона с id «${clip(id, 80)}» нет. Есть: ${known.join('; ') || 'ничего'}. Возьмите id из результата Agent Lab или спросите владельца, о каком прогоне речь.`,
      known, 'Такого прогона в этом проекте нет.');
  }
  const found = want === 'results' ? records.find(record => record.trials.length > 0) : records.find(holdsSituations);
  if (found) return found;
  throw new NeedsOwner('unknown_reference', want === 'results' ? 'Результатов ещё нет: ни один прогон не запускался.' : 'В этом проекте ещё нет ситуаций: сначала их нужно подготовить.', [],
    want === 'results' ? 'Результатов пока нет — сначала запустите прогон.' : 'Ситуаций пока нет. Скажите, какого агента проверить и где лежат логи.');
}
