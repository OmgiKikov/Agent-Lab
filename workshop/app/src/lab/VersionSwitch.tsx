import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { when } from "./format";
import type { LabRun } from "./types";

/**
 * The checked version a page is about. It sits in every result page's header; the list shows each check's own number
 * (the service's `metric.accuracy`), so picking one is already informed.
 */
export function VersionSwitch({ versions, current, onPick, asTitle }: {
  versions: LabRun[]; current: LabRun | null; onPick: (id: string) => void;
  /** The version page: the switch is the page's title. */
  asTitle?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); return; }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const items = [...(list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      e.preventDefault();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.setTimeout(() => list.current?.querySelector<HTMLButtonElement>("[aria-current=true]")?.focus(), 0);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  if (!current) return null;
  const newest = [...versions].reverse();
  return (
    <div ref={box} className="relative">
      {asTitle ? (
        <button
          onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}
          className="lab-focus -ml-1.5 inline-flex h-8 items-center gap-1.5 rounded-md px-1.5 text-body transition-colors duration-100 hover:bg-white/[0.05]"
        >
          <span className="font-semibold text-lab-ink">Версия <span className="tabular-nums">{current.version}</span></span>
          <ChevronDown className="size-3.5 text-lab-mute" />
        </button>
      ) : (
        <button
          onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}
          className="lab-focus inline-flex h-8 items-center gap-2 rounded-md border border-lab-line px-2.5 text-body transition-colors duration-100 hover:border-lab-edge hover:bg-white/[0.04]"
        >
          <span className="lab-label text-lab-mute">Версия</span>
          <span className="font-medium tabular-nums text-lab-ink">{current.version}</span>
          <ChevronDown className="size-3.5 text-lab-mute" />
        </button>
      )}
      {open && (
        <div ref={list} role="listbox" aria-label="Версии агента" className={cn("absolute top-full z-40 mt-1.5 w-[340px] rounded-lg border border-lab-edge bg-lab-raised p-1 shadow-pop", asTitle ? "left-0" : "right-0")}>
          <div className="lab-label px-2.5 pb-1.5 pt-2 text-lab-mute">Проверки версий · без нарушений</div>
          {newest.map(r => {
            const on = r.id === current.id;
            return (
              <button
                key={r.id} role="option" aria-selected={on} aria-current={on} onClick={() => { onPick(r.id); setOpen(false); }}
                className={cn("lab-focus-inset flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors duration-100 hover:bg-white/[0.06] focus:bg-white/[0.06]", on && "bg-white/[0.04]")}
              >
                <span className="w-10 flex-shrink-0 text-body font-medium tabular-nums text-lab-ink">{r.version}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-lab-text">{r.label || r.targetName}</span>
                  <span className="block font-mono text-micro text-lab-mute">{when(r.startedAt)}</span>
                </span>
                <span className="flex-shrink-0 text-body tabular-nums text-lab-soft">{r.metric?.accuracy ?? "—"}%</span>
                <Check className={cn("size-3.5 flex-shrink-0", on ? "text-lab-ink" : "text-transparent")} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
