/** Finds the quote the judge cited in a text: the text before it, the quote, and the text after; null when absent. */
export function splitQuote(text: string, quote?: string): [string, string, string] | null {
  const q = quote?.trim().replace(/^«|»$/g, "").replace(/…$/, "").trim();
  if (!q) return null;
  let at = text.indexOf(q);
  let len = q.length;
  if (at < 0) {
    const lower = text.toLowerCase().indexOf(q.toLowerCase());
    if (lower >= 0) at = lower;
    else if (q.length > 30) {
      const head = q.slice(0, 30);
      at = text.indexOf(head);
      len = head.length;
    }
  }
  return at < 0 ? null : [text.slice(0, at), text.slice(at, at + len), text.slice(at + len)];
}

export type Segment = { text: string; n?: number };

/** A text cut into plain pieces and quoted ones (each with its number), in order; overlapping quotes keep the first. */
export function segments(text: string, marks: { quote: string; n: number }[]): Segment[] {
  const found: { at: number; len: number; n: number }[] = [];
  for (const m of marks) {
    const parts = splitQuote(text, m.quote);
    if (parts) found.push({ at: parts[0].length, len: parts[1].length, n: m.n });
  }
  found.sort((a, b) => a.at - b.at);
  const out: Segment[] = [];
  let pos = 0;
  for (const f of found) {
    if (f.at < pos) continue;
    if (f.at > pos) out.push({ text: text.slice(pos, f.at) });
    out.push({ text: text.slice(f.at, f.at + f.len), n: f.n });
    pos = f.at + f.len;
  }
  if (pos < text.length) out.push({ text: text.slice(pos) });
  return out;
}

/** What the marks an export puts in place of the client's data stand for, said once where conversations are read. */
export const MASKS = "# и * — скрытые данные клиента";

/** A mark standing alone: «#» in anyone's words; «*» only in the client's, since in the agent's it begins a list item. */
const MASK = /(^|[\s(«])#(?=$|[\s.,:;!?%)»])/m;
const CLIENT_MASK = /(^|[\s(«])[#*](?=$|[\s.,:;!?%)»])/m;

/** Whether someone's words show the export's masks (MASKS): the client's (`client`), else the agent's. */
export const showsMasks = (text: string, client: boolean) => (client ? CLIENT_MASK : MASK).test(text);

/** One line of a criterion's words as a person reads them: a point of a list, or a paragraph of its own. */
export type RulePart = { text: string; point: boolean };

/** A heading of the rules' document, with or without the rubric's code: «## Лексика и синтаксис: simple_language». */
const HEADING = /^#{1,6}(?:[ \t]|$)/;
/** The mark a point of a list begins with: «*», «-», «•», «–» or «—». */
const POINT = /^[*\-•–—][ \t]+/;
/** A line that ends a sentence or introduces what follows: the next line is a part of its own. */
const ENDED = /[.!?:;…]$/;

/**
 * A line without Markdown's bold and code marks around words: «**важно**», «`код`» read as words. A single «*» stays:
 * the rules speak of it as a character («маркер «*» (звёздочка)»).
 */
const unmarked = (line: string) =>
  line
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/[ \t]+/g, " ")
    .trim();

/**
 * A criterion's words as a person reads them, the one way every screen and every text that leaves the product shows
 * them: the points the rules were written with («* Стиль — …», also run together on one line) as points, the words
 * around them as paragraphs. The rules' headings go with the rubric's codes in them («### simple_language», «## Лексика
 * и синтаксис: simple_language» — passages a coded rubric quotes are joined by « … » before them), and so do Markdown's
 * bold and code marks; a line broken inside a sentence joins the line before it.
 */
export function ruleParts(text: string): RulePart[] {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+…[ \t]+(?=#)/g, "\n")
    .replace(/[ \t]+([*•])[ \t]+/g, "\n$1 ")
    .split("\n");
  const parts: RulePart[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || HEADING.test(line)) continue;
    const point = POINT.test(line);
    const words = unmarked(line.replace(POINT, ""));
    if (!words) continue;
    const last = parts[parts.length - 1];
    if (!point && last && !ENDED.test(last.text) && /^\p{Ll}/u.test(words)) last.text = `${last.text} ${words}`;
    else parts.push({ text: words, point });
  }
  return parts;
}

/** A criterion's words as lines of plain text (ruleParts): a point as «• …», a paragraph as it is. */
export const ruleLines = (text: string) => ruleParts(text).map((p) => (p.point ? `• ${p.text}` : p.text));

/** Someone's words on one line: line breaks and runs of spaces as one space; a non-breaking space stays what it is. */
export const oneLine = (text: string) => text.replace(/[^\S\u00a0]+/g, " ").trim();

/**
 * A long text on one line (oneLine), cut at a word to about `limit` characters: «…» where it was cut, and the quotes it
 * cut open closed after it («Нажмите кнопку «Чат с…»»).
 */
export function clip(text: string, limit: number): string {
  const whole = oneLine(text);
  if (whole.length <= limit) return whole;
  const head = whole.slice(0, limit + 1);
  const space = head.lastIndexOf(" ");
  const cut = (space > limit / 2 ? head.slice(0, space) : whole.slice(0, limit)).replace(/[\s,.;:!?—–-]+$/, "");
  const open = (start: string, end: string) => Math.max(0, cut.split(start).length - cut.split(end).length);
  return `${cut}…${"“".repeat(open("„", "“"))}${"»".repeat(open("«", "»"))}`;
}

/** Someone's words inside a quote: their own «ёлочки» and "straight quotes" become „лапки“. */
const nested = (text: string) =>
  text
    .replace(/«/g, "„")
    .replace(/»/g, "“")
    .replace(/"([^"\n]*)"/g, "„$1“");

/** Words quoted in a sentence: «…», the quotes inside as „лапки“, and never a second pair of «» of their own. */
export const inQuotes = (text: string) => `«${nested(text.trim().replace(/^«([^«»]*)»$/, "$1"))}»`;
