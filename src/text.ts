import { stripTerminalSequences, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

/*
 * Text on its way to a terminal. Material, model and persisted text is untrusted: it may carry
 * escape sequences, control characters or bidi overrides that redraw or reorder the screen.
 */

/**
 * `text` in lines of at most `first` terminal columns for its first line and `rest` for every other — the value column
 * of a label, a hanging indent. Wrapping never changes the text: its own line breaks stay, a word longer than a line
 * breaks between its characters with nothing inserted, and only the spaces a line breaks at are dropped.
 */
export function wrapHanging(text: string, first: number, rest: number): string[] {
  const [opening = '', ...more] = text.split('\n');
  const [head, tail] = firstLine(opening, Math.max(1, first));
  return [head, ...[...(tail ? [tail] : []), ...more].flatMap(line => wrapTextWithAnsi(line, Math.max(1, rest)))];
}

/** The words of `line` that fit `width` columns and what is left of the line after them. */
function firstLine(line: string, width: number): [string, string] {
  const words = line.split(' ');
  let used = -1, taken = 0;
  for (const word of words) {
    const next = used + 1 + visibleWidth(word);
    if (next > width) break;
    used = next; taken++;
  }
  if (taken) return [words.slice(0, taken).join(' ').trimEnd(), words.slice(taken).join(' ').trimStart()];
  // The first word alone is wider than the line: it breaks between its characters, and the rest of it opens the next line.
  const [long = '', ...others] = words;
  const [piece = '', ...pieces] = wrapTextWithAnsi(long, width);
  return [piece, [pieces.join(''), ...others].join(' ')];
}

/** Everything shown in the terminal crosses this boundary; line breaks survive, tabs become two spaces. */
export function safeText(value: unknown): string {
  return stripTerminalSequences(String(value ?? '')).replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');
}
/** `safeText` for a single output line. */
export const safeLine = (value: unknown): string => safeText(value).replace(/\n+/g, ' ');
/** Whitespace runs become one space; nothing is cut. */
export const oneLine = (value: unknown): string => String(value ?? '').replace(/\s+/g, ' ').trim();
/** `oneLine` cut to `limit` characters, the cut marked with «…». */
export const clip = (value: unknown, limit: number): string => {
  const text = oneLine(value);
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
};
/** The id prefix people see and type: `/agent-lab 1a2b3c4d` finds the run by it. */
export const shortId = (id: string): string => id.slice(0, 8);
