import { visibleWidth } from '@earendil-works/pi-tui';
import type { Experiment } from '../src/contracts.js';
import { logAnswerOf, logTargets, type CalibrationDisagreement } from '../src/card/calibration-view.js';
import { actionRow, briefRows, countsText, detailRows, formatNote, layoutRows, listRows, situationActions, situationBrief, type LayoutRow, type SituationRow, type SituationView } from '../src/card/view.js';
import type { Decision } from '../src/inbox.js';
import { rulebookLines, type RulebookView } from '../src/card/rulebook.js';
import { decisionsLine } from '../src/inbox.js';
import { problemSize, problemsLine, type Problem } from '../src/problems.js';
import {
  accuracyParts, ANSWER_TEXT, calibrationRows, causeRows, failureRows, fitRows, judgeQuestionText, logDisagreementRows, logQuestionText, nextRows,
  resultScreen as resultRows, runLine, trialTurns, whenText, type ResultRow, type Turn,
} from '../src/result-text.js';
import type { NextStep, ResultView } from '../src/result-view.js';
import { countText, pluralForm } from '../src/plural.js';
import { clip, oneLine, safeLine, safeText } from '../src/text.js';
import type { AgentSpace } from '../src/workspace.js';
import type { LaunchPlan } from './conversation.ts';
import { SITUATION_TONE } from './render/situation.ts';
import { GLYPH, ROLE_TONE, type Tone } from './render/theme.ts';
import { agreementTarget, type Answer } from './judge-review.ts';
import type { PreparationView } from './preparation-progress.ts';
import { preparationPanel } from './preparation-panel.ts';
import { situationBrowser, situationExplanation } from './situation-browser.ts';
import { runPanel } from './run-panel.ts';
import { trialTrace } from './trial-trace.ts';
import { dashboardPicks, resultDashboard } from './result-dashboard.ts';
import { WORKSPACE_WIDTH } from './preparation-panel.ts';
import { box, beside, row as panelRow, wrap as panelWrap } from './render/panels.ts';

/*
 * The screens of the agent's workspace (docs/design/ui-spec.md §4, §8), as lines ready to paint: the header with the areas — or the
 * steps of a first run —, the answer of the screen first, then its list or its open object, and one row of key hints.
 * Situations are laid out by the shared projection (src/card/view.ts), results by result-text.ts, so the workspace
 * says exactly what the chat and the CLI say. Pure: no I/O, no painting; widths are the terminal's columns.
 */

export interface Segment { text: string; tone?: Tone; bold?: boolean; background?: 'selectedBg' }
export type Line = Segment[];
/** One key hint of the footer: the key, then what it does. */
export interface Hint { key: string; text: string }
export interface Screen {
  head: Line[];
  body: Line[];
  foot: Hint[];
  /** The body line of the selection: the workspace keeps it in view. */
  anchor?: number;
  /** Where each item of a list starts in the body: what «↓ ещё N» counts. */
  items?: number[];
}

/** What the workspace knows about one agent: loaded from the store by the command, drawn from here. */
export interface SpaceData {
  space: AgentSpace;
  /** The situations being worked on: the draft, else those of the newest run. */
  set?: { record: Experiment; views: SituationView[]; editable: boolean; coverage?: { line: string; uncovered: string | undefined }; plan: LaunchPlan; running: boolean;
    /** «Свод правил» of a card set whose rules were typed; absent for rules grounded before kinds. */
    rulebook?: RulebookView;
    /** What a run of the ready situations would be, in the words of the run dialog itself (conversation.ts `launchLines`). */
    launch?: string[] };
  /** Finished runs with their result, newest first. */
  runs: { record: Experiment; view: ResultView }[];
  decisions: Decision[];
  problems: Problem[];
  /**
   * Work going on now: what it is — situations prepared, situations checked, a run —, its one progress line, how far it
   * got, whether this session can stop it; `frame` turns the spinner.
   */
  progress?: { kind: WorkKind; text: string; share: number | null; stoppable: boolean; frame?: number; preparation?: PreparationView };
  preparation?: PreparationView;
  /** The logged conversations the newest calibrated run disagrees with, by `logKey`: read from their imports by the command. */
  logged?: ReadonlyMap<string, Turn[]>;
  now: Date;
}

/** How SpaceData.logged names the logged conversation of a disagreement. */
export const logKey = (log: Pick<CalibrationDisagreement['log'], 'importId' | 'dialogueId'>): string => `${log.importId}:${log.dialogueId}`;

/** The long work a workspace follows: a preparation of situations, a check of changed ones, a run (with a re-assessment). */
export type WorkKind = 'preparation' | 'check' | 'run';

export type Area = 'inbox' | 'situations' | 'rules' | 'runs' | 'problems';
export type Step = 'situations' | 'run' | 'result';

/* ───────────────────────────── lines ───────────────────────────── */

type WsRole = 'answer' | 'text' | 'muted' | 'heading' | 'selected' | 'actions' | 'warning' | 'error' | 'success' | 'accent' | 'blank' | 'dim';
const WS_TONE: Record<WsRole, { tone?: Tone; bold: boolean }> = {
  answer: { tone: 'text', bold: true }, text: { tone: 'text', bold: false }, muted: { tone: 'muted', bold: false }, heading: { tone: 'accent', bold: true },
  selected: { tone: 'text', bold: true }, actions: { tone: 'accent', bold: false }, warning: { tone: 'warning', bold: false }, error: { tone: 'error', bold: true },
  success: { tone: 'success', bold: false }, accent: { tone: 'accent', bold: false }, blank: { bold: false }, dim: { tone: 'dim', bold: false },
};
const segment = (text: string, style: { tone?: Tone; bold: boolean }): Segment => ({ text, ...(style.tone ? { tone: style.tone } : {}), ...(style.bold ? { bold: true } : {}) });
const blank: Line = [];

/*
 * Record text is untrusted: every row is escaped before it is laid out, so the layout measures what the terminal
 * will show and no escape sequence of a title or a quote reaches the screen.
 */
const safe = <R extends { text: string; right?: { text: string } | string; parts?: string[] }>(row: R): R => ({ ...row, text: safeText(row.text),
  ...(typeof row.right === 'string' ? { right: safeText(row.right) } : row.right ? { right: { ...row.right, text: safeText(row.right.text) } } : {}),
  ...(row.parts ? { parts: row.parts.map(part => safeText(part)) } : {}) });

