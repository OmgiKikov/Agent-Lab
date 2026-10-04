import { nameFromText, quoteKey, type Criterion } from "../../lab/criteria";
import type { DialogRow } from "../../lab/dialogs";

export type Verdict = "all" | "fail" | "serious" | "pass" | "none" | "disputed";

export const toVerdict = (raw: string | null): Verdict =>
  raw === "fail" || raw === "serious" || raw === "pass" || raw === "none" || raw === "disputed" ? raw : "all";

/** «С серьёзной ошибкой» is offered once a criterion is serious (lab/severity); the rest always. */
export const VERDICTS: { value: Verdict; label: string }[] = [
  { value: "all", label: "Все разговоры" },
  { value: "fail", label: "С ошибкой" },
  { value: "serious", label: "С серьёзной ошибкой" },
  { value: "pass", label: "Без ошибок" },
  { value: "none", label: "Не удалось проверить" },
  { value: "disputed", label: "Модели разошлись" },
];

export function matchesRow(
  r: DialogRow,
  verdict: Verdict,
  query: string,
  only: Set<string> | null,
  serious?: Set<string>,
) {
  if (only && !only.has(r.key)) return false;
  if (verdict === "fail" && r.status !== "FAIL") return false;
  if (verdict === "serious" && !serious?.has(r.key)) return false;
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

/**
 * The checked conversations with an error by a serious criterion, as the service counts them beside the check's number
 * (problems.serious_counts): the conversations «С серьёзными ошибками — 6 из 53» opens.
 */
export function seriousRows(rows: DialogRow[], list: Criterion[]): Set<string> {
  const find = criteriaByRule(list);
  return new Set(
    rows
      .filter(
        (r) =>
          (r.status === "PASS" || r.status === "FAIL") &&
          r.rules.some((x) => x.status === "FAIL" && find(r.source, x.ruleId)?.r.serious),
      )
      .map((r) => r.key),
  );
}

/** A criterion's name and number where the record of problems does not have it. */
export type Named = Map<string, { n: number; name: string }>;

/**
 * The criteria of a run that never applied in it: the service counts a criterion only where it has a verdict, so one
 * that applied nowhere is not in the record, and its row in a conversation had neither name nor number. The name comes
 * from the criteria frozen in the run's conversations; the number from the same criterion by its quote, else the next
 * free one.
 */
export function frozenNames(list: Criterion[], rows: DialogRow[]): Named {
  const find = criteriaByRule(list);
  const byQuote = new Map(list.map((c) => [quoteKey(c.r.rule.quote), c]));
  let next = Math.max(0, ...list.map((c) => c.n)) + 1;
  const named: Named = new Map();
  for (const row of rows)
    for (const x of row.frozen ?? []) {
      if (named.has(x.id) || find("sim", x.id)) continue;
      const known = x.quote ? byQuote.get(quoteKey(x.quote)) : undefined;
      named.set(
        x.id,
        known ? { n: known.n, name: known.name } : { n: next++, name: x.name?.trim() || nameFromText(x.text) },
      );
    }
  return named;
}
