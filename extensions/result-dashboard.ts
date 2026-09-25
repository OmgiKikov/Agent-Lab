import { causeItems, causeRows, fitRows, headRows, nextRows, runLine, barRows, type ResultRow } from '../src/result-text.js';
import type { NextStep, ResultView } from '../src/result-view.js';
import { safeText } from '../src/text.js';
import type { Line, ResultPick, Screen, SpaceData } from './workspace-screens.ts';
import { box, selection, span, wrap } from './render/panels.ts';
import { GLYPH, ROLE_TONE } from './render/theme.ts';

/*
 * The first screen of a run's result on the board (docs/design/ui-spec.md §8.5): the head of the result — the alarm,
 * the number, the trust line, whether the agent answered —, then «Дальше» and «Почему ошибается», whose rows the cursor
 * walks, and the run line. Every word is result-text.ts's, in its rows: the board decides nothing of its own, it lays
 * the rows out in its panels and knows only what Enter does on each. «Дальше» comes before the causes, so the judge's
 * blind check is offered before any of its verdicts is read. The whole result — the fine print, every error, what was
 * not measured — is under d.
 *
 *   ✗ Числу пока не верить: …                      ← alarmRow, when the number is not to be trusted yet
 *   Точность агента: 50% — справился в 1 из 2 …    ← the number, or why it is withheld
 *   По выбранным ситуациям; … · мало данных          ← the trust line
 *   ╭─ Дальше ─────────────────────────────────╮   ← the steps, the blind check before any verdict
 *   ╭─ Почему ошибается ───────────────────────╮   ← the causes, each opening its first failure
 *   Прогон сегодня в … · 2 ситуации                  ← the run line
 */

/** What Enter does on each step of «Дальше»; waiting for a run to end is nothing to do. The exam, like the connection, is taken up in the conversation. */
export const STEP_PICK: Record<NextStep['kind'], ResultPick | null> = { review_judge: { kind: 'review' }, blind_check: { kind: 'blind' }, report: { kind: 'report' },
  repeat: { kind: 'repeat' }, why_unmeasured: { kind: 'unmeasured' }, exam: { kind: 'connection' }, check_connection: { kind: 'connection' }, wait: null };

/** Record text is untrusted: every row is made safe before it is laid out, so the layout measures what the terminal shows. */
const safeRow = (row: ResultRow): ResultRow => ({ ...row, text: safeText(row.text), ...(row.right === undefined ? {} : { right: safeText(row.right) }),
  ...(row.short === undefined ? {} : { short: safeText(row.short) }), ...(row.parts ? { parts: row.parts.map(part => safeText(part)) } : {}) });

/** Result rows laid out by the one result layout (result-text.ts fitRows), each painted in its role's colour. */
function laid(rows: readonly ResultRow[], width: number): Line[] {
  return fitRows(rows.map(safeRow), width).map(line => line.role === 'blank' ? [] : [span(line.text, ROLE_TONE[line.role].tone, ROLE_TONE[line.role].bold)]);
}

/** A row the cursor stands on: the selection sign before it — its wrapped lines under the text, not the sign —, bold, on the selection's background. */
function chosen(row: ResultRow, width: number): Line[] {
  const marked: ResultRow = { ...row, indent: 0, text: `${GLYPH.selected} ${row.text}`, hang: (row.hang ?? 0) + 2 };
  return selection(laid([marked], width).map(line => line.map(part => ({ ...part, bold: true }))), width);
}

/** A panel's rows and where each row the cursor can stand on starts, in the panel's own lines. */
interface Panel { title: string; lines: Line[]; offsets: number[]; picks: ResultPick[] }

/**
 * Rows of result-text.ts under their heading as a panel of the board: the heading is its title, and each row `pickOf`
 * gives a pick is one the cursor stands on — `selected` counts over the picks before it (`before`).
 */
