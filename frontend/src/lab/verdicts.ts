import { logKey, simKey } from "./dialogs";
import type { Decision, Example, Problems, RuleEntry } from "./problems";

/** One verdict: a criterion in one conversation. */
export const exampleKey = (e: Example) =>
  `${e.source}|${e.source === "log" ? e.dialogueId : `${e.runId}#${e.index}`}|${e.ruleId}`;

/**
 * A verdict's fixed place in a shuffle of all verdicts (FNV-1a of its key, then mixed): the cases «без ошибки» the
 * queue asks about are the same every time and do not follow the order of the conversations or criteria.
 */
export function rank(e: Example): number {
  const key = exampleKey(e);
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** What a person's answer says about the conversation: «Да» on an error and «Нет» on «без ошибки» both say error. */
export const saysError = (status: Example["status"], decision: Decision) =>
  (status === "FAIL") === (decision === "agree");

/** The conversation of an example as «Разговоры» address it (`?d=`); never a bare number. */
export const conversationKey = (e: Example) =>
  e.source === "log" ? logKey(e.dialogueId ?? "") : simKey(e.runId ?? "", e.index ?? 0);

/**
 * Which example an address names (`?e=`): its conversation, so the same one stays on screen when an answer re-sorts
 * them; in an older address, a number is its place. When the address names none of them (a new check, another
 * export), the first one — or the last for a number past the end — and `missing` says the one asked for is not here.
 */
export function exampleAt(examples: Example[], wanted: string | null): { at: number; missing: boolean } {
  if (wanted && /^\d+$/.test(wanted))
    return {
      at: Math.max(0, Math.min(examples.length - 1, Number(wanted))),
      missing: Number(wanted) >= examples.length,
    };
  const found = wanted ? examples.findIndex((e) => conversationKey(e) === wanted) : 0;
  return { at: Math.max(0, found), missing: found < 0 };
}

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

/** Every fifth case without an answer is «без ошибки»: a person checks what the model missed, not only its finds. */
const KEPT_EVERY = 5;
/**
 * From this many answers on cases «без ошибки» the line under a check's number says out of how many the misses were
 * found (lab/answers): the queue offers as many.
 */
export const MISSES_FROM = 20;

/**
 * Errors nobody answered, in their order, and at every fifth place a verdict «без ошибки» nobody answered, while there
 * are such verdicts: the same ones every time (`rank`), so the share of misses a person finds is not biased by order.
 * When the errors run out first, the cases «без ошибки» go on until a person can have answered MISSES_FROM of them:
 * with 30 errors the fifth places alone would ask about 7, and the misses would never be told.
 */
function unanswered(all: ReturnType<typeof verdictsOf>) {
  const kept = all
    .filter((v) => v.example.status === "PASS" && !v.example.review)
    .sort((a, b) => rank(a.example) - rank(b.example));
  const queue: typeof all = [];
  for (const v of all) {
    if (v.example.status !== "FAIL" || v.example.review) continue;
    queue.push(v);
    if (queue.length % KEPT_EVERY === KEPT_EVERY - 1 && kept.length) queue.push(kept.shift()!);
  }
  const answered = all.filter((v) => v.example.status === "PASS" && v.example.review).length;
  const asked = queue.filter((v) => v.example.status === "PASS").length;
  queue.push(...kept.slice(0, Math.max(0, MISSES_FROM - answered - asked)));
  return queue;
}

/**
 * What a person checks, in order: disputed ones (the second judge gave another verdict) first; then the errors nobody
 * answered, every fifth case a verdict «без ошибки»; then everything, violations before fulfilments.
 */
export function queueOf(data: Problems, queue: Queue, ruleId?: string | null, source?: "log" | "sim") {
  const all = verdictsOf(data, ruleId, source);
  if (queue === "disputed") return all.filter((v) => v.example.second === "disagree");
  if (queue === "unchecked") return unanswered(all);
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
