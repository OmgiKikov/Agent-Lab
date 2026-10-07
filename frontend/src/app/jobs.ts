import { PROPOSING, proposalCheck } from "../lab/severity";
import type { Job } from "../lab/types";
import { criterionLink, launchLink, scenariosLink, SECTIONS, toneCheckLink } from "./links";

/** A task of the service: how it is called and the section where its result lives. */
export const JOBS: Record<string, { label: string; to: string }> = {
  "tone-policy": { label: "Правила общения", to: toneCheckLink("materials") },
  launch: { label: "Проверка агента", to: "/launches" },
  "judge-rules": { label: "Правила судьи", to: "/overview" },
  datasets: { label: "Датасеты", to: "/data" },
  "agent-context": { label: "Контекст агента", to: "/agent" },
  logs: { label: "Загрузка диалогов", to: SECTIONS.data },
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
  if (job.kind === "launch" && job.progress.launch)
    return {
      ...JOBS.launch,
      to: job.input?.check ? launchLink(job.input.check, job.progress.launch) : `/launches/${job.progress.launch}`,
    };
  const check = job.kind === "severity" ? proposalCheck(job) : null;
  return check ? { ...JOBS.severity, to: criterionLink(check) } : JOBS[job.kind];
}
