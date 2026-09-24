/*
 * What counts as the source's own words and values. A quote a model returns is kept only when it is found verbatim —
 * up to the typography a model normalises — and a value is a token with a digit, the same on both sides of the
 * simulator: what the customer may say and what the fabrication check looks for.
 */

/**
 * Value-like tokens: runs of letters/digits/`:./-` that contain a digit and are at least three
 * characters long after trailing punctuation is trimmed, lower-cased. `4321`, `A103`, `14:00`,
 * `202-7` and `11.03.2024` are tokens; `two cards` has none. Used by the answers rule and by
 * the fabrication heuristic, so both sides of the simulator agree on what a "value" is.
 */
const VALUE_TOKEN = /[A-Za-zА-Яа-яЁё0-9:./-]+/g;
export function valueTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.match(VALUE_TOKEN) ?? []) {
    const token = raw.replace(/[.,:]+$/, '').toLocaleLowerCase();
    if (token.length >= 3 && /\d/.test(token)) tokens.add(token);
  }
  return tokens;
}
/**
 * A model copies a source but normalises its typography: straight quotes for «», a hyphen for a
 * dash, -> for →, е for ё, one space for a line break. Such a quote is still the source's own words.
 * Find it and hand back the source's exact characters, so every stored quote is verbatim.
 * Words, order and case must match; a paraphrase is still rejected.
 */
const LOOSE_CHARACTERS: Record<string, string> = {
  '«': '"', '»': '"', '“': '"', '”': '"', '„': '"', '‹': "'", '›': "'", '‘': "'", '’': "'",
  '–': '-', '—': '-', '−': '-', '→': '>', 'ё': 'е', 'Ё': 'Е', '\u00a0': ' ',
};
/** A list marker after whitespace («- », «• », «1. ») is layout, not words; a model drops it or keeps it inline when it quotes. */
const LIST_MARKER = /^(?:[-*•–—]|\d{1,2}[.)])\s/u;
function foldTypography(text: string): { text: string; starts: number[]; ends: number[] } {
  const out: string[] = [], starts: number[] = [], ends: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const raw = text[i]!;
    let ch = LOOSE_CHARACTERS[raw] ?? raw, width = 1;
    if (raw === '-' && text[i + 1] === '>') { ch = '>'; width = 2; }
    if ((!out.length || out[out.length - 1] === ' ') && !/\s/.test(raw)) {
      const marker = LIST_MARKER.exec(text.slice(i, i + 4));
      if (marker) { ch = ' '; width = marker[0].length; }
    }
    if (/\s/.test(ch)) {
      if (out.length && out[out.length - 1] === ' ') { ends[ends.length - 1] = i + width; i += width - 1; continue; }
      ch = ' ';
    }
    out.push(ch); starts.push(i); ends.push(i + width); i += width - 1;
  }
  return { text: out.join(''), starts, ends };
}
/**
 * The source's own characters behind a quote, together with the offset the match was actually made
 * at. Callers that need the place (a line number, a sort key) take `offset` from here instead of
 * searching the source again for the returned text: a re-search answers «the first copy of these
 * characters», which is a different question from «where this requirement's quote was found».
 */
export function verbatimSpanAt(content: string, quote: string): { span: string; offset: number } | undefined {
  const direct = content.indexOf(quote);
  if (direct >= 0) return { span: quote, offset: direct };
  const source = foldTypography(content);
  const needle = foldTypography(quote).text.trim();
  if (!needle) return undefined;
  // A quote that starts mid-sentence gets capitalised; only its first letter may differ in case.
  const first = needle[0]!, swapped = first === first.toLowerCase() ? first.toUpperCase() : first.toLowerCase();
  for (const candidate of [needle, ...(swapped !== first ? [swapped + needle.slice(1)] : [])]) {
    const at = source.text.indexOf(candidate);
    if (at >= 0) {
      const start = source.starts[at]!;
      return { span: content.slice(start, source.ends[at + candidate.length - 1]!), offset: start };
    }
  }
  return undefined;
}
export function verbatimSpan(content: string, quote: string): string | undefined {
  return verbatimSpanAt(content, quote)?.span;
}
