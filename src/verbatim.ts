/*
 * What counts as the source's own words and values. A quote a model returns is kept only when it is found verbatim —
 * up to the typography a model normalises —, a quote a rule rests on is a whole clause of its sentence, and a value is a
 * token with a digit, the same on both sides of the simulator: what the customer may say and what the fabrication check
 * looks for.
 */

/**
 * Value-like tokens: runs of letters/digits/`:./-` that contain a digit and are at least three
 * characters long after trailing punctuation is trimmed, lower-cased. `4321`, `A103`, `14:00`,
 * `202-7` and `11.03.2024` are tokens; `two cards` has none. Used by the answers rule and by
 * the fabrication heuristic, so both sides of the simulator agree on what a "value" is. Both belong to first-format
 * cards and the free simulator, whose checks are part of SIMULATOR_PROTOCOL and are recomputed when a stored run is
 * re-assessed: the definition is frozen. A card's facts are typed and its customer's words are harness text.
 */
const VALUE_TOKEN = /[A-Za-zА-Яа-яЁё0-9:./-]+/g;
export function valueTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.match(VALUE_TOKEN) ?? []) {
    const token = raw.replace(/[.,:]+$/, '').toLowerCase();
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

/** Every place a quote stands in `content` verbatim, as verbatimSpanAt finds one: exact copies first, then typographic ones. */
function* verbatimSpans(content: string, quote: string): Generator<{ span: string; offset: number }> {
  for (let at = content.indexOf(quote); quote && at >= 0; at = content.indexOf(quote, at + 1)) yield { span: quote, offset: at };
  const source = foldTypography(content);
  const needle = foldTypography(quote).text.trim();
  if (!needle) return;
  const first = needle[0]!, swapped = first === first.toLowerCase() ? first.toUpperCase() : first.toLowerCase();
  for (const candidate of [needle, ...(swapped !== first ? [swapped + needle.slice(1)] : [])]) {
    for (let at = source.text.indexOf(candidate); at >= 0; at = source.text.indexOf(candidate, at + 1)) {
      const start = source.starts[at]!;
      yield { span: content.slice(start, source.ends[at + candidate.length - 1]!), offset: start };
    }
  }
}

/*
 * A rule is the sentence the owner wrote, and a quote of it is a whole sentence or a whole clause of one. A clause opens at
 * the text's start, a line's start, or after a mark that ends a clause or opens one (. ! ? … ; : , — ( «), and closes the
 * same way: so a quote cut after «Не» or before «, только если…» — the owner's rule turned around — is never a rule. The
 * marks and the line breaks are the text's structure; its words are never read.
 */
const OPENS_AFTER = new Set(['.', '!', '?', '…', ';', ':', ',', '—', '–', '(', '[', '«', '"', '“', '„']);
const CLOSES_BEFORE = new Set(['.', '!', '?', '…', ';', ':', ',', '—', '–', ')', ']', '»', '"', '”']);
const SENTENCE_ENDS = new Set(['.', '!', '?', '…']);
const CLOSING_MARKS = new Set([')', ']', '»', '"', '”']);
const LINE_BREAKS = new Set(['\n', '\r', ' ', ' ']);
const isSpace = (char: string | undefined): boolean => char !== undefined && !char.trim();
const wordChar = (char: string): boolean => char.toLowerCase() !== char.toUpperCase() || (char >= '0' && char <= '9');
/** A hyphen, a star or a bullet on its own between spaces is a dash or a list marker; inside a word («POS-терминал») it is not. */
const standalone = (content: string, at: number): boolean => (content[at] === '-' || content[at] === '*' || content[at] === '•')
  && (at === 0 || isSpace(content[at - 1])) && isSpace(content[at + 1]);

/** Whether a clause of `content` may open at `start`, and whether a sentence does. */
function openingAt(content: string, start: number): { clause: boolean; sentence: boolean } {
  let at = start;
  while (at > 0 && isSpace(content[at - 1])) {
    if (LINE_BREAKS.has(content[at - 1]!)) return { clause: true, sentence: true };
    at--;
  }
  if (at === 0) return { clause: true, sentence: true };
  const before = content[at - 1]!;
  // A sentence end and a space open the next sentence («1. » a list item); a point with no space is a number's or a
  // shortening's («3.5», «т.д.») and opens nothing.
  if (SENTENCE_ENDS.has(before)) return { clause: at < start || before !== '.', sentence: at < start };
  // A list item («- Не называйте ставку») opens a sentence of its own.
  if (standalone(content, at - 1)) return { clause: true, sentence: lineStart(content, at - 1) };
  return { clause: OPENS_AFTER.has(before), sentence: false };
}

/** Whether only spaces stand between a line's start (or the text's) and `at`. */
function lineStart(content: string, at: number): boolean {
  let from = at;
  while (from > 0 && isSpace(content[from - 1]) && !LINE_BREAKS.has(content[from - 1]!)) from--;
  return from === 0 || LINE_BREAKS.has(content[from - 1]!);
}

/** Whether a clause of `content` may close at `end` (the quote's own last mark counts), and whether a sentence does. */
function closingAt(content: string, end: number): { clause: boolean; sentence: boolean } {
  const last = content[end - 1];
  if (last !== undefined && SENTENCE_ENDS.has(last)) return { clause: true, sentence: true };
  if (last !== undefined && CLOSES_BEFORE.has(last)) return { clause: true, sentence: false };
  let at = end;
  while (at < content.length && isSpace(content[at])) {
    if (LINE_BREAKS.has(content[at]!)) return { clause: true, sentence: true };
    at++;
  }
  if (at === content.length) return { clause: true, sentence: true };
  const after = content[at]!;
  return { clause: CLOSES_BEFORE.has(after) || (at > end && standalone(content, at)), sentence: SENTENCE_ENDS.has(after) };
}

/** The words of a text: runs between spaces that hold a letter or a digit. */
export function wordCount(text: string): number {
  let count = 0, inWord = false, lettered = false;
  for (const char of `${text.normalize('NFKC')} `) {
    if (char.trim()) { inWord = true; lettered ||= wordChar(char); continue; }
    if (inWord && lettered) count++;
    inWord = false; lettered = false;
  }
  return count;
}

/**
 * The sentence of `content` a span stands in: back to the previous sentence end or line break, on to the next one (its
 * closing mark kept), without a list marker in front. The judge reads it as the rule (card/proposal.ts), so it is the
 * source's own characters; a sentence too long to be stored as a rule gives way to the span itself.
 */
export function sentenceAround(content: string, start: number, end: number, limit = 2000): string {
  let from = start;
  while (from > 0 && !LINE_BREAKS.has(content[from - 1]!) && !(SENTENCE_ENDS.has(content[from - 1]!) && isSpace(content[from]))) from--;
  let to = end;
  if (!SENTENCE_ENDS.has(content[end - 1] ?? '')) {
    while (to < content.length && !LINE_BREAKS.has(content[to]!)) {
      const char = content[to++]!;
      if (SENTENCE_ENDS.has(char) && (to === content.length || isSpace(content[to]) || CLOSING_MARKS.has(content[to]!))) break;
    }
  }
  while (to < content.length && CLOSING_MARKS.has(content[to]!)) to++;
  const raw = content.slice(from, to).trim();
  const marker = LIST_MARKER.exec(raw.slice(0, 4));
  const sentence = (marker ? raw.slice(marker[0].length) : raw).trim();
  return sentence && sentence.length <= limit ? sentence : content.slice(start, end).trim();
}

/** A quote read as a clause of its source (quotedClause). */
export interface QuotedClause {
  /** The source's own characters of the quote. */
  span: string;
  /** Whether it opens and closes where a clause may, and whether it is a whole sentence. */
  opens: boolean; closes: boolean; whole: boolean;
  words: number;
  /** The sentence it stands in: what the judge reads as the rule. */
  sentence: string;
}

/**
 * Where a quote stands in `content` as a clause: among every place it is found verbatim, the first one that opens and
 * closes where a clause may; else the first place at all, whose flags then say what is wrong. Undefined when the quote
 * is nowhere verbatim.
 */
export function quotedClause(content: string, quote: string): QuotedClause | undefined {
  let first: QuotedClause | undefined;
  for (const { span, offset } of verbatimSpans(content, quote)) {
    const end = offset + span.length;
    const opening = openingAt(content, offset), closing = closingAt(content, end);
    const clause = { span, opens: opening.clause, closes: closing.clause, whole: opening.sentence && closing.sentence, words: wordCount(span),
      sentence: sentenceAround(content, offset, end) };
    if (clause.opens && clause.closes) return clause;
    first ??= clause;
  }
  return first;
}

/** The fewest words a quote holds: a clause of fewer states no rule, while a whole sentence of two («Не шутите.») does. */
export const CLAUSE_WORDS = 3;
export const SENTENCE_WORDS = 2;
export const enoughWords = (clause: Pick<QuotedClause, 'words' | 'whole'>): boolean => clause.words >= (clause.whole ? SENTENCE_WORDS : CLAUSE_WORDS);
