import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Bookmark, CornerDownLeft, Play, Search, Settings, Sparkles, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { when } from "./format";
import { NAV_ICON, STEP_HINT, buildNav } from "./nav";
import type { LabState, Step } from "./types";
import { Kbd } from "./ui";

type Entry = { id: string; group: string; label: string; sub?: string; icon: LucideIcon; run: () => void };

/**
 * ⌘K: go anywhere and do the main things without the mouse — sections, actions, criteria, scenarios, versions, the trace viewer.
 * The same shortcut opens it on every page of the app.
 */
export function CommandPalette({ open, onClose, state, go, navigate, onPickRun, onJudge, onNewRun, criteria }: {
  open: boolean; onClose: () => void; state: LabState | null; go: (step: Step, item?: string | null) => void; navigate: (to: string) => void;
  onPickRun: (id: string) => void; onJudge: () => void; onNewRun?: () => void; criteria: { key: string; title: string; failed: number }[];
}) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => { if (open) { setQuery(""); setAt(0); } }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    if (onNewRun) out.push({ id: "new-run", group: "Действия", label: "Проверить версию", sub: "Симулятор сыграет сценарии, судья оценит диалоги", icon: Play, run: onNewRun });
    if (state?.runs.length) out.push({ id: "judge", group: "Действия", label: "Сверить судью", sub: "Пройти вердикты последней проверки: верно или нет", icon: NAV_ICON.judge, run: onJudge });
    out.push({ id: "ask", group: "Действия", label: "Спросить ассистента", sub: "Claude Code или Codex рядом с трейсами", icon: Sparkles, run: () => window.dispatchEvent(new Event("workshop:open-message-pane")) });
    if (state) out.push(...buildNav(state).map(n => ({ id: `nav-${n.id}`, group: "Разделы", label: n.title, sub: STEP_HINT[n.id], icon: n.icon, run: () => go(n.id) })));
    out.push(
      { id: "ws-runs", group: "Разделы", label: "Все трейсы", sub: "Workshop", icon: Activity, run: () => navigate("/runs") },
      { id: "ws-search", group: "Разделы", label: "Поиск по трейсам", sub: "Workshop", icon: Search, run: () => navigate("/search") },
      { id: "ws-saved", group: "Разделы", label: "Сохранённые трейсы", sub: "Workshop", icon: Bookmark, run: () => navigate("/saved") },
      { id: "ws-settings", group: "Разделы", label: "Настройки", sub: "Ключи и адреса агентов", icon: Settings, run: () => navigate("/settings") },
    );
    for (const c of criteria) out.push({ id: `criterion-${c.key}`, group: "Критерии", label: c.title, sub: c.failed ? `нарушен в ${c.failed} диалогах` : "выполняется", icon: NAV_ICON.criteria, run: () => go("criteria", c.key) });
    for (const c of state?.cards?.cards ?? []) out.push({ id: `card-${c.id}`, group: "Сценарии", label: c.name, sub: c.topic, icon: NAV_ICON.checks, run: () => go("checks", c.id) });
    for (const r of state?.runs ?? []) out.push({
      id: `run-${r.id}`, group: "Версии", label: `Версия ${r.version}`, sub: `${r.metric?.accuracy ?? "—"}% без нарушений · ${when(r.startedAt)}${r.label ? ` · ${r.label}` : ""}`, icon: NAV_ICON.overview,
      run: () => { onPickRun(r.id); go("overview"); },
    });
    return out;
  }, [state, go, navigate, onPickRun, onJudge, onNewRun, criteria]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => entries.filter(e => !q || `${e.label} ${e.sub ?? ""}`.toLowerCase().includes(q)).slice(0, 50), [entries, q]);
  useEffect(() => { setAt(0); }, [q]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.scrollIntoView({ block: "nearest" }); }, [at]);

  const choose = (e?: Entry) => { if (!e) return; onClose(); e.run(); };
  let lastGroup = "";
  return (
    <Dialog.Root open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70" />
        <Dialog.Content
          aria-describedby={undefined}
          onKeyDown={e => {
            if (e.key === "ArrowDown") { e.preventDefault(); setAt(a => Math.min(a + 1, shown.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setAt(a => Math.max(a - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); choose(shown[at]); }
          }}
          className="fixed left-1/2 top-[16%] z-50 w-[calc(100vw-32px)] max-w-[620px] -translate-x-1/2 overflow-hidden rounded-lg border border-lab-edge bg-lab-raised shadow-pop outline-none"
        >
          <Dialog.Title className="sr-only">Поиск и команды</Dialog.Title>
          <div className="flex items-center gap-2.5 border-b border-lab-line px-4">
            <Search className="size-4 flex-shrink-0 text-lab-mute" />
            <input
              autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Раздел, действие, критерий, сценарий или версия"
              className="h-12 w-full bg-transparent text-reading text-lab-ink outline-none placeholder:text-lab-faint"
            />
            <Kbd>Esc</Kbd>
          </div>
          <div ref={list} className="max-h-[400px] overflow-auto p-1.5">
            {shown.map((e, i) => {
              const header = e.group !== lastGroup ? e.group : null;
              lastGroup = e.group;
              return (
                <div key={e.id}>
                  {header && <div className="lab-label px-2.5 pb-1 pt-3 text-lab-mute">{header}</div>}
                  <button
                    data-index={i} onClick={() => choose(e)} onMouseMove={() => setAt(i)}
                    className={cn("flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left", i === at && "bg-white/[0.07]")}
                  >
                    <e.icon className={cn("size-4 flex-shrink-0", i === at ? "text-lab-ink" : "text-lab-mute")} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body text-lab-ink">{e.label}</span>
                      {e.sub && <span className="block truncate text-caption text-lab-mute">{e.sub}</span>}
                    </span>
                    {i === at && <CornerDownLeft className="size-3.5 flex-shrink-0 text-lab-mute" />}
                  </button>
                </div>
              );
            })}
            {!shown.length && <div className="px-3 py-10 text-center text-body text-lab-mute">Ничего не нашлось</div>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
