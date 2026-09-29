import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Gavel, Search, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { when } from "./format";
import { buildSteps } from "./steps";
import type { LabState, Step } from "./types";

type Entry = { id: string; group: string; label: string; sub?: string; icon: LucideIcon; run: () => void };

/**
 * ⌘K: jump to any step, scenario or run without touching the mouse.
 * The same shortcut opens it everywhere in Agent Lab.
 */
export function CommandPalette({ open, onClose, state, go, onPickRun, onJudge }: {
  open: boolean; onClose: () => void; state: LabState | null; go: (step: Step, item?: string | null) => void;
  onPickRun: (id: string) => void; onJudge: () => void;
}) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => { if (open) { setQuery(""); setAt(0); } }, [open]);

  const entries = useMemo<Entry[]>(() => {
    if (!state) return [];
    const out: Entry[] = buildSteps(state).map(s => ({ id: `step-${s.id}`, group: "Шаги", label: s.title, sub: s.value, icon: s.icon, run: () => go(s.id) }));
    out.push({ id: "judge", group: "Действия", label: "Проверить судью", sub: "Пройти вердикты последнего прогона", icon: Gavel, run: onJudge });
    for (const c of state.cards?.cards ?? []) out.push({ id: `card-${c.id}`, group: "Сценарии", label: c.name, sub: c.topic, icon: buildSteps(state)[2].icon, run: () => go("cards", c.id) });
    for (const r of state.runs) out.push({
      id: `run-${r.id}`, group: "Прогоны", label: `${r.targetName} · ${r.version}`, sub: `${r.metric?.accuracy ?? "—"}% · ${when(r.startedAt)}`, icon: buildSteps(state)[4].icon,
      run: () => { onPickRun(r.id); go("accuracy"); },
    });
    return out;
  }, [state, go, onPickRun, onJudge]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => entries.filter(e => !q || `${e.label} ${e.sub ?? ""}`.toLowerCase().includes(q)).slice(0, 40), [entries, q]);
  useEffect(() => { setAt(0); }, [q]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.scrollIntoView({ block: "nearest" }); }, [at]);

  const choose = (e?: Entry) => { if (!e) return; onClose(); e.run(); };
  let lastGroup = "";
  return (
    <Dialog.Root open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-[3px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          onKeyDown={e => {
            if (e.key === "ArrowDown") { e.preventDefault(); setAt(a => Math.min(a + 1, shown.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setAt(a => Math.max(a - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); choose(shown[at]); }
          }}
          className="fixed left-1/2 top-[18%] z-50 w-[calc(100vw-32px)] max-w-[600px] -translate-x-1/2 overflow-hidden rounded-xl border border-white/10 bg-[#0b0b0b] shadow-[0_24px_80px_rgba(0,0,0,0.7)] outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <Dialog.Title className="sr-only">Быстрый переход</Dialog.Title>
          <div className="flex items-center gap-2.5 border-b border-white/[0.07] px-4">
            <Search className="size-4 flex-shrink-0 text-lab-dim" />
            <input
              autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Куда перейти: шаг, сценарий, прогон"
              className="h-12 w-full bg-transparent text-[14px] text-lab-ink outline-none placeholder:text-lab-faint"
            />
            <kbd className="rounded border border-white/15 px-1.5 font-mono text-[10px] leading-4 text-lab-dim">esc</kbd>
          </div>
          <div ref={list} className="sb max-h-[380px] overflow-auto p-1.5">
            {shown.map((e, i) => {
              const header = e.group !== lastGroup ? e.group : null;
              lastGroup = e.group;
              return (
                <div key={e.id}>
                  {header && <div className="px-2.5 pb-1 pt-2.5 font-mono text-[10px] uppercase tracking-[0.09em] text-lab-dim">{header}</div>}
                  <button
                    data-index={i} onClick={() => choose(e)} onMouseMove={() => setAt(i)}
                    className={cn("flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors", i === at ? "bg-white/[0.08]" : "hover:bg-white/[0.04]")}
                  >
                    <e.icon className="size-4 flex-shrink-0 text-lab-mute" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-lab-text">{e.label}</span>
                      {e.sub && <span className="block truncate text-[11px] text-lab-dim">{e.sub}</span>}
                    </span>
                    {i === at && <CornerDownLeft className="size-3.5 flex-shrink-0 text-lab-dim" />}
                  </button>
                </div>
              );
            })}
            {!shown.length && <div className="px-3 py-8 text-center text-[12px] text-lab-dim">Ничего не нашлось</div>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
