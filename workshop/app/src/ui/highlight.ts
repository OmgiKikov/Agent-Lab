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