/** Workspace rows laid out like a situation's: cut with «…» or wrapped under their hang, a right part never cut. */
function wsLines(rows: LayoutRow<WsRole>[], width: number): Line[] {
  return layoutRows(rows.map(safe), width).map(line => [segment(line.text, WS_TONE[line.role]), ...(line.right ? [segment(line.right.text, WS_TONE[line.right.role])] : [])]);
}
const ws = (role: WsRole, text: string, indent = 1, extra: Partial<LayoutRow<WsRole>> = {}): LayoutRow<WsRole> => ({ role, indent: indent - 1, text, ...extra });

/** A situation's rows (brief, list, question), each role in its colour. */
function situationLines(rows: readonly SituationRow[], width: number): Line[] {
  return layoutRows(rows.map(safe), width).map(line => [segment(line.text, SITUATION_TONE[line.role]), ...(line.right ? [segment(line.right.text, SITUATION_TONE[line.right.role])] : [])]);
}

/** Result rows laid out by the one result layout, each role in its colour. */
function resultLines(rows: ResultRow[], width: number): Line[] {
  return fitRows(rows.map(safe), width).map(line => line.role === 'blank' ? blank : [segment(line.text, ROLE_TONE[line.role])]);
}

/** Shared content width for the workspace's panels and detailed screens. */
const room = (width: number) => Math.max(20, Math.min(width, WORKSPACE_WIDTH));

/* ───────────────────────────── the header ───────────────────────────── */

const AREA_LABEL: Record<Exclude<Area, 'inbox' | 'rules'>, string> = { situations: 'Ситуации', runs: 'Прогоны', problems: 'Проблемы' };
/** Narrower than this, a screen keeps only its place, its answer, its list and the way to the keys (docs/design/ui-spec.md §6). */
export const NARROW = 50;

/** The areas of the workspace: the queue of decisions first while it has any, the current area in accent. */
export function areasOf(data: SpaceData): Area[] {
  return [...(data.decisions.length ? ['inbox' as const] : []), 'situations', ...(data.set?.rulebook ? ['rules' as const] : []), 'runs', 'problems'];
}

/** One place of the header's line — an area or a step — with its label, and the shorter label it may take while the owner is elsewhere. */
interface Tab<Place extends string> { place: Place; text: string; short?: string; tone: Tone }

/**
 * The places as the room allows (docs/design/ui-spec.md §6): every label with wide separators, then with narrow ones, then
 * the counters of the places the owner is not on dropped, then only the places that fit — the current one always, then
 * those `first` names, then the rest in order. A label is never cut: a place that does not fit is left out whole.
 */
function fitTabs<Place extends string>(tabs: readonly Tab<Place>[], current: Place, first: readonly Place[], wide: string, budget: number): { shown: Tab<Place>[]; gap: string } {
  const width = (shown: readonly Tab<Place>[], gap: string) => visibleWidth(shown.map(tab => tab.text).join(gap));
  if (width(tabs, wide) <= budget) return { shown: [...tabs], gap: wide };
  const gap = ` ${wide.trim()} `;
  if (width(tabs, gap) <= budget) return { shown: [...tabs], gap };
  const brief = tabs.map(tab => tab.place === current || tab.short === undefined ? tab : { ...tab, text: tab.short });
  if (width(brief, gap) <= budget) return { shown: brief, gap };
  const kept = new Set<Place>([current]);
  for (const place of [...first, ...tabs.map(tab => tab.place)]) {
    if (kept.has(place) || !tabs.some(tab => tab.place === place)) continue;
    if (width(tabs.filter(tab => kept.has(tab.place) || tab.place === place), gap) <= budget) kept.add(place);
  }
  return { shown: tabs.filter(tab => kept.has(tab.place)), gap };
}

/** The places in one line: the current one in accent and bold, the others in their own tone, the separators muted. */
function tabLine<Place extends string>(shown: readonly Tab<Place>[], current: Place, gap: string): Segment[] {
  return [{ text: ' ' }, ...shown.flatMap((tab, index): Segment[] => [...(index ? [{ text: gap, tone: 'muted' as const }] : []),
    tab.place === current ? { text: ` ${tab.text} `, tone: 'accent', bold: true, background: 'selectedBg' } : { text: tab.text, tone: tab.tone }])];
}

function areaLine(data: SpaceData, current: Area, width: number): Line {
  const counts: Record<Exclude<Area, 'inbox' | 'rules'>, number> = { situations: data.set?.views.length ?? 0, runs: data.runs.length, problems: data.problems.length };
  const tabs: Tab<Area>[] = [...(data.decisions.length ? [{ place: 'inbox' as const, text: `Вопросы ${data.decisions.length}`, tone: 'warning' as const }] : []),
    ...(['situations', 'runs', 'problems'] as const).flatMap((area): Tab<Area>[] => [{ place: area, text: `${AREA_LABEL[area]} ${counts[area]}`, tone: 'muted' },
      ...(area === 'situations' && data.set?.rulebook ? [{ place: 'rules' as const, text: 'Правила', tone: 'muted' as const }] : [])])];
  const wide = '  ·  ';
  const { shown, gap } = fitTabs(tabs, current, ['inbox'], wide, room(width) - 5);
  const parts = tabLine(shown, current, gap);
  const used = parts.reduce((sum, part) => sum + visibleWidth(part.text), 0);
  // No decision waits: a calm mark on the right instead of the queue, while every area fits beside it.
  const calm = `${GLYPH.pass} решений не ждёт`;
  if (!data.decisions.length && gap === wide && used + visibleWidth(calm) + 2 <= room(width)) parts.push({ text: `${' '.repeat(room(width) - used - visibleWidth(calm))}${calm}`, tone: 'success' });
  return parts;
}

/** The steps before the first result; the work going on names its own step: the situations are prepared or checked, the run goes (docs/design/ui-spec.md §4.6). */
function stepLine(data: SpaceData, current: Step, width: number): Line {
  const views = data.set?.views ?? [];
  const ready = views.filter(view => view.status === 'ready').length;
  const latest = data.runs[0]?.view;
  const result = latest && !latest.notMeasured.alarm && !latest.control.alarm ? accuracyParts(latest).value : null;
  const work = data.progress?.kind;
  const situations = work === 'preparation' ? 'Ситуации готовятся' : work === 'check' ? 'Ситуации проверяются' : `Ситуации ${views.length ? `${ready}/${views.length}` : ''}`.trim();
  const tabs: Tab<Step>[] = [{ place: 'situations', text: situations, short: 'Ситуации', tone: 'muted' },
    { place: 'run', text: work === 'run' ? 'Прогон идёт' : 'Прогон', short: 'Прогон', tone: 'muted' },
    { place: 'result', text: `Результат${result ? ` · точность ${result}` : ''}`, short: 'Результат', tone: 'muted' }];
  const { shown, gap } = fitTabs(tabs, current, [], '  ›  ', room(width) - 5);
  return tabLine(shown, current, gap);
}

