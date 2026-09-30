import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export type MenuItem = { key: string; label: ReactNode; sub?: ReactNode; on?: boolean; run: () => void };

/** A small dropdown: a trigger and a list of choices; closes on a click outside and on Esc. */
export function Menu({ trigger, items, align = "left" }: { trigger: ReactNode; items: MenuItem[]; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div ref={ref} className="relative inline-flex">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)} className="inline-flex items-center rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-lab-accent">
        {trigger}
      </button>
      {open && (
        <div role="menu" className={cn("absolute top-full z-40 mt-1 max-h-[320px] min-w-[280px] overflow-auto rounded-lg border border-white/10 bg-lab-hover p-1 shadow-2xl", align === "right" ? "right-0" : "left-0")}>
          {items.map(i => (
            <button
              key={i.key} type="button" role="menuitemradio" aria-checked={!!i.on} onClick={() => { setOpen(false); i.run(); }}
              className="flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.08]"
            >
              <Check className={cn("mt-0.5 size-3.5 flex-shrink-0 text-lab-ink", !i.on && "invisible")} />
              <span className="min-w-0">
                <span className="block text-small text-lab-text">{i.label}</span>
                {i.sub && <span className="block text-meta text-lab-dim">{i.sub}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
