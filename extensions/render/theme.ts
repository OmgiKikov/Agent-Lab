import type { Theme } from '@earendil-works/pi-coding-agent';
import { safeText } from '../../src/text.js';
import { wrapRows } from '../cards.ts';

/*
 * The one place that paints (04-UI-SPEC «Theme Module», CTX-19/CTX-20). Every row of the chat
 * block, the board tabs and the progress rows goes through `renderRows`: escaping, word wrap and
 * colour happen here and nowhere else. Only the semantic tokens of Pi's `Theme` are used, and
 * width is never measured by hand: `wrapRows` works through `visibleWidth` / `wrapTextWithAnsi`.
 *
 * `safeText` and `wrapRows` still live in `cards.ts` (plan 04-02 moves them here and re-exports them).
 */

/** The only foreground tokens a row may carry. */
export type Tone = 'text' | 'muted' | 'dim' | 'accent' | 'success' | 'warning' | 'error' | 'borderMuted';

/**
 * One row to paint: raw `text` (escaped inside `renderRows`), an explicit `tone`/`bold` or a `role`
 * that ROLE_TONE maps to them, and the indent of the phase-2 hanging-indent rule.
 */
export interface Row { text: string; tone?: Tone; bold?: boolean; indent?: number; role?: string }

/** What a host theme must offer; the test fakes implement all three with distinct markers per token. */
export type PaintTheme = Pick<Theme, 'fg' | 'bold' | 'bg'>;

/**
 * The glyph registry of phases 2–4 (02/03/04-UI-SPEC). Every glyph comes with its word on the row,
 * so a row reads correctly with colours off; no literal glyph appears elsewhere in extensions/render.
 */
export const GLYPH = {
  fail: '✗', pass: '✓', unmeasured: '?', selected: '▸', waiting: '●', control: '◆',
  dot: '·', dash: '—', quoteOpen: '«', quoteClose: '»',
  agree: '=', disagree: '!', unsure: '~', arrow: '→',
  barFill: '━', barTrack: '─',
  fixed: '+', broken: '-', unstable: '*', same: '.', incomparable: '/',
} as const;

/**
 * Row role to token (the UI-SPEC «Row role / token» table): the phase-2 result rows and cause rows, the
 * phase-3 agreement and disagreement rows, and the phase-4 verdict rows. A row without a role
 * and without a tone is printed in the terminal's own colour. No glyph is written here: the
 * lint test allows a literal glyph only inside GLYPH above.
 */
export const ROLE_TONE: Record<string, { tone: Tone; bold: boolean }> = {
  // phase 1–2 result rows (result-view.ts ResultRowRole)
  lead: { tone: 'text', bold: true }, line: { tone: 'muted', bold: false },
  detail: { tone: 'muted', bold: false }, situation: { tone: 'warning', bold: false },
  alarm: { tone: 'error', bold: true },
  // phase 3 agreement rows
  agreement: { tone: 'text', bold: false }, 'agreement-tail': { tone: 'muted', bold: false },
  // phase 2 cause section (result-view.ts SectionRow, explain.ts ExplanationRole)
  cause: { tone: 'accent', bold: false }, example: { tone: 'text', bold: true }, title: { tone: 'error', bold: true },
  expected: { tone: 'text', bold: false }, said: { tone: 'text', bold: false },
  rule: { tone: 'muted', bold: false }, more: { tone: 'muted', bold: false }, violated: { tone: 'muted', bold: false },
  unverified: { tone: 'warning', bold: false },
  // phase 3 disagreement rows (result-view.ts DisagreementRole)
  'dis-title': { tone: 'warning', bold: false }, 'dis-verdicts': { tone: 'text', bold: false }, 'dis-reason': { tone: 'text', bold: false },
  // phase 4 verdict block
  'verdict:good': { tone: 'success', bold: true }, 'verdict:warn': { tone: 'warning', bold: true }, 'verdict:bad': { tone: 'error', bold: true },
  headline: { tone: 'text', bold: false }, next: { tone: 'accent', bold: false },
  heading: { tone: 'accent', bold: true }, pointer: { tone: 'muted', bold: false },
  'no-failures': { tone: 'success', bold: false },
};

/** Bold first, then the foreground token, so the weight sits inside the colour. */
export function paint(row: Row, theme: PaintTheme): string {
  const byRole = row.role === undefined ? undefined : ROLE_TONE[row.role];
  const tone = row.tone ?? byRole?.tone;
  const bold = row.bold ?? byRole?.bold ?? false;
  const value = bold ? theme.bold(row.text) : row.text;
  return tone === undefined ? value : theme.fg(tone, value);
}

/**
 * Every host prints its rows through this one function: `safeText` on every text, word wrap with
 * the hanging indent, then paint. Nothing is cut and no `…` is produced; no line is wider than `width`.
 */
export function renderRows(rows: Row[], theme: PaintTheme, width: number): string[] {
  const safe = rows.map(row => ({ ...row, text: safeText(row.text) }));
  return (wrapRows(safe, width) as Row[]).map(row => paint(row, theme));
}
