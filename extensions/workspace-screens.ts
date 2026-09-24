import { visibleWidth } from '@earendil-works/pi-tui';
import type { Experiment } from '../src/contracts.js';
import { actionRow, briefRows, countsText, detailRows, formatNote, layoutRows, listRows, situationActions, situationBrief, type LayoutRow, type SituationRow, type SituationView } from '../src/card/view.js';
import type { Decision } from '../src/inbox.js';
import { decisionsLine } from '../src/inbox.js';
import { problemSize, problemsLine, type Problem } from '../src/problems.js';
import { accuracyParts, causeRows, disagreementRows, errorListRows, failureRows, fitRows, headRows, MAX_WIDTH, nextStepText, runLine, topicRows, unmeasuredRows, whenText, type ResultRow } from '../src/result-text.js';
import type { ResultView } from '../src/result-view.js';
import { countText, pluralForm } from '../src/plural.js';
import { clip, oneLine, safeText } from '../src/text.js';
import type { AgentSpace } from '../src/workspace.js';
import type { LaunchPlan } from './conversation.ts';
import { SITUATION_TONE } from './render/situation.ts';
import { GLYPH, ROLE_TONE, type Tone } from './render/theme.ts';
import { agreementTarget, type Answer } from './judge-review.ts';

/*
 * The screens of the agent's workspace (ui-spec §4, §8), as lines ready to paint: the header with the areas — or the
 * steps of a first run —, the answer of the screen first, then its list or its open object, and one row of key hints.
 * Situations are laid out by the shared projection (src/card/view.ts), results by result-text.ts, so the workspace
 * says exactly what the chat and the CLI say. Pure: no I/O, no painting; widths are the terminal's columns.
 */

export interface Segment { text: string; tone?: Tone; bold?: boolean }
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
  set?: { record: Experiment; views: SituationView[]; editable: boolean; coverage?: { line: string; uncovered: string | undefined }; plan: LaunchPlan; running: boolean };
  /** Finished runs with their result, newest first. */
  runs: { record: Experiment; view: ResultView }[];
  decisions: Decision[];
  problems: Problem[];
  /** Work going on now: its one progress line, how far it got, whether this session can stop it; `frame` turns the spinner. */
  progress?: { text: string; share: number; stoppable: boolean; frame?: number };
  now: Date;
}

export type Area = 'inbox' | 'situations' | 'runs' | 'problems';
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

/** The width the workspace lays out at: the terminal's, never more than the 100 columns of the mockups. */
const room = (width: number) => Math.max(20, Math.min(width, MAX_WIDTH));

/* ───────────────────────────── the header ───────────────────────────── */

const AREA_LABEL: Record<Exclude<Area, 'inbox'>, string> = { situations: 'Ситуации', runs: 'Прогоны', problems: 'Проблемы' };

/** «Агент: агент поддержки» with the version on the right from 100 columns up (ui-spec §6: narrower, the label goes). */
function titleLine(title: string, right: string | null, width: number): Line[] {
  return wsLines([ws('answer', title, 1, { clip: true, ...(right && width >= MAX_WIDTH ? { right: { role: 'muted', text: right } } : {}) })], room(width));
}

/** The areas of the workspace: the queue of decisions first while it has any, the current area in accent. */
export function areasOf(data: SpaceData): Area[] {
  return [...(data.decisions.length ? ['inbox' as const] : []), 'situations', 'runs', 'problems'];
}

function areaLine(data: SpaceData, current: Area, width: number): Line {
  const counts: Record<Exclude<Area, 'inbox'>, number> = { situations: data.set?.views.length ?? 0, runs: data.runs.length, problems: data.problems.length };
  const parts: Segment[] = [{ text: ' ' }];
  const add = (text: string, area: Area, tone: Tone) => {
    if (parts.length > 1) parts.push({ text: '  ·  ', tone: 'muted' });
    parts.push(area === current ? { text, tone: 'accent', bold: true } : { text, tone });
  };
  if (data.decisions.length) add(`Нужно ваше решение: ${data.decisions.length}`, 'inbox', 'warning');
  for (const area of ['situations', 'runs', 'problems'] as const) add(`${AREA_LABEL[area]} ${counts[area]}`, area, 'muted');
  const used = parts.reduce((sum, part) => sum + visibleWidth(part.text), 0);
  // No decision waits: a calm mark on the right instead of the queue.
  const calm = `${GLYPH.pass} решений не ждёт`;
  if (!data.decisions.length && used + visibleWidth(calm) + 2 <= room(width)) parts.push({ text: `${' '.repeat(room(width) - used - visibleWidth(calm))}${calm}`, tone: 'success' });
  return parts;
}

