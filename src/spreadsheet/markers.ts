/*
 * One conversation per row: the export writes the whole conversation into one cell, each message led by
 * a marker of who speaks (`CLIENT …`, `AGENT …`). These are the export's own structural tokens, not words
 * of the conversation. Some exports put a separator between messages (« ` »): a message boundary is then
 * only ever where both meet — a separator followed by a confirmed marker — and a marker word inside a
 * message, or a separator inside a message not followed by a marker, stays text of that message. Other
 * exports only join the messages with spaces: a message then starts at every confirmed marker that opens
 * the text or follows a space, as a whole word — the AGENT of SUPPORT_AGENT starts nothing.
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

/**
 * The readings below look at every character of a column, so they read UTF-16 units by their codes: a one-character
 * string and a case conversion per character kept a 4 MB workbook busy for seconds. What a unit is — an uppercase
 * letter, another letter (one with a case), no letter — is computed once per unit. `charCodeAt` past the text is NaN,
 * which is neither a letter nor a space.
 */
const UNITS = new Uint8Array(0x10000);
const UPPER = 1, LOWER = 2, NO_LETTER = 3;
function unitKind(code: number): number {
  let kind = UNITS[code];
  if (kind === undefined) return NO_LETTER;
  if (!kind) {
    const char = String.fromCharCode(code);
    UNITS[code] = kind = char.toLowerCase() === char.toUpperCase() ? NO_LETTER : char === char.toUpperCase() ? UPPER : LOWER;
  }
  return kind;
}
const digitOrUnderscore = (code: number): boolean => code >= 48 && code <= 57 || code === 95;
const wordCode = (code: number): boolean => digitOrUnderscore(code) || unitKind(code) !== NO_LETTER;
const spaceCode = (code: number): boolean => code === 32 || code === 9 || code === 10 || code === 13;
const isLetter = (char: string): boolean => char.length === 1 ? unitKind(char.charCodeAt(0)) !== NO_LETTER : char.toLowerCase() !== char.toUpperCase();
const isWordChar = (char: string | undefined): boolean => char !== undefined && (char.length === 1 ? wordCode(char.charCodeAt(0)) : isLetter(char));
const sum = (counts: Iterable<number>) => { let total = 0; for (const count of counts) total += count; return total; };

/**
 * A word of uppercase letters (any alphabet), digits and underscores with at least one letter: how exports tag who
 * speaks. Words come from wordAt, a unit at a time, so every character of one is a single unit.
 */
function isMarkerToken(token: string): boolean {
  if (token.length < 2 || token.length > MARKER_CHARS) return false;
  let letters = 0;
  for (let i = 0; i < token.length; i++) {
    const code = token.charCodeAt(i);
    if (digitOrUnderscore(code)) continue;
    if (unitKind(code) !== UPPER) return false;
    letters++;
  }
  return letters > 0;
}
/** Whether the word at `at` could be a marker at all: one that opens with a lowercase letter never is. */
const mayBeMarker = (text: string, at: number): boolean => unitKind(text.charCodeAt(at)) !== LOWER;

const wordEnd = (text: string, at: number): number => { while (wordCode(text.charCodeAt(at))) at++; return at; };
const wordAt = (text: string, at: number): string => text.slice(at, wordEnd(text, at));
const skipSpace = (text: string, at: number): number => { while (spaceCode(text.charCodeAt(at))) at++; return at; };

/** The first units of a list of markers, once per list: most places start no marker, and one comparison says so. */
const FIRST_UNITS = new WeakMap<readonly string[], ReadonlySet<number> | null>();
function firstUnits(markers: readonly string[]): ReadonlySet<number> | null {
  let first = FIRST_UNITS.get(markers);
  if (first === undefined) FIRST_UNITS.set(markers, first = markers.some(marker => !marker) ? null : new Set(markers.map(marker => marker.charCodeAt(0))));
  return first;
}

/** The marker that starts at `at` as a whole word, the longest when one marker is the beginning of another. */
function markerAt(text: string, at: number, markers: readonly string[]): string | undefined {
  if (firstUnits(markers)?.has(text.charCodeAt(at)) === false) return undefined;
  let found: string | undefined;
  for (const marker of markers) if (text.startsWith(marker, at) && (!isWordChar(marker.at(-1)) || !wordCode(text.charCodeAt(at + marker.length))) && marker.length > (found?.length ?? 0)) found = marker;
  return found;
}
/** The units one of `markers` may start with, as a test eachBoundary passes places by. */
function startsOf(markers: readonly string[]): ((code: number) => boolean) | undefined {
  const first = firstUnits(markers);
  return first ? code => first.has(code) : undefined;
}
/** A unit an uppercase word may open with: an uppercase letter, a digit or `_`. */
const tokenStart = (code: number): boolean => digitOrUnderscore(code) || unitKind(code) === UPPER;

/**
 * Calls `visit` at every place of `text` from `from` on where a message may begin: right after each
 * separator (spaces skipped), or, without one, at each word that follows a space — never the text's first
 * word, which starts the text in every reading. `visit` returns how far the search may jump (past a marker
 * it found), or nothing to go on. `end` is where the message before that place ends: at the separator, or
 * at the place itself. A place whose first unit `opens` refuses is passed over as if `visit` found nothing
 * there: most words of a conversation start no marker, and one comparison says so.
 */
