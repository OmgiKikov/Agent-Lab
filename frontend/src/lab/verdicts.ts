import type { Example, Problems, RuleEntry } from "./problems";

/** One verdict: a criterion in one conversation. */
export const exampleKey = (e: Example) =>
  `${e.source}|${e.source === "log" ? e.dialogueId : `${e.runId}#${e.index}`}|${e.ruleId}`;

export type Queue = "disputed" | "unchecked" | "all";

export const QUEUE_TITLE: Record<Queue, string> = {
  disputed: "Спорные случаи",
  unchecked: "Без вашего ответа",
  all: "Все случаи",
};

/** Every verdict with evidence (a violation or a fulfilment), with its criterion; of one criterion and one source when given. */
export function verdictsOf(
  data: Problems,
  ruleId?: string | null,
  source?: "log" | "sim",
): { rule: RuleEntry; example: Example }[] {
  const rules = ruleId ? data.rules.filter((r) => r.id === ruleId) : data.rules;
  return rules.flatMap((rule) =>
    (source ? rule[source].examples : [...rule.log.examples, ...rule.sim.examples])
      .filter((e) => e.status === "FAIL" || e.status === "PASS")
      .map((example) => ({ rule, example })),
  );
}

/**
 * What a person checks, in order: disputed ones (the second judge gave another verdict) first; then violations
 * nobody checked; then everything, violations before fulfilments.
 */
export function queueOf(data: Problems, queue: Queue, ruleId?: string | null, source?: "log" | "sim") {
  const all = verdictsOf(data, ruleId, source);
  if (queue === "disputed") return all.filter((v) => v.example.second === "disagree");
  if (queue === "unchecked") return all.filter((v) => v.example.status === "FAIL" && !v.example.review);
  return [...all.filter((v) => v.example.status === "FAIL"), ...all.filter((v) => v.example.status === "PASS")];
}

/** People's decisions on verdicts: each verdict once; an older decision on a whole simulated conversation once. */
export function decisions(data: Problems): { agree: number; disagree: number } {
  const seen = new Set<string>();
  let agree = 0;
  let disagree = 0;
  for (const { example } of verdictsOf(data)) {
    if (!example.review) continue;
    const key = example.reviewScope === "dialogue" ? `${example.runId}#${example.index}` : exampleKey(example);
    if (seen.has(key)) continue;
    seen.add(key);
    if (example.review === "agree") agree++;
    else disagree++;
  }
  return { agree, disagree };
}
