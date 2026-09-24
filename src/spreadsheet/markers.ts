/*
 * One conversation per row: the export writes the whole conversation into one cell, each message led by
 * a marker of who speaks (`CLIENT …`, `AGENT …`). These are the export's own structural tokens, not words
 * of the conversation. Some exports put a separator between messages (« ` »): a message boundary is then
 * only ever where both meet — a separator followed by a confirmed marker — and a marker word inside a
 * message, or a separator inside a message not followed by a marker, stays text of that message. Other
 * exports only join the messages with spaces: a message then starts at every confirmed marker that opens
 * the text or follows a space, as a whole word — the AGENT of ACQUIRING_AGENT starts nothing.
 *
 * Detection only proposes, and it compares readings: each character that stands before the markers taken
 * as the separator, and the markers alone. A reading is plausible when both sides of a conversation are in
 * it, the second not near zero next to the first, and — with a separator — the separator stands before
 * most markers. Backticks that close a code fence in an agent's reply stand before a client's marker now
 * and then, never before the agent's; the export's separator stands before both. The owner confirms.
 */

export interface MarkerCount { token: string; messages: number; dialogues: number }
export interface MarkerStructure {
  /** What stands between messages; undefined when nothing does and a message starts at every marker. */
  separator?: string;
  /** Proposed markers, the most frequent first. */
  markers: MarkerCount[];
  /** Texts whose first word is a proposed marker. */
  led: number;
}
export interface SplitMessage { marker: string; content: string }

/** Below this, an uppercase word after a separator is more likely a word of a message («SMS», «ИНН») than a marker. */
const MIN_MARKER_MESSAGES = 3;
const MIN_MARKER_SHARE = 0.001;
/**
 * Without a separator any word after a space could start a message, so a word the texts do not open is a marker
 * only when it stands in this share of the conversations, as each side of a dialogue does. «ИП» or «SMS» in some
 * messages is not proposed; a rarer marker (an operator who joins a few conversations) the owner names.
 */
const SPACED_MARKER_SHARE = 0.5;
/** Both sides of a dialogue write: the second most frequent marker starts at least this share of the first one's messages. */
const NEAR_ZERO = 0.1;
/**
 * The export's separator stands before most markers that start a word after a space — a client writing «AGENT»
 * inside a message aside; a character inside messages, like the backticks closing a code fence, before a few.
 */
const SEPARATOR_SHARE = 0.5;
/** A marker is a word, not a sentence. */
const MARKER_CHARS = 40;
/** Characters that end or open a phrase in ordinary text: an uppercase word after them says nothing about structure. */
const PROSE = new Set(['.', ',', '!', '?', ':', ';', '(', ')', '"', '\'', '«', '»', '„', '“', '”', '-', '–', '—', '…']);

const isLetter = (char: string) => char.toLowerCase() !== char.toUpperCase();
const isWordChar = (char: string | undefined): boolean => char !== undefined && (isLetter(char) || (char >= '0' && char <= '9') || char === '_');
const isSpace = (char: string | undefined) => char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === ' ';
const sum = (counts: Iterable<number>) => { let total = 0; for (const count of counts) total += count; return total; };

/** A word of uppercase letters (any alphabet), digits and underscores with at least one letter: how exports tag who speaks. */
function isMarkerToken(token: string): boolean {
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
/** Where a word starts after a space: without a separator, the only places after the text's start where a message may begin. */
const opensAfterSpace = (text: string, at: number) => isSpace(text[at - 1]) && !isSpace(text[at]);

/** The marker that starts at `at` as a whole word, the longest when one marker is the beginning of another. */
function markerAt(text: string, at: number, markers: readonly string[]): string | undefined {
  let found: string | undefined;
  for (const marker of markers) if (text.startsWith(marker, at) && (!isWordChar(marker.at(-1)) || !isWordChar(text[at + marker.length])) && marker.length > (found?.length ?? 0)) found = marker;
  return found;
}

/**
 * Calls `visit` at every place of `text` from `from` on where a message may begin: right after each
 * separator (spaces skipped), or, without one, at each word that follows a space — never the text's first
 * word, which starts the text in every reading. `visit` returns how far the search may jump (past a marker
 * it found), or nothing to go on. `end` is where the message before that place ends: at the separator, or
 * at the place itself.
 */
function eachBoundary(text: string, separator: string | undefined, from: number, visit: (at: number, end: number) => number | void): void {
  if (separator !== undefined) {
    for (let at = text.indexOf(separator, from); at !== -1;) {
      const next = skipSpace(text, at + separator.length);
      at = text.indexOf(separator, visit(next, at) ?? at + separator.length);
    }
    return;
  }
  for (let at = Math.max(from, skipSpace(text, 0) + 1); at < text.length; at++) {
    if (!opensAfterSpace(text, at)) continue;
    const past = visit(at, at);
    if (past !== undefined) at = past - 1;
  }
}

/**
 * The messages of one conversation text, or undefined when the text does not start with a marker. A
 * message runs from its marker (and an optional colon after it) to the next boundary: the separator
 * before the next marker, or that marker itself when messages are not separated.
 */
export function splitMessages(text: string, separator: string | undefined, markers: readonly string[]): SplitMessage[] | undefined {
  const start = skipSpace(text, 0);
  const first = markerAt(text, start, markers);
  if (!first) return undefined;
  const bounds: { marker: string; from: number; end: number }[] = [{ marker: first, from: start + first.length, end: -1 }];
  eachBoundary(text, separator, start + first.length, (at, end) => {
    const marker = markerAt(text, at, markers);
    if (!marker) return undefined;
    bounds.push({ marker, from: at + marker.length, end });
    return at + marker.length;
  });
  return bounds.map((bound, i) => {
    const end = bounds[i + 1]?.end ?? text.length;
    const from = text[bound.from] === ':' ? bound.from + 1 : bound.from;
    return { marker: bound.marker, content: text.slice(from, end).trim() };
  });
}

/** How often each uppercase word starts a message when messages are separated by `separator`, or by nothing. */
function countMarkers(texts: readonly string[], separator: string | undefined): MarkerCount[] {
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
    eachBoundary(text, separator, 0, at => { count(wordAt(text, at)); });
  }
  return [...counts.values()].sort((a, b) => b.messages - a.messages || a.token.localeCompare(b.token));
}

