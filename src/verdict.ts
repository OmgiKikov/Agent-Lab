import { pluralForm } from './plural.js';
import { causeSection, resultViewRows, SECTION_TEXT, SMALL_SAMPLE, unmeasuredControl, type ResultView } from './result-view.js';

/*
 * The verdict block of phase 4: one line in plain words about how well the agent does, what to do
 * next, and the rows of the chat block in their locked order (04-UI-SPEC V1, V2, B1, B2).
 * Pure: no I/O, no escaping (each surface escapes at its own boundary), no model text. Every number
 * comes from `ResultView`; this module only words it. The thresholds live here and nowhere else.
 */

/** From this rounded percent of decided situations the agent «справляется хорошо». */
export const GOOD_FROM = 80;
/** From this rounded percent up to GOOD_FROM the agent «справляется с ошибками»; below it «плохо». */
export const MIXED_FROM = 50;

/** Genitive after «из»: «1 из 1 ситуации», «9 из 13 ситуаций». */
const SITUATIONS_OF: [string, string, string] = ['ситуации', 'ситуаций', 'ситуаций'];

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
  if (percent >= GOOD_FROM) return `Агент справляется хорошо: ${count}`;
  if (percent >= MIXED_FROM) return `Агент справляется с ошибками: ${count}`;
  return `Агент справляется плохо: ${count}`;
}

/** The tone column of V1: a control warning and «плохо» are bad, «нет» and «с ошибками» warn, «хорошо» is good. */
export function verdictLevel(view: ResultView): VerdictLevel {
  if (view.control.warning !== null) return 'bad';
  const percent = percentOf(view);
  if (percent === null) return 'warn';
  return percent >= GOOD_FROM ? 'good' : percent >= MIXED_FROM ? 'warn' : 'bad';
}

/**
 * V2, the one «Дальше» row (C-110…C-117, C-147), in the locked evaluation order: the control first,
 * then a run still going, then the review queue, then what is left to do with the number.
 */
export function nextStep(view: ResultView, options: { runId: string; surface: Surface }): string {
  const { passed, decided } = view.headline;
  if (view.control.warning !== null) return 'Дальше: проверьте судью и связь с агентом.';
  if (view.pending > 0) return 'Дальше: дождитесь конца прогона.';
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
 * its `lead` weight, because the verdict line above it is the focal element now (UI-D-10).
 */
function firstBlock(view: ResultView, options: { details: boolean }): VerdictRow[] {
  const rows = resultViewRows(view, options.details ? { details: true } : {});
  const kept = options.details ? rows : rows.filter(row => row.role !== 'situation');
  return kept.map(row => row.role === 'lead' ? { ...row, role: 'headline' } : row);
}

/**
 * B1 row 4: the section heading and only the short rows of the cause section — the cause names,
 * or the situation titles when there are no clusters — so the collapsed block stays short (UI-D-13).
 */
function causeNames(view: ResultView): VerdictRow[] {
  const section = causeSection(view);
  if (!section) return [];
  const short = section.kind === 'causes' ? 'cause' : 'title';
  return [{ role: 'heading', indent: 0, text: SECTION_TEXT[section.kind].board }, ...section.rows.filter(row => row.role === short)];
}

/**
 * The chat verdict block (B1 collapsed, B2 expanded), in the locked row order: V1, the first block,
 * the causes, then V2. A blank row appears only between two non-empty groups.
 */
export function verdictBlockRows(view: ResultView, options: { expanded: boolean; runId: string; surface: Surface }): VerdictRow[] {
  const verdict: VerdictRow = { role: `verdict:${verdictLevel(view)}`, indent: 0, text: verdictLine(view) };
  const next: VerdictRow = { role: 'next', indent: 0, text: nextStep(view, options) };
  return groups([
    [verdict, ...firstBlock(view, { details: false })],
    causeNames(view),
    [next],
  ]);
}
