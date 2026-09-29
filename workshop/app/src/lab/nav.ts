import { Activity, Bot, FileText, FlaskConical, GitBranch, MessagesSquare, ShieldCheck, TriangleAlert, type LucideIcon } from "lucide-react";
import type { LabState, Step } from "./types";

export const STEPS: Step[] = ["agent", "logs", "checks", "runs", "health", "findings", "versions", "trust"];

/** Addresses of the earlier layouts keep working. */
export const LEGACY: Record<string, string> = { connect: "/lab/agent", cards: "/lab/checks", run: "/lab/runs", accuracy: "/lab/health" };

/** The agent and its logs come first; everything about the simulated customer follows. */
export type NavGroup = "agent" | "simulator";
export type NavItem = { id: Step; title: string; icon: LucideIcon; group: NavGroup; badge?: string; hot?: boolean; busy: boolean };
export const NAV_GROUP_TITLE: Record<NavGroup, string> = { agent: "Агент и логи", simulator: "Симулятор клиента" };

/** What the badges of the navigation say; derived from the latest run by the page. */
export type NavExtra = { findings?: number; trustPending?: boolean; version?: string };

const ICON: Record<Step, LucideIcon> = { health: Activity, findings: TriangleAlert, trust: ShieldCheck, checks: FlaskConical, versions: GitBranch, runs: MessagesSquare, agent: Bot, logs: FileText };
export const NAV_ICON = ICON;

export function buildNav(state: LabState | null, extra: NavExtra): NavItem[] {
  const job = state?.job.running ? state.job.kind : null;
  const cards = state?.cards?.cards.length ?? 0;
  const sources = state?.sources.length ?? 0;
  const logs = state?.logs.total ?? 0;
  return [
    { id: "agent", title: "Агент", icon: ICON.agent, group: "agent", busy: job === "sources", badge: sources ? String(sources) : undefined },
    { id: "logs", title: "Логи", icon: ICON.logs, group: "agent", busy: job === "discover", badge: logs ? String(logs) : undefined },
    { id: "checks", title: "Набор проверок", icon: ICON.checks, group: "simulator", busy: job === "cards", badge: cards ? String(cards) : undefined },
    { id: "runs", title: "Разговоры", icon: ICON.runs, group: "simulator", busy: job === "run", badge: state?.runs.length ? String(state.runs.length) : undefined },
    { id: "health", title: "Здоровье", icon: ICON.health, group: "simulator", busy: false },
    { id: "findings", title: "Находки", icon: ICON.findings, group: "simulator", busy: false, badge: extra.findings ? String(extra.findings) : undefined, hot: !!extra.findings },
    { id: "versions", title: "Версии", icon: ICON.versions, group: "simulator", busy: false, badge: extra.version },
    { id: "trust", title: "Доверие", icon: ICON.trust, group: "simulator", busy: job === "rejudge", badge: extra.trustPending ? "!" : undefined },
  ];
}

export type SetupStep = { label: string; hint: string; done: boolean; to: string; cta: string };

/** The first-run checklist: what is still to do before the first number appears. */
export function setupSteps(state: LabState): SetupStep[] {
  return [
    { label: "Подключите агента", hint: "Адрес агента и репозиторий: из них берутся правила проверки.", done: state.sources.length > 0, to: "/lab/agent", cta: "Подключить" },
    { label: "Загрузите и оцените логи", hint: "Судья найдёт, что агент уже нарушал в реальных разговорах.", done: !!state.discover, to: "/lab/logs", cta: "К логам" },
    { label: "Соберите набор проверок", hint: "Из оценённых логов получатся сценарии для симулятора клиента.", done: (state.cards?.cards.length ?? 0) > 0, to: "/lab/checks", cta: "К проверкам" },
    { label: "Проверьте агента", hint: "Симулятор сыграет сценарии, судья оценит разговоры.", done: state.runs.length > 0, to: "/lab/runs", cta: "Запустить" },
  ];
}