/**
 * The workspace's header: the agent, then its areas (or, before the first result, the steps). Narrower than 50 columns
 * only the line of places stays, so the owner still sees where they are (docs/design/ui-spec.md §6).
 */
export function header(data: SpaceData, place: { area: Area } | { step: Step }, width: number, compact = false): Line[] {
  const { space } = data;
  const places = 'step' in place ? stepLine(data, place.step, width) : areaLine(data, place.area, width);
  if (width < NARROW || compact) return [places];
  const name = /^(?:\/|.*\bAGENT_LAB_)/.test(space.name) ? 'Проверка агента' : space.name;
  return [[{ text: ' AGENT LAB', tone: 'accent', bold: true }, { text: `  /  ${safeLine(clip(name, Math.max(10, width - 22)))}`, tone: 'text' }], [], places, [], [{ text: '─'.repeat(width), tone: 'borderMuted' }]];
}

/* ───────────────────────────── the areas ───────────────────────────── */

const FOOT = {
  inbox: [{ key: '↑↓', text: 'выбрать' }, { key: '1–3', text: 'решить' }, { key: 'Enter', text: 'открыть' }, { key: '←→', text: 'области' }, { key: '?', text: 'клавиши' }],
  area: [{ key: '↑↓', text: 'выбрать' }, { key: 'Enter', text: 'открыть' }, { key: '1–3', text: 'действие' }, { key: '←→', text: 'области' }, { key: '?', text: 'клавиши' }],
  list: [{ key: '↑↓', text: 'выбрать' }, { key: 'Enter', text: 'открыть' }, { key: 'Esc', text: 'назад' }],
} satisfies Record<string, Hint[]>;

/** «Нужно ваше решение» (docs/design/ui-spec.md §8.3): one decision in three lines — what it is about, one phrase, the actions. */
export function inboxScreen(data: SpaceData, selected: number, width: number): Screen {
  const latest = data.runs[0];
  const result = latest && accuracyParts(latest.view);
  const lead = [ws('answer', decisionsLine(data.decisions.length)),
    ...(latest && result ? [ws('muted', `Последний прогон ${whenText(latest.record.createdAt, data.now)}: ${result.value ? `точность ${result.value} ${result.tail}` : lowerFirst(result.tail)}.`)] : [])];
  const body: Line[] = [...wsLines(lead, room(width)), blank];
  const items: number[] = [];
  let anchor: number | undefined;
  data.decisions.forEach((decision, index) => {
    const mine = index === selected;
    items.push(body.length);
    if (mine) anchor = body.length;
    body.push(...wsLines([ws(mine ? 'selected' : 'text', `${mine ? '›' : ' '} ${decision.subject}`, 1, { clip: true }),
      ws('muted', decision.text, 4, { hang: 0 }),
      ws('actions', decision.choices.map((choice, number) => `${number + 1} ${choice.label}`).join('  ·  '), 4, { clip: true })], room(width)));
    if (index < data.decisions.length - 1) body.push(blank);
  });
  return { head: [], body, foot: FOOT.inbox, ...(anchor !== undefined ? { anchor } : {}), items };
}

const lowerFirst = (text: string) => text.charAt(0).toLocaleLowerCase('ru') + text.slice(1);

/**
 * «Ситуации»: before the first result (docs/design/ui-spec.md §4.2) the counts lead — what is ready, what waits for the owner —; in the
 * workspace (§8.4) the coverage of the logs' topics does. Then three lines a situation; the selected one's question and
 * actions under it.
 */
export function situationsScreen(data: SpaceData, selected: number, width: number, options: { firstRun?: boolean } = {}): Screen {
  const set = data.set;
  const areas: Hint = options.firstRun ? { key: '→', text: 'прогон' } : { key: '←→', text: 'области' };
  if (set?.views.length && data.progress?.kind !== 'preparation') {
    const screen = situationBrowser(data, selected, width,
      [{ key: '↑↓', text: 'ситуация' }, { key: 'PgDn', text: 'ниже' }, { key: '←→', text: options.firstRun ? 'этапы' : 'области' }, { key: 'Enter', text: 'открыть' }, { key: 'Esc', text: 'закрыть' }]);
    if (data.progress?.kind === 'check') screen.body.unshift(...progressLines(data.progress, room(width)));
    return screen;
  }
  // Situations being prepared or checked: the work's own row leads, and it says where its situations appear.
  const progress = data.progress;
  const hint = progress && progress.kind !== 'run' ? HERE_HINT[progress.kind] : undefined;
  const work = hint ? progress : undefined;
  const going = data.preparation ? preparationPanel(data.preparation, set?.views ?? [], width, work?.frame ?? 0)
    : work && hint ? [...progressLines(work, room(width)), ...wsLines([ws('muted', hint, 3)], room(width))] : [];
  if (!set?.views.length) return { head: [], body: work ? going : wsLines([ws('answer', 'Ситуаций пока нет.'),
    ws('muted', 'Скажите в чате, какого агента проверить и где лежат логи, — Lab соберёт ситуации сам.')], room(width)),
  foot: [...(work ? [] : [{ key: 'a', text: 'спросить Lab' }]), areas, { key: 'Esc', text: 'закрыть' }] };
  const waiting = set.views.some(view => view.status === 'needs_owner');
  const note = !set.editable ? [ws('muted', formatNote(set.record) ?? 'Старый формат: эти ситуации можно посмотреть, но не изменить.')]
    : set.record.trials.length ? [ws('muted', `Ситуации прогона ${whenText(set.record.createdAt, data.now)}; изменения пойдут в новый черновик, прогон не меняется.`)] : [];
  const lead = set.coverage && !options.firstRun ? [ws('answer', set.coverage.line), ...(set.coverage.uncovered ? [ws('muted', set.coverage.uncovered, 3)] : []), ...note]
    : [ws('answer', countsText(set.views)), ...(waiting ? [ws('muted', 'Готовые можно запускать уже сейчас; остальные войдут, когда ответите.')] : note)];
  const body: Line[] = [...(going.length ? [...going, blank] : []), ...wsLines(lead, room(width)), blank];
  const items: number[] = [];
  let anchor: number | undefined;
  const narrow = width < 70;
  set.views.forEach((view, index) => {
    const mine = index === selected;
    items.push(body.length);
    if (mine) anchor = body.length;
    body.push(...situationLines(listRows(view, { selected: mine, running: set.running, narrow }), room(width)));
    const actions = mine && set.editable ? situationActions(view) : [];
    // Answers alone say nothing: the question stands above them.
    if (actions.length && view.question?.choices.length) body.push(...situationLines([{ role: 'question', indent: 5, text: `? ${view.question.text}`, clip: true }], room(width)));
    if (actions.length) body.push(...situationLines([{ ...actionRow(actions), indent: 5 }], room(width)));
  });
  const foot: Hint[] = options.firstRun ? [{ key: '↑↓', text: 'выбрать' }, { key: 'Enter', text: 'открыть' }, ...(set.editable ? [{ key: '1–3', text: 'действие' }] : []), areas, { key: '?', text: 'клавиши' }]
    : set.editable ? FOOT.area : [{ key: '↑↓', text: 'выбрать' }, { key: 'Enter', text: 'открыть' }, areas, { key: '?', text: 'клавиши' }];
  return { head: [], body, foot, ...(anchor !== undefined ? { anchor: data.preparation && selected === 0 ? 0 : anchor } : {}), items };
}