function stepLine(data: SpaceData, current: Step): Line {
  const views = data.set?.views ?? [];
  const ready = views.filter(view => view.status === 'ready').length;
  const result = data.runs[0] ? accuracyParts(data.runs[0].view).value : null;
  const steps: [Step, string][] = [['situations', `Ситуации ${views.length ? `${ready}/${views.length}` : ''}`.trim()],
    ['run', data.progress ? 'Прогон идёт' : 'Прогон'], ['result', `Результат${result ? ` ${result}` : ''}`]];
  return [{ text: ' ' }, ...steps.flatMap(([step, label], index): Segment[] => [...(index ? [{ text: '  ›  ', tone: 'muted' as const }] : []),
    step === current ? { text: label, tone: 'accent', bold: true } : { text: label, tone: 'muted' }])];
}

/** The workspace's two header lines: the agent, then its areas (or, before the first result, the steps). */
export function header(data: SpaceData, place: { area: Area } | { step: Step }, width: number): Line[] {
  const { space } = data;
  const version = space.demo ? 'учебный пример' : space.version ? `версия ${space.version}` : null;
  return 'step' in place ? [...titleLine(`Agent Lab · ${space.name}`, version, width), stepLine(data, place.step)]
    : [...titleLine(`Агент: ${space.name}`, version, width), areaLine(data, place.area, width)];
}

/* ───────────────────────────── the areas ───────────────────────────── */

const FOOT = {
  inbox: [{ key: '↑↓', text: 'выбрать' }, { key: '1–3', text: 'решить' }, { key: 'Enter', text: 'открыть' }, { key: '←→', text: 'области' }, { key: '?', text: 'клавиши' }],
  area: [{ key: '↑↓', text: 'выбрать' }, { key: 'Enter', text: 'открыть' }, { key: '1–3', text: 'действие' }, { key: '←→', text: 'области' }, { key: '?', text: 'клавиши' }],
  list: [{ key: '↑↓', text: 'выбрать' }, { key: 'Enter', text: 'открыть' }, { key: 'Esc', text: 'назад' }],
} satisfies Record<string, Hint[]>;

/** «Нужно ваше решение» (ui-spec §8.3): one decision in three lines — what it is about, one phrase, the actions. */
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
 * «Ситуации»: before the first result (ui-spec §4.2) the counts lead — what is ready, what waits for the owner —; in the
 * workspace (§8.4) the coverage of the logs' topics does. Then three lines a situation; the selected one's question and
 * actions under it.
 */
export function situationsScreen(data: SpaceData, selected: number, width: number, options: { firstRun?: boolean } = {}): Screen {
  const set = data.set;
  const areas: Hint = options.firstRun ? { key: '→', text: 'прогон' } : { key: '←→', text: 'области' };
  if (!set?.views.length) return { head: [], body: wsLines([ws('answer', 'Ситуаций пока нет.'),
    ws('muted', 'Скажите в чате, какого агента проверить и где лежат логи, — Lab соберёт ситуации сам.')], room(width)), foot: [{ key: 'a', text: 'спросить Lab' }, areas, { key: 'Esc', text: 'закрыть' }] };
  const waiting = set.views.some(view => view.status === 'needs_owner');
  const note = !set.editable ? [ws('muted', formatNote(set.record) ?? 'Старый формат: эти ситуации можно посмотреть, но не изменить.')]
    : set.record.trials.length ? [ws('muted', `Ситуации прогона ${whenText(set.record.createdAt, data.now)}; изменения пойдут в новый черновик, прогон не меняется.`)] : [];
  const lead = set.coverage && !options.firstRun ? [ws('answer', set.coverage.line), ...(set.coverage.uncovered ? [ws('muted', set.coverage.uncovered, 3)] : []), ...note]
    : [ws('answer', countsText(set.views)), ...(waiting ? [ws('muted', 'Готовые можно запускать уже сейчас; остальные войдут, когда ответите.')] : note)];
  const body: Line[] = [...wsLines(lead, room(width)), blank];
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
  return { head: [], body, foot, ...(anchor !== undefined ? { anchor } : {}), items };
}

/** What the runs' screen offers besides its rows: the report, another run, every run. */
export function runActions(data: SpaceData): string[] {
  const ready = data.set?.views.filter(view => view.status === 'ready').length ?? 0;
  return ['Отчёт для заказчика', ready ? `Запустить снова — ${countText(ready, ['готовая', 'готовых', 'готовых'])}` : 'Запустить снова', 'Все прогоны'];
}

