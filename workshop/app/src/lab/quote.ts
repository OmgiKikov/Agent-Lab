/** Finds the quote the judge cited in a text: the text before it, the quote, and the text after; null when absent. */
export function splitQuote(text: string, quote?: string): [string, string, string] | null {
  const q = quote?.trim().replace(/^«|»$/g, "").replace(/…$/, "").trim();
  if (!q) return null;
  let at = text.indexOf(q);
  let len = q.length;
  if (at < 0) {
    const lower = text.toLowerCase().indexOf(q.toLowerCase());
    if (lower >= 0) at = lower;
    else if (q.length > 30) { const head = q.slice(0, 30); at = text.indexOf(head); len = head.length; }
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
