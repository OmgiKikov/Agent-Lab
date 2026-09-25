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

