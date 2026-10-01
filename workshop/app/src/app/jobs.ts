import type { Job } from "../lab/types";
import { scenariosLink, SECTIONS } from "./links";

/** A task of the service: how it is called and the section where its result lives. */
export const JOBS: Record<string, { label: string; to: string }> = {
  sources: { label: "Чтение кода агента", to: SECTIONS.agent },
  discover: { label: "Оценка логов", to: SECTIONS.logs },
  cards: { label: "Сборка сценариев", to: scenariosLink() },
  run: { label: "Симуляция", to: SECTIONS.simulations },
  rejudge: { label: "Переоценка прогона", to: SECTIONS.simulations },
  names: { label: "Имена критериев", to: SECTIONS.criteria },
};

export const jobOf = (job: Job) => (job.kind ? JOBS[job.kind] : undefined);
