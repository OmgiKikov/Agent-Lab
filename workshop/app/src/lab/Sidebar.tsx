import { Activity, Bookmark, Check, Loader2, Search, Settings, Sparkles, Square, type LucideIcon } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useWorkshopConnected } from "@/hooks/use-workshop-ws";
import { api } from "./api";
import { useLabContext } from "./LabContext";
import { AGENT_SUBTITLE, AGENT_TITLE } from "./look";
import type { NavItem } from "./nav";
import { useToast } from "./toast";
import type { LabState } from "./types";
import { Kbd, LabMark } from "./ui";

const JOB_TITLE: Record<string, string> = { run: "Идёт проверка версии", rejudge: "Судья переоценивает", discover: "Судья читает логи", cards: "Собираются сценарии", sources: "Читается код агента" };

/** The running job, visible from every page: what it does, how far it is, and a way to stop it. */
function JobCard({ state }: { state: LabState }) {
  const { error } = useToast();
  const j = state.job;
  if (!j.running) return null;
  const { done = 0, total = 0, message } = j.progress;
  const share = total ? Math.round((100 * done) / total) : null;
  return (
    <div className="mx-3 mb-3 rounded-lg border border-lab-line bg-lab-card p-3" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-body font-medium text-lab-ink">
        <Loader2 className="size-3.5 animate-spin text-lab-accent" />
        <span className="min-w-0 flex-1 truncate">{JOB_TITLE[j.kind ?? ""] ?? "Идёт работа"}</span>
        {share !== null && <span className="text-caption tabular-nums text-lab-mute">{done}/{total}</span>}
      </div>
      {message && <div className="mt-1 line-clamp-2 text-caption text-lab-mute">{message}</div>}
      {share !== null && (
        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-white/[0.07]">
          <div className="h-full rounded-full bg-lab-accent transition-[width] duration-500 ease-out" style={{ width: `${share}%` }} />
        </div>
      )}
      <button onClick={() => api("/api/job/stop", {}).catch(error)} className="lab-focus mt-2.5 inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 text-caption text-lab-mute transition-colors duration-100 hover:bg-lab-raised hover:text-lab-ink">
        <Square className="size-2.5 fill-current" />Остановить
      </button>
    </div>
  );
}

type Row = { key: string; title: string; icon: LucideIcon; to: string; active: boolean; badge?: string; hot?: boolean; busy?: boolean; setup?: { n: number; done?: boolean } };

function NavRow({ row, onGo }: { row: Row; onGo: (to: string) => void }) {
  return (
    <button
      onClick={() => onGo(row.to)} aria-current={row.active ? "page" : undefined}
      className={cn(
        "lab-focus-inset group flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-body transition-colors duration-100",
        row.active ? "bg-lab-active text-lab-ink" : "text-lab-mute hover:bg-lab-raised hover:text-lab-ink",
      )}
    >
      {row.busy ? <Loader2 className="size-4 flex-shrink-0 animate-spin text-lab-accent" />
        : row.setup ? (
          <span className={cn("flex size-4 flex-shrink-0 items-center justify-center rounded-full text-micro font-semibold tabular-nums",
            row.setup.done ? "bg-lab-ok/15 text-lab-ok" : row.active ? "bg-lab-ink text-lab-canvas" : "border border-lab-strong text-lab-mute")}>
            {row.setup.done ? <Check className="size-2.5" strokeWidth={3} /> : row.setup.n}
          </span>
        ) : <row.icon className={cn("size-4 flex-shrink-0", row.active ? "text-lab-ink" : "text-lab-mute group-hover:text-lab-text")} />}
      <span className="min-w-0 flex-1 truncate font-medium">{row.title}</span>
      {row.badge && <span className={cn("flex-shrink-0 text-caption tabular-nums", row.hot ? "font-semibold text-lab-bad" : "text-lab-warn")} title={row.hot ? "Нарушаются" : "Ждёт проверки"}>{row.badge}</span>}
    </button>
  );
}

function Group({ title, aside, rows, onGo }: { title?: string; aside?: string; rows: Row[]; onGo: (to: string) => void }) {
  return (
    <div className="mt-6 first:mt-0">
      {title && (
        <div className="mb-1 flex items-center justify-between px-2.5">
          <span className="text-caption font-medium text-lab-mute">{title}</span>
          {aside && <span className="text-caption tabular-nums text-lab-faint">{aside}</span>}
        </div>
      )}
      <div className="space-y-px">{rows.map(r => <NavRow key={r.key} row={r} onGo={onGo} />)}</div>
    </div>
  );
}

