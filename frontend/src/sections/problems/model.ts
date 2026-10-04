import type { Criterion } from "../../lab/criteria";
import { count } from "../../lab/format";
import type { Side } from "../../lab/problems";
import { seriousFirst } from "../../lab/severity";

export type Filter = "all" | "log" | "sim";
export type SideKey = "log" | "sim";

export const toFilter = (raw: string | null): Filter => (raw === "log" || raw === "sim" ? raw : "all");
export const toSide = (raw: string | null): SideKey | null => (raw === "log" || raw === "sim" ? raw : null);

/** Dialogues where the criterion could be checked: broken or kept. The denominator of every count of a criterion. */
export const checked = (s: Pick<Side, "failed" | "passed">) => s.failed + s.passed;

/**
 * What «N из M» of a criterion says, in the words of the report: «в 19 из 53 разговоров, где критерий удалось
 * проверить». M read as all the conversations checked; those where this criterion could not be checked are not in it.
 */
export const errorIn = (s: Pick<Side, "failed" | "passed">) =>
  `в ${s.failed}\u00a0из\u00a0${count(checked(s), "разговора", "разговоров", "разговоров")}, где критерий удалось проверить`;

/** The side a row of the queue counts: the logs, unless the filter is the simulation or only the simulation found it. */
export const rowSide = (c: Criterion, filter: Filter): SideKey =>
  filter === "sim" || (filter === "all" && !c.r.log.failed) ? "sim" : "log";

/**
 * The queue: what the agent breaks in the logs — the serious criteria first, then the most frequent; then what only
 * the simulation found, in the same order. Frequency is never called severity: only a criterion's severity is, a
 * person's decision or the automatic check's proposal (lab/severity).
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
