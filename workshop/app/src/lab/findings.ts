import { personaOf } from "./logic";
import type { Item, LabRun } from "./types";

/**
 * A finding is one broken rule seen across conversations: «the agent does not ask for the terminal before advising».
 * The service does not group failures, so they are grouped here by the text of the rule.
 */
export type Finding = {
  key: string; rule: string; title: string;
  count: number; measured: number;
  byPersona: Record<string, number>;
  items: Item[];
};

export type Change = "new" | "remains" | "fixed";
export type Compared = { finding: Finding; change: Change | null; before: number };

const finished = (i: Item) => i.status === "PASS" || i.status === "FAIL";
const keyOf = (rule: string) => rule.trim().toLowerCase().replace(/\s+/g, " ");

export function deriveFindings(items: Item[]): Finding[] {
  const measured = items.filter(finished).length;
  const found = new Map<string, Finding>();
  for (const item of items) {
    for (const r of item.rules) {
      if (r.status !== "FAIL") continue;
      const key = keyOf(r.rule);
      const f = found.get(key) ?? { key, rule: r.rule, title: r.title || r.rule, count: 0, measured, byPersona: {}, items: [] };
      if (!f.items.includes(item)) {
        f.items.push(item);
        f.count++;
        const p = personaOf(item);
        f.byPersona[p] = (f.byPersona[p] ?? 0) + 1;
      }
      found.set(key, f);
    }
  }
  return [...found.values()].sort((a, b) => b.count - a.count);
}

/** Findings of this run against the previous one: new, still there, fixed. Without a previous run there is no verdict. */
export function compareFindings(current: Finding[], previous: Finding[] | null): Compared[] {
  if (!previous) return current.map(finding => ({ finding, change: null, before: 0 }));
  const before = new Map(previous.map(f => [f.key, f]));
  const now = new Set(current.map(f => f.key));
  const out: Compared[] = current.map(finding => ({ finding, change: before.has(finding.key) ? "remains" : "new", before: before.get(finding.key)?.count ?? 0 }));
  for (const f of previous) if (!now.has(f.key)) out.push({ finding: { ...f, count: 0, items: [], byPersona: {} }, change: "fixed", before: f.count });
  const rank: Record<Change, number> = { new: 0, remains: 1, fixed: 2 };
  return out.sort((a, b) => rank[a.change!] - rank[b.change!] || b.finding.count - a.finding.count);
}

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
