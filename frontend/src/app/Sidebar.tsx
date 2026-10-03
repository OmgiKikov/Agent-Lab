import { NavLink, useLocation } from "react-router-dom";
import {
  Bot,
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
import { Step } from "../product/Step";
import { AgentSwitch } from "./AgentSwitch";
import { useShell } from "./ShellContext";
import { TaskCard } from "./TaskCard";
import { SECTIONS } from "./links";
import { useLabState } from "../lab/LabProvider";
import { dialoguesShown, TONE_ONLY } from "./product";

export type NavItem = {
  to: string;
  label: string;
  mobileLabel?: string;
  icon: LucideIcon;
  match: string[];
  count?: number;
  step?: 1 | 2;
};
export type NavCounts = { logs?: number; sims?: number; criteria?: number };

/** One product: a guided entry and the shared stages, evidence, and criteria. */
export function useNav({ logs, sims, criteria }: NavCounts): NavItem[] {
  const { state } = useLabState();
  const items: NavItem[] = [
    {
      to: SECTIONS.start,
      label: "Начать проверку",
      mobileLabel: "Старт",
      icon: ClipboardCheck,
      match: ["/start", "/check"],
    },
    { to: SECTIONS.overview, label: "Обзор", icon: LayoutGrid, match: ["/overview"] },
    {
      to: SECTIONS.logs,
      label: "Диалоги",
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
  if (!TONE_ONLY) return items;
  // «Диалоги 8» read as eight dialogues, not eight problems; with one stage the count says nothing the page does not.
  return items
    .filter(
      (i) => i.to === SECTIONS.start || i.to === SECTIONS.overview || (i.to === SECTIONS.logs && dialoguesShown(state)),
    )
    .map((i) => ({ ...i, count: undefined }));
}

/** The agent and settings stay below the day-to-day work. */
export const SETUP: NavItem[] = [
  ...(TONE_ONLY ? [] : [{ to: SECTIONS.agent, label: "Агент", icon: Bot, match: ["/agent"] }]),
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
  const shell = useShell();
  return (
    <nav aria-label="Разделы" className="hidden w-[248px] flex-shrink-0 flex-col bg-side px-3 pb-3 pt-5 lg:flex">
      <AgentSwitch />
      {!TONE_ONLY && (
        <button
          type="button"
          onClick={shell.openPalette}
          className="mt-5 flex h-9 items-center gap-3 rounded-control px-3 text-body text-fg-3 transition-colors hover:bg-hover hover:text-fg-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
        >
          <Search aria-hidden className="size-[18px]" strokeWidth={1.6} />
          <span className="flex-1 text-left">Поиск</span>
          <span className="text-small text-fg-4">⌘K</span>
        </button>
      )}
      <div className="mt-1 flex flex-col gap-0.5">
        {items.map((item) => (
          <Item key={item.label} item={item} />
        ))}
      </div>
      <div className="flex-1" />
      <div className="mb-3">
        <TaskCard />
      </div>
      <div className="flex flex-col gap-0.5">
        {SETUP.map((item) => (
          <Item key={item.label} item={item} />
        ))}
      </div>
    </nav>
  );
}
