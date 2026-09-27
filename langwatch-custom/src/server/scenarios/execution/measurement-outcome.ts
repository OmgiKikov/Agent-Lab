export type EvidenceVerdict = "success" | "failure" | "inconclusive";
/** Positional keys are unique for every frozen criterion, including Cyrillic. */
export const criterionKey = (_criterion: string, index: number) =>
  "criterion_" + index;
export function evaluateRequiredCriteria(
  criteria: string[],
  values: Record<string, unknown>,
  keyFor = (c: string, i: number) => criterionKey(c, i),
) {
  const states = criteria.map((c, i) => values[keyFor(c, i)]);
  const metCriteria = criteria.filter((_, i) => states[i] === "true");
  const unmetCriteria = criteria.filter((_, i) => states[i] === "false");
  const inconclusiveCriteria = criteria.filter(
    (_, i) => states[i] !== "true" && states[i] !== "false",
  );
  const verdict: EvidenceVerdict = unmetCriteria.length
    ? "failure"
    : inconclusiveCriteria.length || !criteria.length
      ? "inconclusive"
      : "success";
  return {
    success: verdict === "success",
    verdict,
    metCriteria,
    unmetCriteria,
    inconclusiveCriteria,
  };
}
/** Business evidence and execution failure are independent. Shared with exports. */
export function measurementOutcome(
  status: string,
  results?: {
    verdict?: string;
    error?: string;
    metCriteria?: string[];
    unmetCriteria?: string[];
    inconclusiveCriteria?: string[];
  } | null,
) {
  const passed = results?.metCriteria?.length ?? 0;
  const violations = results?.unmetCriteria?.length ?? 0;
  const unknown = results?.inconclusiveCriteria?.length ?? 0;
  const interrupted =
    ["CANCELLED", "STALLED"].includes(status) ||
    (status === "ERROR" && results?.verdict !== "inconclusive") || !!results?.error;
  const unfinished = ["QUEUED", "PENDING", "RUNNING", "IN_PROGRESS"].includes(
    status,
  );
  const incomplete =
    interrupted ||
    unfinished ||
    unknown > 0 ||
    results?.verdict === "inconclusive" ||
    status === "INCONCLUSIVE";
  return {
    passed,
    violations: interrupted ? 0 : violations,
    unknown,
    execution: interrupted ? "error" : unfinished ? "pending" : "completed",
    business:
      interrupted || unfinished
        ? "unknown"
        : violations
          ? "failure"
          : incomplete
            ? "unknown"
            : results?.verdict === "success"
              ? "success"
              : "unknown",
    acceptance:
      interrupted || unfinished
        ? "not_verified"
        : violations
          ? "rejected"
          : incomplete
            ? "not_verified"
            : results?.verdict === "success"
              ? "accepted"
              : "not_verified",
  };
}
