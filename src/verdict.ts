import { pluralForm } from './plural.js';
import { causeSection, DISAGREEMENT_BOARD_TITLE, disagreementRows, resultViewRows, SECTION_TEXT, shortId, SMALL_SAMPLE, unmeasuredControl, type ResultView } from './result-view.js';

/*
 * The verdict block of phase 4: one line in plain words about how well the agent does, what to do
 * next, and the rows of the chat block in their locked order (04-UI-SPEC V1, V2, B1, B2).
 * Pure: no I/O, no escaping (each surface escapes at its own boundary), no model text. Every number
 * comes from `ResultView`; this module only words it. The thresholds live here and nowhere else.
 * No displayed text is measured or cut here: `shortId` and `causeSection` own their own limits.
 */

/** From this rounded percent of decided situations the agent «справляется хорошо». */
export const GOOD_FROM = 80;
/** From this rounded percent up to GOOD_FROM the agent «справляется с ошибками»; below it «плохо». */
export const MIXED_FROM = 50;

/** Genitive after «из»: «1 из 1 ситуации», «9 из 13 ситуаций». */
const SITUATIONS_OF: [string, string, string] = ['ситуации', 'ситуаций', 'ситуаций'];
/** Dative after «по»: «по 1 ситуации», «по 3 ситуациям». */
const SITUATIONS_BY: [string, string, string] = ['ситуации', 'ситуациям', 'ситуациям'];

/** The phase-2 row when something was decided and nothing failed (the board prints the same words). */
export const NO_FAILURES_TEXT = 'Провалов не зарегистрировано. Это не гарантия качества в реальном трафике.';
/** R-01: where every failure is read, by tab name (the phase-2 «раздел 1» pointer is never printed in the block). */
export const allFailuresTab = (runId: string): string => `Все провалы — /agent-lab ${shortId(runId)}, вкладка «Провалы».`;
/** The same pointer in the conversation: a failure is opened by asking for it; the board stays optional. */
export const allFailuresChat = (runId: string): string => `Любой провал можно открыть здесь: попросите показать его по номеру. Доска со всеми провалами — /agent-lab ${shortId(runId)}.`;

export type VerdictLevel = 'good' | 'warn' | 'bad';
export type Surface = 'chat' | 'board';

/**
 * The control word of the warning row (UI-D-01): the same two predicates `buildResultView` uses,
 * so the verdict line and the alarm never disagree.
 */
function controlWord(view: ResultView): string {
  const failed = view.control.cards.some(card => card.outcome === 'fail');
  const unmeasured = view.control.cards.some(unmeasuredControl);
  return failed && unmeasured ? 'не пройден или не измерен' : failed ? 'не пройден' : 'не измерен';
}

/** The rounded percent the headline prints; the thresholds apply to it, never to the raw share (Pitfall 6). */
function percentOf(view: ResultView): number | null {
  const { decided, accuracy } = view.headline;
  return decided === 0 || accuracy === null ? null : Math.round(accuracy * 100);
}

/** V1: the first rule that matches wins (C-104…C-109). No trailing period: it is a title row. */
export function verdictLine(view: ResultView): string {
  if (view.control.warning !== null) return `Числу пока не верить: контроль ${controlWord(view)}`;
  const percent = percentOf(view);
  if (percent === null) return 'Проверенных ситуаций нет';
  const { passed, decided } = view.headline;
  const count = `${passed} из ${decided} ${pluralForm(decided, SITUATIONS_OF)}${decided < SMALL_SAMPLE ? ' (мало данных)' : ''}`;
  // The accuracy number leads: it is the first thing an owner or a customer looks for.
  const lead = `Точность ${percent}% · агент справляется`;
  if (percent >= GOOD_FROM) return `${lead} хорошо: ${count}`;
  if (percent >= MIXED_FROM) return `${lead} с ошибками: ${count}`;
  return `${lead} плохо: ${count}`;
}

/** The tone column of V1: a control warning and «плохо» are bad, «нет» and «с ошибками» warn, «хорошо» is good. */
export function verdictLevel(view: ResultView): VerdictLevel {
  if (view.control.warning !== null) return 'bad';
  const percent = percentOf(view);
  if (percent === null) return 'warn';
  return percent >= GOOD_FROM ? 'good' : percent >= MIXED_FROM ? 'warn' : 'bad';
}

/**
 * What the phase-3 review queue still waits for, read from the published agreement fields only:
 * unmarked failures and unmarked sampled passes are the queue entries without a current mark on
 * every target; K is the current (not stale) «не могу сказать» marks on a queued situation — phase 3
 * keeps them open, so they are never treated as done (UI-D-02, rule 2c).
 */
function reviewQueue(view: ResultView): { unmarkedFailures: number; unmarkedPasses: number; unsure: number } {
  const { queueFailures, sampledPasses, unmarked, marks } = view.agreement;
  const failures = new Set(queueFailures);
  const passes = new Set(sampledPasses);
  return {
    unmarkedFailures: unmarked.filter(id => failures.has(id)).length,
    unmarkedPasses: unmarked.filter(id => passes.has(id)).length,
    unsure: marks.filter(mark => !mark.stale && mark.answer === 'unsure' && (failures.has(mark.trialId) || passes.has(mark.trialId))).length,
  };
}

/**
 * V2, the one «Дальше» row (C-110…C-117, C-147), in the locked evaluation order: the control first,
 * then a run still going, then the review queue (failures, sampled passes, doubts), then nothing
 * decided, then what is left to do with the number. The board variant names the tab instead of the command.
 */