/** The one action of «Свод правил»: operator instructions in or out of it, as a whole. */
export function rulebookAction(rulebook: RulebookView): string {
  const operators = rulebook.kinds.find(item => item.kind === 'operator_procedure')!;
  return operators.binds ? 'Не судить бота по инструкциям для операторов' : 'Судить бота и по инструкциям для операторов';
}

/**
 * «Свод правил» (W1): which of the owner's rules bind the bot — each kind with its count, the sources, and the one key that
 * lets operator instructions in or keeps them out. Single rules come in through the question of the situation that needs one.
 */
export function rulebookScreen(data: SpaceData, width: number): Screen {
  const rulebook = data.set?.rulebook;
  if (!rulebook) return { head: [], body: wsLines([ws('answer', 'Свода правил у этих ситуаций нет: их правила подготовлены до того, как Lab стал различать виды правил.')], room(width)),
    foot: [{ key: '←→', text: 'области' }, { key: 'Esc', text: 'закрыть' }] };
  const [first, ...rest] = rulebookLines(rulebook);
  const editable = !!data.set?.editable;
  const body = wsLines([ws('answer', first!), ...rest.map(line => ws(line.startsWith('  ') ? 'text' : 'muted', line.trimStart(), line.startsWith('  ') ? 3 : 1)),
    ws('blank', ''), ws('muted', 'Отдельное правило становится обязательным для бота ответом на вопрос ситуации, которой оно нужно.'),
    ...(editable ? [ws('blank', ''), ws('actions', `1  ${rulebookAction(rulebook)}`, 3)] : [ws('muted', 'Свод правил меняется в черновике ситуаций.')])], room(width));
  return { head: [], body, foot: [...(editable ? [{ key: '1', text: 'изменить' }] : []), { key: '←→', text: 'области' }, { key: 'a', text: 'спросить Lab' }, { key: '?', text: 'клавиши' }] };
}

/** What the runs' screen offers besides its rows: the report, another run, every run. */
export function runActions(data: SpaceData): string[] {
  const ready = data.set?.views.filter(view => view.status === 'ready').length ?? 0;
  return ['Отчёт для заказчика', ready ? `Запустить снова — ${countText(ready, ['готовая', 'готовых', 'готовых'])}` : 'Запустить снова', 'Все прогоны'];
}

/**
 * A row of the result screen the cursor can stand on: a cause (or a failure by title) opens its failure; under the
 * details, a situation that disagrees with production opens that disagreement (`log`); a step of «Дальше» does what it
 * says — the judge's review opens its queue, the report is saved, the situations run again, the unmeasured ones are
 * listed, the connection goes to the conversation.
 */
export type ResultPick = { kind: 'failure'; trialId: string } | { kind: 'log'; cardId: string } | { kind: 'review' } | { kind: 'blind' } | { kind: 'report' } | { kind: 'repeat' } | { kind: 'unmeasured' } | { kind: 'connection' };

/** What Enter does on each step of «Дальше»; waiting for a run to end is nothing to do. */
const STEP_PICK: Record<NextStep['kind'], ResultPick | null> = { review_judge: { kind: 'review' }, blind_check: { kind: 'blind' }, report: { kind: 'report' }, repeat: { kind: 'repeat' },
  why_unmeasured: { kind: 'unmeasured' }, check_connection: { kind: 'connection' }, wait: null };

const sameRow = (a: ResultRow, b: ResultRow): boolean => a.role === b.role && a.indent === b.indent && a.text === b.text && a.right === b.right;
/** Where `block` stands whole among `rows`, or -1. */
function blockAt(rows: readonly ResultRow[], block: readonly ResultRow[]): number {
  if (!block.length) return -1;
  return rows.findIndex((_, at) => block.every((row, offset) => { const shown = rows[at + offset]; return shown !== undefined && sameRow(shown, row); }));
}

/**
 * The rows of the result screen — the very rows the CLI summary prints and the model reads as the board's screen
 * (result-text.ts `resultScreen`) — and, laid over them, what the cursor does on each: a cause opens its failure, a
 * situation of «Сверка с продом» its disagreement, a step of «Дальше» does what it says. The board adds no row of its
 * own to the result.
 */
export function pickedRows(view: ResultView, options: { details: boolean; now: Date }): { rows: ResultRow[]; picks: (ResultPick | null)[] } {
  const rows = resultRows(view, { surface: 'board', details: options.details, now: options.now });
  const picks: (ResultPick | null)[] = rows.map(() => null);
  const causes = causeRows(view), causesAt = blockAt(rows, causes);
  const trialOf = (scenarioId: string | undefined) => view.failures.find(failure => failure.scenarioId === scenarioId)?.trialId;
  let item = 0;
  if (causesAt >= 0) causes.forEach((row, offset) => {
    if (row.role !== 'item') return;
    const trialId = trialOf(view.topCauses.length ? view.topCauses[item]?.scenarioIds[0] : view.failures[item]?.scenarioId);
    item++;
    if (trialId) picks[causesAt + offset] = { kind: 'failure', trialId };
  });
  // Each situation of «Сверка с продом» is one row naming it, in the order of the disagreements.
  const calibration = calibrationRows(view), calibrationAt = blockAt(rows, calibration);
  let disagreement = 0;
  if (calibrationAt >= 0) calibration.forEach((row, offset) => {
    if (row.role !== 'item') return;
    const cardId = view.calibration?.disagreements[disagreement++]?.cardId;
    if (cardId) picks[calibrationAt + offset] = { kind: 'log', cardId };
  });
  const nextAt = blockAt(rows, nextRows(view, 'board'));
  if (nextAt >= 0) view.next.forEach((step, offset) => { picks[nextAt + 1 + offset] = STEP_PICK[step.kind]; });
  return { rows, picks };
}

