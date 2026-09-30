import type { Example, Side } from "./problems";

/** The second judge on the violations of one side: how many he checked, and how many of those he agreed with. */
export function secondOf(examples: Example[]): { checked: number; agree: number; whole: number } {
  const judged = examples.filter(e => e.status === "FAIL" && e.second);
  return { checked: judged.length, agree: judged.filter(e => e.second === "agree").length, whole: judged.filter(e => e.secondScope === "dialogue").length };
}

/** People on the violations of one side: how many are checked, of them how many said «верно», of all the violations shown. */
export function humansOf(side: Side): { of: number; checked: number; agree: number } {
  const fails = side.examples.filter(e => e.status === "FAIL");
  const checked = fails.filter(e => e.review);
  return { of: fails.length, checked: checked.length, agree: checked.filter(e => e.review === "agree").length };
}
