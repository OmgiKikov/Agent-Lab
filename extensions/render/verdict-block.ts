import { type Theme } from '@earendil-works/pi-coding-agent';
import { type Component } from '@earendil-works/pi-tui';
import type { AgentToolResult, ToolRenderResultOptions } from '@earendil-works/pi-coding-agent';
import { chatBlock, fitRows, type ResultRow } from '../../src/result-text.js';
import type { ResultView } from '../../src/result-view.js';
import { expandHint, hintLines, lineBody } from './feed.ts';
import { GLYPH, paint, renderRows, type PaintTheme, type Row, type Tone } from './theme.ts';

/*
 * The result of a run in the chat (docs/design/ui-spec.md §4.10): the same rows the workspace and the CLI lay out, under the
 * branch sign of the action that produced it. The details a session keeps hold only ids (REV-01): the view is kept in
 * memory while Pi runs.
 *
 * A reopened session (or a result message of an earlier one) has no view in memory, but its content — what the model
 * read — carries `lines`: the result screen's own words, laid out by result-text.ts. They are already in the session
 * file, so drawing them adds nothing to it; they are checked for shape, escaped like every row and drawn plainly: the
 * number and its trust under the branch, everything else on ctrl+o. Without them, one honest row.
 */

export const VERDICT_KIND = 'agent-lab/verdict';

/** What a result stores in the session: a kind, a version and two ids — never a quote, a title or a number. */
export interface VerdictDetails { kind: typeof VERDICT_KIND; version: 1; runId: string; resultKey: string }

/** Only this exact shape is drawn as the block. */
export function isVerdictDetails(value: unknown): value is VerdictDetails {
  if (!value || typeof value !== 'object') return false;
  const details = value as Partial<VerdictDetails>;
  return details.kind === VERDICT_KIND && details.version === 1 && typeof details.runId === 'string' && typeof details.resultKey === 'string';
}

/** The last views produced in this process, by result key; enough for a session's worth of runs. */
const VIEW_CACHE_SIZE = 20;
const views = new Map<string, ResultView>();

/** Remember the view a result was produced with, so the block can be drawn from ids alone. */
export function rememberView(resultKey: string, view: ResultView): void {
  views.delete(resultKey);
  views.set(resultKey, view);
  for (const key of views.keys()) {
    if (views.size <= VIEW_CACHE_SIZE) break;
    views.delete(key);
  }
}

/** Drop every remembered view (tests; a reopened session starts with nothing here). */
export function forgetViews(): void {
  views.clear();
}

/** The view for a stored result: the remembered one, or null when there is none to draw from. */
export function viewFor(details: VerdictDetails): ResultView | null {
  return views.get(details.resultKey) ?? null;
}

/** The honest row when the block cannot be drawn from what the session holds. */
export const MISSING_RESULT = 'Результат не хранится в сессии — попросите показать его ещё раз.';

/**
 * The block under the branch sign: the answer first, the trust line and the causes in the column of its text. The chat's
 * rows are shifted left by their own indent step, so every line after the first stands under the answer.
 */
function underBranch(rows: ResultRow[]): ResultRow[] {
  return rows.map(row => row.indent >= 2 ? { ...row, indent: row.indent - 2 } : row);
}

/** Columns before the laid-out rows: two spaces and the branch sign on the first line, three spaces on the rest (each laid-out line keeps its own one-column margin). */
const LEAD = 3;

/**
 * The result block of the chat as a pi-tui component: the rows of `chatBlock`, laid out by `fitRows` (so the
 * trust line breaks only between its parts) and painted by role. The rows are built once, in the constructor,
 * so a failing view fails inside the host's try/catch and never inside Pi's render loop.
 */
export class VerdictBlock implements Component {
  private readonly rows: ResultRow[];
  constructor(view: ResultView, private readonly expanded: boolean, private readonly theme: PaintTheme, private readonly hint: (expanded: boolean) => string) {
    this.rows = underBranch(chatBlock(view, { expanded }));
  }
  invalidate(): void {}
  render(width: number): string[] {
    const room = Math.max(1, width - LEAD);
    const lines = renderRows(fitRows(this.rows, room), this.theme, room);
    return [...lines.map((line, index) => (index ? ' '.repeat(LEAD) : `  ${paint({ text: GLYPH.branch, tone: 'muted' }, this.theme)}`) + line),
      ...hintLines(this.hint(this.expanded), width)];
  }
}

