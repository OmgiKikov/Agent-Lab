import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Tile = { label: string; value: ReactNode; of?: ReactNode; onClick?: () => void; active?: boolean; title?: string };

/**
 * Raindrop's stat tiles: one bordered box cut into cells by hairlines, a small label over a bold number.
 * A cell with onClick opens what it counts.
 */
export function Tiles({ tiles, className }: { tiles: Tile[]; className?: string }) {
  return (
    <div role="group" className={cn("flex overflow-x-auto rounded border border-white/[0.08] bg-lab-raised", className)}>
      {tiles.map((t, i) => {
        const body = (
          <>
            <div className="whitespace-nowrap text-meta text-lab-mute">{t.label}</div>
            <div className="mt-0.5 flex items-baseline gap-1.5 whitespace-nowrap">
              <span className="text-stat font-semibold text-lab-ink">{t.value}</span>
              {t.of !== undefined && <span className="text-meta text-lab-dim">{t.of}</span>}
            </div>
          </>
        );
        const cell = cn("min-w-0 flex-1 px-3 py-2 text-left", i > 0 && "border-l border-white/[0.08]");
        return t.onClick ? (
          <button
            key={t.label} type="button" onClick={t.onClick} title={t.title} aria-pressed={t.active}
            className={cn(cell, "transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-lab-accent", t.active ? "bg-lab-active" : "hover:bg-lab-hover")}
          >
            {body}
          </button>
        ) : <div key={t.label} title={t.title} className={cell}>{body}</div>;
      })}
    </div>
  );
}
