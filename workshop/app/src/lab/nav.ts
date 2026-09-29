import { Bot, FileText, FlaskConical, LayoutDashboard, ListChecks, MessagesSquare, ShieldCheck, type LucideIcon } from "lucide-react";
import type { LabState, Step } from "./types";

export const STEPS: Step[] = ["overview", "criteria", "dialogs", "judge", "agent", "logs", "checks"];

/** Addresses of the earlier layouts keep working. */
export const LEGACY: Record<string, string> = {
  health: "/lab/overview", accuracy: "/lab/overview", versions: "/lab/overview", findings: "/lab/criteria",
  trust: "/lab/judge", runs: "/lab/dialogs", run: "/lab/dialogs", cards: "/lab/checks", connect: "/lab/agent",
};

/**
 * Two groups. The answer: the version's verdict, the criteria, the dialogues that prove them, and how far to trust the judge.
 * The preparation: the three steps that feed it, in the order they depend on each other.
 */
export type NavGroup = "main" | "setup";
export type NavItem = {
  id: Step; title: string; icon: LucideIcon; group: NavGroup; busy: boolean;
  /** A number worth a glance (broken criteria), or a mark that something waits for a person. */
  badge?: string; hot?: boolean;
  /** Preparation steps: done, and the step's number. */
  done?: boolean; n?: number;
};
export const NAV_GROUP_TITLE: Record<NavGroup, string | null> = { main: null, setup: "Подготовка" };

/** What the badges of the navigation say; derived by the page. */
export type NavExtra = { broken?: number; dialogs?: number; trustPending?: boolean };

export const NAV_ICON: Record<Step, LucideIcon> = {
  overview: LayoutDashboard, criteria: ListChecks, dialogs: MessagesSquare, judge: ShieldCheck, agent: Bot, logs: FileText, checks: FlaskConical,
};

export const STEP_TITLE: Record<Step, string> = {
  overview: "Сводка", criteria: "Критерии", dialogs: "Диалоги", judge: "Доверие", agent: "Агент", logs: "Логи", checks: "Сценарии",
};

export function buildNav(state: LabState | null, extra: NavExtra): NavItem[] {
  const job = state?.job.running ? state.job.kind : null;
  const setup = state ? setupSteps(state) : [];
  const item = (id: Step, group: NavGroup, rest: Partial<NavItem> = {}): NavItem => ({ id, title: STEP_TITLE[id], icon: NAV_ICON[id], group, busy: false, ...rest });
  return [
    item("overview", "main"),
    item("criteria", "main", { badge: extra.broken ? String(extra.broken) : undefined, hot: !!extra.broken }),
    item("dialogs", "main", { busy: job === "run" }),
    item("judge", "main", { busy: job === "rejudge", badge: extra.trustPending ? "•" : undefined }),
    item("agent", "setup", { busy: job === "sources", done: setup[0]?.done, n: 1 }),
    item("logs", "setup", { busy: job === "discover", done: setup[1]?.done, n: 2 }),
    item("checks", "setup", { busy: job === "cards", done: setup[2]?.done, n: 3 }),
  ];
}

export type SetupStep = { id: Step; label: string; hint: string; done: boolean; to: string; cta: string };

/** The first-run path: each step feeds the next — the agent's prompts give the criteria, the logs give the scenarios, the scenarios are played. */
export function setupSteps(state: LabState): SetupStep[] {
  return [
    { id: "agent", label: "Подключите агента", hint: "Адрес агента и его код: из промптов и инструментов получаются критерии.", done: state.sources.length > 0, to: "/lab/agent", cta: "Подключить" },
    { id: "logs", label: "Оцените реальные диалоги", hint: "Загрузите выгрузку чата: судья проверит разговоры по критериям.", done: !!state.discover, to: "/lab/logs", cta: "Загрузить логи" },
    { id: "checks", label: "Соберите сценарии и проверьте версию", hint: "Из логов получаются сценарии, симулятор клиента играет их с агентом.", done: state.runs.length > 0, to: "/lab/checks", cta: "К сценариям" },
  ];
}
