import type { Job } from "../lab/types";
import { scenariosLink, SECTIONS } from "./links";

/** A task of the service: how it is called and the section where its result lives. */
export const JOBS: Record<string, { label: string; to: string }> = {
  "tone-policy": { label: "Правила tone of voice", to: "/check?step=materials" },
  "tone-criteria": { label: "Критерии tone of voice", to: "/check?step=criteria" },
  "tone-check": { label: "Проверка tone of voice", to: "/check?step=result" },
  "tone-advice": { label: "Предложение по находке", to: "/check?step=result" },
  "tone-clarification": { label: "Уточнение критерия", to: "/check?step=criteria" },
  sources: { label: "Чтение кода агента", to: SECTIONS.agent },
  discover: { label: "Оценка логов", to: SECTIONS.logs },
  cards: { label: "Сборка сценариев", to: scenariosLink() },
  run: { label: "Симуляция", to: SECTIONS.simulations },
  rejudge: { label: "Переоценка прогона", to: SECTIONS.simulations },
  names: { label: "Имена критериев", to: SECTIONS.criteria },
};

export const jobOf = (job: Job) => (job.kind ? JOBS[job.kind] : undefined);
