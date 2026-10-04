import type { Check } from "../lab/types";
import type { CheckStep } from "../lab/tone";

export type { Check };

/**
 * Where everything lives; screens link through these, so a page moves in one place. Each check of the real
 * conversations (tone of voice, accuracy) is a section of its own, the simulations are another; all three have the
 * same pages: the result, its problems, its conversations, the check by a person.
 */
export type Stage = Check | "sim";

export const SECTIONS = {
  overview: "/overview",
  /** «Сводка для руководителя»: a page of the agent, from «Обзор» and ⌘K, not a section of the navigation. */
  summary: "/summary",
  tone: "/tone",
  accuracy: "/accuracy",
  simulations: "/simulations",
  agent: "/agent",
  settings: "/settings",
};

const ROOT: Record<Stage, string> = { tone: SECTIONS.tone, code: SECTIONS.accuracy, sim: SECTIONS.simulations };
const enc = encodeURIComponent;
const query = (extra: Record<string, string | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  const q = p.toString();
  return q ? `?${q}` : "";
};

/**
 * Which side of the service's record of problems a stage reads: a check reads the conversations of the export
 * (`log`), the simulations read a run (`sim`).
 */
export const side = (stage: Stage): "log" | "sim" => (stage === "sim" ? "sim" : "log");

/** The section of a check or of the simulations: «/tone», «/accuracy», «/simulations». */
export const stageRoot = (stage: Stage) => ROOT[stage];

/** The result of a stage: of a check, or of a run of the simulation (the last one when none is named). */
export const stageLink = (stage: Stage, runId?: string | null) =>
  `${ROOT[stage]}${stage === "sim" ? query({ run: runId }) : ""}`;

/** A problem on its own page, in its stage; in the simulation, of a run. */
export const problemLink = (ruleId: string, stage: Stage, runId?: string | null) =>
  `${ROOT[stage]}/problems/${enc(ruleId)}${stage === "sim" ? query({ run: runId }) : ""}`;

/** The conversations of a stage, filtered or with one open (`d`). */
export const conversationsLink = (stage: Stage, extra: Record<string, string | null | undefined> = {}) =>
  `${ROOT[stage]}/conversations${query(extra)}`;

/** A person's check of what a stage found: a queue (`queue`), of one criterion (`rule`), of a run (`run`). */
export const reviewLink = (stage: Stage, extra: Record<string, string | null | undefined> = {}) =>
  `${ROOT[stage]}/review${query(extra)}`;

/** The runs of the simulation, and the scenario cards (one of them when given). */
export const runLink = (runId: string) => `${SECTIONS.simulations}${query({ run: runId })}`;
export const scenariosLink = (cardId?: string) => `${SECTIONS.simulations}/scenarios${query({ s: cardId })}`;

/** The criteria of a check, one of them chosen when given; `view=code` shows it where it is written. */
export const criterionLink = (
  check: Check,
  ruleId?: string | null,
  extra: Record<string, string | null | undefined> = {},
) => `${ROOT[check]}/criteria${query({ c: ruleId, ...extra })}`;

/** The tone-of-voice check step by step; without a step it opens where the work stands. */
export const toneCheckLink = (step?: CheckStep) => `${SECTIONS.tone}/check${query({ step })}`;

/** The saved checks of a check, one of them open when given. */
export const historyLink = (check: Check, id?: string | null) => `${ROOT[check]}/history${query({ id })}`;
