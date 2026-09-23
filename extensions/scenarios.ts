import type { Experiment } from '../src/contracts.js';
import { actionRow, briefRows, countsText, detailRows, formatNote, listRows, situationActions, type SituationRow, type SituationView } from '../src/card/view.js';
import { LibraryConflict, StaleRevisionError } from '../src/errors.js';
import { launchLines, scenarioPlan } from './conversation.ts';
import type { FlowRow } from './flow.ts';
import { cardPlan } from './launch.ts';

/*
 * The situations of a draft on the board (ui-spec §4.2–4.5), drawn by the shared projection: the list — three
 * lines per situation, the selected one marked with its numbered actions under it — or one situation open with
 * its question; the state of the preparation; and the plan of the run. Rows only: the board lays them out.
 */

const r = (text: string, color?: FlowRow['color'], bold = false): FlowRow => ({ text, color, bold });
const blank: SituationRow = { role: 'blank', indent: 0, text: '' };

/** The list of the draft's situations, or the selected one open; `details`: «d» under an open one. */
export function situationLines(record: Experiment, views: readonly SituationView[], options: { selected: number; open: boolean; details: boolean; running: boolean }): SituationRow[] {
  const chosen = views[options.selected];
  const note = formatNote(record);
  if (options.open && chosen) {
    const actions = chosen.question ? [] : situationActions(chosen);
    return [...briefRows(chosen, { running: options.running }), ...(actions.length ? [blank, actionRow(actions)] : []), ...(options.details ? [blank, ...detailRows(chosen)] : [])];
  }
  if (!views.length) return [{ role: 'detail', indent: 0, text: 'Ситуаций пока нет: они появятся после подготовки.' }];
  return [{ role: 'selected', indent: 0, text: countsText(views) }, ...(note ? [{ role: 'source' as const, indent: 0, text: note }] : []), blank,
    ...views.flatMap((view, index) => {
      const rows = listRows(view, { selected: index === options.selected, running: options.running });
      // The selected situation's actions sit under it (ui-spec §8.4); its question answers come first.
      const actions = index === options.selected ? situationActions(view) : [];
      return actions.length ? [...rows, { ...actionRow(actions), indent: 5 }] : rows;
    })];
}

/** How the preparation went: what was read, what waits, what was left out and why. */
export function logsRows(record: Experiment): FlowRow[] {
  const progress = record.preparationProgress;
  const rows = [r('ЛОГИ', 'accent', true),
    r(progress ? `Разобрано разговоров: ${progress.processed.length} · ждут: ${progress.pending.length} · исключено: ${progress.excluded.length}` : 'Подготовка не записана.', progress?.pending.length ? 'warning' : 'muted')];
  if (progress?.pending.length && !record.librarySnapshot?.acceptance) rows.push(r(progress.activeDialogueId && progress.protocol !== 'cards-v1'
    ? 'Вызов оборвался в процессе: его стоимость неизвестна, автоматически он не повторяется.' : 'u — продолжить подготовку с того же места', 'accent'));
  for (const item of progress?.excluded ?? []) rows.push(r(`• ${item.dialogueId}: ${item.reason}`, 'muted'));
  return rows;
}

/** The plan of the run: what runs now and what stays out. A draft of cards accepts its ready situations with the run. */
export function runRows(record: Experiment, views: readonly SituationView[]): FlowRow[] {
  const library = record.librarySnapshot;
  const plan = library?.formatVersion === 2 && !library.acceptance ? cardPlan(record, views) : scenarioPlan(record);
  const runnable = plan.situations > 0 && !(library?.formatVersion === 1 && !library.acceptance);
  return [r('ПРОГОН', 'accent', true), ...launchLines(record, plan).map(line => r(line)), r(''),
    runnable ? r(library?.formatVersion === 2 && !library.acceptance ? 'r — утвердить готовые ситуации и запустить: одно подтверждение' : 'r — открыть подтверждение запуска', 'accent')
      : r(library?.formatVersion === 1 ? 'Старый формат: утвердить эти ситуации нельзя.' : 'Запускать нечего: ответьте на вопросы в «Ситуациях».', 'warning')];
}

export function scenarioErrorText(error: unknown): string {
  return error instanceof StaleRevisionError ? error.message
    : error instanceof LibraryConflict ? 'Ситуации изменились. Откройте их заново и повторите по свежему состоянию.'
    : error instanceof Error ? error.message : String(error);
}
