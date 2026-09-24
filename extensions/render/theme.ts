import type { Theme } from '@earendil-works/pi-coding-agent';
import { visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { layoutRows } from '../../src/card/view.js';
import type { ResultRole } from '../../src/result-text.js';
import { safeText } from '../../src/text.js';

/*
 * The one place that paints (ui-spec §6). Every row of the chat, the workspace and the progress row goes
 * through `renderRows`: escaping, word wrap and colour happen here and nowhere else. Only the semantic
 * tokens of Pi's `Theme` are used, and width is never measured by hand: wrapping works through pi-tui's
 * `wrapTextWithAnsi`, a list line is laid out by the shared `layoutRows`.
 */

/** The only foreground tokens a row may carry. */
export type Tone = 'text' | 'muted' | 'dim' | 'accent' | 'success' | 'warning' | 'error' | 'borderMuted';

/** One row to paint: raw `text` (escaped inside `renderRows`), an explicit `tone`/`bold` or a `role` that ROLE_TONE maps to them. */
export interface Row {
  text: string; tone?: Tone; bold?: boolean; indent?: number; role?: string;
  /** The column wrapped lines continue at, when it is not two past the indent: the value column of a brief. */
  hang?: number;
  /** A part aligned to the right edge and never cut, in its own tone: a situation's status chip. */
  right?: { text: string; tone: Tone };
  /** One line cut with «…» instead of wrapped: a line of a list. */
  clip?: true;
  /**
   * A sign before the text in its own tone — GLYPH.action of an action, GLYPH.branch of its summary. The text hangs after it,
   * so a wrapped line starts under the text, never under the sign.
   */
  mark?: { text: string; tone: Tone };
}

/** What a host theme must offer; the test fakes implement all three with distinct markers per token. */
export type PaintTheme = Pick<Theme, 'fg' | 'bold' | 'bg'>;

/**
 * Every glyph a Lab row may draw (ui-spec §6, the chat of §4.10), each next to its word so a row reads
 * with colours off. No literal glyph appears elsewhere in extensions/render.
 */
export const GLYPH = {
  pass: '✓', fail: '✗', unmeasured: '?', selected: '›', dot: '·', dash: '—', quoteOpen: '«', quoteClose: '»', arrow: '→', more: '↓',
  /** The row of one Lab action in the chat, tinted by how it ended. */
  action: '●',
  /** Its summary lines hang from this. */
  branch: '└',
  barFill: '━', barTrack: '─',
} as const;

/** Result rows (src/result-text.ts) by role: the answer coloured by level, the trust line muted, headings in accent (ui-spec §6). */
export const ROLE_TONE: Record<Exclude<ResultRole, 'blank'>, { tone: Tone; bold: boolean }> = {
  'accuracy:good': { tone: 'success', bold: true }, 'accuracy:warn': { tone: 'warning', bold: true },
  'accuracy:bad': { tone: 'error', bold: true }, 'accuracy:none': { tone: 'text', bold: true }, alarm: { tone: 'error', bold: true },
  trust: { tone: 'muted', bold: false }, 'trust:small': { tone: 'warning', bold: false }, reality: { tone: 'muted', bold: false },
  heading: { tone: 'accent', bold: true }, item: { tone: 'text', bold: false }, 'item:muted': { tone: 'muted', bold: false },
  failed: { tone: 'error', bold: true }, quote: { tone: 'text', bold: false }, muted: { tone: 'muted', bold: false },
  next: { tone: 'text', bold: false }, 'next:first': { tone: 'accent', bold: false }, good: { tone: 'success', bold: false },
};

/** Bold first, then the foreground token, so the weight sits inside the colour. */
export function paint(row: Row, theme: PaintTheme): string {
  const byRole = row.role === undefined ? undefined : (ROLE_TONE as Record<string, { tone: Tone; bold: boolean }>)[row.role];
  const tone = row.tone ?? byRole?.tone;
  const bold = row.bold ?? byRole?.bold ?? false;
  const value = bold ? theme.bold(row.text) : row.text;
  return tone === undefined ? value : theme.fg(tone, value);
}

/**
 * A row as plain lines of at most `width` columns: the first at its indent, the rest under its hanging
 * column (two past the indent unless `hang` says otherwise). A terminal too narrow for the hang wraps flush.
 */
export function wrapRow(row: Pick<Row, 'text' | 'indent' | 'hang'>, width: number): string[] {
  const room = Math.max(1, Math.floor(width));
  const indent = row.indent ?? 0;
  const hang = row.hang ?? (indent ? indent + 2 : 0);
  if (!indent && !hang || room <= Math.max(indent, hang) + 1) return wrapTextWithAnsi(row.text, room);
  const [first = '', ...rest] = wrapTextWithAnsi(row.text, room - indent);
  const tail = rest.join(' ');
  return [' '.repeat(indent) + first, ...(tail ? wrapTextWithAnsi(tail, room - hang).map(piece => ' '.repeat(hang) + piece) : [])];
}

/**
 * Every host prints its rows through this one function: `safeText` on every text, word wrap with the
 * hanging indent, then paint. A list line is cut with «…» by the shared layout; nothing else is cut, and
 * no line is wider than `width`.
 */
export function renderRows(rows: Row[], theme: PaintTheme, width: number): string[] {
  return rows.flatMap(raw => {
    const row = { ...raw, text: safeText(raw.text) };
    if (row.mark) {
      // The sign stands in the indent; the text wraps in the room after it and hangs under itself.
      const mark = safeText(row.mark.text);
      const lead = (row.indent ?? 0) + visibleWidth(mark) + 1;
      const lines = wrapRow({ text: row.text, indent: 0, hang: 0 }, Math.max(1, width - lead));
      return lines.map((line, index) => (index ? ' '.repeat(lead) : `${' '.repeat(row.indent ?? 0)}${paint({ text: mark, tone: row.mark!.tone }, theme)} `)
        + paint({ ...row, text: line }, theme));
    }
    if (!row.right && !row.clip) return wrapRow(row, width).map(line => paint({ ...row, text: line }, theme));
    // A list line is laid out in src like every other surface's (cut with «…», the right part never cut); here it is only painted.
    const right = row.right && { role: 'right', text: safeText(row.right.text) };
    return layoutRows([{ role: 'row', indent: row.indent ?? 0, text: row.text, clip: true, ...(right ? { right } : {}) }], width, 0)
      .map(line => paint({ ...row, text: line.text }, theme) + (row.right && line.right ? paint({ text: line.right.text, tone: row.right.tone }, theme) : ''));
  });
}
