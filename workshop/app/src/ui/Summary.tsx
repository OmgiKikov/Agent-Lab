import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Stat = { label: string; value: ReactNode; of?: ReactNode; onClick?: () => void; active?: boolean; title?: string };

/** The block's summary: a few big numbers over the list, each a filter of it (Raindrop's issue header, Latitude's counters). */
export function Summary({ stats, className }: { stats: Stat[]; className?: string }) {
  return (
    <div role="group" className={cn("flex flex-shrink-0 overflow-x-auto border-b border-white/[0.06]", className)}>
      {stats.map(s => {
        const body = (
          <>
            <div className="text-meta text-lab-dim">{s.label}</div>
            <div className="mt-0.5 flex items-baseline gap-1.5 whitespace-nowrap">
              <span className="text-title font-medium text-lab-ink">{s.value}</span>
              {s.of !== undefined && <span className="text-meta text-lab-dim">{s.of}</span>}
            </div>
          </>
        );
        const cell = "min-w-[132px] border-r border-white/[0.06] px-4 py-2.5 text-left";
        return s.onClick ? (
          <button
            key={s.label} type="button" onClick={s.onClick} title={s.title} aria-pressed={s.active}
            className={cn(cell, "transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-lab-accent", s.active ? "bg-lab-active" : "hover:bg-lab-hover")}
          >
            <div>{body}</div>
          </button>
        ) : <div key={s.label} title={s.title} className={cell}>{body}</div>;
      })}
    </div>
  );
}
