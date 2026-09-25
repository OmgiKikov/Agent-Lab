/*
 * The position a cell of an order column gives a message: a leaf, so both the grouping of a sheet's rows into
 * conversations (selection.ts) and the reading of each conversation (dialogues.ts) order by the same rule.
 */

const NUMBER = /^[+-]?\d+(?:[.,]\d+)?(?:[eE][+-]?\d+)?$/;
const DOTTED_DATE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3}))?)?)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * The position a cell of an order column gives a message: a number (a sequence number, or Excel's day
 * count of a date cell) or a written date and time (ISO or DD.MM.YYYY). Undefined when it is neither.
 */
export function parseOrder(text: string): { kind: 'number' | 'date'; value: number } | undefined {
  const value = text.trim();
  if (NUMBER.test(value)) return { kind: 'number', value: Number(value.replace(',', '.')) };
  const dotted = DOTTED_DATE.exec(value);
  if (dotted) {
    const part = (group: number) => Number(dotted[group] ?? 0);
    const time = Date.UTC(part(3), part(2) - 1, part(1), part(4), part(5), part(6), Number((dotted[7] ?? '0').padEnd(3, '0')));
    const date = new Date(time);
    // 31.02.2026 is not a date: Date.UTC would quietly make it March.
    return date.getUTCDate() === part(1) && date.getUTCMonth() === part(2) - 1 ? { kind: 'date', value: time } : undefined;
  }
  const iso = ISO_DATE.test(value) ? Date.parse(value.replace(' ', 'T')) : NaN;
  return Number.isFinite(iso) ? { kind: 'date', value: iso } : undefined;
}