function panel(rows: readonly ResultRow[], width: number, pickOf: (row: ResultRow, index: number) => ResultPick | null, selected: number, before: number): Panel {
  const [heading, ...body] = rows;
  const out: Panel = { title: heading?.text ?? '', lines: [], offsets: [], picks: [] };
  body.forEach((row, index) => {
    const pick = pickOf(row, index);
    if (!pick) { out.lines.push(...laid([row], width)); return; }
    out.offsets.push(out.lines.length);
    out.lines.push(...(before + out.picks.length === selected ? chosen(row, width) : laid([row], width)));
    out.picks.push(pick);
  });
  return out;
}

/** The lines before a panel's content: its top border and the blank line under it (render/panels.ts box). */
const BOX_TOP = 2;

export function dashboardPicks(view: ResultView): ResultPick[] {
  return [...view.next.flatMap(step => STEP_PICK[step.kind] ?? []), ...(view.failures.length ? causeItems(view).items.flatMap(cause => {
    const failure = view.failures.find(item => cause.scenarioIds.includes(item.scenarioId));
    return failure ? [{ kind: 'failure' as const, trialId: failure.trialId }] : [];
  }) : [])];
}

/**
 * The board's first screen of one run's result. `back`: Esc returns to the list of runs this result was opened from;
 * otherwise Esc closes the board, and the key hint says which.
 */
export function resultDashboard(data: SpaceData, run: SpaceData['runs'][number], selected: number, actions: string[], width: number, options: { back?: boolean } = {}): Screen & { picks: ResultPick[] } {
  const { view } = run;
  const body: Line[] = [];
  const going = data.progress?.kind === 'run' && data.runs[0] === run ? data.progress : undefined;
  if (going) body.push(...wrap(going.text, width, 'accent'), []);
  body.push(...laid(headRows(view, { brief: true }), width), []);

  // «Дальше» above the causes at every width: the step the owner is advised to take, the judge's blind check before any
  // of its verdicts is read.
  const next = panel(nextRows(view, 'board'), width - 4, (_row, index) => STEP_PICK[view.next[index]!.kind], selected, 0);
  // «Почему ошибается»: each cause opens its first failure; without a failure, the one sentence that says so.
  const causes = causeRows(view);
  const failed = causeItems(view).items;
  const trialOf = (index: number) => view.failures.find(failure => failed[index]?.scenarioIds.includes(failure.scenarioId))?.trialId;
  let cause = 0;
  const why = view.failures.length ? panel(causes, width - 4, row => {
    if (row.role !== 'item') return null;
    const trialId = trialOf(cause++);
    return trialId ? { kind: 'failure', trialId } : null;
  }, selected, next.picks.length) : undefined;

  const picks = [...next.picks, ...why?.picks ?? []];
  const items: number[] = [];
  const shown = [...(next.lines.length ? [{ panel: next, tone: 'accent' as const }] : []), ...(why ? [{ panel: why, tone: 'muted' as const }] : [])];
  for (const item of shown) {
    items.push(...item.panel.offsets.map(offset => body.length + BOX_TOP + offset));
    body.push(...box(item.panel.title, item.panel.lines, width, item.tone), []);
  }
  // Nothing failed: the sentence about what that does not prove stands under the steps.
  if (!view.failures.length && causes.length) body.push(...laid(causes, width), []);
  body.push(...laid([runLine(view, data.now), ...barRows(view)], width), []);
  if (actions.length) body.push(...box('Прогон', actions.flatMap((label, i) => wrap(`${i + 1}  ${label}`, width - 4, 'accent')), width));
  const anchor = items[selected];
  return { head: [], body, items, picks, ...(anchor === undefined ? {} : { anchor }), foot: [
    { key: '↑↓', text: 'выбрать' }, { key: 'Enter', text: 'открыть' }, { key: 'd', text: 'вся статистика' }, { key: 'Esc', text: options.back ? 'назад' : 'закрыть' }, { key: '?', text: 'клавиши' },
  ] };
}
