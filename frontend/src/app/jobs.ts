import { PROPOSING, proposalCheck } from "../lab/severity";
import type { Job } from "../lab/types";
import { criterionLink, scenariosLink, SECTIONS, toneCheckLink } from "./links";

/**
 * A task of the service: how it is called and the section where its result lives. `quiet`: the window that started it
 * says how it went, so its end is not told again.
 */
export const JOBS: Record<string, { label: string; to: string; quiet?: boolean }> = {
  "tone-policy": { label: "Правила общения", to: toneCheckLink("materials") },
  logs: { label: "Загрузка выгрузки", to: SECTIONS.exports, quiet: true },
  exports: { label: "Удаление выгрузки", to: SECTIONS.exports, quiet: true },
  "tone-criteria": { label: "Критерии tone of voice", to: toneCheckLink("criteria") },
  "tone-check": { label: "Проверка tone of voice", to: toneCheckLink("result") },
  "tone-advice": { label: "Предложение по находке", to: toneCheckLink("result") },
  "tone-clarification": { label: "Уточнение критерия", to: toneCheckLink("criteria") },
  sources: { label: "Чтение кода агента", to: SECTIONS.agent },
  discover: { label: "Проверка точности", to: SECTIONS.accuracy },
  cards: { label: "Сборка сценариев", to: scenariosLink() },
  run: { label: "Прогон симуляции", to: SECTIONS.simulations },
  rejudge: { label: "Повторная оценка прогона", to: SECTIONS.simulations },
  // «Отметить автоматически» (lab/severity): to the criteria of the check it proposes for (jobOf), else «Обзор».
  severity: { label: PROPOSING, to: SECTIONS.overview },
};

/**
 * A task as a person reads it, and where its result lives. A proposal of which errors are serious leads to the criteria
 * of the check this tab started it for, where its proposals are checked.
 */
export function jobOf(job: Job) {
  if (!job.kind) return undefined;
  const check = job.kind === "severity" ? proposalCheck(job) : null;
  return check ? { ...JOBS.severity, to: criterionLink(check) } : JOBS[job.kind];
}