/** How many messages each of `markers` starts — markers the owner named, in any case or form. */
export function boundaryCounts(texts: readonly string[], separator: string | undefined, markers: readonly string[]): Map<string, number> {
  const counts = new Map(markers.map(marker => [marker, 0]));
  const count = (text: string, at: number) => { const marker = markerAt(text, at, markers); if (marker) counts.set(marker, counts.get(marker)! + 1); };
  for (const text of texts) {
    count(text, skipSpace(text, 0));
    eachBoundary(text, separator, 0, at => { count(text, at); });
  }
  return counts;
}

/** Texts whose first word is one of `markers`. */
function ledTexts(texts: readonly string[], markers: readonly string[]): number {
  return texts.filter(text => markerAt(text, skipSpace(text, 0), markers) !== undefined).length;
}

/**
 * The texts read with `separator` (or with none): the markers worth proposing and the texts they lead, or
 * undefined when every text is a single message — nothing starts a second one, so there is no structure. With
 * a separator, a marker is an uppercase word after it often enough to be structure; without one, a word the
 * texts open (the start of a text is a boundary in every reading) or one that half of the conversations hold.
 */
function readingOf(texts: readonly string[], separator: string | undefined, leading: ReadonlyMap<string, number>): MarkerStructure | undefined {
  const counts = countMarkers(texts, separator);
  const total = sum(counts.map(item => item.messages));
  const markers = counts.filter(separator === undefined
    ? item => (leading.get(item.token) ?? 0) >= MIN_MARKER_MESSAGES || item.dialogues >= texts.length * SPACED_MARKER_SHARE
    : item => item.messages >= Math.max(MIN_MARKER_MESSAGES, MIN_MARKER_SHARE * total));
  const led = ledTexts(texts, markers.map(item => item.token));
  if (sum(markers.map(item => item.messages)) <= led) return undefined;
  return { ...separator === undefined ? {} : { separator }, markers, led };
}

/** Both sides of a conversation: a second marker, not near zero next to the first. */
function plausible(reading: MarkerStructure): boolean {
  const [first, second] = reading.markers;
  return first !== undefined && second !== undefined && second.messages >= first.messages * NEAR_ZERO;
}

/**
 * Whether the reading's separator stands before most markers: of the markers' words that follow a space inside
 * the texts — where a message would start without a separator — most follow the separator too.
 */
function separatesMarkers(texts: readonly string[], reading: MarkerStructure): boolean {
  const separated = sum(reading.markers.map(item => item.messages)) - reading.led;
  const spaced = sum(boundaryCounts(texts, undefined, reading.markers.map(item => item.token)).values()) - reading.led;
  return separated >= spaced * SEPARATOR_SHARE;
}

/**
 * The structure of a column of conversation texts, or undefined when most texts do not start with an
 * uppercase word or no reading of them is plausible. The owner's separator — or the owner's word that
 * there is none (null) — is taken as given. Otherwise the first plausible reading wins: a separator that
 * stands before most markers, the likeliest first, then the markers alone. Proposes; the owner confirms.
 */
export function detectMarkers(texts: readonly string[], given?: string | null): MarkerStructure | undefined {
  const leading = new Map<string, number>();
  for (const text of texts) {
    const token = wordAt(text, skipSpace(text, 0));
    if (isMarkerToken(token)) leading.set(token, (leading.get(token) ?? 0) + 1);
  }
  if (sum(leading.values()) < texts.length / 2) return undefined;
  if (given !== undefined) return readingOf(texts, given ?? undefined, leading);
  const opening = likelySeparators(texts, new Set(leading.keys()));
  for (const separator of opening.length ? opening : likelySeparators(texts)) {
    const reading = readingOf(texts, separator, leading);
    if (reading && plausible(reading) && separatesMarkers(texts, reading)) return reading;
  }
  const spaced = readingOf(texts, undefined, leading);
  return spaced && plausible(spaced) ? spaced : undefined;
}

/**
 * The characters that stand right before a marker inside the texts (spaces skipped; a line break counts as
 * `\n`), the most frequent first, each seen at least twice. Only `tokens` are looked at when given — the
 * words that open conversations are surely markers — otherwise every uppercase word. Punctuation of
 * ordinary text never qualifies.
 */
function likelySeparators(texts: readonly string[], tokens?: ReadonlySet<string>): string[] {
  const before = new Map<string, number>();
  for (const text of texts) {
    let at = skipSpace(text, 0);
    at += wordAt(text, at).length;
    while (at < text.length) {
      if (!isWordChar(text[at])) { at++; continue; }
      const word = wordAt(text, at);
      if (tokens ? tokens.has(word) : isMarkerToken(word)) {
        let back = at - 1;
        while (back >= 0 && (text[back] === ' ' || text[back] === '\t' || text[back] === '\r' || text[back] === ' ')) back--;
        const char = text[back];
        if (char !== undefined && (char === '\n' || !isWordChar(char) && !PROSE.has(char))) before.set(char, (before.get(char) ?? 0) + 1);
      }
      at += word.length;
    }
  }
  return [...before].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([char]) => char);
}