const WORKSHOP: { key: string; title: string; icon: LucideIcon; to: string }[] = [
  { key: "runs", title: "Все трейсы", icon: Activity, to: "/runs" },
  { key: "search", title: "Поиск", icon: Search, to: "/search" },
  { key: "saved", title: "Сохранённые", icon: Bookmark, to: "/saved" },
];

/**
 * The app's one navigation column, on every page: the product and the agent under test, the answer (the Lab's sections),
 * the preparation as numbered steps, the trace viewer, the job at work, and the way to the assistant and the settings.
 */
export function Sidebar({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  const { state, offline, nav, openPalette } = useLabContext();
  const workshop = useWorkshopConnected();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const onGo = (to: string) => { navigate(to); onNavigate?.(); };
  const labStep = pathname.startsWith("/lab") ? (pathname.split("/")[2] || "overview") : null;
  const row = (i: NavItem): Row => ({
    key: i.id, title: i.title, icon: i.icon, to: `/lab/${i.id}`, active: labStep === i.id, badge: i.badge, hot: i.hot, busy: i.busy,
    setup: i.group === "setup" ? { n: i.n ?? 0, done: i.done } : undefined,
  });
  const main = nav.filter(i => i.group === "main").map(row);
  const setup = nav.filter(i => i.group === "setup").map(row);
  const setupDone = setup.filter(r => r.setup?.done).length;
  const tools: Row[] = WORKSHOP.map(w => ({ ...w, active: pathname === w.to || pathname.startsWith(`${w.to}/`) }));

  return (
    <aside className={cn("flex w-[232px] flex-shrink-0 flex-col border-r border-lab-line bg-lab-panel", className)} aria-label="Навигация">
      <button onClick={() => onGo("/lab/overview")} className="lab-focus-inset flex h-14 flex-shrink-0 items-center gap-2.5 px-4 text-left">
        <LabMark size={20} className="text-lab-ink" />
        <span className="text-body font-semibold tracking-tight text-lab-ink">Agent Lab</span>
      </button>

      <div className="px-3">
        <div className="px-2 pb-3 pt-1">
          <div className="text-caption text-lab-mute">Проверяем</div>
          <div className="mt-0.5 truncate text-body font-medium text-lab-ink">{AGENT_TITLE}</div>
          <div className="truncate text-caption text-lab-mute">{AGENT_SUBTITLE}</div>
        </div>
        <button
          onClick={() => { openPalette(); onNavigate?.(); }}
          className="lab-focus flex h-8 w-full items-center gap-2 rounded-md border border-lab-edge bg-lab-canvas/60 px-2.5 text-left text-body text-lab-mute transition-colors duration-100 hover:border-lab-strong hover:text-lab-text"
        >
          <Search className="size-3.5" />Поиск и команды
          <Kbd className="ml-auto">⌘K</Kbd>
        </button>
      </div>

      <nav className="mt-5 min-h-0 flex-1 overflow-y-auto px-3 pb-3" aria-label="Разделы">
        <Group rows={main} onGo={onGo} />
        <Group title="Подготовка" aside={setup.length ? `${setupDone} из ${setup.length}` : undefined} rows={setup} onGo={onGo} />
        <Group title="Трейсы" rows={tools} onGo={onGo} />
      </nav>

      {state && <JobCard state={state} />}

      <div className="border-t border-lab-line px-3 py-2">
        <button
          onClick={() => { window.dispatchEvent(new Event("workshop:open-message-pane")); onNavigate?.(); }}
          className="lab-focus-inset flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-body text-lab-mute transition-colors duration-100 hover:bg-lab-raised hover:text-lab-ink"
        >
          <Sparkles className="size-4" />Спросить ассистента
        </button>
        <NavRow row={{ key: "settings", title: "Настройки", icon: Settings, to: "/settings", active: pathname === "/settings" }} onGo={onGo} />
        <div className="flex items-center gap-3 px-2.5 pb-1 pt-2 text-caption text-lab-faint">
          <span className="inline-flex items-center gap-1.5" title={offline ? "Сервис Agent Lab не отвечает" : "Сервис Agent Lab на связи"}>
            <span className={cn("size-1.5 rounded-full", offline ? "bg-lab-bad" : state ? "bg-lab-ok" : "bg-lab-faint")} />Lab
          </span>
          <span className="inline-flex items-center gap-1.5" title={workshop ? "Workshop на связи: трейсы пишутся" : "Workshop не отвечает: трейсы недоступны"}>
            <span className={cn("size-1.5 rounded-full", workshop ? "bg-lab-ok" : "bg-lab-bad")} />Workshop
          </span>
          {state?.model && <span className="ml-auto min-w-0 truncate font-mono text-micro" title={`Модель судьи и клиента: ${state.model}`}>{state.model}</span>}
        </div>
      </div>
    </aside>
  );
}
