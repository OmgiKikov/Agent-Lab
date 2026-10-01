/**
 * Where everything lives; screens link through these, so a page moves in one place. The product has two stages of
 * checking, each with the same pages: its result, its problems, its conversations, its check by a person.
 */
export type Stage = "log" | "sim";

export const SECTIONS = {
  overview: "/overview",
  logs: "/logs",
  simulations: "/simulations",
  criteria: "/criteria",
  agent: "/agent",
  settings: "/settings",
};

const ROOT: Record<Stage, string> = { log: SECTIONS.logs, sim: SECTIONS.simulations };
const enc = encodeURIComponent;
const query = (extra: Record<string, string | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  const q = p.toString();
  return q ? `?${q}` : "";
};

/** The result of a stage: the logs, or a run of the simulation (the last one when none is named). */
export const stageLink = (stage: Stage, runId?: string | null) =>
  `${ROOT[stage]}${stage === "sim" ? query({ run: runId }) : ""}`;

/** A problem on its own page, in its stage; in the simulation, of a run. */
export const problemLink = (ruleId: string, stage: Stage = "log", runId?: string | null) =>
  `${ROOT[stage]}/problems/${enc(ruleId)}${stage === "sim" ? query({ run: runId }) : ""}`;

/** The conversations of a stage, filtered or with one open (`d`). */
export const conversationsLink = (stage: Stage, extra: Record<string, string | null | undefined> = {}) =>
  `${ROOT[stage]}/conversations${query(extra)}`;

/** A person's check of the verdicts of a stage: a queue (`queue`), of one criterion (`rule`), of a run (`run`). */
export const reviewLink = (stage: Stage, extra: Record<string, string | null | undefined> = {}) =>
  `${ROOT[stage]}/review${query(extra)}`;

/** The runs of the simulation, and the scenario cards (one of them when given). */
export const runLink = (runId: string) => `${SECTIONS.simulations}${query({ run: runId })}`;
export const scenariosLink = (cardId?: string) => `${SECTIONS.simulations}/scenarios${query({ s: cardId })}`;

/** A criterion where it is written: the agent's code with the criterion marked. */
export function criterionLink(ruleId: string, extra: Record<string, string | null | undefined> = {}) {
  return `${SECTIONS.criteria}${query({ c: ruleId, ...extra })}`;
}