function eachBoundary(text: string, separator: string | undefined, from: number, visit: (at: number, end: number) => number | void, opens?: (code: number) => boolean): void {
  if (separator !== undefined) {
    for (let at = text.indexOf(separator, from); at !== -1;) {
      const next = skipSpace(text, at + separator.length);
      const past = opens && !opens(text.charCodeAt(next)) ? undefined : visit(next, at);
      at = text.indexOf(separator, past ?? at + separator.length);
    }
    return;
  }
  const start = Math.max(from, skipSpace(text, 0) + 1);
  let before = text.charCodeAt(start - 1);
  for (let at = start; at < text.length; at++) {
    const code = text.charCodeAt(at);
    // A place opens after a space: the unit before it is one, and it is not.
    if (!spaceCode(before) || spaceCode(code) || opens && !opens(code)) { before = code; continue; }
    const past = visit(at, at);
    if (past !== undefined) at = past - 1;
    before = text.charCodeAt(at);
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
  }, startsOf(markers));
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
    const count = (at: number) => {
      if (!mayBeMarker(text, at)) return;
      const token = wordAt(text, at);
      if (!isMarkerToken(token)) return;
      let entry = counts.get(token);
      if (!entry) counts.set(token, entry = { token, messages: 0, dialogues: 0 });
      entry.messages++;
      if (!seen.has(token)) { seen.add(token); entry.dialogues++; }
    };
    count(skipSpace(text, 0));
    eachBoundary(text, separator, 0, at => { count(at); }, tokenStart);
  }
  return [...counts.values()].sort((a, b) => b.messages - a.messages || a.token.localeCompare(b.token));
}

/** A word Lab's model may choose as a marker: how often it stands at a word boundary of a column's texts, and in how many texts. */
export interface CandidateToken { token: string; occurrences: number; texts: number }

/**
 * The words a column's texts could mark messages with, for Lab's model to choose from: every uppercase word (CLIENT,
 * AGENT, БОТ) and every «Клиент:» label — a word right before a colon, the colon included — that starts at a word
 * boundary: the text's start, or after any character that is not part of a word, so the AGENT of SUPPORT_AGENT is
 * none. Only words standing in two texts or more: structure repeats, a one-off word is content. The most frequent
 * first, at most `limit`.
 */
export function candidateTokens(texts: readonly string[], limit: number): CandidateToken[] {
  const counts = new Map<string, CandidateToken>();
  for (const text of texts) {
    const seen = new Set<string>();
    for (let at = 0; at < text.length; at++) {
      const code = text.charCodeAt(at);
      if (!wordCode(code) || wordCode(text.charCodeAt(at - 1))) continue;
      const end = wordEnd(text, at), colon = text.charCodeAt(end) === 58;
      // A word that opens with a lowercase letter and stands before no colon is neither; it is not cut out of the text.
      if (!colon && unitKind(code) === LOWER) { at = end - 1; continue; }
      const word = text.slice(at, end);
      const label = colon && word.length >= 2 && word.length < MARKER_CHARS && [...word].some(isLetter);
      const token = isMarkerToken(word) ? word : label ? `${word}:` : undefined;
      at = end - 1;
      if (!token) continue;
      let entry = counts.get(token);
      if (!entry) counts.set(token, entry = { token, occurrences: 0, texts: 0 });
      entry.occurrences++;
      if (!seen.has(token)) { seen.add(token); entry.texts++; }
    }
  }
  return [...counts.values()].filter(item => item.texts >= Math.min(2, texts.length))
    .sort((a, b) => b.occurrences - a.occurrences || (a.token < b.token ? -1 : a.token > b.token ? 1 : 0)).slice(0, limit);
}