/** A row of the result screen the cursor can stand on: a cause (or a failure by title) opens its failure; the judge's review opens its queue. */
export type ResultPick = { kind: 'failure'; trialId: string } | { kind: 'review' };

/**
 * One run's result (ui-spec §4.7, §8.5): the number and its trust, the topics, why it errs — each cause a row the
 * cursor can open —, whether the judge still waits for the owner, then the run and its actions. `details`: every
 * error, what was not measured and the owner's disagreements too.
 */
export function resultScreen(data: SpaceData, run: { record: Experiment; view: ResultView }, options: { selected: number; details: boolean; actions?: string[] }, width: number): Screen & { picks: ResultPick[] } {
  const { view } = run;
  const w = room(width);
  const body: Line[] = [];
  if (data.progress && run === data.runs[0]) body.push(...progressLines(data.progress, w), blank);
  body.push(...resultLines(headRows(view), w));
  const topics = topicRows(view);
  if (topics.length) body.push(blank, ...resultLines(topics, w));
  const picks: ResultPick[] = [];
  const items: number[] = [];
  let anchor: number | undefined;
  const pick = (target: ResultPick, row: ResultRow) => {
    const mine = picks.length === options.selected;
    picks.push(target);
    items.push(body.length);
    if (mine) anchor = body.length;
    body.push(...resultLines([mine ? { ...row, indent: 0, text: `${GLYPH.selected} ${row.text}` } : row], w).map(line => mine ? line.map(part => ({ ...part, bold: true })) : line));
  };
  const causes = causeRows(view);
  if (causes.length) {
    body.push(blank);
    const trialOf = (scenarioId: string | undefined) => view.failures.find(failure => failure.scenarioId === scenarioId)?.trialId;
    let item = 0;
    for (const row of causes) {
      if (row.role !== 'item') { body.push(...resultLines([row], w)); continue; }
      const scenarioId = view.topCauses.length ? view.topCauses[item]?.scenarioIds[0] : view.failures[item]?.scenarioId;
      const trialId = trialOf(scenarioId);
      item++;
      if (trialId) pick({ kind: 'failure', trialId }, row); else body.push(...resultLines([row], w));
    }
  }
  const review = view.next.find(step => step.kind === 'review_judge');
  if (review) { body.push(blank, ...resultLines([{ role: 'heading', indent: 0, text: 'Дальше' }], w)); pick({ kind: 'review' }, { role: 'next:first', indent: 2, text: nextStepText(review) }); }
  if (options.details) for (const block of [errorListRows(view), unmeasuredRows(view), disagreementRows(view)]) if (block.length) body.push(blank, ...resultLines(block, w));
  const previous = data.runs[data.runs.indexOf(run) + 1];
  const was = previous ? accuracyParts(previous.view).value : null;
  const line = runLine(view, data.now);
  body.push(blank, ...resultLines([{ ...line, parts: [...line.parts ?? [], ...(was && previous ? [`было ${was} (${whenText(previous.record.createdAt, data.now)})`] : [])],
    text: `${line.text}${was && previous ? ` · было ${was} (${whenText(previous.record.createdAt, data.now)})` : ''}` }], w));
  const actions = options.actions ?? [];
  if (actions.length) body.push(...wsLines([ws('actions', actions.map((label, index) => `${index + 1} ${label}`).join('  ·  '), 1, { clip: true })], w));
  return { head: [], body, picks, items, ...(anchor !== undefined ? { anchor } : {}), foot: FOOT.area };
}

/** The spinner of the progress row: the frames of Pi's own Loader; the workspace turns it while work goes on. */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** The progress row of work going on (ui-spec §4.6): the line and the bar come from the record; a bar only when there is room for one. */
export function progressLines(progress: NonNullable<SpaceData['progress']>, width: number): Line[] {
  const frame = progress.frame ?? 0;
  const text = ` ${progress.text}`;
  const bar = Math.min(40, width - visibleWidth(text) - 6);
  const filled = Math.round(Math.max(0, bar) * Math.max(0, Math.min(1, progress.share)));
  return [[{ text: ' ' }, { text: SPINNER[frame % SPINNER.length]!, tone: 'accent' }, { text, tone: 'text', bold: true },
    ...(bar >= 10 ? [{ text: '  ' }, { text: GLYPH.barFill.repeat(filled), tone: 'accent' as const }, { text: GLYPH.barTrack.repeat(bar - filled), tone: 'muted' as const }] : [])]];
}

/** «Проблемы» (ui-spec §8.6): the repeating problems, in the agent first, then in the test. */
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