/** At most this many stored lines are drawn, each at most this many characters: a result screen never comes near either. */
const STORED_LINES = 400, STORED_CHARACTERS = 2000;

/**
 * The lines of a result as its content stored them (model-output.ts `resultOutput`): an array of short strings, else
 * null. The content is data read back from a file: only this shape is drawn, never anything else of it.
 */
export function storedLines(result: Pick<AgentToolResult<unknown>, 'content'>): string[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(result.content.filter(part => part.type === 'text').map(part => part.text).join('')); } catch { return null; }
  const stored = parsed && typeof parsed === 'object' ? (parsed as { lines?: unknown }).lines : undefined;
  if (!Array.isArray(stored) || !stored.length || stored.length > STORED_LINES) return null;
  const lines: string[] = [];
  for (const item of stored) {
    if (typeof item !== 'string' || item.length > STORED_CHARACTERS) return null;
    lines.push(item);
  }
  return lines;
}

/** The stored lines a reopened result shows folded: the alarm or the number and the trust line under it, not the fine print. */
const STORED_HEAD = 3;

/**
 * A result drawn from its stored lines: the start of the screen's head — the number and its trust — under the branch
 * sign, the rest on ctrl+o. The lines keep the one-column margin they were laid out with, as the block's own rows do.
 */
export class StoredVerdict implements Component {
  private readonly head: string[];
  constructor(private readonly lines: string[], private readonly expanded: boolean, private readonly theme: PaintTheme, private readonly hint: (expanded: boolean) => string) {
    const end = lines.findIndex(line => !line.trim());
    this.head = (end < 0 ? lines : lines.filter((_, index) => index < end)).slice(0, STORED_HEAD);
  }
  invalidate(): void {}
  render(width: number): string[] {
    const room = Math.max(1, width - LEAD);
    const shown = this.expanded ? this.lines : this.head;
    const rows: Row[] = shown.map((line, index) => ({ text: line, ...(index ? { tone: 'muted' as const } : { tone: 'text' as const, bold: true }) }));
    const lines = renderRows(rows, this.theme, room);
    return [...lines.map((line, index) => (index ? ' '.repeat(LEAD) : `  ${paint({ text: GLYPH.branch, tone: 'muted' }, this.theme)}`) + line),
      ...(this.lines.length > this.head.length ? hintLines(this.hint(this.expanded), width) : [])];
  }
}

type LegacyRenderer = (result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme) => Component;

/** What ctrl+o opens under a result, and what to say next when something failed. */
export const verdictHint = (view: ResultView) => (expanded: boolean): string => expanded ? expandHint(true, '')
  : view.failures.length ? `${expandHint(false, 'причины с примерами')}${explain(view)}${report(view)}`
    : `${expandHint(false, 'подробнее')}${report(view)}`;
/** The first failure to open by its situation's number — unless the step «Дальше» already names it, one row above. */
const explain = (view: ResultView): string => view.next[0]?.kind === 'review_judge' ? ''
  : ` · «разбери ситуацию ${view.cards.find(card => card.scenarioId === view.failures[0]!.scenarioId)?.number ?? 1}»`;
/** The customer report is suggested only where «Дальше» offers it: never for a number withheld or not to be trusted. */
const report = (view: ResultView): string => view.next.some(step => step.kind === 'report') ? ' · «отчёт для заказчика»' : '';

/**
 * The tool host: verdict details with a remembered view give the block; without one, the result's stored lines give
 * it plainly (a reopened session), and without those, the honest row; anything else goes to `legacy`. A throw anywhere
 * ends as one muted row, never as an exception inside Pi. `onTone` learns the colour of the action's sign.
 */
export function renderAgentLabResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, legacy: LegacyRenderer,
  onTone: (tone: Tone) => void = () => {}): Component {
  try {
    const details: unknown = result.details;
    if (isVerdictDetails(details)) {
      const view = viewFor(details);
      if (!view) {
        const stored = storedLines(result);
        onTone('muted');
        return stored ? new StoredVerdict(stored, options.expanded, theme, expanded => expandHint(expanded, 'подробнее')) : lineBody(MISSING_RESULT, 'warning', theme);
      }
      onTone('success');
      return new VerdictBlock(view, options.expanded, theme, verdictHint(view));
    }
    return legacy(result, options, theme);
  } catch {
    onTone('muted');
    return lineBody('Этот результат не удалось показать — попросите показать его ещё раз.', 'muted', theme);
  }
}
