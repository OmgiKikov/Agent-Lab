/*
 * How de-identified exports hide what a customer wrote. The marks are an external convention with no structure —
 * whatever the export's masking tool writes — so this module is the one place that reads them, as llm/model-call.ts
 * is for providers' error phrases.
 *
 * One table of marks (version 2), every reading follows from it:
 *
 *   ***, ###            a run of symbols written over a value — not a lone * between numbers («5 * 3»: a product),
 *                       not a lone # before a number («Заказ # 123»: a number sign)
 *   xxx, хххх, XXXX     three or more Latin or Cyrillic x — not XXX or ХХХ between two words («в XXX веке»: a Roman numeral)
 *   <PHONE>, <ФИО>      a tag in angle brackets
 *   [redacted] [masked] [скрыто] [удалено]
 *
 * A mark stands alone: one touching a letter or a digit is not a mask («*важно*», «5*3», «№#12»). The readings: the
 * masked values of a message (maskedSpans, where card/unmask.ts writes plausible values in), a message nothing the
 * customer wrote is left of (maskedThrough: the import refuses a conversation all of whose customer messages are so,
 * the miner leaves out one with any), and a value that is a mark again (holdsMark).
 *
 * Version 1 is the three readings that disagreed before the table; it stays for what was stored under it, frozen: an
 * import batch or a table's mapping without `maskVersion` was read so, the topic map of such an import left out what
 * its exclusion left out, and a value Lab filled in without `maskVersion` (card/schema.ts `filled`) stands over the
 * mark version 1 counted — every mark the pattern finds, its context unread. A new batch records version 2 only where
 * a message reads otherwise (readAlike); a new fill always records the table it counted its marks by.
 */

/** 1: the frozen readings of what was stored before the table; 2: the table. */
export type MaskVersion = 1 | 2;
/** The table every new reading follows; an import and a table's mapping record it. */
export const MASK_VERSION = 2 satisfies MaskVersion;