/** The rows of a result the cursor walks, in the order the screen shows them — with its details or without. */
export const resultPicks = (view: ResultView, now: Date, details = false): ResultPick[] =>
  details ? pickedRows(view, { details, now }).picks.filter((pick): pick is ResultPick => pick !== null) : dashboardPicks(view);

/**
 * One run's result (docs/design/ui-spec.md §4.7, §8.5): the rows of the CLI summary — the number and its trust, the topics, why
 * it errs, «Дальше» — retained under details. The default dashboard shows status, counters and actionable rows. Details add what was not measured,
 * the owner's disagreements and the comparison with production. The board lays over them only what a screen of its
 * own knows: the work going on above, how the run before did on the run line, the numbered actions under it all.
 */
export function resultScreen(data: SpaceData, run: { record: Experiment; view: ResultView }, options: { selected: number; details: boolean; actions?: string[] }, width: number): Screen & { picks: ResultPick[] } {
  if (!options.details) return resultDashboard(data, run, options.selected, options.actions ?? [], room(width));
  const { view } = run;
  const w = room(width);
  const { rows, picks: laid } = pickedRows(view, { details: options.details, now: data.now });
  const previous = data.runs[data.runs.indexOf(run) + 1];
  const was = previous ? accuracyParts(previous.view).value : null;
  const before = was && previous ? `было ${was} (${whenText(previous.record.createdAt, data.now)})` : null;
  const line = runLine(view, data.now);
  const body: Line[] = [];
  const going = data.progress?.kind === 'run' && run === data.runs[0] ? data.progress : undefined;
  if (going) body.push(...progressLines(going, w), blank);
  const picks: ResultPick[] = [];
  const items: number[] = [];
  let anchor: number | undefined;
  rows.forEach((row, index) => {
    const shown = before && sameRow(row, line) ? { ...row, text: `${row.text} · ${before}`, parts: [...row.parts ?? [], before] } : row;
    const pick = laid[index];
    if (!pick) { body.push(...resultLines([shown], w)); return; }
    const mine = picks.length === options.selected;
    picks.push(pick);
    items.push(body.length);
    if (mine) anchor = body.length;
    body.push(...resultLines([mine ? { ...shown, indent: 0, text: `${GLYPH.selected} ${shown.text}` } : shown], w).map(laidOut => mine ? laidOut.map(part => ({ ...part, bold: true })) : laidOut));
  });
  const actions = options.actions ?? [];
  if (actions.length) body.push(blank, ...wsLines([ws('actions', actions.map((label, index) => `${index + 1} ${label}`).join('  ·  '), 1, { clip: true })], w));
  return { head: [], body, picks, items, ...(anchor !== undefined ? { anchor } : {}), foot: [{ key: 'd', text: 'к сводке' }, { key: '↑↓', text: 'выбрать' }, { key: 'Enter', text: 'открыть' }, { key: 'PgDn', text: 'ниже' }, { key: 'Esc', text: 'назад' }] };
}

/** The spinner of the progress row: the frames of Pi's own Loader; the workspace turns it while work goes on. */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** The progress row of work going on (docs/design/ui-spec.md §4.6): the line and the bar come from the record; a bar only when there is room for one. */
export function progressLines(progress: NonNullable<SpaceData['progress']>, width: number): Line[] {
  const frame = progress.frame ?? 0;
  // The line is made of the record's own words (its message, a stop's reason): escaped like every other record text.
  const text = ` ${safeLine(progress.text)}`;
  const bar = progress.share === null ? 0 : Math.min(40, width - visibleWidth(text) - 6);
  const filled = Math.round(Math.max(0, bar) * Math.max(0, Math.min(1, progress.share ?? 0)));
  return [[{ text: ' ' }, { text: SPINNER[frame % SPINNER.length]!, tone: 'accent' }, { text, tone: 'text', bold: true },
    ...(bar >= 10 ? [{ text: '  ' }, { text: GLYPH.barFill.repeat(filled), tone: 'accent' as const }, { text: GLYPH.barTrack.repeat(bar - filled), tone: 'muted' as const }] : [])]];
}

/** «Проблемы» (docs/design/ui-spec.md §8.6): the repeating problems, in the agent first, then in the test. */
export function problemsScreen(data: SpaceData, selected: number, width: number): Screen {
  const w = room(width);
  const body: Line[] = [...wsLines([ws('answer', problemsLine(data.problems)),
    ...(data.problems.length ? [ws('muted', 'У каждой — ситуации и дословные ответы агента. Разовые ошибки — в «Прогонах».')] : [])], w)];
  const items: number[] = [];
  let anchor: number | undefined;
  let number = 0;
  for (const side of ['agent', 'test'] as const) {
    const own = data.problems.filter(problem => problem.side === side);
    if (!own.length) continue;
    body.push(blank, ...wsLines([ws('heading', side === 'agent' ? 'Проблема в агенте' : 'Проблема в тесте')], w));
    for (const problem of own) {
      const mine = number === selected;
      number++;
      items.push(body.length);
      if (mine) anchor = body.length;
      body.push(...wsLines([ws(mine ? 'selected' : 'text', `${mine ? '›' : ' '} ${String(number).padEnd(2)} ${problem.title}`, 1, { clip: true, right: { role: 'muted', text: problemSize(problem) } }),
        ...(mine && problem.trialId ? [ws('actions', '1 Открыть разговор', 6)] : [])], w));
    }
  }
  return { head: [], body, foot: FOOT.area, items, ...(anchor !== undefined ? { anchor } : {}) };
}

/* ───────────────────────────── the first run ───────────────────────────── */

