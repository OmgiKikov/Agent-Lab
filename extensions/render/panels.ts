import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { safeLine } from '../../src/text.js';
import type { Line, Segment } from '../workspace-screens.ts';
import type { Tone } from './theme.ts';

export const span = (text: string, tone: Tone = 'text', bold = false): Segment => ({ text, tone, bold });
export const row = (text: string, tone: Tone = 'text', bold = false): Line => [span(safeLine(text), tone, bold)];
const size = (line: Line) => line.reduce((sum, part) => sum + visibleWidth(part.text), 0);
const pad = (line: Line, width: number): Line => [...line, span(' '.repeat(Math.max(0, width - size(line))))];
export const fit = (text: string, width: number) => safeLine(truncateToWidth(safeLine(text), Math.max(1, width), '…'));
export const wrap = (text: string, width: number, tone: Tone = 'text'): Line[] => wrapTextWithAnsi(safeLine(text), Math.max(1, width)).map(value => row(value, tone));

export function box(title: string, body: Line[], width: number): Line[] {
  const label = fit(` ${title} `, width - 4);
  return [[span('╭─', 'borderMuted'), span(label, 'muted'), span('─'.repeat(Math.max(0, width - visibleWidth(label) - 3)) + '╮', 'borderMuted')],
    ...[[], ...body, []].map(line => [span('│ ', 'borderMuted'), ...pad(line, width - 4), span(' │', 'borderMuted')]),
    row('╰' + '─'.repeat(width - 2) + '╯', 'borderMuted')];
}
export function beside(left: Line[], right: Line[], leftWidth: number): Line[] {
  return Array.from({ length: Math.max(left.length, right.length) }, (_, i) => [...pad(left[i] ?? [], leftWidth), span('  '), ...(right[i] ?? [])]);
}

/** Equal-height counters on a wide terminal, a readable list on a narrow one. */
export function metrics(values: { label: string; value: string; note: string; tone: Tone }[], width: number): Line[] {
  if (width < 76) return values.flatMap(value => [
    [span(`${value.value.padStart(2)}  `, value.tone, true), span(value.label.toLocaleLowerCase('ru')), span(` · ${value.note}`, 'muted')],
  ]).flatMap(line => line.reduce((size, part) => size + visibleWidth(part.text), 0) > width
    ? wrap(line.map(part => part.text).join(''), width) : [line]);
  const cell = Math.floor((width - (values.length - 1) * 2) / values.length);
  const contents = values.map(value => [row(value.value, value.tone, true), ...wrap(value.note, cell - 4, 'muted')]);
  const height = Math.max(...contents.map(lines => lines.length));
  const tiles = values.map((value, i) => box(value.label, [...contents[i]!, ...Array.from({ length: height - contents[i]!.length }, (): Line => [])], cell));
  return tiles[0]!.map((_, i) => tiles.flatMap((tile, j) => [...(j ? [span('  ')] : []), ...tile[i]!]));
}
