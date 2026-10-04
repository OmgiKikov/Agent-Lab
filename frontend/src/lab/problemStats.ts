import { count } from "./format";
import type { Example, Side } from "./problems";

/** The second judge on the violations of one side: how many he checked, and how many of those he agreed with. */
export function secondOf(examples: Example[]): { checked: number; agree: number; whole: number } {
  const judged = examples.filter((e) => e.status === "FAIL" && e.second);
  return {
    checked: judged.length,
    agree: judged.filter((e) => e.second === "agree").length,
    whole: judged.filter((e) => e.secondScope === "dialogue").length,
  };
}

/** People on the violations of one side: how many are checked, of them how many said «верно», of all the violations shown. */
export function humansOf(side: Side): { of: number; checked: number; agree: number } {
  const fails = side.examples.filter((e) => e.status === "FAIL");
  const checked = fails.filter((e) => e.review);
  return { of: fails.length, checked: checked.length, agree: checked.filter((e) => e.review === "agree").length };
}

/** From this many of a person's answers on one criterion its page says how often the check was right by it. */
export const RIGHT_FROM = 5;

/**
 * How often the check was right by one criterion of one side, by a person's answers: «Да» agrees with it, on an error
 * it found and on a case «без ошибки» alike. Only answers on the criterion itself: an older answer on a whole simulated
 * conversation says nothing about it.
 */
export function rightOf(side: Side): {
  answered: number;
  right: number;
  errors: { answered: number; right: number };
  clean: { answered: number; right: number };
} {
  const answered = side.examples.filter((e) => e.review && e.reviewScope === "rule");
  const tally = (status: "FAIL" | "PASS") => {
    const own = answered.filter((e) => e.status === status);
    return { answered: own.length, right: own.filter((e) => e.review === "agree").length };
  };
  const errors = tally("FAIL");
  const clean = tally("PASS");
  return { answered: errors.answered + clean.answered, right: errors.right + clean.right, errors, clean };
}

/**
 * «Модель права в 9 из 10 оценок, которые вы проверили по этому критерию.» Only from RIGHT_FROM answers, and only out
 * of them; with answers on cases «без ошибки» among them, how it was right on each kind. Null with fewer answers: then
 * the page says only how the person answered.
 */
export function rightText(r: ReturnType<typeof rightOf>): string | null {
  if (r.answered < RIGHT_FROM) return null;
  const head = `Модель права в\u00a0${r.right}\u00a0из\u00a0${count(r.answered, "оценки", "оценок", "оценок")}, которые вы проверили по этому критерию`;
  if (!r.clean.answered) return `${head}.`;
  const kinds = [
    r.errors.answered
      ? `в\u00a0${r.errors.right}\u00a0из\u00a0${count(r.errors.answered, "найденной ошибки", "найденных ошибок", "найденных ошибок")}`
      : null,
    `в\u00a0${r.clean.right}\u00a0из\u00a0${count(r.clean.answered, "случая", "случаев", "случаев")} «без ошибки»`,
  ];
  return `${head}: ${kinds.filter(Boolean).join(" и ")}.`;
}
