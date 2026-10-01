/** Where each section lives; screens link through these, so a section moves in one place. */
export const SECTIONS = {
  violations: "/violations",
  dialogs: "/logs?tab=dialogs",
  criteria: "/criteria",
  simulations: "/simulations",
  agent: "/agent",
  settings: "/settings",
};

/** A violation in its section: the criterion, the side of its examples and the run of the simulation when chosen. */
export function violationLink(ruleId: string, extra: Record<string, string | null | undefined> = {}) {
  const p = new URLSearchParams({ v: ruleId });
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  return `${SECTIONS.violations}?${p}`;
}

/** A criterion where it is written: the agent's code with the criterion marked. */
export function criterionLink(ruleId: string, extra: Record<string, string | null | undefined> = {}) {
  const p = new URLSearchParams({ c: ruleId });
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  return `${SECTIONS.criteria}?${p}`;
}
