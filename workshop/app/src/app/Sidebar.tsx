import { NavLink, useLocation } from "react-router-dom";
import { Bot, Droplet, FlaskConical, ListChecks, MessagesSquare, Settings, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { AGENT_SUBTITLE, AGENT_TITLE } from "../lab/look";
import { TaskCard } from "./TaskCard";
import { SECTIONS } from "./links";

export type NavItem = { to: string; label: string; icon: LucideIcon; match: string[]; count?: number; tone?: "bad" };

/** The sections in the order of the work, with what each holds; the agent and settings below. */
export function useNav({ violations, dialogs, criteria }: { violations?: number; dialogs?: number; criteria?: number }): NavItem[] {
  return [
    { to: SECTIONS.violations, label: "Нарушения", icon: TriangleAlert, match: ["/violations", "/logs", "/results", "/review"], count: violations, tone: violations ? "bad" : undefined },
    { to: SECTIONS.dialogs, label: "Диалоги", icon: MessagesSquare, match: ["/dialogs", "/runs", "/search", "/saved"], count: dialogs },
    { to: SECTIONS.criteria, label: "Критерии", icon: ListChecks, match: ["/criteria", "/agent/criteria"], count: criteria },
    { to: SECTIONS.simulations, label: "Симуляции", icon: FlaskConical, match: ["/simulations", "/scenarios"] },
    { to: SECTIONS.agent, label: "Агент", icon: Bot, match: ["/agent"] },
  ];
}

export function isActive(item: NavItem, pathname: string, search: string) {
  if (item.match.includes("/logs") && pathname === "/logs" && new URLSearchParams(search).get("tab") === "dialogs") return false;
  if (item.to.startsWith("/logs?tab=dialogs") && pathname === "/logs") return new URLSearchParams(search).get("tab") === "dialogs";
  if (pathname.startsWith("/agent/criteria")) return item.match.includes("/agent/criteria");
  return item.match.some(m => pathname === m || pathname.startsWith(`${m}/`));
}

function Item({ item }: { item: NavItem }) {
  const { pathname, search } = useLocation();
  const on = isActive(item, pathname, search);
  return (
    <NavLink
      to={item.to} aria-current={on ? "page" : undefined}
      className={cn(
        "flex h-9 items-center gap-2.5 rounded-control px-2.5 text-body font-medium transition-colors duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60",
        on ? "bg-raised text-fg" : "text-fg-2 hover:bg-hover hover:text-fg",
      )}
    >
      <item.icon aria-hidden className="size-4 flex-shrink-0" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.count !== undefined && item.count > 0 && (
        <span className={cn("font-mono text-meta", item.tone === "bad" ? "text-bad" : "text-fg-3")}>{item.count}</span>
      )}
    </NavLink>
  );
}

/** The navigation on every screen of a wide window: who is checked, the sections with labels, the running task, settings. */
export function Sidebar({ counts }: { counts: { violations?: number; dialogs?: number; criteria?: number } }) {
  const items = useNav(counts);
  return (
    <nav aria-label="Разделы" className="hidden w-56 flex-shrink-0 flex-col border-r border-line bg-side px-2.5 pb-2.5 pt-3 lg:flex">
      <NavLink to={SECTIONS.violations} className="mb-3 flex items-center gap-2.5 rounded-control border-b border-line px-1.5 pb-3.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60">
        <span className="flex size-7 flex-shrink-0 items-center justify-center rounded-control bg-customer text-customer-fg"><Droplet aria-hidden className="size-4" strokeWidth={1.75} /></span>
        <span className="min-w-0">
          <span className="block truncate text-small font-semibold text-fg">{AGENT_TITLE}</span>
          <span className="block text-meta text-fg-3">{AGENT_SUBTITLE}</span>
        </span>
      </NavLink>
      <div className="flex flex-col gap-0.5">{items.map(i => <Item key={i.label} item={i} />)}</div>
      <div className="flex-1" />
      <div className="mb-2"><TaskCard /></div>
      <Item item={{ to: SECTIONS.settings, label: "Настройки", icon: Settings, match: ["/settings"] }} />
    </nav>
  );
}
