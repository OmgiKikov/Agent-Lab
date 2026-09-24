/*
 * One conversation per row: the export writes the whole conversation into one cell, each message led by
 * a marker of who speaks (`CLIENT …`, `AGENT …`) and separated from the previous one by a separator
 * (« ` »). These are the export's own structural tokens, not words of the conversation, and a message
 * boundary is only ever where both meet: a separator followed by a confirmed marker. A marker word inside
 * a message, or a separator inside a message not followed by a marker, stays text of that message.
 *
 * Detection only proposes: markers are the uppercase words found at message boundaries often enough to be
 * structure, the separator is the character that most often stands right before them. The owner confirms.
 */

export interface MarkerCount { token: string; messages: number; dialogues: number }
export interface MarkerStructure {
  separator: string;
  /** Proposed markers, the most frequent first. */
  markers: MarkerCount[];
  /** Texts whose first word is a proposed marker. */
  led: number;
}
export interface SplitMessage { marker: string; content: string }

/** Below this, an uppercase word after a separator is more likely a word of a message («SMS», «ИНН») than a marker. */
const MIN_MARKER_MESSAGES = 3;
const MIN_MARKER_SHARE = 0.001;
/** A marker is a word, not a sentence. */
const MARKER_CHARS = 40;
/** Characters that end or open a phrase in ordinary text: an uppercase word after them says nothing about structure. */
const PROSE = new Set(['.', ',', '!', '?', ':', ';', '(', ')', '"', '\'', '«', '»', '„', '“', '”', '-', '–', '—', '…']);

const isLetter = (char: string) => char.toLowerCase() !== char.toUpperCase();
const isWordChar = (char: string | undefined): boolean => char !== undefined && (isLetter(char) || (char >= '0' && char <= '9') || char === '_');
const isSpace = (char: string | undefined) => char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ' ';

/** A word of uppercase letters (any alphabet), digits and underscores with at least one letter: how exports tag who speaks. */
export function isMarkerToken(token: string): boolean {
  if (token.length < 2 || token.length > MARKER_CHARS) return false;
  let letters = 0;
  for (const char of token) {
    if (!isWordChar(char)) return false;
    if (isLetter(char)) { if (char !== char.toUpperCase()) return false; letters++; }
  }
  return letters > 0;
}

const wordAt = (text: string, at: number): string => { let end = at; while (isWordChar(text[end])) end++; return text.slice(at, end); };
const skipSpace = (text: string, at: number): number => { while (isSpace(text[at])) at++; return at; };

/** The marker that starts at `at` as a whole word, the longest when one marker is the beginning of another. */
function markerAt(text: string, at: number, markers: readonly string[]): string | undefined {
  let found: string | undefined;
  for (const marker of markers) if (text.startsWith(marker, at) && (!isWordChar(marker.at(-1)) || !isWordChar(text[at + marker.length])) && marker.length > (found?.length ?? 0)) found = marker;
  return found;
}

/**
 * The messages of one conversation text, or undefined when the text does not start with a marker. A
 * message runs from its marker (and an optional colon after it) to the separator of the next boundary.
 */
export function splitMessages(text: string, separator: string, markers: readonly string[]): SplitMessage[] | undefined {
  const start = skipSpace(text, 0);
  const first = markerAt(text, start, markers);
  if (!first) return undefined;
  const bounds: { marker: string; from: number; separator: number }[] = [{ marker: first, from: start + first.length, separator: -1 }];
  for (let search = start + first.length; ;) {
    const at = text.indexOf(separator, search);
    if (at === -1) break;
    const next = skipSpace(text, at + separator.length);
    const marker = markerAt(text, next, markers);
    if (marker) bounds.push({ marker, from: next + marker.length, separator: at });
    search = marker ? next + marker.length : at + separator.length;
  }
  return bounds.map((bound, i) => {
    const end = bounds[i + 1]?.separator ?? text.length;
    const from = text[bound.from] === ':' ? bound.from + 1 : bound.from;
    return { marker: bound.marker, content: text.slice(from, end).trim() };
  });
}