/** «Прогон» before the first result (ui-spec §4.6): what will run, the agent, the time and the spending, what stays out; or how it goes. */
export function runStepScreen(data: SpaceData, width: number): Screen {
  const w = room(width);
  if (data.progress) return { head: [], body: [...progressLines(data.progress, w), ...wsLines([ws('muted', 'Первые ответы уже видны в «Результате». Доску можно закрыть — прогон продолжится.', 3)], w)],
    foot: [...(data.progress.stoppable ? [{ key: 'Enter', text: 'остановить' }] : []), { key: '→', text: 'результат' }, { key: 'Esc', text: 'закрыть' }] };
  const set = data.set;
  const plan = set?.plan;
  if (!set || !plan?.situations) {
    const waiting = set?.views.filter(view => view.status === 'needs_owner').length ?? 0;
    return { head: [], body: wsLines([ws('answer', waiting ? `Нечего запускать: ответьте на ${countText(waiting, ['вопрос', 'вопроса', 'вопросов'])} в «Ситуациях».` : 'Нечего запускать: готовых ситуаций пока нет.')], w),
      foot: [{ key: '←', text: 'ситуации' }, { key: 'Esc', text: 'закрыть' }] };
  }
  const record = set.record;
  const attempts = plan.situations ? plan.conversations / plan.situations : 0;
  const field = (label: string, value: string) => ws('text', `${label.padEnd(12)}${value}`, 4, { hang: 12 });
  return { head: [], body: wsLines([
    ws('answer', `Готово к запуску: ${countText(plan.situations, ['ситуация', 'ситуации', 'ситуаций'])}, ${countText(plan.conversations, ['разговор', 'разговора', 'разговоров'])}`),
    ws('muted', attempts > 1 ? `Каждая ситуация — ${countText(attempts, ['разговор', 'разговора', 'разговоров'])}: клиента играет Lab, ответы агента оценивает судья.`
      : 'Клиента играет Lab, ответы агента оценивает судья.'),
    ws('blank', ''),
    field('Агент', record.target.kind === 'unconnected' ? 'ещё не подключён — Lab спросит при запуске' : data.space.name + (data.space.version ? ` · версия ${data.space.version}` : '')),
    field('Займёт', `до ${Math.max(1, Math.round(record.settings.maxDurationMs / 60_000))} мин`),
    field('Расход', record.mode === 'demo' ? 'без модели и оплаты — учебный пример' : `до ${countText(plan.judgeCalls, ['вызова', 'вызовов', 'вызовов'])} судьи — платите только за потраченное`),
    ...(plan.outside ? [field('Не войдут', plan.outside)] : []),
  ], w), foot: [{ key: 'Enter', text: 'запустить' }, { key: '←', text: 'ситуации' }, { key: 'Esc', text: 'закрыть' }] };
}

/* ───────────────────────────── open objects ───────────────────────────── */

/** One situation open (ui-spec §4.3–4.5): its brief, its question or its actions, and «d» when asked. */
export function situationScreen(view: SituationView, options: { details: boolean; running: boolean; editable: boolean }, width: number): Screen {
  const actions = options.editable ? situationActions(view) : [];
  const rows = [...briefRows(view, { running: options.running, narrow: width < 70 }),
    ...(actions.length && !view.question?.choices.length ? [{ role: 'blank' as const, indent: 0, text: '' }, actionRow(actions)] : []),
    ...(options.details ? [{ role: 'blank' as const, indent: 0, text: '' }, ...detailRows(view)] : [])];
  const answering = actions.length && view.question?.choices.length;
  const foot: Hint[] = [...(actions.length ? [{ key: '1–3', text: answering ? 'ответить' : 'действие' }] : []), { key: 'a', text: 'спросить Lab' },
    ...(view.status === 'unusable' ? [] : [{ key: 'd', text: options.details ? 'скрыть проверку' : 'как это проверяется' }]), { key: 'Esc', text: 'назад' }];
  return { head: [], body: situationLines(rows, room(width)), foot };
}

const ANSWER_WORD: Record<Answer, string> = { agree: 'да, судья прав', disagree: 'нет, судья ошибся', unsure: 'не знаю' };
/** Why a conversation carries no question about the judge. */
const NOT_ASKED = { control: 'Контрольная ситуация: в проверку судьи не входит.', unmeasured: 'Ситуация не измерена: соглашаться не с чем.',
  undecided: 'Судья не вынес решения: соглашаться не с чем.' } as const;

/**
 * One conversation the judge decided (ui-spec §4.8): a failure as expected → the agent's words → the rule → the
 * conversation; a pass drawn for a double-check the same way. Then the question to the owner, or their answer.
 */
