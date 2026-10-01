import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** A card of a grid: raised, lifts a pixel under the pointer; the open one wears an orange ring. */
export function Tile({ on, onClick, children, className }: { on?: boolean; onClick: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (on) ref.current?.scrollIntoView({ block: "nearest" }); }, [on]);
  return (
    <button ref={ref} type="button" onClick={onClick} aria-pressed={on}
      className={cn("group relative flex min-h-[150px] flex-col rounded-[10px] border bg-[rgb(35,35,35)] p-4 text-left transition-[border-color,transform,box-shadow] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-lab-accent",
        on ? "border-[rgba(232,145,45,0.55)] shadow-[0_0_0_3px_rgba(232,145,45,0.12)]" : "border-white/[0.08] hover:-translate-y-px hover:border-white/[0.18]", className)}>
      {children}
    </button>
  );
}

/** The grid the tiles sit in; it leaves room on the right while a floating panel is open. */
export function TileGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">{children}</div>;
}

export const DEEP = "shadow-[0_28px_70px_-18px_rgba(0,0,0,0.85),0_0_0_1px_rgba(255,255,255,0.09)]";

/**
 * A panel floating over the grid, not a sheet that hides it: the grid stays in view and clickable.
 * Esc closes it. Below 1280 px it covers the width.
 */
export function Floating({ head, onClose, children, wide }: { head: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector('[role="dialog"][data-state="open"]')) onClose(); };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onClose]);
  return (
    <aside className={cn("absolute inset-2 z-30 flex flex-col overflow-hidden rounded-[14px] bg-[rgb(29,29,29)] xl:inset-auto xl:bottom-3 xl:right-3 xl:top-3", wide ? "xl:w-[620px]" : "xl:w-[520px]", DEEP, "animate-in fade-in-0 slide-in-from-right-4")}>
      <div className="flex min-h-[46px] items-center gap-2 border-b border-white/[0.08] px-4 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">{head}</div>
        <button type="button" onClick={onClose} aria-label="Закрыть (Esc)" title="Закрыть (Esc)" className="rounded-md p-1 text-lab-dim transition-colors hover:bg-white/[0.08] hover:text-lab-text"><X className="size-4" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-5 pb-8 pt-4">{children}</div>
    </aside>
  );
}

/** The page under a floating panel: a scrolling column that makes room for the panel on wide screens. */
export function WithFloating({ open, children, panel, wide }: { open: boolean; children: ReactNode; panel: ReactNode; wide?: boolean }) {
  return (
    <div className="relative min-h-0 flex-1">
      <div className="h-full overflow-auto">
        <div className={cn("px-6 pb-16 pt-6 transition-[padding] duration-200", open && (wide ? "xl:pr-[648px]" : "xl:pr-[548px]"))}>{children}</div>
      </div>
      {panel}
    </div>
  );
}

/** Cards laid on each other: the ones behind peek out below and to the right, like a stack of sheets. */
export function Stack({ children, depth = 2, className }: { children: ReactNode; depth?: number; className?: string }) {
  return (
    <div className={cn("relative", className)}>
      {Array.from({ length: depth }, (_, i) => depth - i).map(d => (
        <div key={d} aria-hidden className="absolute inset-0 rounded-[12px] border border-white/[0.07] bg-[rgb(33,33,33)]"
          style={{ transform: `translate(${d * 10}px, ${d * 10}px)`, opacity: 1 - d * 0.28 }} />
      ))}
      <div className="relative">{children}</div>
    </div>
  );
}

/** A small caption over a section of a floating panel. */
export const Caption = ({ children, className }: { children: ReactNode; className?: string }) => <div className={cn("text-[11px] text-lab-dim", className)}>{children}</div>;

/** The title row of a page body: a title, a quiet line after it, and the page's actions on the right. */
export function PageTitle({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <h1 className="text-[20px] font-medium tracking-[-0.4px] text-lab-ink">{title}</h1>
      {sub && <span className="text-[12px] text-lab-dim">{sub}</span>}
      {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A quiet outlined button of the page title row. */
export function Soft({ onClick, disabled, title, children, className }: { onClick: () => void; disabled?: boolean; title?: string; children: ReactNode; className?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title}
      className={cn("inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.03] px-2.5 text-[12px] text-lab-soft transition-colors hover:border-white/[0.2] hover:text-lab-ink disabled:pointer-events-none disabled:opacity-40", className)}>
      {children}
    </button>
  );
}
