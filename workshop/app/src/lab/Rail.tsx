import { useEffect, useRef, useState } from "react";
import { Activity, Bookmark, FlaskConical, Loader2, MessagesSquare, Scale, Search, Settings, SlidersHorizontal, Sparkles, Square, type LucideIcon } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useWorkshopConnected } from "@/hooks/use-workshop-ws";
import { api } from "./api";
import { useLabContext } from "./LabContext";
import { AGENT_SUBTITLE, AGENT_TITLE } from "./look";
import { STEP_HINT, setupHome, setupSteps } from "./nav";
import { useToast } from "./toast";
import type { LabState } from "./types";
import { Kbd, LabMark } from "./ui";

const JOB_TITLE: Record<string, string> = { run: "Идёт проверка версии", rejudge: "Судья переоценивает", discover: "Судья читает логи", cards: "Собираются сценарии", sources: "Читается код агента" };

type Item = {
  key: string; title: string; hint?: string; icon: LucideIcon; to?: string; onClick?: () => void; active: boolean;
  /** A dot on the icon: something new is broken (bad), something waits for a person (warn). */
  dot?: "bad" | "warn"; busy?: boolean; count?: string;
};

/** One place of the rail: an icon, its name on hover (or beside it in the drawer), a dot when something needs a look. */
function RailItem({ item, expanded, onGo }: { item: Item; expanded?: boolean; onGo: (i: Item) => void }) {
  const Icon = item.busy ? Loader2 : item.icon;
  return (
    <button
      onClick={() => onGo(item)} aria-current={item.active ? "page" : undefined} aria-label={item.title}
      className={cn(
        "lab-focus group/rail relative flex items-center rounded-md transition-colors duration-100",
        expanded ? "h-9 w-full gap-3 px-2.5 text-left" : "size-10 justify-center",
        item.active ? "bg-white/[0.08] text-lab-ink" : "text-lab-mute hover:bg-white/[0.05] hover:text-lab-ink",
      )}
    >
      <Icon className={cn("size-[18px] flex-shrink-0", item.busy && "animate-spin text-lab-accent")} strokeWidth={1.75} />
      {item.dot && <span className={cn("absolute size-1.5 rounded-full ring-2 ring-lab-panel", expanded ? "left-6 top-2" : "right-2 top-2", item.dot === "bad" ? "bg-lab-bad" : "bg-lab-warn")} />}
      {expanded ? (
        <>
          <span className="min-w-0 flex-1 truncate text-body">{item.title}</span>
          {item.count && <span className="lab-label text-lab-faint">{item.count}</span>}
        </>
      ) : (
        <span role="tooltip" className="pointer-events-none absolute left-full top-1/2 z-50 ml-2.5 hidden w-max max-w-[260px] -translate-y-1/2 rounded-md border border-lab-edge bg-lab-raised px-2.5 py-1.5 text-left shadow-pop group-hover/rail:block group-focus-visible/rail:block">
          <span className="block text-body font-medium text-lab-ink">{item.title}{item.count && <span className="ml-1.5 font-normal text-lab-mute">{item.count}</span>}</span>
          {item.hint && <span className="block text-caption text-lab-mute">{item.hint}</span>}
        </span>
      )}
    </button>
  );
}

