import type { Check, LabState } from "./types";

export const CHECKS: Check[] = ["tone", "code"];

/** The names a person reads: in the navigation, the headings, the labels of runs and scenarios. */
export const CHECK_NAME: Record<Check, string> = { tone: "Tone of voice", code: "Точность" };

/** «по критериям Tone of voice»: what a run or a scenario is counted by. */
export const BY_CRITERIA: Record<Check, string> = {
  tone: "по критериям Tone\u00a0of\u00a0voice",
  code: "по критериям точности",
};

/** The task of the service that writes a check's result. */
export const JOB_OF: Record<Check, string> = { tone: "tone-check", code: "discover" };

/** The result of a check, or null while it has none. */
export const resultOf = (state: LabState | null, check: Check) => state?.checks[check] ?? null;

/**
 * Where an address from before the checks had their own sections leads (spec §3): into the check that has a result,
 * tone of voice when both or neither do.
 */
export const checkOfOld = (state: LabState | null): Check =>
  resultOf(state, "code") && !resultOf(state, "tone") ? "code" : "tone";