/** A mark written the way the table writes it, standing alone between words; its context is checked in code. */
const MASK_MARK = /(?<![\p{L}\p{N}])(?:[*#]+|[xх]{3,}|<[^<>\s]{1,40}>|\[(?:redacted|masked|скрыто|удалено)\])(?![\p{L}\p{N}])/giu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
/** The characters marks are written with: a value holding one is no plain value. */
const MARK_CHARACTERS: ReadonlySet<string> = new Set(['*', '#', '<', '>', '[', ']']);

/** One masked value of a message: where its mark stands and the mark itself. */
export interface MaskedSpan { start: number; end: number; mark: string }

const isSpace = (char: string | undefined) => char !== undefined && char.trim() === '';
const isDigit = (char: string | undefined) => char !== undefined && char >= '0' && char <= '9';
const isWordChar = (char: string | undefined) => char !== undefined && LETTER_OR_DIGIT.test(char);
const isX = (char: string) => char === 'x' || char === 'х' || char === 'X' || char === 'Х';

/** The nearest character that is not a space, from `at` in the direction `step` (-1 back, 1 forward). */
function nearest(content: string, at: number, step: -1 | 1): string | undefined {
  while (at >= 0 && at < content.length && isSpace(content[at])) at += step;
  return content[at];
}
/** The word next to a mark, across spaces: back from `at` (step -1) or forward from it. */
function wordNear(content: string, at: number, step: -1 | 1): string {
  while (at >= 0 && at < content.length && isSpace(content[at])) at += step;
  let from = at;
  while (from >= 0 && from < content.length && isWordChar(content[from])) from += step;
  return step === 1 ? content.slice(at, from) : content.slice(from + 1, at + 1);
}
/** A word of letters that is not itself a mark of x: «в», «веке». */
const plainWord = (word: string) => word !== '' && [...word].every(char => !isDigit(char)) && ![...word].every(isX);

/**
 * Whether a candidate the pattern found is a masked value in its context: a product of numbers, a number sign and a
 * Roman numeral are written with the same characters, and the words around them tell them apart.
 */
function masks(content: string, start: number, end: number): boolean {
  const mark = content.slice(start, end);
  if (mark === '*' && isDigit(nearest(content, start - 1, -1)) && isDigit(nearest(content, end, 1))) return false;
  if (mark === '#' && isDigit(nearest(content, end, 1))) return false;
  if (mark.length === 3 && [...mark].every(char => char === 'X' || char === 'Х') && plainWord(wordNear(content, start - 1, -1)) && plainWord(wordNear(content, end, 1))) return false;
  return true;
}

/**
 * The masked values of a message, in order, as the table of `version` reads them. Version 1 — the frozen reading the
 * values Lab filled in before the table were counted by — takes every mark the pattern finds, its context unread.
 */
export function maskedSpans(content: string, version: MaskVersion = MASK_VERSION): MaskedSpan[] {
  return [...content.matchAll(MASK_MARK)].flatMap(match => {
    const start = match.index, end = match.index + match[0].length;
    return version === 1 || masks(content, start, end) ? [{ start, end, mark: match[0] }] : [];
  });
}

/** A value to write over a mark: where the mark stands in its message (a span maskedSpans found) and the value. */
export interface MarkValue { start: number; end: number; value: string }

/**
 * The message with each value written over its mark; a mark without a value stays, the rest is kept character for
 * character, and of two values over one mark the later is written. The places are given, not read here: a value stays
 * where the table it was counted by found its mark (card/checks.ts filledSpan).
 */
export function withValues(content: string, values: readonly MarkValue[]): string {
  const over = new Map(values.map(item => [item.start, item] as const));
  let out = '', from = 0;
  for (const { start, end, value } of [...over.values()].sort((a, b) => a.start - b.start)) {
    if (start < from) continue; // the marks of one pattern never overlap: a place inside one already written stays written
    out += content.slice(from, start) + value;
    from = end;
  }
  return out + content.slice(from);
}

/** Version 1 of the import: a message made of `*`, x, bracketed words, tags and spaces only. Frozen with the imports read by it. */
const MASK_ONLY_V1 = /^(?:\s|\*|x|х|\[(?:redacted|masked|скрыто|удалено)\]|<[^>]+>)+$/i;

/**
 * Nothing the customer wrote is left: the message holds a mark and not one letter or digit outside its marks. Under
 * version 1 — the import's frozen reading — a message of `*`, x, bracketed words, tags and spaces only.
 */
export function maskedThrough(content: string, version: MaskVersion = MASK_VERSION): boolean {
  if (version === 1) return MASK_ONLY_V1.test(content);
  const spans = maskedSpans(content);
  if (!spans.length) return false;
  let rest = '', from = 0;
  for (const span of spans) { rest += content.slice(from, span.start); from = span.end; }
  return !LETTER_OR_DIGIT.test(rest + content.slice(from));
}

/**
 * A message the miner leaves its conversation out for: hidden entirely. Under version 1 — the exclusion's frozen
 * reading, which the stored topic maps of such imports left out by — a `*` or `#` and not one letter or digit.
 */
export function hiddenMessage(content: string, version: MaskVersion = MASK_VERSION): boolean {
  return version === 1 ? /[*#]/u.test(content) && !LETTER_OR_DIGIT.test(content) : maskedThrough(content);
}

/**
 * Whether a message may hold a mark at all, by one pass over its codes: a character marks are written with, a run of
 * three x, or nothing but x and spaces (which the first import reading took for a mask). False settles every reading.
 */
function mayHoldMark(content: string): boolean {
  let run = 0, onlyX = true;
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code === 42 || code === 35 || code === 60 || code === 91) return true; // * # < [
    if (code === 120 || code === 88 || code === 0x445 || code === 0x425) { if (++run >= 3) return true; continue; } // x X х Х
    run = 0;
    if (code > 32 && code !== 0xa0 && code < 0x1680) onlyX = false; // any other space keeps the full reading below
  }
  return onlyX;
}

/**
 * Whether the first readings and the table read a customer's message alike — for the import and for the miner. An
 * import records the table it was read by only when some message is read otherwise: an import of messages both read
 * alike is the very import the first readings made of them, stored or not, and its topic map is the same.
 */
export const readAlike = (content: string): boolean => !mayHoldMark(content)
  || maskedThrough(content, 1) === maskedThrough(content, 2) && hiddenMessage(content, 1) === hiddenMessage(content, 2);

/** A value that is a mark again, or holds a character marks are written with: never a value written in for a mark. */
export const holdsMark = (value: string): boolean => maskedSpans(value).length > 0 || [...value].some(char => MARK_CHARACTERS.has(char));
