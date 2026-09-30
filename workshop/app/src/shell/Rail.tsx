import { NavLink, useLocation } from "react-router-dom";
import { Bot, FlaskConical, MessagesSquare, Settings, TriangleAlert, type LucideIcon } from "lucide-react";
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
        "relative flex min-h-9 w-full items-center gap-3 rounded-md px-3 text-small transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-lab-accent",
        active ? "bg-lab-active text-lab-ink" : "text-lab-dim hover:bg-lab-hover hover:text-lab-text",
      )}
    >
      <item.icon className="size-4 shrink-0" strokeWidth={1.75} />
      <span className="truncate">{item.label}</span>
      {!!item.badge && <span className="ml-auto min-w-[18px] rounded-full bg-lab-bad/90 px-1.5 text-center font-mono text-micro leading-[18px] text-black">{item.badge}</span>}
      {busy && <span className="pulse-dot ml-auto size-1.5 shrink-0 rounded-full bg-lab-accent" />}
    </NavLink>
  );
}

/** The rail on every page, like Raindrop's sidebar: the sections in the order of the work; the agent and settings below. */
export function Rail({ problems }: { problems: number }) {
  const { state } = useLabState();
  const kind = state?.job.running ? state.job.kind : null;
  const busy = (to: string) => !!kind && JOBS[kind]?.to.split("?")[0] === to;
  const main: Item[] = [
    { to: LINKS.problems, label: "Проблемы", icon: TriangleAlert, match: ["/problems", "/rules", "/review"], badge: problems },
    { to: LINKS.dialogs, label: "Диалоги", icon: MessagesSquare, match: ["/dialogs", "/runs", "/search", "/saved"] },
    { to: LINKS.simulations, label: "Симуляции", icon: FlaskConical, match: ["/simulations"] },
  ];
  const bottom: Item[] = [
    { to: LINKS.agent, label: "Агент", icon: Bot, match: ["/agent"] },
    { to: LINKS.settings, label: "Настройки", icon: Settings, match: ["/settings"] },
  ];
  return (
    <nav aria-label="Разделы" className="flex w-[196px] flex-shrink-0 flex-col gap-1 border-r border-white/[0.06] bg-lab-surface px-3 py-4">
      <NavLink to={LINKS.problems} aria-label="На главную" className="mb-7 flex items-center gap-2 px-2 text-lab-soft transition-colors hover:text-lab-ink">
        <RaindropLogo size={18} />
        <span className="font-mono text-[11px] font-semibold tracking-[0.16em] text-lab-ink">RAINDROP</span>
        <span className="ml-auto rounded border border-white/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-lab-dim">LAB</span>
      </NavLink>
      <div className="mb-1 px-2 font-mono text-[9px] uppercase tracking-[0.16em] text-lab-faint">Evaluate</div>
      {main.map(i => <RailLink key={i.to} item={i} busy={busy(i.to)} />)}
      <div className="mt-6 flex-1" />
      <div className="mb-1 px-2 font-mono text-[9px] uppercase tracking-[0.16em] text-lab-faint">Workspace</div>
      <Activity />
      {bottom.map(i => <RailLink key={i.to} item={i} busy={busy(i.to)} />)}
    </nav>
  );
}
