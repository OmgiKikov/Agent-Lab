import { Activity, FlaskConical, GitBranch, MessagesSquare, Plug, ShieldCheck, TriangleAlert, type LucideIcon } from "lucide-react";
import type { LabState, Step } from "./types";

export const STEPS: Step[] = ["health", "findings", "trust", "checks", "versions", "runs", "connect"];

/** Addresses of the earlier five-step layout keep working. */
export const LEGACY: Record<string, string> = { agent: "/lab/connect", logs: "/lab/connect?tab=logs", cards: "/lab/checks", run: "/lab/runs", accuracy: "/lab/health" };

export type NavItem = { id: Step; title: string; icon: LucideIcon; badge?: string; hot?: boolean; busy: boolean };

/** What the badges of the navigation say; derived from the latest run by the page. */
export type NavExtra = { findings?: number; trustPending?: boolean; version?: string };

const ICON: Record<Step, LucideIcon> = { health: Activity, findings: TriangleAlert, trust: ShieldCheck, checks: FlaskConical, versions: GitBranch, runs: MessagesSquare, connect: Plug };
export const NAV_ICON = ICON;

export function buildNav(state: LabState | null, extra: NavExtra): NavItem[] {
  const job = state?.job.running ? state.job.kind : null;
  const cards = state?.cards?.cards.length ?? 0;
  return [
    { id: "health", title: "Здоровье", icon: ICON.health, busy: false },
    { id: "findings", title: "Находки", icon: ICON.findings, busy: false, badge: extra.findings ? String(extra.findings) : undefined, hot: !!extra.findings },
    { id: "trust", title: "Доверие", icon: ICON.trust, busy: job === "rejudge", badge: extra.trustPending ? "!" : undefined },
    { id: "checks", title: "Набор проверок", icon: ICON.checks, busy: job === "cards", badge: cards ? String(cards) : undefined },
    { id: "versions", title: "Версии", icon: ICON.versions, busy: false, badge: extra.version },
    { id: "runs", title: "Разговоры", icon: ICON.runs, busy: job === "run", badge: state?.runs.length ? String(state.runs.length) : undefined },
    { id: "connect", title: "Подключение", icon: ICON.connect, busy: job === "sources" || job === "discover" },
  ];
}

export type SetupStep = { label: string; hint: string; done: boolean; to: string; cta: string };

/** The first-run checklist: what is still to do before the first number appears. */
export function setupSteps(state: LabState): SetupStep[] {
  return [
    { label: "Подключите агента", hint: "Адрес агента и репозиторий: из них берутся правила проверки.", done: state.sources.length > 0, to: "/lab/connect", cta: "Подключить" },
    { label: "Загрузите и оцените логи", hint: "Судья найдёт, что агент уже нарушал в реальных разговорах.", done: !!state.discover, to: "/lab/connect?tab=logs", cta: "К логам" },
    { label: "Соберите набор проверок", hint: "Из оценённых логов получатся сценарии для симулятора клиента.", done: (state.cards?.cards.length ?? 0) > 0, to: "/lab/checks", cta: "К проверкам" },
    { label: "Проверьте агента", hint: "Симулятор сыграет сценарии, судья оценит разговоры.", done: state.runs.length > 0, to: "/lab/runs", cta: "Запустить" },
  ];
}
