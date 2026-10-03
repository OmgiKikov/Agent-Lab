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

/**
 * The criteria of the product by the ids the checks gave them in a stage, so a conversation's verdicts carry the same
 * numbers as everywhere. Not by wording: a verdict keeps the text the check saw, with a person's clarifications.
 */
export function criteriaByRule(list: Criterion[]) {
  const map = new Map(
    list.flatMap((c) =>
      (["log", "sim"] as const).flatMap((s) => c.r[s].ruleIds.map((id) => [`${s}|${id}`, c] as const)),
    ),
  );
  return (source: "log" | "sim", ruleId: string) => map.get(`${source}|${ruleId}`);
}
