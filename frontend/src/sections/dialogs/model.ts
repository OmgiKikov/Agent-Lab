import type { Criterion } from "../../lab/criteria";
import type { DialogRow } from "../../lab/dialogs";

export type Verdict = "all" | "fail" | "pass" | "none" | "disputed";

export const toVerdict = (raw: string | null): Verdict =>
  raw === "fail" || raw === "pass" || raw === "none" || raw === "disputed" ? raw : "all";

export const VERDICTS: { value: Verdict; label: string }[] = [
  { value: "all", label: "Все разговоры" },
  { value: "fail", label: "С ошибкой" },
  { value: "pass", label: "Без ошибок" },
  { value: "none", label: "Не проверены" },
  { value: "disputed", label: "Проверки разошлись" },
];

export function matchesRow(r: DialogRow, verdict: Verdict, query: string, only: Set<string> | null) {
  if (only && !only.has(r.key)) return false;
  if (verdict === "fail" && r.status !== "FAIL") return false;
  if (verdict === "pass" && r.status !== "PASS") return false;
  if (verdict === "none" && (r.status === "PASS" || r.status === "FAIL")) return false;
  if (verdict === "disputed" && !r.disputed) return false;
  const q = query.trim().toLowerCase();
  return !q || [r.title, r.topic, ...r.fails].some((s) => s.toLowerCase().includes(q));
}

const textKey = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

/** The criteria of the product by the checks' wording, so a conversation's verdicts carry the same numbers as everywhere. */
export function criteriaByText(list: Criterion[]) {
  const map = new Map(list.map((c) => [textKey(c.r.rule.text), c]));
  return (text: string) => map.get(textKey(text));
}
