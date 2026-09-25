import { stripTerminalSequences, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

/*
 * The rows of a result and their one layout. result-text.ts says what a result says as semantic rows — a role, an
 * indent, a text, an optional right-hand counter or « · » parts —; this module lays them out as plain lines of a given
 * width, so the board, the chat and the CLI wrap identically and Pi only paints. Widths are terminal columns (wide
 * characters count double), never string length; nothing here adds or drops a word. Pure: no I/O, no escaping.
 */

export type ResultRole =
  | 'accuracy:good' | 'accuracy:warn' | 'accuracy:bad' | 'accuracy:none' | 'alarm'
  /** `trust:small` is the trust line with a warning in it — a small sample, unmeasured situations, a judge that built the situations. */
  | 'trust' | 'trust:small' | 'reality' | 'calibration' | 'heading' | 'item' | 'item:muted' | 'failed' | 'quote' | 'muted'
  | 'next' | 'next:first' | 'good' | 'blank';
export interface ResultRow {
  role: ResultRole; indent: number; text: string;
  /** A right-aligned counter that is never cut; `short` replaces it on a narrow screen as « — short» after the text. */
  right?: string; short?: string;
  /** Parts joined by « · »; a long row breaks only between parts, each broken line ending with «·». */
  parts?: string[];
  /** Extra indent of wrapped lines under a label column («Агент ответил   «…»»). */
  hang?: number;
}

/** Wider terminals keep the 100-column layout with margins (docs/design/ui-spec.md §6). */
export const MAX_WIDTH = 100;

/** The empty row between two blocks of a screen. */
export const blank: ResultRow = { role: 'blank', indent: 0, text: '' };

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The runs of spaces and the words between them, in order; only a plain space separates words. */
function tokens(text: string): string[] {
  const out: string[] = [];
  for (const char of text) {
    const last = out.at(-1);
    if (last !== undefined && (last[0] === ' ') === (char === ' ')) out[out.length - 1] = last + char;
    else out.push(char);
  }
  return out;
}

/** The longest head of `word` that fits in `room` columns, at least one grapheme, and the rest; nothing is added or lost. */
function splitWord(word: string, room: number): [string, string] {
  let head = '', used = 0;
  for (const { segment } of graphemes.segment(word)) {
    const width = visibleWidth(segment);
    if (head && used + width > room) break;
    head += segment; used += width;
  }
  return [head, word.slice(head.length)];
}

/**
 * Word-wrap in terminal columns (wide characters count double) without changing the text: lines break only at spaces
 * — the spaces at a break are dropped, the others kept —, a line break of the text stays one, and a word wider than
 * its line is split between its characters with nothing inserted. `width(i)` is the room of the i-th line, so a
 * hanging indent narrows every line after the first.
 */
export function wrapText(text: string, width: (line: number) => number): string[] {
  const lines: string[] = [];
  const room = () => Math.max(1, width(lines.length));
  for (const paragraph of text.split('\n')) {
    let line = '', pending = '';
    for (const token of tokens(paragraph)) {
      if (token[0] === ' ') { pending += token; continue; }
      if (visibleWidth(line + pending + token) <= room()) { line += pending + token; pending = ''; continue; }
      if (line) lines.push(line);
      line = ''; pending = '';
      let rest = token;
      while (visibleWidth(rest) > room()) {
        const [head, tail] = splitWord(rest, room());
        lines.push(head);
        rest = tail;
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

// truncateToWidth closes its ellipsis with style resets for a live terminal; these rows are plain text, painted later by role.
const clipTo = (text: string, width: number) => stripTerminalSequences(truncateToWidth(text, Math.max(1, width), '…'));

/** The « ·» after a part, and the same separator glued to the part's last word by a no-break space while the part wraps. */
const SEPARATOR = ' ·';
const GLUED = '\u00a0·';

/**
 * The parts of a « · » row packed into lines of `room` columns (continuation lines two narrower): a part goes whole to
 * the next line when it does not fit, and a part longer than a line wraps inside itself. The separator belongs to the
 * part before it, so a broken line ends with «·» and none starts with it; the parts' own text is never changed.
 */
function packParts(parts: readonly string[], room: number): string[] {
  const lines: string[] = [];
  const roomAt = (line: number) => line ? room - 2 : room;
  let current = '';
  for (const [i, part] of parts.entries()) {
    const tail = i < parts.length - 1 ? SEPARATOR : '';
    const joined = current ? `${current} ${part}${tail}` : `${part}${tail}`;
    if (visibleWidth(joined) <= roomAt(lines.length)) { current = joined; continue; }
    if (current) lines.push(current);
    // Wrapped, the part keeps its separator glued to its last word, so the dot never goes down alone.
    const pieces = wrapText(tail ? `${part}${GLUED}` : part, line => roomAt(lines.length + line));
    // A word longer than its line may be split right before the glued separator: its last character goes down with it.
    const last = pieces.at(-1)!;
    if (tail && pieces.length > 1 && (last === '·' || last === GLUED)) {
      const before = pieces[pieces.length - 2]!;
      const glue = last === '·' && before.endsWith('\u00a0') ? '\u00a0' : '';
      const core = before.slice(0, before.length - glue.length);
      const [head, moved] = splitWord(core, Math.max(1, visibleWidth(core) - 1));
      pieces.splice(-2, 2, head, moved + glue + last);
    }
    // The glue was the layout's own: the separator is printed with its plain space, as on an unbroken line.
    const end = pieces.at(-1)!;
    if (tail && end.endsWith(GLUED)) pieces[pieces.length - 1] = end.slice(0, -GLUED.length) + SEPARATOR;
    lines.push(...pieces.slice(0, -1));
    current = pieces.at(-1) ?? '';
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Plain lines of at most `width` (capped at MAX_WIDTH) terminal columns: a right counter aligned to
 * the edge (its text clipped with «…», the counter never), « · » parts packed per line, everything
 * else word-wrapped under its hanging indent without a character added or lost. One layout for the
 * board, the chat and the CLI, so the three never wrap differently; widths are measured in columns,
 * never in string length.
 */
export function fitRows(rows: ResultRow[], width: number): { role: ResultRole; text: string }[] {
  const edge = Math.max(20, Math.min(width, MAX_WIDTH));
  return rows.flatMap(row => {
    const pad = ' '.repeat(row.indent + 1);
    const room = edge - pad.length;
    if (row.right !== undefined) {
      if (row.short !== undefined && edge < 80) return [{ role: row.role, text: pad + clipTo(row.text, room - visibleWidth(row.short) - 3) + ` — ${row.short}` }];
      const text = clipTo(row.text, room - visibleWidth(row.right) - 2);
      return [{ role: row.role, text: pad + text + ' '.repeat(Math.max(2, room - visibleWidth(text) - visibleWidth(row.right))) + row.right }];
    }
    if (row.parts) return packParts(row.parts, room).map((line, i) => ({ role: row.role, text: (i ? `${pad}  ` : pad) + line }));
    if (!row.text) return [{ role: row.role, text: '' }];
    const hang = row.hang ?? 0;
    return wrapText(row.text, line => line ? room - hang : room).map((piece, i) => ({ role: row.role, text: pad + (i ? ' '.repeat(hang) : '') + piece }));
  });
}

/** The rows as plain text: the CLI prints this, and the saved text renders are made with it. */
export const plainText = (rows: ResultRow[], width: number) => fitRows(rows, width).map(line => line.text.trimEnd()).join('\n');