export function nextStep(view: ResultView, options: { runId: string; surface: Surface }): string {
  const { passed, decided } = view.headline;
  const chat = options.surface === 'chat';
  // In the conversation the next step is something to ask for; the board is only where the owner's own marks are made.
  const marks = 'Согласны ли вы с судьёй — скажите здесь же, отмечу.';
  if (view.control.warning !== null) return 'Дальше: проверьте судью и связь с агентом.';
  if (view.pending > 0) return 'Дальше: дождитесь конца прогона.';
  const queue = reviewQueue(view);
  if (queue.unmarkedFailures > 0) return chat ? `Дальше: попросите показать первый провал. ${marks}` : 'Дальше: откройте вкладку «Провалы» и отметьте согласие с провалами.';
  if (queue.unmarkedPasses > 0) return chat ? `Дальше: попросите показать успехи, выбранные для перепроверки. ${marks}` : 'Дальше: откройте вкладку «Провалы» и отметьте согласие с судьёй.';
  if (queue.unsure > 0) {
    const k = `${queue.unsure} ${pluralForm(queue.unsure, SITUATIONS_BY)}`;
    return chat ? `Дальше: решите по ${k}, согласны ли вы с судьёй: попросите показать их. ${marks}` : `Дальше: на вкладке «Провалы» решите по ${k}: y или n.`;
  }
  if (decided === 0) return chat ? 'Дальше: спросите, почему ситуации не измерены.' : 'Дальше: откройте вкладку «Диалоги» и посмотрите, почему ситуации не измерены.';
  if (decided - passed > 0) return 'Дальше: повторите прогон после исправления агента.';
  return 'Дальше: выгрузите отчёт для заказчика.';
}

/** A row of the block: the role names the tone (theme.ts ROLE_TONE); the text is raw. */
export interface VerdictRow { role: string; indent: number; text: string }
const BLANK: VerdictRow = { role: 'blank', indent: 0, text: '' };

/** Groups separated by one blank row; an empty group prints nothing and adds no blank (B1/B2 «no double blank rows»). */
function groups(items: VerdictRow[][]): VerdictRow[] {
  return items.filter(rows => rows.length).flatMap((rows, i) => i ? [BLANK, ...rows] : rows);
}

/**
 * The first block of the result (phase 1–3 rows) inside the verdict block: the headline row loses
 * its `lead` weight, because the verdict line above it is the focal element now (UI-D-10). Collapsed,
 * the per-situation «?» rows stay out so the block stays short (UI-D-13); the agreement tail rows stay.
 */
function firstBlock(view: ResultView, expanded: boolean): VerdictRow[] {
  const rows = resultViewRows(view, expanded ? { details: true } : {});
  const kept = expanded ? rows : rows.filter(row => row.role !== 'situation');
  return kept.map(row => row.role === 'lead' ? { ...row, role: 'headline' } : row);
}

/**
 * Row 4 of the block: the cause section under its board heading — collapsed, only the short rows
 * (the cause names, or the situation titles when there are no clusters); expanded, every row. When
 * something was decided and nothing failed, the phase-2 no-failures sentence; before any decision, nothing.
 */
function causes(view: ResultView, expanded: boolean): VerdictRow[] {
  const section = causeSection(view);
  if (!section) return view.headline.decided > 0 && !view.failures.length ? [{ role: 'no-failures', indent: 0, text: NO_FAILURES_TEXT }] : [];
  const short = section.kind === 'causes' ? 'cause' : 'title';
  const rows = expanded ? section.rows : section.rows.filter(row => row.role === short);
  return [{ role: 'heading', indent: 0, text: SECTION_TEXT[section.kind].board }, ...rows];
}

/** F7 in the expanded block: the heading and every current disagreement, nothing when there is none. */
function disagreements(view: ResultView): VerdictRow[] {
  if (!view.agreement.disagreements.length) return [];
  return [{ role: 'heading', indent: 0, text: DISAGREEMENT_BOARD_TITLE }, ...disagreementRows(view)];
}

/**
 * The chat verdict block in the locked row order. Collapsed (B1): V1, the first block without the
 * «?» rows, the cause names, V2. Expanded (B2): V1, the whole first block, the full causes, the
 * disagreements, the pointer to the «Провалы» tab, V2. A blank row appears only between two
 * non-empty groups; the host adds the expand hint under the last row.
 */
export function verdictBlockRows(view: ResultView, options: { expanded: boolean; runId: string; surface: Surface }): VerdictRow[] {
  const verdict: VerdictRow = { role: `verdict:${verdictLevel(view)}`, indent: 0, text: verdictLine(view) };
  const next: VerdictRow = { role: 'next', indent: 0, text: nextStep(view, options) };
  // In the conversation the block is the end of the run: each main cause comes with its human explanation —
  // what was expected, what the agent said, which owner rule — without a key press. The board keeps the names only.
  if (!options.expanded) return groups([[verdict, ...firstBlock(view, false)], causes(view, options.surface === 'chat'), [next]]);
  const pointer: VerdictRow[] = view.failures.length ? [{ role: 'pointer', indent: 0, text: options.surface === 'chat' ? allFailuresChat(options.runId) : allFailuresTab(options.runId) }] : [];
  return groups([[verdict, ...firstBlock(view, true)], causes(view, true), disagreements(view), pointer, [next]]);
}
