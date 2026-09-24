/*
 * How de-identified exports hide what a customer wrote. The marks are an external convention with no structure —
 * whatever the export's masking tool writes — so this module is the one place that reads them, as llm/model-call.ts
 * is for providers' error phrases. The first two readings are frozen: the import's decides which rows a stored import holds,
 * and the exclusion's decides what a stored topic map and sample left out, so a change would read old logs anew.
 *
 *   ***, ###                       symbols written over a value
 *   xxxx, хххх                     Latin or Cyrillic x over a value (the import's reading)
 *   [redacted] [masked] [скрыто] [удалено]
 *   <PHONE>, <ФИО>                 a tag in angle brackets
 */

const MASK_ONLY = /^(?:\s|\*|x|х|\[(?:redacted|masked|скрыто|удалено)\]|<[^>]+>)+$/i;

/** A message made of masking marks and spaces only: nothing the customer wrote is left. */
export const maskedThrough = (content: string): boolean => MASK_ONLY.test(content);

/** A message hidden by masking symbols: a `*` or `#` and not one letter or digit left. */
export const hiddenBySymbols = (content: string): boolean => /[*#]/u.test(content) && !/[\p{L}\p{N}]/u.test(content);

/**
 * The third reading, of the values inside a message that still reads («с утра было # покупки, на * и *»): each mark that
 * stands alone between words is one masked value. A mark is a run of `*` or `#`, a run of three or more x, a tag in
 * angle brackets or a bracketed word; one touching a letter or a digit is not a mask («*важно*», «5*3», «№#12»). It
 * decides only where Lab writes a plausible value in (card/unmask.ts), never which rows an import holds.
 */
const MASK_MARK = /(?<![\p{L}\p{N}])(?:[*#]+|[xх]{3,}|<[^<>\s]{1,40}>|\[(?:redacted|masked|скрыто|удалено)\])(?![\p{L}\p{N}])/giu;

/** One masked value of a message: where its mark stands and the mark itself. */
export interface MaskedSpan { start: number; end: number; mark: string }

/** The masked values of a message, in order. */
export function maskedSpans(content: string): MaskedSpan[] {
  return [...content.matchAll(MASK_MARK)].map(match => ({ start: match.index, end: match.index + match[0].length, mark: match[0] }));
}

/** The message with values written in: `values.get(n)` over the n-th mark (0-based); a mark without a value stays, the rest is kept character for character. */
export function withValues(content: string, values: ReadonlyMap<number, string>): string {
  let out = '', from = 0;
  maskedSpans(content).forEach((span, index) => {
    const value = values.get(index);
    if (value === undefined) return;
    out += content.slice(from, span.start) + value;
    from = span.end;
  });
  return out + content.slice(from);
}