/** Where what the work makes appears, said on the step of the run, and that closing the board does not stop it. */
const WORK_HINT: Record<WorkKind, string> = {
  preparation: 'Готовые ситуации появляются в «Ситуациях» по ходу подготовки. Доску можно закрыть — подготовка продолжится.',
  check: 'Статус изменённых ситуаций в «Ситуациях» обновится сам. Доску можно закрыть — проверка продолжится.',
  run: 'Первые ответы уже видны в «Результате». Доску можно закрыть — прогон продолжится.',
};
/** The same, said among the situations themselves. */
const HERE_HINT: Record<Exclude<WorkKind, 'run'>, string> = {
  preparation: 'Готовые ситуации появляются здесь по ходу подготовки. Доску можно закрыть — подготовка продолжится.',
  check: 'Статус изменённых ситуаций обновится сам. Доску можно закрыть — проверка продолжится.',
};

/**
 * «Прогон» before the first result (docs/design/ui-spec.md §4.6): what a run of the ready situations will be, in the very words
 * of the run dialog Enter opens — one description of the plan, never two —; or the work going on, which Enter stops.
 */
export function runStepScreen(data: SpaceData, width: number, details = false): Screen {
  const w = room(width);
  const work = data.progress;
  if (work?.kind === 'run' && data.set) return { head: [], body: runPanel(data, width, details),
    foot: [{ key: '→', text: 'результат' }, ...(work.stoppable ? [{ key: 'Enter', text: 'остановить' }] : []), { key: 'Esc', text: 'закрыть' }] };
  if (work) return { head: [], body: [...(work.kind === 'run' ? [] : [...wsLines([ws('answer', work.kind === 'preparation' ? 'Запустить можно, когда подготовка закончится.' : 'Запустить можно, когда проверка закончится.')], w), blank]),
    ...progressLines(work, w), ...wsLines([ws('muted', WORK_HINT[work.kind], 3)], w)],
  foot: [...(work.stoppable ? [{ key: 'Enter', text: 'остановить' }] : []), work.kind === 'run' ? { key: '→', text: 'результат' } : { key: '←', text: 'ситуации' }, { key: 'Esc', text: 'закрыть' }] };
  const set = data.set;
  if (!set?.plan.situations || !set.launch) {
    const waiting = set?.views.filter(view => view.status === 'needs_owner').length ?? 0;
    return { head: [], body: wsLines([ws('answer', waiting ? `Нечего запускать: ответьте на ${countText(waiting, ['вопрос', 'вопроса', 'вопросов'])} в «Ситуациях».` : 'Нечего запускать: готовых ситуаций пока нет.')], w),
      foot: [{ key: '←', text: 'ситуации' }, { key: 'Esc', text: 'закрыть' }] };
  }
  return { head: [], body: runPanel(data, width, details),
    foot: [{ key: 'Enter', text: 'к запуску' }, { key: '←', text: 'ситуации' }, { key: 'd', text: details ? 'скрыть параметры' : 'параметры' }, { key: 'Esc', text: 'закрыть' }] };
}

/* ───────────────────────────── open objects ───────────────────────────── */

/** One situation open (docs/design/ui-spec.md §4.3–4.5): its brief, its question or its actions, and «d» when asked. */
export function situationScreen(view: SituationView, options: { details: boolean; running: boolean; editable: boolean }, width: number): Screen {
  const actions = options.editable ? situationActions(view) : [];
  const rows = [...briefRows(view, { running: options.running, narrow: width < 70 }),
    ...(actions.length && !view.question?.choices.length ? [{ role: 'blank' as const, indent: 0, text: '' }, actionRow(actions)] : []),
    ...(options.details ? [{ role: 'blank' as const, indent: 0, text: '' }, ...detailRows(view)] : [])];
  const answering = actions.length && view.question?.choices.length;
  const foot: Hint[] = [...(actions.length ? [{ key: '1–3', text: answering ? 'ответить' : 'действие' }] : []), { key: 'a', text: 'спросить Lab' },
    ...(view.status === 'unusable' ? [] : [{ key: 'd', text: options.details ? 'скрыть проверку' : 'как это проверяется' }]), { key: 'Esc', text: 'назад' }];
  return { head: [], body: options.details ? situationLines(rows, room(width)) : situationExplanation(view, room(width), options.editable), foot };
}

/** The keys of the answers, after the question or the owner's answer. */
const ANSWER_KEYS = '1 да · 2 нет · 3 не знаю';
/** Why a conversation carries no question about the judge. */
const NOT_ASKED = { control: 'Контрольная ситуация: в проверку судьи не входит.', unmeasured: 'Ситуация не измерена: соглашаться не с чем.',
  undecided: 'Судья не вынес решения: соглашаться не с чем.' } as const;

/**
 * One conversation the judge decided (docs/design/ui-spec.md §4.8): a failure as expected → the agent's words → the rule → the
 * conversation; a pass drawn for a double-check the same way. Then the question to the owner, or their answer.
 */
