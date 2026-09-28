import { Bot, FileText, FlaskConical, Gauge, MessagesSquare, type LucideIcon } from "lucide-react";
import { count, pct } from "./format";
import type { LabState, Step } from "./types";

export const STEPS: Step[] = ["agent", "logs", "cards", "run", "accuracy"];

export type StepInfo = { id: Step; title: string; icon: LucideIcon; value: string; done: boolean; busy: boolean; cta: string };

/** The five steps with what each has produced so far, and whether a job for it is running. */
export function buildSteps(state: LabState | null): StepInfo[] {
  const d = state?.discover;
  const deck = state?.cards?.cards ?? [];
  const lastScored = state?.runs.find(r => r.metric && r.metric.accuracy !== null && r.status !== "running");
  const job = state?.job.running ? state.job.kind : null;
  const sources = state?.sources.length ?? 0;
  const runs = state?.runs.length ?? 0;
  return [
    {
      id: "agent", title: "агент", icon: Bot, done: sources > 0, busy: job === "sources", cta: "Соберите контекст агента",
      value: state ? (sources ? `${count(sources, "источник", "источника", "источников")} · ${state.models.via}` : "контекст не собран") : "",
    },
    {
      id: "logs", title: "логи", icon: FileText, done: !!d, busy: job === "discover",
      cta: state?.logs.total ? "Оцените логи" : "Загрузите выгрузку логов",
      value: d ? `${d.summary.checked} разговоров · ${pct(d.summary.failed, d.summary.checked)}% с нарушениями` : state?.logs.total ? `${state.logs.total} в выгрузке · не оценены` : "выгрузка не загружена",
    },
    {
      id: "cards", title: "сценарии", icon: FlaskConical, done: deck.length > 0, busy: job === "cards", cta: "Соберите сценарии",
      value: deck.length ? count(deck.length, "сценарий", "сценария", "сценариев") : "ещё не собраны",
    },
    {
      id: "run", title: "прогон", icon: MessagesSquare, done: runs > 0, busy: job === "run" || job === "rejudge", cta: "Запустите прогон",
      value: runs ? count(runs, "прогон", "прогона", "прогонов") : "ещё не было",
    },
    {
      id: "accuracy", title: "точность", icon: Gauge, done: !!lastScored, busy: false, cta: "Посмотрите точность",
      value: lastScored ? `${lastScored.metric!.accuracy}% · ${lastScored.targetName}` : "нет оценённых прогонов",
    },
  ];
}
