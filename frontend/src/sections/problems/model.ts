import type { Criterion } from "../../lab/criteria";
import { count } from "../../lab/format";
import type { Side } from "../../lab/problems";
import { seriousFirst } from "../../lab/severity";

export type Filter = "all" | "log" | "sim";
export type SideKey = "log" | "sim";

export const toFilter = (raw: string | null): Filter => (raw === "log" || raw === "sim" ? raw : "all");
export const toSide = (raw: string | null): SideKey | null => (raw === "log" || raw === "sim" ? raw : null);

/**
 * The checked conversations of the check where the criterion applies and was decided, broken or kept: the
 * denominator of every count of a criterion, never more than the check's own.
 */
export const checked = (s: Pick<Side, "failed" | "passed">) => s.failed + s.passed;

/**
 * What «N из M» of a criterion says, in the words of the report: «в 19 из 53 разговоров, где критерий применим». The
 * checked conversations it did not apply to, or could not be decided in, are not in it (restText says how many).
 */
export const errorIn = (s: Pick<Side, "failed" | "passed">) =>
  `в ${s.failed}\u00a0из\u00a0${count(checked(s), "разговора", "разговоров", "разговоров")}, где критерий применим`;

/**
 * The checked conversations a criterion did not apply to: the service's count, or, from a service that does not give
 * it, what is left of the check's checked conversations (`assessed`) after the criterion's own.
 */
export const notApplicableOf = (s: Pick<Side, "failed" | "passed" | "unknown" | "notApplicable">, assessed: number) =>
  s.notApplicable ?? Math.max(0, assessed - s.failed - s.passed - s.unknown);

/**
 * The checked conversations a criterion's «N из M» leaves out, said once where the criterion is read: «Ещё в 3
 * разговорах критерий не удалось проверить, в 12 он не применим. В счёт они не входят.», each part only when there
 * are such conversations; null when there are none.
 */
export function restText(s: Pick<Side, "failed" | "passed" | "unknown" | "notApplicable">, assessed: number) {
  const apart = notApplicableOf(s, assessed);
  const where = (n: number) => `в\u00a0${count(n, "разговоре", "разговорах", "разговорах")}`;
  const unknown = s.unknown ? `${where(s.unknown)} критерий не удалось проверить` : "";
  const elsewhere = !apart ? "" : unknown ? `в\u00a0${apart} он не применим` : `${where(apart)} критерий не применим`;
  if (!unknown && !elsewhere) return null;
  const parts = [unknown, elsewhere].filter(Boolean).join(", ");
  return `Ещё ${parts}. ${s.unknown + apart === 1 ? "В счёт он не входит." : "В счёт они не входят."}`;
}

/** The side a row of the queue counts: the logs, unless the filter is the simulation or only the simulation found it. */
export const rowSide = (c: Criterion, filter: Filter): SideKey =>
  filter === "sim" || (filter === "all" && !c.r.log.failed) ? "sim" : "log";

/**
 * The queue: what the agent breaks in the logs — the criteria a person marked serious first, then the most frequent;
 * then what only the simulation found, in the same order. Frequency is never called severity, and the automatic
 * check's proposal orders nothing (lab/severity, seriousFirst): «Итог», the main problem of «Обзор» and the summary
 * follow a person's decision alone.
 */
export function queueOf(list: Criterion[], filter: Filter): Criterion[] {
  const log = list
    .filter((c) => c.r.log.failed > 0)
    .sort(
      (a, b) =>
        seriousFirst(a.r, b.r) || b.r.log.failed - a.r.log.failed || b.r.sim.failed - a.r.sim.failed || a.n - b.n,
    );
  const sim = list
    .filter((c) => c.r.sim.failed > 0)
    .sort((a, b) => seriousFirst(a.r, b.r) || b.r.sim.failed - a.r.sim.failed || a.n - b.n);
  if (filter === "log") return log;
  if (filter === "sim") return sim;
  return [...log, ...sim.filter((c) => !c.r.log.failed)];
}

export function matches(c: Criterion, query: string) {
  const q = query.trim().toLowerCase();
  return (
    !q || [c.r.title, c.name, c.r.rule.quote, c.r.rule.text, ...c.r.topics].some((s) => s?.toLowerCase().includes(q))
  );
}

/** The violations of one side in the order to show them: the service already puts the best-backed first. */
export const violationsOf = (c: Criterion, side: SideKey) => c.r[side].examples.filter((e) => e.status === "FAIL");
