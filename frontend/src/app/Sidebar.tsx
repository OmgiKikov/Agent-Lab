import { NavLink, useLocation } from "react-router-dom";
import {
  Bot,
  FlaskConical,
  LayoutGrid,
  MessageSquareQuote,
  Repeat,
  Search,
  Settings,
  Target,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { CHECK_NAME } from "../lab/checks";
import { Label } from "../ui/Label";
import { AgentSwitch } from "./AgentSwitch";
import { useShell } from "./ShellContext";
import { TaskCard } from "./TaskCard";
import { SECTIONS } from "./links";

export type NavItem = { to: string; label: string; mobileLabel?: string; icon: LucideIcon };

/**
 * The work in its order: the overview; what is checked in the real conversations of the export, each check its own
 * section; the trials: synthetic customers, the export replayed through the local agent. Group labels are quiet text,
 * not links. No counts: «Диалоги 8» read as eight conversations; a running task shows in its own card.
 */
export const GROUPS: { label?: string; items: NavItem[] }[] = [
  { items: [{ to: SECTIONS.overview, label: "Обзор", icon: LayoutGrid }] },
  {
    label: "Проверки разговоров",
    items: [
      { to: SECTIONS.tone, label: CHECK_NAME.tone, mobileLabel: "Tone", icon: MessageSquareQuote },
      { to: SECTIONS.accuracy, label: CHECK_NAME.code, icon: Target },
    ],
  },
  {
    label: "Испытания",
    items: [
      { to: SECTIONS.simulations, label: "Симуляции", icon: FlaskConical },
      { to: SECTIONS.replay, label: "Повтор разговоров", icon: Repeat },
    ],
  },
];

/** The places of the work in one row; the bottom of a phone shows as many of them as fit (BottomNav). */
export const WORK: NavItem[] = GROUPS.flatMap((g) => g.items);

/** The agent and settings stay below the day-to-day work: they are the developer's. */
export const SETUP: NavItem[] = [
  { to: SECTIONS.agent, label: "Агент", icon: Bot },
  { to: SECTIONS.settings, label: "Настройки", icon: Settings },
];

/** A place is current on its own address and on every page inside it. */
export const isActive = (item: NavItem, pathname: string) => pathname === item.to || pathname.startsWith(`${item.to}/`);

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
      <item.icon
        aria-hidden
        className={cn("size-[18px] flex-shrink-0", on ? "text-fg" : "text-fg-3")}
        strokeWidth={1.6}
      />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
    </NavLink>
  );
}

/** The navigation on every screen of a wide window: the agent it checks, search, the places, the running task, the setup. */
export function Sidebar() {
  const shell = useShell();
  return (
    <nav
      aria-label="Разделы"
      className="hidden w-[248px] flex-shrink-0 flex-col bg-side px-3 pb-3 pt-5 lg:flex print:!hidden"
    >
      <AgentSwitch />
      <button
        type="button"
        onClick={shell.openPalette}
        className="mt-5 flex h-9 items-center gap-3 rounded-control px-3 text-body text-fg-3 transition-colors hover:bg-hover hover:text-fg-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
      >
        <Search aria-hidden className="size-[18px]" strokeWidth={1.6} />
        <span className="flex-1 text-left">Поиск</span>
        <span className="text-small text-fg-4">⌘K</span>
      </button>
      <div className="mt-0.5 flex flex-col">
        {GROUPS.map((group, i) => {
          const id = `nav-group-${i}`;
          return (
            <div
              key={group.label ?? i}
              role={group.label ? "group" : undefined}
              aria-labelledby={group.label ? id : undefined}
              className="flex flex-col gap-0.5"
            >
              {group.label && (
                <Label id={id} className="block px-3 pb-1.5 pt-5">
                  {group.label}
                </Label>
              )}
              {group.items.map((item) => (
                <Item key={item.to} item={item} />
              ))}
            </div>
          );
        })}
      </div>
      <div className="flex-1" />
      <div className="mb-3">
        <TaskCard />
      </div>
      <div className="flex flex-col gap-0.5 border-t border-line pt-3">
        {SETUP.map((item) => (
          <Item key={item.to} item={item} />
        ))}
      </div>
    </nav>
  );
}
