import { keyHint, type Theme } from '@earendil-works/pi-coding-agent';
import { Text, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import type { AgentToolResult, ToolRenderResultOptions } from '@earendil-works/pi-coding-agent';
import { verdictBlockRows } from '../../src/verdict.js';
import type { ResultView } from '../../src/result-view.js';
import { safeText, shortId } from '../../src/text.js';
import { renderRows, type PaintTheme, type Row } from './theme.ts';

/*
 * The chat verdict block (04-UI-SPEC B1–B4) and its tool host. One component draws the block for
 * every host from the same `ResultView`; the session file (0644) holds only ids (REV-01): the view
 * is kept in memory while Pi runs and, from plan 04-03 on, rebuilt from the 0600 run record.
 */

export const VERDICT_KIND = 'agent-lab/verdict';

/** What `agent_lab_run` stores in the session: a kind, a version and two ids — never a quote, a title or a number. */
export interface VerdictDetails { kind: typeof VERDICT_KIND; version: 1; runId: string; resultKey: string }

/** Only this exact shape is drawn as the block; every other `details` (old sessions, other tools) keeps the legacy look (T-04-02). */
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

/** Drop every remembered view (tests, and a reopened session before 04-03 starts with nothing here). */
export function forgetViews(): void {
  views.clear();
}

/** The view for a stored result: the remembered one, or null when there is none to draw from (04-03 adds the record rebuild here). */
export function viewFor(details: VerdictDetails): ResultView | null {
  return views.get(details.resultKey) ?? null;
}

/** C-190: the honest row when the block cannot be drawn from what the session holds. */
const missingRunText = (runId: string): string => `Прогон ${shortId(runId)} не найден в .agent-lab — блок нельзя показать.`;

/**
 * The verdict block as a pi-tui component. The plain rows are built once, in the constructor, so a
 * failing view fails inside the host's try/catch and never inside Pi's render loop. The hint is
 * Pi's own styled `keyHint` text (or a fixed string in tests), so it is not escaped again.
 */
export class VerdictBlock implements Component {
  private readonly rows: Row[];
  constructor(view: ResultView, private readonly expanded: boolean, private readonly theme: PaintTheme, private readonly hint: (expanded: boolean) => string) {
    this.rows = verdictBlockRows(view, { expanded, runId: view.runId, surface: 'chat' });
  }
  invalidate(): void {}
  render(width: number): string[] {
    return [...renderRows(this.rows, this.theme, width), ...wrapTextWithAnsi(this.hint(this.expanded), width)];
  }
}

type LegacyRenderer = (result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme) => Component;

/** The first text part of a tool result: what Pi itself would show if the renderer failed. */
function contentText(result: AgentToolResult<unknown>): string {
  return result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
}

/**
 * The tool host (B3, B4): verdict details with a remembered view give the block; verdict details
 * without one give the C-190 row; anything else goes to the unchanged legacy renderer. A throw anywhere
 * ends as the escaped content text, never as an exception inside Pi (T-04-05).
 */
export function renderAgentLabResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, legacy: LegacyRenderer): Component {
  try {
    const details: unknown = result.details;
    if (isVerdictDetails(details)) {
      const view = viewFor(details);
      if (!view) return new Text(theme.fg('warning', safeText(missingRunText(details.runId))), 0, 0);
      return new VerdictBlock(view, options.expanded, theme, expanded => keyHint('app.tools.expand', expanded ? 'свернуть' : 'подробнее'));
    }
    return legacy(result, options, theme);
  } catch {
    return new Text(safeText(contentText(result)), 0, 0);
  }
}
