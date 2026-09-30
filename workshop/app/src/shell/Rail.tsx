import { NavLink, useLocation } from "react-router-dom";
import { Bot, FlaskConical, ListChecks, MessagesSquare, Settings, TriangleAlert, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { RaindropLogo } from "../components/RaindropLogo";
import { Activity } from "./Activity";
import { JOBS } from "./jobs";
import { useLabState } from "./LabProvider";
import { LINKS } from "./links";

type Item = { to: string; label: string; icon: LucideIcon; match: string[]; badge?: number };

function RailLink({ item, busy }: { item: Item; busy: boolean }) {
  const { pathname } = useLocation();
  const active = item.match.some(m => pathname === m || pathname.startsWith(`${m}/`));
  return (
    <NavLink
      to={item.to} aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex w-14 flex-col items-center gap-1 rounded-lg py-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-lab-accent",
        active ? "bg-lab-active text-lab-ink" : "text-lab-dim hover:bg-lab-hover hover:text-lab-text",
      )}
    >
      <item.icon className="size-[18px]" strokeWidth={1.75} />
      <span className="text-micro">{item.label}</span>
      {!!item.badge && <span className="absolute right-1 top-1 min-w-[16px] rounded-full bg-lab-bad px-1 text-center font-mono text-micro font-semibold text-black">{item.badge}</span>}
      {busy && <span className="pulse-dot absolute left-2 top-2 size-1.5 rounded-full bg-lab-accent" />}
    </NavLink>
  );
}

/** The rail on every page, like Raindrop's sidebar: the sections in the order of the work; the agent and settings below. */
export function Rail({ problems }: { problems: number }) {
  const { state } = useLabState();
  const kind = state?.job.running ? state.job.kind : null;
  const busy = (to: string) => !!kind && JOBS[kind]?.to.split("?")[0] === to;
  const main: Item[] = [
    { to: LINKS.problems, label: "Проблемы", icon: TriangleAlert, match: ["/problems"], badge: problems },
    { to: LINKS.dialogs, label: "Диалоги", icon: MessagesSquare, match: ["/dialogs", "/runs", "/search", "/saved"] },
    { to: LINKS.rules, label: "Правила", icon: ListChecks, match: ["/rules", "/review"] },
    { to: LINKS.simulations, label: "Симуляции", icon: FlaskConical, match: ["/simulations"] },
  ];
  const bottom: Item[] = [
    { to: LINKS.agent, label: "Агент", icon: Bot, match: ["/agent"] },
    { to: LINKS.settings, label: "Настройки", icon: Settings, match: ["/settings"] },
  ];
  return (
    <nav aria-label="Разделы" className="flex w-16 flex-shrink-0 flex-col items-center gap-1 border-r border-white/[0.06] bg-lab-surface py-3">
      <NavLink to={LINKS.problems} aria-label="На главную" className="mb-3 rounded-md p-1 text-lab-soft transition-colors hover:text-lab-ink">
        <RaindropLogo size={22} />
      </NavLink>
      {main.map(i => <RailLink key={i.to} item={i} busy={busy(i.to)} />)}
      <div className="flex-1" />
      <Activity />
      {bottom.map(i => <RailLink key={i.to} item={i} busy={busy(i.to)} />)}
    </nav>
  );
}
