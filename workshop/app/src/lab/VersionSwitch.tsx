import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { whenLong } from "./format";
import type { LabRun } from "./types";

/**
 * The version a page is about, and the one it is compared with. The version is the Lab's main object,
 * so it sits in every page header; the list shows each version's own result, so picking one is already informed.
 */
export function VersionSwitch({ versions, current, previous, onPick }: {
  versions: LabRun[]; current: LabRun | null; previous: LabRun | null; onPick: (id: string) => void;
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
      <button
        onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}
        className="lab-focus inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-body transition-colors duration-100 hover:bg-lab-raised"
      >
        <span className="text-lab-mute">Версия</span>
        <span className="font-semibold tabular-nums text-lab-ink">{current.version}</span>
        {previous && <span className="hidden text-lab-mute lg:inline">против <span className="tabular-nums">{previous.version}</span></span>}
        <ChevronDown className="size-3.5 text-lab-mute" />
      </button>
      {open && (
        <div ref={list} role="listbox" aria-label="Версии агента" className="absolute right-0 top-full z-40 mt-1.5 w-[320px] rounded-xl border border-lab-edge bg-lab-raised p-1 shadow-pop">
          <div className="px-2.5 pb-1.5 pt-2 text-caption text-lab-mute">Версии агента · сравнение всегда с предыдущей</div>
          {newest.map(r => {
            const on = r.id === current.id;
            return (
              <button
                key={r.id} role="option" aria-selected={on} aria-current={on} onClick={() => { onPick(r.id); setOpen(false); }}
                className={cn("lab-focus-inset flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-100 hover:bg-lab-active focus:bg-lab-active", on && "bg-lab-active/60")}
              >
                <span className="w-12 flex-shrink-0 pt-px text-body font-semibold tabular-nums text-lab-ink">{r.version}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-lab-text">{r.label || r.targetName}</span>
                  <span className="block text-caption text-lab-mute">{whenLong(r.startedAt)}</span>
                </span>
                <span className="flex-shrink-0 pt-px text-body tabular-nums text-lab-text">{r.metric?.accuracy ?? "—"}%</span>
                <Check className={cn("mt-0.5 size-3.5 flex-shrink-0", on ? "text-lab-ink" : "text-transparent")} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
