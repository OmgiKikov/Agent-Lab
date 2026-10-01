import { useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  Bot,
  ChevronDown,
  ClipboardCheck,
  FlaskConical,
  LayoutGrid,
  ListChecks,
  MessagesSquare,
  Search,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AGENT_TITLE } from "../lab/look";
import { Step } from "../product/Step";
import { Mark } from "./Mark";
import { useShell } from "./ShellContext";
import { TaskCard } from "./TaskCard";
import { SECTIONS } from "./links";

export type NavItem = { to: string; label: string; icon: LucideIcon; match: string[]; count?: number; step?: 1 | 2 };
export type NavCounts = { logs?: number; sims?: number; criteria?: number };

/** The guided check is primary; the remaining tools belong to the workspace. */
export function useNav({ logs, sims, criteria }: NavCounts): NavItem[] {
  return [
    { to: SECTIONS.start, label: "Проверка", icon: ClipboardCheck, match: ["/start", "/check"] },
    { to: SECTIONS.overview, label: "Обзор", icon: LayoutGrid, match: ["/overview"] },
    {
      to: SECTIONS.logs,
      label: "Логи",
      icon: MessagesSquare,
      match: ["/logs", "/problems", "/dialogs", "/review", "/violations"],
      count: logs,
      step: 1,
    },
    {
      to: SECTIONS.simulations,
      label: "Симуляции",
      icon: FlaskConical,
      match: ["/simulations", "/scenarios", "/results"],
      count: sims,
      step: 2,
    },
    {
      to: SECTIONS.criteria,
      label: "Критерии",
      icon: ListChecks,
      match: ["/criteria", "/agent/criteria"],
      count: criteria,
    },
  ];
}

/** The agent belongs to the workspace; settings stay accessible from either flow. */
export const SETUP: NavItem[] = [
  { to: SECTIONS.agent, label: "Агент", icon: Bot, match: ["/agent"] },
  { to: SECTIONS.settings, label: "Настройки", icon: Settings, match: ["/settings"] },
];

export function isActive(item: NavItem, pathname: string) {
  if (pathname.startsWith("/agent/criteria")) return item.match.includes("/agent/criteria");
  return item.match.some((m) => pathname === m || pathname.startsWith(`${m}/`));
}

function Item({ item }: { item: NavItem }) {
  const { pathname } = useLocation();
  const on = isActive(item, pathname);
  return (
    <NavLink
      to={item.to}
      aria-current={on ? "page" : undefined}
      className={cn(
        "flex h-9 items-center gap-3 rounded-control px-3 text-body font-medium transition-colors duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60",
        on ? "bg-selected text-fg" : "text-fg-2 hover:bg-hover hover:text-fg",
      )}
    >
      {item.step ? (
        <span className="flex size-[18px] items-center justify-center">
          <Step n={item.step} on={on} size="sm" />
        </span>
      ) : (
        <item.icon
          aria-hidden
          className={cn("size-[18px] flex-shrink-0", on ? "text-fg" : "text-fg-3")}
          strokeWidth={1.6}
        />
      )}
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.count !== undefined && item.count > 0 && (
        <span
          className="min-w-5 text-right text-small tabular-nums text-fg-3"
          title={item.step ? "Проблем — критериев с ошибкой" : undefined}
        >
          {item.count}
        </span>
      )}
    </NavLink>
  );
}

/** The navigation on every screen of a wide window: the product and the agent it checks, search, the places, the running task, the setup. */
export function Sidebar({ counts }: { counts: NavCounts }) {
  const items = useNav(counts);
  const { pathname } = useLocation();
  const workspace = [...items.slice(1), SETUP[0]];
  const inWorkspace = workspace.some((item) => isActive(item, pathname));
  const [disclosure, setDisclosure] = useState<{ pathname: string; open: boolean } | null>(null);
  const expanded = disclosure?.pathname === pathname ? disclosure.open : inWorkspace;
  const shell = useShell();
  return (
    <nav aria-label="Разделы" className="hidden w-[248px] flex-shrink-0 flex-col bg-side px-3 pb-3 pt-5 lg:flex">
      <NavLink
        to={SECTIONS.start}
        className="flex items-center gap-3 rounded-control px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
      >
        <Mark />
        <span className="min-w-0">
          <span className="block text-read font-semibold leading-5 text-fg">Agent Lab</span>
          <span className="block truncate text-small text-fg-3">{AGENT_TITLE}</span>
        </span>
      </NavLink>
      <button
        type="button"
        onClick={shell.openPalette}
        className="mt-5 flex h-9 items-center gap-3 rounded-control px-3 text-body text-fg-3 transition-colors hover:bg-hover hover:text-fg-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
      >
        <Search aria-hidden className="size-[18px]" strokeWidth={1.6} />
        <span className="flex-1 text-left">Поиск</span>
        <span className="text-small text-fg-4">⌘K</span>
      </button>
      <div className="mt-1 flex flex-col gap-0.5">
        <Item item={items[0]} />
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls="workspace-navigation"
          onClick={() => setDisclosure({ pathname, open: !expanded })}
          className={cn(
            "mt-3 flex min-h-11 items-center gap-3 rounded-control px-3 text-body font-medium transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60",
            inWorkspace && !expanded ? "bg-selected text-fg" : "text-fg-2 hover:bg-hover hover:text-fg",
          )}
        >
          <LayoutGrid aria-hidden className="size-[18px] flex-shrink-0 text-fg-3" strokeWidth={1.6} />
          <span className="flex-1 text-left">Рабочая область</span>
          <ChevronDown
            aria-hidden
            className={cn(
              "size-4 text-fg-3 transition-transform motion-reduce:transition-none",
              expanded && "rotate-180",
            )}
          />
        </button>
        <div id="workspace-navigation" hidden={!expanded}>
          <div className="ml-5 flex flex-col gap-0.5 border-l border-line pl-2">
            {workspace.map((item) => (
              <Item key={item.label} item={item} />
            ))}
          </div>
        </div>
      </div>
      <div className="flex-1" />
      <div className="mb-3">
        <TaskCard />
      </div>
      <div className="flex flex-col gap-0.5">
        <Item item={SETUP[1]} />
      </div>
    </nav>
  );
}