/** How many messages each of `markers` starts — markers the owner named, in any case or form. */
export function boundaryCounts(texts: readonly string[], separator: string | undefined, markers: readonly string[]): Map<string, number> {
  const counts = new Map(markers.map(marker => [marker, 0]));
  const count = (text: string, at: number) => { const marker = markerAt(text, at, markers); if (marker) counts.set(marker, counts.get(marker)! + 1); };
  const opens = startsOf(markers);
  for (const text of texts) {
    count(text, skipSpace(text, 0));
    eachBoundary(text, separator, 0, at => { count(text, at); }, opens);
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
function readingOf(texts: readonly string[], separator: string | undefined, leading: ReadonlyMap<string, number>, counts = countMarkers(texts, separator)): MarkerStructure | undefined {
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
 * the texts — where a message would start without a separator — most follow the separator too. `spaced` counts the
 * markers' messages read with no separator; detection has counted every uppercase word so already.
 */
function separatesMarkers(texts: readonly string[], reading: MarkerStructure,
  spaced: ReadonlyMap<string, number> = boundaryCounts(texts, undefined, reading.markers.map(item => item.token))): boolean {
  const separated = sum(reading.markers.map(item => item.messages)) - reading.led;
  const around = sum(reading.markers.map(item => spaced.get(item.token) ?? 0)) - reading.led;
  return separated >= around * SEPARATOR_SHARE;
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
  // Every uppercase word counted with no separator, once: the separators are checked against it, and it is the last reading.
  let counted: MarkerCount[] | undefined;
  const unseparated = () => counted ??= countMarkers(texts, undefined);
  const opening = likelySeparators(texts, new Set(leading.keys()));
  for (const separator of opening.length ? opening : likelySeparators(texts)) {
    const reading = readingOf(texts, separator, leading);
    if (reading && plausible(reading) && separatesMarkers(texts, reading, new Map(unseparated().map(item => [item.token, item.messages])))) return reading;
  }
  const spaced = readingOf(texts, undefined, leading, unseparated());
  return spaced && plausible(spaced) ? spaced : undefined;
}

/** How many messages each named marker starts, and in how many texts, the most frequent first. */
function namedCounts(texts: readonly string[], separator: string | undefined, markers: readonly string[]): MarkerCount[] {
  const counts = new Map(markers.map(token => [token, { token, messages: 0, dialogues: 0 }]));
  const opens = startsOf(markers);
  for (const text of texts) {
    const seen = new Set<string>();
    const count = (at: number) => {
      const marker = markerAt(text, at, markers);
      if (!marker) return;
      const entry = counts.get(marker)!;
      entry.messages++;
      if (!seen.has(marker)) { seen.add(marker); entry.dialogues++; }
    };
    count(skipSpace(text, 0));
    eachBoundary(text, separator, 0, at => { count(at); }, opens);
  }
  return [...counts.values()].sort((a, b) => b.messages - a.messages || a.token.localeCompare(b.token));
}

/** The characters before the named markers inside the texts, as likelySeparators counts them before uppercase words. */
function charsBefore(texts: readonly string[], markers: readonly string[]): string[] {
  const before = new Map<string, number>();
  for (const text of texts) {
    for (let at = skipSpace(text, 0) + 1; at < text.length; at++) {
      if (wordCode(text.charCodeAt(at - 1))) continue;
      const marker = markerAt(text, at, markers);
      if (!marker) continue;
      let back = at - 1;
      while (back >= 0 && (text[back] === ' ' || text[back] === '\t' || text[back] === '\r')) back--;
      const char = text[back];
      if (char !== undefined && (char === '\n' || !isWordChar(char) && !PROSE.has(char))) before.set(char, (before.get(char) ?? 0) + 1);
      at += marker.length - 1;
    }
  }
  return [...before].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([char]) => char);
}

/**
 * The structure of texts under the markers the owner named, in any case or form («Клиент:», «Оператор:»): Lab's own
 * detection looks for uppercase words, and the owner's word is taken as given. The separator is the owner's (null:
 * none), else the character before most of the named markers, else none. Undefined when the named markers lead fewer
 * than half of the texts — they do not open its conversations — or start no second message anywhere.
 */
export function namedStructure(texts: readonly string[], markers: readonly string[], given?: string | null): MarkerStructure | undefined {
  const led = ledTexts(texts, markers);
  if (!markers.length || led < texts.length / 2) return undefined;
  const reading = (separator: string | undefined): MarkerStructure | undefined => {
    const counts = namedCounts(texts, separator, markers);
    return sum(counts.map(item => item.messages)) > led ? { ...separator === undefined ? {} : { separator }, markers: counts, led } : undefined;
  };
  if (given !== undefined) return reading(given ?? undefined);
  for (const separator of charsBefore(texts, markers)) {
    const candidate = reading(separator);
    if (candidate && separatesMarkers(texts, candidate)) return candidate;
  }
  return reading(undefined);
}

/**
 * The characters that stand right before a marker inside the texts (spaces skipped; a line break counts as
 * `\n`), the most frequent first, each seen at least twice. Only `tokens` are looked at when given — the
 * words that open conversations are surely markers — otherwise every uppercase word. Punctuation of
 * ordinary text never qualifies.
 */
function likelySeparators(texts: readonly string[], tokens?: ReadonlySet<string>): string[] {
  const before = new Map<string, number>();
  const first = tokens && new Set([...tokens].map(token => token.charCodeAt(0)));
  for (const text of texts) {
    let at = wordEnd(text, skipSpace(text, 0));
    while (at < text.length) {
      const code = text.charCodeAt(at);
      if (!wordCode(code)) { at++; continue; }
      const end = wordEnd(text, at);
      // Only a word that may be one is cut out of the text and looked up.
      if (first ? first.has(code) && tokens!.has(text.slice(at, end)) : unitKind(code) !== LOWER && isMarkerToken(text.slice(at, end))) {
        let back = at - 1;
        while (back >= 0 && (text[back] === ' ' || text[back] === '\t' || text[back] === '\r' || text[back] === ' ')) back--;
        const char = text[back];
        if (char !== undefined && (char === '\n' || !isWordChar(char) && !PROSE.has(char))) before.set(char, (before.get(char) ?? 0) + 1);
      }
      at = end;
    }
  }
  return [...before].filter(([, count]) => count >= 2).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([char]) => char);
}
