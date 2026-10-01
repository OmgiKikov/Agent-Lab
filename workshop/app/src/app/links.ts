/** Where each section lives; screens link through these, so a section moves in one place. */
export const SECTIONS = {
  overview: "/overview",
  problems: "/problems",
  dialogs: "/dialogs",
  review: "/review",
  criteria: "/criteria",
  simulations: "/simulations",
  agent: "/agent",
  settings: "/settings",
};

/** A problem on its own page: the criterion the agent breaks; the source of its examples and the run when chosen. */
export function problemLink(ruleId: string, extra: Record<string, string | null | undefined> = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  const q = p.toString();
  return `${SECTIONS.problems}/${encodeURIComponent(ruleId)}${q ? `?${q}` : ""}`;
}

/** A criterion where it is written: the agent's code with the criterion marked. */
export function criterionLink(ruleId: string, extra: Record<string, string | null | undefined> = {}) {
  const p = new URLSearchParams({ c: ruleId });
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  return `${SECTIONS.criteria}?${p}`;
}

/** A run of the simulation, or the scenario cards (one of them when given), in «Симуляции». */
export const runLink = (runId: string) => `${SECTIONS.simulations}?r=${encodeURIComponent(runId)}`;
export const scenariosLink = (cardId?: string) => `${SECTIONS.simulations}?mode=scenarios${cardId ? `&s=${encodeURIComponent(cardId)}` : ""}`;
