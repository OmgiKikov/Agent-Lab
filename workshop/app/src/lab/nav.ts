import { Bot, FileText, FlaskConical, ListChecks, MessagesSquare, PlayCircle, Scale, type LucideIcon } from "lucide-react";
import type { LabState, Step } from "./types";

export const STEPS: Step[] = ["overview", "criteria", "dialogs", "judge", "agent", "logs", "checks"];

/** Addresses of the earlier layouts keep working. */
export const LEGACY: Record<string, string> = {
  health: "/lab/overview", accuracy: "/lab/overview", versions: "/lab/overview", findings: "/lab/criteria",
  trust: "/lab/judge", runs: "/lab/dialogs", run: "/lab/dialogs", cards: "/lab/checks", connect: "/lab/agent",
};

/**
 * Two groups. The result: the version's check (the service's metric and the broken criteria), its dialogues, and the judge
 * (second judge, repeats, the human check). The preparation: the service's steps in the order they depend on each other.
 */
export type NavGroup = "main" | "setup";
export type NavItem = {
  id: Step; title: string; icon: LucideIcon; group: NavGroup; busy: boolean;
  /** Preparation steps: done, and the step's number. */
  done?: boolean; n?: number;
};
export const NAV_GROUP_TITLE: Record<NavGroup, string | null> = { main: null, setup: "Подготовка" };

export const NAV_ICON: Record<Step, LucideIcon> = {
  overview: FlaskConical, criteria: ListChecks, dialogs: MessagesSquare, judge: Scale, agent: Bot, logs: FileText, checks: PlayCircle,
};

export const STEP_TITLE: Record<Step, string> = {
  overview: "Версия", criteria: "Критерии", dialogs: "Диалоги", judge: "Судья", agent: "Агент", logs: "Логи", checks: "Сценарии",
};

/** What each place answers, for tooltips and ⌘K. */
export const STEP_HINT: Record<Step, string> = {
  overview: "Сколько диалогов без нарушений и что нарушается",
  criteria: "Что агент обязан делать",
  dialogs: "Доказательства: каждый диалог с вердиктом",
  judge: "Второй судья, повторы и сверка с человеком",
  agent: "Подключение и источники критериев",
  logs: "Реальные диалоги агента",
  checks: "Что играет симулятор клиента",
};

export function buildNav(state: LabState | null): NavItem[] {
  const job = state?.job.running ? state.job.kind : null;
  const setup = state ? setupSteps(state) : [];
  const item = (id: Step, group: NavGroup, rest: Partial<NavItem> = {}): NavItem => ({ id, title: STEP_TITLE[id], icon: NAV_ICON[id], group, busy: false, ...rest });
  return [
    item("overview", "main", { busy: job === "run" }),
    item("dialogs", "main"),
    item("judge", "main", { busy: job === "rejudge" }),
    item("agent", "setup", { busy: job === "sources", done: setup[0]?.done, n: 1 }),
    item("logs", "setup", { busy: job === "discover", done: setup[1]?.done, n: 2 }),
    item("checks", "setup", { busy: job === "cards", done: setup[2]?.done, n: 3 }),
  ];
}

export type SetupStep = { id: Step; label: string; hint: string; gives: string; done: boolean; to: string; cta: string };

/**
 * The service's preparation, in the order its jobs need each other: sources from the agent's code (POST /api/sources),
 * the log audit that extracts the criteria from them and judges the real dialogues (/api/discover),
 * the scenarios built from the audit (/api/cards). Each step is done when the service has its result.
 */
export function setupSteps(state: LabState): SetupStep[] {
  return [
    { id: "agent", label: "Подключите агента", hint: "Адрес агента и его код.", gives: "источники: промпты, инструменты, база знаний", done: state.sources.length > 0, to: "/lab/agent", cta: "Подключить агента" },
    { id: "logs", label: "Оцените реальные диалоги", hint: "Выгрузка чата из Excel.", gives: "критерии из источников и нарушения в реальных диалогах", done: !!state.discover, to: "/lab/logs", cta: "Загрузить логи" },
    { id: "checks", label: "Соберите сценарии", hint: "Ситуации клиентов из оценённых логов.", gives: "сценарии для симулятора клиента", done: !!state.cards?.cards.length, to: "/lab/checks", cta: "Собрать сценарии" },
  ];
}

/** Where «Подготовка» leads: the first step not done yet, or the agent. */
export const setupHome = (state: LabState | null) => (state ? setupSteps(state).find(s => !s.done)?.to : undefined) ?? "/lab/agent";
