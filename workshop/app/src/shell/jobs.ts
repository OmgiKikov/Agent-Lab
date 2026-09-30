import type { Job } from "../lab/types";
import { LINKS } from "./links";

/** A task of the service: how it is called and the section where its result lives. */
export const JOBS: Record<string, { label: string; to: string }> = {
  sources: { label: "Чтение кода агента", to: LINKS.agent },
  discover: { label: "Оценка логов", to: LINKS.problems },
  cards: { label: "Сборка сценариев", to: LINKS.scenarios },
  run: { label: "Симуляция", to: LINKS.simulations },
  rejudge: { label: "Переоценка прогона", to: LINKS.simulations },
};

export const jobOf = (job: Job) => (job.kind ? JOBS[job.kind] : undefined);