export function judgedScreen(run: { record: Experiment; view: ResultView }, trialId: string, answer: Answer | undefined, place: { at: number; of: number } | undefined, width: number, details = false): Screen {
  const { record, view } = run;
  const w = room(width);
  const index = view.failures.findIndex(failure => failure.trialId === trialId);
  const trial = record.trials.find(item => item.id === trialId);
  if (details && trial) return { head: [], body: trialTrace(trial, w), foot: [{ key: 'd', text: 'к оценке' }, { key: 'PgUp/PgDn', text: 'листать' }, { key: 'Esc', text: 'назад' }] };
  const scenario = trial && record.scenarios.find(item => item.id === trial.scenarioId);
  let rows: ResultRow[];
  if (index >= 0) {
    // The explanation of result-text.ts, whole; its closing question — and the blank row before it — make way for the
    // board's own, which carries the keys of the answers and the owner's answer once given.
    rows = failureRows(view, record, index);
    const asked = rows.findIndex(row => row.role === 'next:first');
    if (asked >= 0) rows = rows.slice(0, rows[asked - 1]?.role === 'blank' ? asked - 1 : asked);
  } else {
    const brief = scenario ? situationBrief(record, scenario) : undefined;
    const said = trial?.events.filter(event => event.type === 'assistant' && oneLine(event.text ?? '')).at(-1);
    const label = (name: string, text: string): ResultRow => ({ role: 'item', indent: 4, text: `${name.padEnd(16)}${text}`, hang: 16 });
    const passed = view.cards.find(card => card.scenarioId === trial?.scenarioId)?.outcome === 'pass';
    rows = [{ role: passed ? 'good' : 'muted', indent: 0, text: `${passed ? GLYPH.pass : '?'} ${oneLine(scenario?.title ?? '')}`, right: passed ? 'справился' : 'разговор' }, { role: 'blank', indent: 0, text: '' },
      label('Ожидалось', brief?.must.map(duty => duty.text).join('; ') || 'не записано в ситуации'),
      label('Агент ответил', said ? `«${oneLine(said.text)}»` : 'ответа нет'),
      ...(brief?.must[0]?.rule ? [label('Правило', `«${brief.must[0].rule}»`)] : [])];
  }
  // A failure's explanation holds its conversation already; a pass drawn for a double-check shows it in the same rows.
  const conversationAt = rows.findIndex(row => row.role === 'heading' && row.text === 'Разговор');
  if (conversationAt >= 0) rows = rows.slice(0, conversationAt);
  // The question is about the decision the judge recorded, never about a verdict the owner already changed.
  const target = agreementTarget(record, trial);
  const question = !target && !['results_review', 'complete'].includes(record.phase)
    ? 'Прогон не завершён. Подтвердить оценку судьи можно после завершения прогона.'
    : target?.kind !== 'ready' ? NOT_ASKED[target?.kind ?? 'undecided']
    : answer ? `Ваш ответ: ${ANSWER_TEXT[answer]}. Изменить: ${ANSWER_KEYS}` : `${judgeQuestionText(target.judgeVerdict)}   ${ANSWER_KEYS}`;
  const wide = w >= 100;
  const leftWidth = wide ? Math.floor(w * 0.42) : w;
  const rightWidth = wide ? w - leftWidth - 2 : w;
  const evidence: Line[] = [];
  for (const item of rows.slice(1)) {
    const label = ['Ожидалось', 'Агент ответил', 'Правило', 'Клиент'].find(label => item.text.startsWith(label.padEnd(16)));
    if (label) evidence.push(panelRow(label.toLocaleUpperCase('ru'), 'muted', true), ...panelWrap(item.text.slice(16), leftWidth - 4), []);
    else evidence.push(...resultLines([{ ...item, indent: 0 }], leftWidth - 4));
  }
  const messages: Line[] = [];
  for (const [i, turn] of trialTurns(trial).entries()) messages.push(
    panelRow(`${String(i + 1).padStart(2, '0')}  ${turn.who.toLocaleUpperCase('ru')}`, turn.who === 'Агент' ? 'accent' : 'muted', true),
    ...panelWrap(turn.text, rightWidth - 4), []);
  if (!messages.length) messages.push(...panelWrap('Реплики в этом разговоре не сохранены.', rightWidth - 4, 'muted'));
  const left = box('ОЖИДАНИЯ И ОСНОВАНИЯ', evidence, leftWidth);
  const right = box('РАЗГОВОР С АГЕНТОМ', messages, rightWidth);
  const body: Line[] = [...resultLines(rows.slice(0, 1), w), [],
    ...box('ПРОВЕРКА ОЦЕНКИ', panelWrap(question, w - 4, target?.kind === 'ready' ? 'accent' : 'muted'), w), [],
    ...(wide ? beside(left, right, leftWidth) : [...left, [], ...right])];
  if (place) body.unshift(...wsLines([ws('muted', `Проверка судьи: ${place.at} из ${place.of}`)], w), blank);
  return { head: [], body, foot: [...(target?.kind === 'ready' ? [{ key: '1–3', text: 'ответить' }] : []), { key: 'd', text: 'инструменты и источники' }, { key: 'a', text: 'спросить Lab' }, { key: '↑↓', text: 'листать' }, { key: 'Esc', text: 'назад' }] };
}

/**
 * One situation that disagrees with production, opened from «Сверка с продом» (docs/design/card-v2-spec.md §10.5): what the
 * calibration says of it, the run's attempt it compared and the logged conversation, then the question about the judge's
 * reading of the log — or the owner's answer. The answer lands on the log's side, never on the run's conversation.
 */
export function logScreen(data: SpaceData, run: { record: Experiment; view: ResultView }, cardId: string, width: number): Screen {
  const w = room(width);
  const item = run.view.calibration?.disagreements.find(entry => entry.cardId === cardId);
  if (!item) return { head: [], body: wsLines([ws('muted', 'Эта ситуация больше не расходится с продом.')], w), foot: [{ key: 'Esc', text: 'назад' }] };
  const logged = data.logged?.get(logKey(item.log));
  const rows = logDisagreementRows(item, { title: true, attempt: trialTurns(run.record.trials.find(trial => trial.id === item.trialIds[0])), ...(logged ? { log: logged } : {}) });
  const targets = logTargets(run.record, cardId);
  const answer = logAnswerOf(run.record, targets);
  const question = !targets.length ? 'Судья не вынес решения по разговору из логов: соглашаться не с чем.'
    : answer ? `Ваш ответ: ${ANSWER_TEXT[answer]}. Изменить: ${ANSWER_KEYS}` : `${logQuestionText(targets)}   ${ANSWER_KEYS}`;
  const body = [...resultLines(rows, w), ...(logged ? [] : [blank, ...wsLines([ws('muted', 'Разговор из логов показывается у последнего прогона со сверкой.', 5)], w)]), blank,
    ...wsLines([ws(answer || !targets.length ? 'muted' : 'accent', question)], w)];
  return { head: [], body, foot: [...(targets.length ? [{ key: '1–3', text: 'ответить' }] : []), { key: 'a', text: 'спросить Lab' }, { key: '↑↓', text: 'листать' }, { key: 'Esc', text: 'назад' }] };
}

/** «Все прогоны» (docs/design/ui-spec.md §8.5): each run by its date, version and result, with the result before it. */
export function allRunsScreen(data: SpaceData, selected: number, width: number): Screen {
  const w = room(width);
  const body: Line[] = [...wsLines([ws('answer', 'Все прогоны')], w), blank];
  const items: number[] = [];
  let anchor: number | undefined;
  data.runs.forEach((run, index) => {
    const mine = index === selected;
    const { value, tail } = accuracyParts(run.view);
    const previous = data.runs[index + 1];
    const was = previous ? accuracyParts(previous.view).value : null;
    const result = value ? `${value} — ${run.view.headline.passed} из ${run.view.headline.decided}` : lowerFirst(tail);
    const version = run.record.targetVersion ?? run.record.targetRelease;
    items.push(body.length);
    if (mine) anchor = body.length;
    const when = whenText(run.record.createdAt, data.now);
    body.push(...wsLines([ws(mine ? 'selected' : 'text', `${mine ? '›' : ' '} ${(when.charAt(0).toLocaleUpperCase('ru') + when.slice(1)).padEnd(18)}${version ? `версия ${clip(oneLine(version), 20)}`.padEnd(22) : ''.padEnd(22)}${result}`, 1,
      { clip: true, ...(was ? { right: { role: 'muted', text: `было ${was}` } } : {}) })], w));
  });
  return { head: [], body, foot: FOOT.list, items, ...(anchor !== undefined ? { anchor } : {}) };
}

