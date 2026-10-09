import { launchError, useLaunch } from "../lab/launches";
import { PROPOSING, proposalCheck } from "../lab/severity";
import type { Job } from "../lab/types";
import { criterionLink, launchLink, scenariosLink, SECTIONS } from "./links";

/** The error of a task a person stopped (backend/lab/jobs.py): a stop, not a failure. */
export const STOPPED = "Остановлено";

/**
 * A task of the service: how it is called, the section where its result lives, and what is there to open, as its
 * notice's link says it: «Открыть проверку», «Открыть критерии».
 */
export const JOBS: Record<string, { label: string; to: string; open: string }> = {
  "tone-policy": { label: "Правила общения", to: criterionLink("tone"), open: "критерии" },
  launch: { label: "Проверка агента", to: `${SECTIONS.tone}/history`, open: "проверку" },
  "judge-rules": { label: "Правила", to: SECTIONS.overview, open: "обзор" },
  datasets: { label: "Датасеты", to: "/data", open: "датасеты" },
  "agent-context": { label: "Контекст агента", to: "/agent", open: "агента" },
  logs: { label: "Загрузка датасета", to: SECTIONS.data, open: "датасеты" },
  "tone-criteria": { label: "Критерии tone of voice", to: criterionLink("tone"), open: "критерии" },
  "tone-check": { label: "Проверка tone of voice", to: SECTIONS.tone, open: "итог" },
  "tone-advice": { label: "Предложение по находке", to: SECTIONS.tone, open: "итог" },
  "tone-clarification": { label: "Уточнение критерия", to: criterionLink("tone"), open: "критерии" },
  sources: { label: "Чтение кода агента", to: SECTIONS.agent, open: "агента" },
  discover: { label: "Проверка точности", to: SECTIONS.accuracy, open: "итог" },
  cards: { label: "Сборка сценариев", to: scenariosLink(), open: "сценарии" },
  run: { label: "Прогон симуляции", to: SECTIONS.simulations, open: "симуляции" },
  rejudge: { label: "Повторная оценка прогона", to: SECTIONS.simulations, open: "симуляции" },
  // «Отметить автоматически» (lab/severity): to the criteria of the check it proposes for (jobOf), else «Обзор».
  severity: { label: PROPOSING, to: SECTIONS.overview, open: "обзор" },
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
  return check ? { ...JOBS.severity, to: criterionLink(check), open: "критерии" } : JOBS[job.kind];
}

/**
 * Why a task failed, as its notice and its card say it; null for a task that did not fail. A launch fails with one
 * sentence for all its ways, so its own reason is read from the launch (lab/launches, launchError): null until the
 * launch has come, so that a notice waits for it rather than tell the sentence that says nothing.
 */
export function useFailure(job: Job | null | undefined): string | null {
  const error = job?.error && job.error !== STOPPED ? job.error : null;
  const id = error && job?.kind === "launch" ? job.progress.launch : undefined;
  const launch = useLaunch(id);
  if (!error || !id) return error;
  // A launch still running in the cache is asked again until it has ended as its task did.
  if (launch.data?.id === id && launch.data.status !== "running") return launchError(launch.data) ?? error;
  return launch.isError ? error : null;
}