/** How often each uppercase word starts a message when messages are separated by `separator`. */
export function countMarkers(texts: readonly string[], separator: string): MarkerCount[] {
  const counts = new Map<string, MarkerCount>();
  for (const text of texts) {
    const seen = new Set<string>();
    const count = (token: string) => {
      if (!isMarkerToken(token)) return;
      let entry = counts.get(token);
      if (!entry) counts.set(token, entry = { token, messages: 0, dialogues: 0 });
      entry.messages++;
      if (!seen.has(token)) { seen.add(token); entry.dialogues++; }
    };
    count(wordAt(text, skipSpace(text, 0)));
    for (let at = text.indexOf(separator); at !== -1; at = text.indexOf(separator, at + separator.length)) count(wordAt(text, skipSpace(text, at + separator.length)));
  }
  return [...counts.values()].sort((a, b) => b.messages - a.messages || a.token.localeCompare(b.token));
}

/** How many messages each of `markers` starts — markers the owner named, in any case or form. */
export function boundaryCounts(texts: readonly string[], separator: string, markers: readonly string[]): Map<string, number> {
  const counts = new Map(markers.map(marker => [marker, 0]));
  const count = (text: string, at: number) => { const marker = markerAt(text, skipSpace(text, at), markers); if (marker) counts.set(marker, counts.get(marker)! + 1); };
  for (const text of texts) {
    count(text, 0);
    for (let at = text.indexOf(separator); at !== -1; at = text.indexOf(separator, at + separator.length)) count(text, at + separator.length);
  }
  return counts;
}

/** The markers worth proposing among the counts: frequent enough at boundaries to be the export's structure. */
export function frequentMarkers(counts: readonly MarkerCount[]): MarkerCount[] {
  const total = counts.reduce((sum, item) => sum + item.messages, 0);
  return counts.filter(item => item.messages >= Math.max(MIN_MARKER_MESSAGES, MIN_MARKER_SHARE * total));
}

/** Texts whose first word is one of `markers`. */
export function ledTexts(texts: readonly string[], markers: readonly string[]): number {
  return texts.filter(text => markerAt(text, skipSpace(text, 0), markers) !== undefined).length;
}

/**
 * The structure of a column of conversation texts, or undefined when most texts do not start with an
 * uppercase word or no separator stands before the markers. The owner's separator is taken as given.
 * Proposes; the owner confirms.
 */
export function detectMarkers(texts: readonly string[], given?: string): MarkerStructure | undefined {
  const leading = new Map<string, number>();
  for (const text of texts) {
    const token = wordAt(text, skipSpace(text, 0));
    if (isMarkerToken(token)) leading.set(token, (leading.get(token) ?? 0) + 1);
  }
  if ([...leading.values()].reduce((sum, n) => sum + n, 0) < texts.length / 2) return undefined;
  const separator = given ?? likelySeparator(texts, new Set(leading.keys())) ?? likelySeparator(texts);
  if (separator === undefined) return undefined;
  const markers = frequentMarkers(countMarkers(texts, separator));
  const led = ledTexts(texts, markers.map(item => item.token));
  // Every text a single message: the separator never stands before a marker, so there is no structure to read.
  if (markers.reduce((sum, item) => sum + item.messages, 0) <= led) return undefined;
  return { separator, markers, led };
}

/**
 * The character that most often stands right before a marker inside the texts (spaces skipped; a line
 * break counts as `\n`). Only `tokens` are looked at when given — the words that open conversations are
 * surely markers — otherwise every uppercase word. Punctuation of ordinary text never qualifies.
 */
function likelySeparator(texts: readonly string[], tokens?: ReadonlySet<string>): string | undefined {
  const before = new Map<string, number>();
  for (const text of texts) {
    let at = skipSpace(text, 0);
    at += wordAt(text, at).length;
    while (at < text.length) {
      if (!isWordChar(text[at])) { at++; continue; }
      const word = wordAt(text, at);
      if (tokens ? tokens.has(word) : isMarkerToken(word)) {
        let back = at - 1;
        while (back >= 0 && (text[back] === ' ' || text[back] === '\t' || text[back] === '\r' || text[back] === ' ')) back--;
        const char = text[back];
        if (char !== undefined && (char === '\n' || !isWordChar(char) && !PROSE.has(char))) before.set(char, (before.get(char) ?? 0) + 1);
      }
      at += word.length;
    }
  }
  let best: [string, number] | undefined;
  for (const entry of before) if (!best || entry[1] > best[1]) best = entry;
  return best && best[1] >= 2 ? best[0] : undefined;
}