/** One problem open (docs/design/ui-spec.md §8.6): its size and topics, what the agent said, the conversation to open. */
export function problemScreen(problem: Problem, number: number, width: number): Screen {
  const w = room(width);
  const facts = [countText(problem.situations.length, ['ситуация', 'ситуации', 'ситуаций']), ...(problem.runsInRow > 1 ? [`в ${problem.runsInRow} прогонах подряд`] : []),
    ...(problem.topics.length ? [`${pluralForm(problem.topics.length, ['тема', 'темы', 'темы'])}: ${problem.topics.join(', ')}`] : [])];
  const body = wsLines([
    ws('answer', `${String(number).padEnd(2)} ${problem.title}`, 1, { clip: true, right: { role: problem.side === 'agent' ? 'warning' : 'muted', text: problem.side === 'agent' ? 'проблема в агенте' : 'проблема в тесте' } }),
    ws('muted', facts.join(' · '), 4),
    ws('blank', ''),
    ws('heading', problem.side === 'agent' ? 'Наблюдение' : 'Ситуации'),
    ...(problem.side === 'agent' && problem.observations.length ? problem.observations.map(item => ws('text', `«${item.quote}» — ситуация «${item.title}»`, 4, { hang: 2 }))
      : problem.situations.map(item => ws('text', item.title, 4, { hang: 2 }))),
    ...(problem.trialId ? [ws('blank', ''), ws('actions', '1 Открыть разговор')] : []),
  ], w);
  return { head: [], body, foot: [...(problem.trialId ? [{ key: '1–3', text: 'действие' }] : []), { key: 'a', text: 'спросить Lab' }, { key: '↑↓', text: 'листать' }, { key: 'Esc', text: 'назад' }] };
}

/** The eight keys (docs/design/ui-spec.md §5). */
export function helpScreen(width: number): Screen {
  const key = (keys: string, text: string) => ws('text', `${keys.padEnd(9)}${text}`, 4, { hang: 9 });
  return { head: [], body: wsLines([ws('answer', 'Клавиши'), ws('blank', ''),
    key('↑ ↓', 'выбрать строку; в открытой ситуации или разговоре — листать'),
    key('Enter', 'открыть или сделать то, что написано в строке'),
    key('Esc', 'назад; в начале — закрыть (прогон продолжится)'),
    key('← →', 'области; до первого результата — шаги'),
    key('1 2 3', 'действие у выбранного или ответ на вопрос'),
    key('a', 'спросить Lab про выбранное'),
    key('d', 'как это проверяется — для разработчика'),
    key('?', 'эта подсказка'),
    ws('blank', ''),
    ws('muted', 'Всё то же можно сказать словами в чате: «покажи вторую ситуацию», «запусти готовые».'),
    ws('muted', 'Судья — модель, которая читает разговор и решает, справился ли агент.')], room(width)), foot: [{ key: 'Esc', text: 'назад' }] };
}

/** The folder with nothing in it yet (docs/design/ui-spec.md §4.9): what Lab does, and the two ways to begin. */
export function startScreen(selected: number, width: number): Screen {
  // Each choice with its note beside it when every note fits its line; otherwise every note under its choice, wrapped, never cut.
  const choices = [['Проверить своего агента', 'нужна папка агента и, если есть, файл с разговорами'], ['Учебный пример', 'без модели и ключей, 1 минута']] as const;
  const beside = choices.every(([, note]) => 1 + 32 + visibleWidth(note) <= room(width));
  const choice = ([label, note]: readonly [string, string], index: number): LayoutRow<WsRole>[] => {
    const head = `${index === selected ? '›' : ' '} ${label}`;
    const role: WsRole = index === selected ? 'selected' : 'text';
    return beside ? [ws(role, `${head.padEnd(32)}${note}`)] : [ws(role, head), ws('muted', note, 3)];
  };
  return { head: wsLines([ws('answer', 'Agent Lab — насколько хорош ваш агент')], room(width)),
    body: wsLines([ws('muted', 'Lab разыграет с агентом ситуации из ваших разговоров и скажет, где и почему он ошибается.'), ws('blank', ''),
      ...choices.flatMap(choice)], room(width)),
    anchor: 2, foot: [{ key: '↑↓', text: 'выбрать' }, { key: 'Enter', text: 'начать' }, { key: 'Esc', text: 'закрыть' }] };
}

/** Several agents in one folder (docs/design/ui-spec.md §8.2): each with its version, its latest result and the decisions it waits for. */
export function agentsScreen(spaces: readonly { space: AgentSpace; result: string | null; decisions: number }[], selected: number, width: number, now: Date): Screen {
  const w = room(width);
  const body: Line[] = [];
  spaces.forEach((item, index) => {
    const mine = index === selected;
    const latest = item.space.runs[0];
    const version = item.space.demo ? 'учебный пример' : item.space.version ? `версия ${item.space.version}` : '';
    body.push(...wsLines([ws(mine ? 'selected' : 'text', `${mine ? '›' : ' '} ${clip(item.space.name, 28).padEnd(28)}${clip(version, 22).padEnd(22)}${item.result && latest ? `${item.result} — ${whenText(latest.createdAt, now)}` : ''}`, 1,
      { clip: true, ...(item.decisions ? { right: { role: 'warning', text: `нужно ваше решение: ${item.decisions}` } } : {}) })], w));
  });
  const last = spaces.length;
  body.push(blank, ...wsLines([ws(selected === last ? 'selected' : 'text', `${selected === last ? '›' : ' '} Проверить нового агента`)], w));
  return { head: wsLines([ws('answer', 'Agent Lab'), ws('muted', 'Агенты в этой папке')], w), body, foot: [{ key: '↑↓', text: 'выбрать' }, { key: 'Enter', text: 'открыть' }, { key: 'Esc', text: 'закрыть' }],
    anchor: Math.min(selected, last) };
}