/** The job at work, from every page: a ring that fills as it goes; open it to see what it does and to stop it. */
function JobRing({ state, expanded }: { state: LabState; expanded?: boolean }) {
  const { error } = useToast();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  const j = state.job;
  if (!j.running) return null;
  const { done = 0, total = 0, message } = j.progress;
  const share = total ? done / total : 0;
  const title = JOB_TITLE[j.kind ?? ""] ?? "Идёт работа";
  const r = 8, c = 2 * Math.PI * r;
  return (
    <div ref={box} className="relative" role="status" aria-live="polite">
      <button
        onClick={() => setOpen(o => !o)} aria-label={title}
        className={cn("lab-focus flex items-center rounded-md text-lab-accent transition-colors duration-100 hover:bg-white/[0.05]", expanded ? "h-9 w-full gap-3 px-2.5" : "size-10 justify-center")}
      >
        <svg width={20} height={20} viewBox="0 0 20 20" className="flex-shrink-0 -rotate-90" aria-hidden>
          <circle cx={10} cy={10} r={r} fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth={2} />
          {total ? <circle cx={10} cy={10} r={r} fill="none" stroke="currentColor" strokeWidth={2} strokeDasharray={c} strokeDashoffset={c * (1 - share)} strokeLinecap="round" className="transition-[stroke-dashoffset] duration-500" />
            : <circle cx={10} cy={10} r={r} fill="none" stroke="currentColor" strokeWidth={2} strokeDasharray={`${c / 4} ${c}`} strokeLinecap="round" className="origin-center animate-spin" />}
        </svg>
        {expanded && <span className="min-w-0 flex-1 truncate text-left text-body text-lab-text">{title}</span>}
        {expanded && total > 0 && <span className="lab-label tabular-nums text-lab-mute">{done}/{total}</span>}
      </button>
      {open && (
        <div className={cn("absolute z-50 w-[280px] rounded-lg border border-lab-edge bg-lab-raised p-3 shadow-pop", expanded ? "left-0 top-full mt-1" : "bottom-0 left-full ml-2.5")}>
          <div className="flex items-center gap-2 text-body font-medium text-lab-ink">
            <span className="pulse-dot size-1.5 rounded-full bg-lab-accent" />
            <span className="min-w-0 flex-1 truncate">{title}</span>
            {total > 0 && <span className="lab-label tabular-nums text-lab-mute">{done}/{total}</span>}
          </div>
          {message && <div className="mt-1 line-clamp-2 text-caption text-lab-mute">{message}</div>}
          {total > 0 && <div className="mt-2.5 h-1 overflow-hidden rounded-sm bg-white/[0.07]"><div className="h-full bg-lab-accent transition-[width] duration-500 ease-out" style={{ width: `${100 * share}%` }} /></div>}
          <button onClick={() => { api("/api/job/stop", {}).catch(error); setOpen(false); }} className="lab-focus mt-2.5 inline-flex h-7 items-center gap-1.5 rounded-md border border-lab-edge px-2.5 text-caption text-lab-text transition-colors duration-100 hover:bg-white/[0.06] hover:text-lab-ink">
            <Square className="size-2.5 fill-current" />Остановить
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The app's one navigation, on every page, Raindrop's rail: the version, the dialogues and the judge (the answer),
 * the trace viewer, then the preparation, the assistant and the settings. Icons with names on hover;
 * `expanded` shows the names beside them (the drawer on a narrow screen).
 */
export function Rail({ className, expanded, onNavigate }: { className?: string; expanded?: boolean; onNavigate?: () => void }) {
  const { state, offline, extra, openPalette } = useLabContext();
  const workshop = useWorkshopConnected();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const step = pathname.startsWith("/lab") ? (pathname.split("/")[2] || "overview") : null;
  const on = (...steps: string[]) => !!step && steps.includes(step);
  const under = (to: string) => pathname === to || pathname.startsWith(`${to}/`);
  const onGo = (i: Item) => { if (i.onClick) i.onClick(); else if (i.to) navigate(i.to); onNavigate?.(); };
  const setup = state ? setupSteps(state) : [];
  const setupLeft = setup.filter(s => !s.done).length;

  const answer: Item[] = [
    { key: "overview", title: "Версия", hint: STEP_HINT.overview, icon: FlaskConical, to: "/lab/overview", active: on("overview", "criteria"), dot: extra.fresh ? "bad" : undefined, busy: state?.job.running && state.job.kind === "run" },
    { key: "dialogs", title: "Диалоги", hint: STEP_HINT.dialogs, icon: MessagesSquare, to: "/lab/dialogs", active: on("dialogs") },
    { key: "judge", title: "Судья", hint: STEP_HINT.judge, icon: Scale, to: "/lab/judge", active: on("judge"), dot: extra.trustPending ? "warn" : undefined },
  ];
  const traces: Item[] = [
    { key: "runs", title: "Трейсы", hint: "Все трейсы Workshop: спаны, время, токены", icon: Activity, to: "/runs", active: under("/runs") },
    { key: "search", title: "Поиск", hint: "Поиск по трейсам прода в Raindrop", icon: Search, to: "/search", active: under("/search") },
    { key: "saved", title: "Сохранённые", hint: "Сохранённые трейсы и папки", icon: Bookmark, to: "/saved", active: under("/saved") },
  ];
  const tools: Item[] = [
    { key: "setup", title: "Подготовка", hint: setupLeft ? `Осталось шагов: ${setupLeft} из 3` : "Агент, логи, сценарии", icon: SlidersHorizontal, to: setupHome(state), active: on("agent", "logs", "checks"), dot: state && setupLeft ? "warn" : undefined, count: state ? `${3 - setupLeft}/3` : undefined },
    { key: "ask", title: "Ассистент", hint: "Claude Code или Codex рядом с трейсами", icon: Sparkles, onClick: () => window.dispatchEvent(new Event("workshop:open-message-pane")), active: false },
    { key: "settings", title: "Настройки", hint: "Ключи и адреса агентов", icon: Settings, to: "/settings", active: under("/settings") },
  ];
  const health = offline ? "bad" : !workshop ? "warn" : "ok";
  const healthText = `${offline ? "Сервис Agent Lab не отвечает" : "Agent Lab на связи"} · ${workshop ? "Workshop на связи" : "Workshop не отвечает"}${state?.model ? ` · модель ${state.model}` : ""}`;

  return (
    <aside className={cn("flex flex-shrink-0 flex-col border-r border-lab-line bg-lab-panel", expanded ? "w-[248px] px-2" : "w-14 items-center", className)} aria-label="Навигация">
      <button onClick={() => { navigate("/lab/overview"); onNavigate?.(); }} className={cn("lab-focus-inset flex h-[52px] flex-shrink-0 items-center gap-2.5 text-lab-ink", expanded ? "px-2.5" : "justify-center")} aria-label="Agent Lab">
        <LabMark size={20} />
        {expanded && <span className="min-w-0 text-left"><span className="block text-body font-semibold">Agent Lab</span><span className="block truncate text-caption text-lab-mute">{AGENT_TITLE} · {AGENT_SUBTITLE}</span></span>}
      </button>

      {expanded && (
        <button onClick={() => { openPalette(); onNavigate?.(); }} className="lab-focus mb-3 flex h-8 w-full items-center gap-2 rounded-md border border-lab-line bg-white/[0.03] px-2.5 text-body text-lab-mute">
          <Search className="size-3.5" />Поиск и команды<Kbd className="ml-auto">⌘K</Kbd>
        </button>
      )}

      <nav className={cn("flex min-h-0 flex-1 flex-col gap-1", !expanded && "items-center pt-1")} aria-label="Разделы">
        {answer.map(i => <RailItem key={i.key} item={i} expanded={expanded} onGo={onGo} />)}
        <span className={cn("my-2 h-px bg-lab-line", expanded ? "mx-2.5" : "w-5")} aria-hidden />
        {traces.map(i => <RailItem key={i.key} item={i} expanded={expanded} onGo={onGo} />)}
      </nav>

      <div className={cn("flex flex-col gap-1 pb-3", !expanded && "items-center")}>
        {state && <JobRing state={state} expanded={expanded} />}
        {tools.map(i => <RailItem key={i.key} item={i} expanded={expanded} onGo={onGo} />)}
        <span className={cn("mt-2 flex items-center gap-2", expanded ? "px-2.5" : "justify-center")} title={healthText} aria-label={healthText}>
          <span className={cn("size-1.5 rounded-full", health === "ok" ? "bg-lab-ok" : health === "warn" ? "bg-lab-warn" : "bg-lab-bad", health !== "ok" && "pulse-dot")} />
          {expanded && <span className="min-w-0 truncate text-caption text-lab-mute">{healthText}</span>}
        </span>
      </div>
    </aside>
  );
}