export function judgedScreen(run: { record: Experiment; view: ResultView }, trialId: string, answer: Answer | undefined, place: { at: number; of: number } | undefined, width: number): Screen {
  const { record, view } = run;
  const w = room(width);
  const index = view.failures.findIndex(failure => failure.trialId === trialId);
  const trial = record.trials.find(item => item.id === trialId);
  const scenario = trial && record.scenarios.find(item => item.id === trial.scenarioId);
  let rows: ResultRow[];
  if (index >= 0) rows = failureRows(view, record, index).filter(row => row.role !== 'next:first');
  else {
    const brief = scenario ? situationBrief(record, scenario) : undefined;
    const said = trial?.events.filter(event => event.type === 'assistant' && oneLine(event.text ?? '')).at(-1);
    const label = (name: string, text: string): ResultRow => ({ role: 'item', indent: 4, text: `${name.padEnd(16)}${text}`, hang: 16 });
    rows = [{ role: 'good', indent: 0, text: `${GLYPH.pass} ${oneLine(scenario?.title ?? '')}`, right: 'справился' }, { role: 'blank', indent: 0, text: '' },
      label('Ожидалось', brief?.must.map(duty => duty.text).join('; ') || 'не записано в ситуации'),
      label('Агент ответил', said ? `«${oneLine(said.text)}»` : 'ответа нет'),
      ...(brief?.must[0]?.rule ? [label('Правило', `«${brief.must[0].rule}»`)] : [])];
  }
  const turns = (trial?.events ?? []).filter(event => (event.type === 'user' || event.type === 'assistant') && oneLine(event.text ?? ''));
  const conversation: ResultRow[] = index >= 0 || !turns.length ? [] : [{ role: 'blank', indent: 0, text: '' }, { role: 'heading', indent: 4, text: 'Разговор' },
    ...turns.map(event => ({ role: 'quote' as const, indent: 6, text: `${(event.type === 'user' ? 'Клиент' : 'Агент').padEnd(9)}${oneLine(event.text)}`, hang: 9 }))];
  // The question is about the decision the judge recorded, never about a verdict the owner already changed.
  const target = agreementTarget(record, trial);
  const question = target?.kind !== 'ready' ? NOT_ASKED[target?.kind ?? 'undecided']
    : answer ? `Ваш ответ: ${ANSWER_WORD[answer]}. Изменить: 1 да · 2 нет · 3 не знаю`
      : `Судья решил: ${target.judgeVerdict === 'fail' ? 'не справился' : 'справился'}. Вы согласны?   1 да · 2 нет · 3 не знаю`;
  const body = [...resultLines([...rows, ...conversation], w), blank, ...wsLines([ws(answer || target?.kind !== 'ready' ? 'muted' : 'accent', question)], w)];
  if (place) body.unshift(...wsLines([ws('muted', `Проверка судьи: ${place.at} из ${place.of}`)], w), blank);
  return { head: [], body, foot: [...(target?.kind === 'ready' ? [{ key: '1–3', text: 'ответить' }] : []), { key: 'a', text: 'спросить Lab' }, { key: '↑↓', text: 'листать' }, { key: 'Esc', text: 'назад' }] };
}

/** «Все прогоны» (ui-spec §8.5): each run by its date, version and result, with the result before it. */
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

/** One problem open (ui-spec §8.6): its size and topics, what the agent said, the conversation to open. */
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

/** The eight keys (ui-spec §5). */
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

/** The folder with nothing in it yet (ui-spec §4.9): what Lab does, and the two ways to begin. */
export function startScreen(selected: number, width: number): Screen {
  const choice = (index: number, label: string, note: string) => ws(index === selected ? 'selected' : 'text', `${index === selected ? '›' : ' '} ${label.padEnd(30)}${note}`, 1, { clip: true });
  return { head: wsLines([ws('answer', 'Agent Lab — насколько хорош ваш агент')], room(width)),
    body: wsLines([ws('muted', 'Lab разыграет с агентом ситуации из ваших разговоров и скажет, где и почему он ошибается.'), ws('blank', ''),
      choice(0, 'Проверить своего агента', 'нужна папка агента и, если есть, файл с разговорами'), choice(1, 'Учебный пример', 'без модели и ключей, 1 минута')], room(width)),
    anchor: 2, foot: [{ key: '↑↓', text: 'выбрать' }, { key: 'Enter', text: 'начать' }, { key: 'Esc', text: 'закрыть' }] };
}

/** Several agents in one folder (ui-spec §8.2): each with its version, its latest result and the decisions it waits for. */
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
