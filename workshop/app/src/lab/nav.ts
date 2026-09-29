import { Bot, FileText, FlaskConical, ListChecks, MessagesSquare, ShieldCheck, type LucideIcon } from "lucide-react";
import type { LabState, Step } from "./types";

export const STEPS: Step[] = ["criteria", "dialogs", "judge", "agent", "logs", "checks"];

/** Addresses of the earlier layouts keep working. */
export const LEGACY: Record<string, string> = {
  health: "/lab/criteria", findings: "/lab/criteria", versions: "/lab/criteria", accuracy: "/lab/criteria",
  trust: "/lab/judge", runs: "/lab/dialogs", run: "/lab/dialogs", cards: "/lab/checks", connect: "/lab/agent",
};

/** The three things the Lab is about, then where the dialogues come from. */
export type NavGroup = "main" | "sources";
export type NavItem = { id: Step; title: string; icon: LucideIcon; group: NavGroup; badge?: string; hot?: boolean; busy: boolean };
export const NAV_GROUP_TITLE: Record<NavGroup, string | null> = { main: null, sources: "Откуда диалоги" };

/** What the badges of the navigation say; derived by the page. */
export type NavExtra = { broken?: number; dialogs?: number; trustPending?: boolean };

export const NAV_ICON: Record<Step, LucideIcon> = { criteria: ListChecks, dialogs: MessagesSquare, judge: ShieldCheck, agent: Bot, logs: FileText, checks: FlaskConical };

export function buildNav(state: LabState | null, extra: NavExtra): NavItem[] {
  const job = state?.job.running ? state.job.kind : null;
  const cards = state?.cards?.cards.length ?? 0;
  const sources = state?.sources.length ?? 0;
  const logs = state?.logs.total ?? 0;
  return [
    { id: "criteria", title: "Критерии", icon: NAV_ICON.criteria, group: "main", busy: false, badge: extra.broken ? String(extra.broken) : undefined, hot: !!extra.broken },
    { id: "dialogs", title: "Диалоги", icon: NAV_ICON.dialogs, group: "main", busy: job === "run", badge: extra.dialogs ? String(extra.dialogs) : undefined },
    { id: "judge", title: "Судья", icon: NAV_ICON.judge, group: "main", busy: job === "rejudge", badge: extra.trustPending ? "!" : undefined },
    { id: "agent", title: "Агент", icon: NAV_ICON.agent, group: "sources", busy: job === "sources", badge: sources ? String(sources) : undefined },
    { id: "logs", title: "Логи", icon: NAV_ICON.logs, group: "sources", busy: job === "discover", badge: logs ? String(logs) : undefined },
    { id: "checks", title: "Сценарии симулятора", icon: NAV_ICON.checks, group: "sources", busy: job === "cards", badge: cards ? String(cards) : undefined },
  ];
}

export type SetupStep = { label: string; hint: string; done: boolean; to: string; cta: string };

/** The first-run path: what is left to do before the first criterion has evidence. */
export function setupSteps(state: LabState): SetupStep[] {
  return [
    { label: "Подключите агента", hint: "Адрес агента и репозиторий: из них берутся его промпты, инструменты и критерии.", done: state.sources.length > 0, to: "/lab/agent", cta: "Подключить" },
    { label: "Загрузите и оцените логи", hint: "Судья проверит настоящие разговоры по критериям и покажет, что агент уже нарушал.", done: !!state.discover, to: "/lab/logs", cta: "К логам" },
    { label: "Прогоните симулятор клиента", hint: "Тот же набор критериев проверяется на разговорах, которых в логах ещё нет.", done: state.runs.length > 0, to: "/lab/checks", cta: "К сценариям" },
  ];
}
