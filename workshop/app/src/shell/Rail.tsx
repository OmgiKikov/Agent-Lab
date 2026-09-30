import { NavLink, useLocation } from "react-router-dom";
import { Bot, ClipboardCheck, FlaskConical, MessagesSquare, Settings, Route, type LucideIcon } from "lucide-react";
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
      to={item.to} aria-current={active ? "page" : undefined} title={item.label} aria-label={item.label}
      className={cn(
        "relative flex size-9 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-lab-accent",
        active ? "bg-lab-active text-lab-ink" : "text-lab-dim hover:bg-lab-hover hover:text-lab-text",
      )}
    >
      <item.icon className="size-4" strokeWidth={1.75} />
      {!!item.badge && <span className="absolute -right-0.5 -top-0.5 min-w-[14px] rounded-full bg-lab-bad px-1 text-center text-micro leading-[14px] text-black">{item.badge}</span>}
      {busy && <span className="pulse-dot absolute bottom-1 right-1 size-1.5 rounded-full bg-lab-accent" />}
    </NavLink>
  );
}

/** The rail on every page, like Raindrop's sidebar: the sections in the order of the work; the agent and settings below. */
export function Rail({ logs, results }: { logs: number; results: number }) {
  const { state } = useLabState();
  const kind = state?.job.running ? state.job.kind : null;
  const busy = (to: string) => !!kind && JOBS[kind]?.to.split("?")[0] === to;
  const main: Item[] = [
    { to: LINKS.agent, label: "Агент", icon: Bot, match: ["/agent"] },
    { to: LINKS.logs, label: "Логи", icon: MessagesSquare, match: ["/logs"], badge: logs },
    { to: LINKS.scenarios, label: "Сценарии", icon: Route, match: ["/scenarios"] },
    { to: LINKS.simulations, label: "Прогоны", icon: FlaskConical, match: ["/simulations"] },
    { to: LINKS.results, label: "Результаты", icon: ClipboardCheck, match: ["/results"], badge: results },
  ];
  const bottom: Item[] = [{ to: LINKS.settings, label: "Настройки", icon: Settings, match: ["/settings"] }];
  return (
    <nav aria-label="Блоки" className="flex w-12 flex-shrink-0 flex-col items-center gap-1 border-r border-white/[0.06] bg-lab-surface py-3">
      <NavLink to={LINKS.logs} aria-label="На главную" className="mb-3 rounded-md p-1 text-lab-soft transition-colors hover:text-lab-ink">
        <RaindropLogo size={18} />
      </NavLink>
      {main.map(i => <RailLink key={i.to} item={i} busy={busy(i.to)} />)}
      <div className="flex-1" />
      <Activity />
      {bottom.map(i => <RailLink key={i.to} item={i} busy={busy(i.to)} />)}
    </nav>
  );
}
