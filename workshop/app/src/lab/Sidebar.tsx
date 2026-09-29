import { Activity, Check, Loader2, Search, Sparkles, Square } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { api } from "./api";
import { AGENT_SUBTITLE, AGENT_TITLE } from "./look";
import { NAV_GROUP_TITLE, type NavGroup, type NavItem } from "./nav";
import { useToast } from "./toast";
import type { LabState, Step } from "./types";
import { Kbd, LabMark } from "./ui";

type Go = (step: Step, item?: string | null) => void;

const JOB_TITLE: Record<string, string> = { run: "Идёт проверка версии", rejudge: "Судья переоценивает", discover: "Судья читает логи", cards: "Собираются сценарии", sources: "Читается код агента" };

/** The running job, visible from every screen: what it does, how far it is, and a way to stop it. */
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
        {share !== null && <span className="tabular-nums text-caption text-lab-mute">{done}/{total}</span>}
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

function NavRow({ item, active, go }: { item: NavItem; active: boolean; go: Go }) {
  const setup = item.group === "setup";
  return (
    <button
      onClick={() => go(item.id)} aria-current={active ? "page" : undefined}
      className={cn(
        "lab-focus-inset group flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-body transition-colors duration-100",
        active ? "bg-lab-active text-lab-ink" : "text-lab-mute hover:bg-lab-raised hover:text-lab-ink",
      )}
    >
      {item.busy ? <Loader2 className="size-4 flex-shrink-0 animate-spin text-lab-accent" />
        : setup ? (
          <span className={cn("flex size-4 flex-shrink-0 items-center justify-center rounded-full text-micro font-semibold tabular-nums",
            item.done ? "bg-lab-ok/15 text-lab-ok" : active ? "bg-lab-ink text-lab-canvas" : "border border-lab-strong text-lab-mute")}>
            {item.done ? <Check className="size-2.5" strokeWidth={3} /> : item.n}
          </span>
        ) : <item.icon className={cn("size-4 flex-shrink-0", active ? "text-lab-ink" : "text-lab-mute group-hover:text-lab-text")} />}
      <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
      {item.badge && (
        <span className={cn("flex-shrink-0 tabular-nums text-caption", item.hot ? "font-semibold text-lab-bad" : "text-lab-warn")} title={item.hot ? "Нарушаются" : "Ждёт проверки"}>{item.badge}</span>
      )}
    </button>
  );
}

/** The one navigation column: the product, the agent under test, the answer, the preparation, and the job at work. */
export function Sidebar({ state, offline, step, go, nav, onPalette, className }: {
  state: LabState | null; offline: boolean; step: Step; go: Go; nav: NavItem[]; onPalette: () => void; className?: string;
}) {
  const groups = (["main", "setup"] as NavGroup[]).map(g => ({ id: g, items: nav.filter(i => i.group === g) }));
  const setupDone = nav.filter(i => i.group === "setup" && i.done).length;
  return (
    <aside className={cn("flex w-[232px] flex-shrink-0 flex-col border-r border-lab-line bg-lab-panel", className)} aria-label="Agent Lab">
      <div className="flex h-14 items-center gap-2.5 px-4">
        <LabMark size={20} className="text-lab-ink" />
        <span className="text-body font-semibold tracking-tight text-lab-ink">Agent Lab</span>
        <span className={cn("ml-auto size-1.5 rounded-full", offline ? "bg-lab-bad" : "bg-lab-ok")} title={offline ? "Сервис Agent Lab не отвечает" : "Сервис Agent Lab на связи"} />
      </div>

      <div className="px-3">
        <div className="rounded-lg px-2 pb-3 pt-1">
          <div className="text-caption text-lab-mute">Проверяем</div>
          <div className="mt-0.5 truncate text-body font-medium text-lab-ink">{AGENT_TITLE}</div>
          <div className="truncate text-caption text-lab-mute">{AGENT_SUBTITLE}</div>
        </div>
        <button
          onClick={onPalette}
          className="lab-focus flex h-8 w-full items-center gap-2 rounded-md border border-lab-edge bg-lab-canvas/60 px-2.5 text-left text-body text-lab-mute transition-colors duration-100 hover:border-lab-strong hover:text-lab-text"
        >
          <Search className="size-3.5" />Поиск и команды
          <Kbd className="ml-auto">⌘K</Kbd>
        </button>
      </div>

      <nav className="mt-4 flex-1 overflow-y-auto px-3" aria-label="Разделы">
        {groups.map((g, k) => (
          <div key={g.id} className={cn(k > 0 && "mt-6")}>
            {NAV_GROUP_TITLE[g.id] && (
              <div className="mb-1 flex items-center justify-between px-2.5">
                <span className="text-caption font-medium text-lab-mute">{NAV_GROUP_TITLE[g.id]}</span>
                {g.id === "setup" && <span className="tabular-nums text-caption text-lab-faint">{setupDone} из {g.items.length}</span>}
              </div>
            )}
            <div className="space-y-px">{g.items.map(i => <NavRow key={i.id} item={i} active={i.id === step} go={go} />)}</div>
          </div>
        ))}
      </nav>

      {state && <JobCard state={state} />}

      <div className="border-t border-lab-line px-3 py-2">
        <button
          onClick={() => window.dispatchEvent(new Event("workshop:open-message-pane"))}
          className="lab-focus-inset flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-body text-lab-mute transition-colors duration-100 hover:bg-lab-raised hover:text-lab-ink"
        >
          <Sparkles className="size-4" />Спросить ассистента
        </button>
        <Link
          to="/runs"
          className="lab-focus-inset flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-body text-lab-mute transition-colors duration-100 hover:bg-lab-raised hover:text-lab-ink"
        >
          <Activity className="size-4" />Трейсы Workshop
        </Link>
        {state?.model && <div className="truncate px-2.5 pb-1 pt-2 font-mono text-micro text-lab-faint" title={`Модель судьи и клиента: ${state.model}`}>{state.model}</div>}
      </div>
    </aside>
  );
}

