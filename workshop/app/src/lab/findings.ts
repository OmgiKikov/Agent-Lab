import type { Item, LabRun } from "./types";

const keyOf = (rule: string) => rule.trim().toLowerCase().replace(/\s+/g, " ");

/** Puts the quote the judge cited in a `<mark>`: returns the text before it, the quote, and the text after. */
export function splitQuote(text: string, quote?: string): [string, string, string] | null {
  const q = quote?.trim().replace(/^«|»$/g, "").replace(/…$/, "").trim();
  if (!q) return null;
  let at = text.indexOf(q);
  let len = q.length;
  if (at < 0) {
    const lower = text.toLowerCase().indexOf(q.toLowerCase());
    if (lower >= 0) { at = lower; }
    else if (q.length > 30) { const head = q.slice(0, 30); at = text.indexOf(head); len = head.length; }
  }
  return at < 0 ? null : [text.slice(0, at), text.slice(at, at + len), text.slice(at + len)];
}

/* ---------- trust ---------- */

export type TrustLevel = "pending" | "partial" | "ok";
export const MIN_CHECKED = 10;
export const ENOUGH_CHECKED = 30;

export const TRUST_TEXT: Record<TrustLevel, string> = { pending: "оценка предварительная", partial: "условно надёжна", ok: "оценке можно верить" };

/** How far the run's number can be trusted: how many verdicts a person checked and how right the judge was. */
export function trustOf(run: LabRun | null) {
  const m = run?.metric;
  const reviewed = m?.human?.reviewed ?? 0;
  const humanShare = m?.human && reviewed >= MIN_CHECKED ? m.human.agree / reviewed : null;
  const secondShare = m?.secondJudge && m.secondJudge.checked ? m.secondJudge.agree / m.secondJudge.checked : null;
  const level: TrustLevel = reviewed < MIN_CHECKED ? "pending"
    : reviewed >= ENOUGH_CHECKED && (humanShare ?? 0) >= 0.8 && (secondShare ?? 1) >= 0.8 ? "ok" : "partial";
  return { level, reviewed, humanShare, secondShare, agree: m?.human?.agree ?? 0 };
}

/** Where the judge was corrected by a person: per criterion, how many of the checked verdicts were wrong. */
export function judgeErrors(items: Item[]) {
  const by = new Map<string, { rule: string; checked: number; wrong: number }>();
  for (const item of items) {
    if (!item.review) continue;
    for (const r of item.rules) {
      if (r.status !== "FAIL" && r.status !== "PASS") continue;
      const row = by.get(keyOf(r.rule)) ?? { rule: r.rule, checked: 0, wrong: 0 };
      row.checked++;
      if (item.review === "disagree") row.wrong++;
      by.set(keyOf(r.rule), row);
    }
  }
  return [...by.values()].sort((a, b) => b.wrong / b.checked - a.wrong / a.checked || b.checked - a.checked);
}
