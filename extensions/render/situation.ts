import type { SituationRole, SituationRow } from '../../src/card/view.js';
import type { Row, Tone } from './theme.ts';

/*
 * A situation's rows (src/card/view.ts) in the chat and on the board: each role gets its theme token
 * (ui-spec §6) — the chip by its status, the headings in accent, the source, the rules and the reasons
 * muted, the question as a warning, «d» dim. Layout stays in src; this only names the colours.
 */

export const SITUATION_TONE: Record<SituationRole, { tone?: Tone; bold: boolean }> = {
  title: { tone: 'text', bold: false }, selected: { tone: 'text', bold: true }, line: { tone: 'text', bold: false },
  source: { tone: 'muted', bold: false }, heading: { tone: 'accent', bold: true }, field: { tone: 'text', bold: false },
  rule: { tone: 'muted', bold: false }, question: { tone: 'warning', bold: false }, choice: { tone: 'text', bold: false },
  problem: { tone: 'muted', bold: false }, actions: { tone: 'accent', bold: false }, detail: { tone: 'dim', bold: false },
  change: { tone: 'text', bold: false }, blank: { bold: false },
  'chip:ready': { tone: 'success', bold: false }, 'chip:ask': { tone: 'warning', bold: false },
  'chip:unusable': { tone: 'muted', bold: false }, 'chip:checking': { tone: 'muted', bold: false },
};

/**
 * The rows the chat feed paints. The feed has no left margin of its own, so the situation layout's one-column
 * margin becomes part of each indent, and the value column of a brief hangs from there.
 */
export function situationRows(rows: readonly SituationRow[]): Row[] {
  return rows.map(row => {
    const { tone, bold } = SITUATION_TONE[row.role];
    const right = row.right && SITUATION_TONE[row.right.role].tone;
    return { text: row.text, ...(tone ? { tone } : {}), bold, indent: row.indent + 1,
      ...(row.hang !== undefined ? { hang: row.indent + 1 + row.hang } : {}),
      ...(row.right && right ? { right: { text: row.right.text, tone: right } } : {}), ...(row.clip ? { clip: true } : {}) };
  });
}
