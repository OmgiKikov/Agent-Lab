import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { safeLine, wrapHanging } from '../../src/text.js';
import type { Line, Segment } from '../workspace-screens.ts';
import type { Tone } from './theme.ts';

export const span = (text: string, tone: Tone = 'text', bold = false): Segment => ({ text, tone, bold });
export const row = (text: string, tone: Tone = 'text', bold = false): Line => [span(safeLine(text), tone, bold)];
const size = (line: Line) => line.reduce((sum, part) => sum + visibleWidth(part.text), 0);
const pad = (line: Line, width: number): Line => [...line, span(' '.repeat(Math.max(0, width - size(line))))];
export const fit = (text: string, width: number) => safeLine(truncateToWidth(safeLine(text), Math.max(1, width), '…'));
/** A text in lines of `width`; one that starts with spaces stands at that column, its wrapped lines hanging under it. */
export function wrap(text: string, width: number, tone: Tone = 'text'): Line[] {
  const safe = safeLine(text);
  let lead = 0;
  while (safe[lead] === ' ') lead++;
  if (!lead || lead >= safe.length || lead + 3 >= width) return wrapTextWithAnsi(safe, Math.max(1, width)).map(value => row(value, tone));
  const [first = '', ...rest] = wrapHanging(safe.slice(lead), width - lead, width - lead - 2);
  return [row(' '.repeat(lead) + first, tone), ...rest.map(piece => row(' '.repeat(lead + 2) + piece, tone))];
}

/** A quoted customer message, visually distinct from instructions and reviewer comments. */
export function quote(text: string, width: number): Line[] {
  return wrap(text, Math.max(1, width - 3)).map(line => [span('│  ', 'accent'), ...line]);
}

/** Keep continuation lines aligned with the text, not its numbered marker. */
export function numbered(text: string, index: number, width: number): Line[] {
  const prefix = `${index}. `;
  return wrap(text, Math.max(1, width - prefix.length)).map((line, i) => [span(i ? ' '.repeat(prefix.length) : prefix, 'accent'), ...line]);
}

/** Compact keyboard action: only the key gets a filled background. */
export function action(key: string, label: string, width: number): Line[] {
  const prefix = ` ${key} `;
  if (visibleWidth(prefix) + 2 >= width) return wrap(`${key} ${label}`, width, 'accent');
  return wrap(label, width - visibleWidth(prefix) - 2).map((line, i) => [
    i ? span(' '.repeat(visibleWidth(prefix))) : { ...span(prefix, 'accent', true), background: 'selectedBg' },
    span('  '), ...line,
  ]);
}

/** A selection remains legible without colour thanks to its leading marker. */
export function selection(lines: Line[], width: number): Line[] {
  return lines.map(line => pad(line, width).map(part => ({ ...part, background: 'selectedBg' })));
}

export function box(title: string, body: Line[], width: number, tone: Tone = 'muted'): Line[] {
  const label = fit(` ${title} `, width - 4);
  return [[span('╭─', 'borderMuted'), span(label, tone, true), span('─'.repeat(Math.max(0, width - visibleWidth(label) - 3)) + '╮', 'borderMuted')],
    ...[[], ...body, []].map(line => [span('│ ', 'borderMuted'), ...pad(line, width - 4), span(' │', 'borderMuted')]),
    row('╰' + '─'.repeat(width - 2) + '╯', 'borderMuted')];
}
export function beside(left: Line[], right: Line[], leftWidth: number): Line[] {
  return Array.from({ length: Math.max(left.length, right.length) }, (_, i) => [...pad(left[i] ?? [], leftWidth), span('  '), ...(right[i] ?? [])]);
}

/**
 * Equal-height counters on a wide terminal; on a narrow one a list that reads as words whatever the number —
 * «Готовы: 1 · можно запускать», never «1 готовы» —, a line too long for the terminal wrapped under its own text.
 */
export function metrics(values: { label: string; value: string; note: string; tone: Tone }[], width: number): Line[] {
  if (width < 76) return values.flatMap((value): Line[] => {
    const label = value.label.toLocaleLowerCase('ru');
    const name = `${label.charAt(0).toLocaleUpperCase('ru')}${label.slice(1)}: `;
    const line: Line = [span(name), span(value.value, value.tone, true), span(` · ${value.note}`, 'muted')];
    if (size(line) <= width) return [line];
    const [first = '', ...rest] = wrapHanging(safeLine(`${name}${value.value} · ${value.note}`), width, width - 2);
    return [row(first), ...rest.map(piece => [span('  '), ...row(piece)])];
  });
  const cell = Math.floor((width - (values.length - 1) * 2) / values.length);
  const contents = values.map(value => [row(value.value, value.tone, true),
    ...wrap(value.label.toLocaleLowerCase('ru'), cell), ...wrap(value.note, cell, 'muted')]);
  const height = Math.max(...contents.map(lines => lines.length));
  const tiles = values.map((_, i) => [row('─'.repeat(cell), 'borderMuted'), ...contents[i]!, ...Array.from({ length: height - contents[i]!.length }, (): Line => [])].map(line => pad(line, cell)));
  return tiles[0]!.map((_, i) => tiles.flatMap((tile, j) => [...(j ? [span('  ')] : []), ...tile[i]!]));
}
