import { Bot, FileText, FlaskConical, ListChecks, MessagesSquare, PlayCircle, Scale, type LucideIcon } from "lucide-react";
import type { LabState, Step } from "./types";

export const STEPS: Step[] = ["overview", "criteria", "dialogs", "judge", "agent", "logs", "checks"];

/** Addresses of the earlier layouts keep working. */
export const LEGACY: Record<string, string> = {
  health: "/lab/overview", accuracy: "/lab/overview", versions: "/lab/overview", findings: "/lab/criteria",
  trust: "/lab/judge", runs: "/lab/dialogs", run: "/lab/dialogs", cards: "/lab/checks", connect: "/lab/agent",
};

/**
 * Two groups. The answer: the version (its verdict and what breaks), the dialogues that prove it, and the judge — how far to trust it.
 * The preparation: the three steps that feed it, in the order they depend on each other. Criteria live on the version's page.
 */
export type NavGroup = "main" | "setup";
export type NavItem = {
  id: Step; title: string; icon: LucideIcon; group: NavGroup; busy: boolean;
  /** A number worth a glance (new violations), or a mark that something waits for a person. */
  badge?: string; hot?: boolean;
  /** Preparation steps: done, and the step's number. */
  done?: boolean; n?: number;
};
export const NAV_GROUP_TITLE: Record<NavGroup, string | null> = { main: null, setup: "Подготовка" };

/** What the badges of the navigation say; derived by the page. */
export type NavExtra = { broken?: number; fresh?: number; dialogs?: number; trustPending?: boolean };

export const NAV_ICON: Record<Step, LucideIcon> = {
  overview: FlaskConical, criteria: ListChecks, dialogs: MessagesSquare, judge: Scale, agent: Bot, logs: FileText, checks: PlayCircle,
};

export const STEP_TITLE: Record<Step, string> = {
  overview: "Версия", criteria: "Критерии", dialogs: "Диалоги", judge: "Судья", agent: "Агент", logs: "Логи", checks: "Сценарии",
};

/** What each place answers, for tooltips and ⌘K. */
export const STEP_HINT: Record<Step, string> = {
  overview: "Стала ли версия лучше и что сломалось",
  criteria: "Что агент обязан делать",
  dialogs: "Доказательства: каждый диалог с вердиктом",
  judge: "Можно ли верить оценке",
  agent: "Подключение и источники критериев",
  logs: "Реальные диалоги агента",
  checks: "Что играет симулятор клиента",
};

export function buildNav(state: LabState | null, extra: NavExtra): NavItem[] {
  const job = state?.job.running ? state.job.kind : null;
  const setup = state ? setupSteps(state) : [];
  const item = (id: Step, group: NavGroup, rest: Partial<NavItem> = {}): NavItem => ({ id, title: STEP_TITLE[id], icon: NAV_ICON[id], group, busy: false, ...rest });
  return [
    item("overview", "main", { busy: job === "run", badge: extra.fresh ? String(extra.fresh) : undefined, hot: !!extra.fresh }),
    item("dialogs", "main"),
    item("judge", "main", { busy: job === "rejudge", badge: extra.trustPending ? "•" : undefined }),
    item("agent", "setup", { busy: job === "sources", done: setup[0]?.done, n: 1 }),
    item("logs", "setup", { busy: job === "discover", done: setup[1]?.done, n: 2 }),
    item("checks", "setup", { busy: job === "cards", done: setup[2]?.done, n: 3 }),
  ];
}

export type SetupStep = { id: Step; label: string; hint: string; gives: string; done: boolean; to: string; cta: string };

/** The first-run path: each step feeds the next — the agent's prompts give the criteria, the logs give the scenarios, the scenarios are played. */
export function setupSteps(state: LabState): SetupStep[] {
  return [
    { id: "agent", label: "Подключите агента", hint: "Адрес агента и его код.", gives: "критерии из промптов и инструментов", done: state.sources.length > 0, to: "/lab/agent", cta: "Подключить агента" },
    { id: "logs", label: "Оцените реальные диалоги", hint: "Выгрузка чата из Excel.", gives: "нарушения в реальных диалогах", done: !!state.discover, to: "/lab/logs", cta: "Загрузить логи" },
    { id: "checks", label: "Соберите сценарии", hint: "Ситуации клиентов из логов.", gives: "вердикт по каждой версии", done: state.runs.length > 0, to: "/lab/checks", cta: "Собрать сценарии" },
  ];
}

/** Where «Подготовка» leads: the first step not done yet, or the agent. */
export const setupHome = (state: LabState | null) => (state ? setupSteps(state).find(s => !s.done)?.to : undefined) ?? "/lab/agent";
