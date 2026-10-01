import { NavLink, useLocation } from "react-router-dom";
import { Bot, Droplet, FlaskConical, LayoutDashboard, ListChecks, MessagesSquare, Search, Settings, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { AGENT_SUBTITLE, AGENT_TITLE } from "../lab/look";
import { useShell } from "./ShellContext";
import { TaskCard } from "./TaskCard";
import { SECTIONS } from "./links";

export type NavItem = { to: string; label: string; icon: LucideIcon; match: string[]; count?: number; tone?: "bad" };
export type NavCounts = { problems?: number; dialogs?: number; criteria?: number };

/** The sections in the order of the work, each with what it holds: how the agent is doing, where it errs, the conversations, what it must do, the simulations. */
export function useNav({ problems, dialogs, criteria }: NavCounts): NavItem[] {
  return [
    { to: SECTIONS.overview, label: "Обзор", icon: LayoutDashboard, match: ["/overview"] },
    { to: SECTIONS.problems, label: "Проблемы", icon: TriangleAlert, match: ["/problems", "/violations", "/logs", "/results"], count: problems, tone: problems ? "bad" : undefined },
    { to: SECTIONS.dialogs, label: "Разговоры", icon: MessagesSquare, match: ["/dialogs", "/runs", "/search", "/saved"], count: dialogs },
    { to: SECTIONS.criteria, label: "Критерии", icon: ListChecks, match: ["/criteria", "/agent/criteria", "/review"], count: criteria },
    { to: SECTIONS.simulations, label: "Симуляции", icon: FlaskConical, match: ["/simulations", "/scenarios"] },
  ];
}

/** The agent and the settings: what is set up once, below the work. */
export const SETUP: NavItem[] = [
  { to: SECTIONS.agent, label: "Агент", icon: Bot, match: ["/agent"] },
  { to: SECTIONS.settings, label: "Настройки", icon: Settings, match: ["/settings"] },
];

export function isActive(item: NavItem, pathname: string) {
  if (pathname.startsWith("/agent/criteria")) return item.match.includes("/agent/criteria");
  return item.match.some(m => pathname === m || pathname.startsWith(`${m}/`));
}

function Item({ item }: { item: NavItem }) {
  const { pathname } = useLocation();
  const on = isActive(item, pathname);
  return (
    <NavLink
      to={item.to} aria-current={on ? "page" : undefined}
      className={cn(
        "flex h-9 items-center gap-2.5 rounded-control px-2.5 text-body font-medium transition-colors duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60",
        on ? "bg-list text-fg shadow-card ring-1 ring-line" : "text-fg-2 hover:bg-hover hover:text-fg",
      )}
    >
      <item.icon aria-hidden className={cn("size-4 flex-shrink-0", on ? "text-fg" : "text-fg-3")} strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.count !== undefined && item.count > 0 && (
        <span className={cn("rounded-full px-1.5 text-meta font-medium tabular-nums", item.tone === "bad" ? "bg-bad/10 text-bad" : "text-fg-3")}>{item.count}</span>
      )}
    </NavLink>
  );
}

/** The navigation on every screen of a wide window: who is checked, search, the sections, the running task, the setup. */
export function Sidebar({ counts }: { counts: NavCounts }) {
  const items = useNav(counts);
  const shell = useShell();
  return (
    <nav aria-label="Разделы" className="hidden w-60 flex-shrink-0 flex-col border-r border-line bg-side px-3 pb-3 pt-4 lg:flex">
      <NavLink to={SECTIONS.agent} title="Подключение и код агента" className="flex items-center gap-2.5 rounded-control px-1.5 py-1 transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60">
        <span className="flex size-8 flex-shrink-0 items-center justify-center rounded-control bg-primary text-white"><Droplet aria-hidden className="size-4" strokeWidth={2} /></span>
        <span className="min-w-0">
          <span className="block truncate text-body font-semibold text-fg">{AGENT_TITLE}</span>
          <span className="block text-meta text-fg-3">{AGENT_SUBTITLE}</span>
        </span>
      </NavLink>
      <button type="button" onClick={shell.openPalette} className="mt-4 flex h-9 items-center gap-2.5 rounded-control border border-line bg-list px-2.5 text-body text-fg-3 shadow-card transition-colors hover:text-fg-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60">
        <Search aria-hidden className="size-4" strokeWidth={1.75} />
        <span className="flex-1 text-left">Поиск</span>
        <span className="text-meta text-fg-4">⌘K</span>
      </button>
      <div className="mt-4 flex flex-col gap-0.5">{items.map(i => <Item key={i.label} item={i} />)}</div>
      <div className="flex-1" />
      <div className="mb-3"><TaskCard /></div>
      <div className="flex flex-col gap-0.5 border-t border-line pt-3">{SETUP.map(i => <Item key={i.label} item={i} />)}</div>
    </nav>
  );
}
