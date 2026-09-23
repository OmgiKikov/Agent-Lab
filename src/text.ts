import { stripTerminalSequences } from '@earendil-works/pi-tui';

/*
 * Text on its way to a terminal. Material, model and persisted text is untrusted: it may carry
 * escape sequences, control characters or bidi overrides that redraw or reorder the screen.
 */

/** Everything shown in the terminal crosses this boundary; line breaks survive, tabs become two spaces. */
export function safeText(value: unknown): string {
  return stripTerminalSequences(String(value ?? '')).replace(/\r\n?/g, '\n').replace(/\t/g, '  ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '');
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
