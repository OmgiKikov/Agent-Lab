import type { ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { Label } from "./Label";

/** A verbatim quote from a source — the agent's own code — with the file it is in. */
export function Quote({ label, origin, onOrigin, children, hover, onHover }: {
  label: string; origin?: string; onOrigin?: () => void; children: ReactNode; hover?: boolean; onHover?: (on: boolean) => void;
}) {
  return (
    <figure>
      <div className="flex items-baseline justify-between gap-4">
        <Label>{label}</Label>
        {origin && (onOrigin ? (
          <button type="button" onClick={onOrigin} title="Открыть источник" className="inline-flex min-w-0 items-center gap-1 font-mono text-meta text-lab-dim transition-colors hover:text-lab-text">
            <span className="truncate">{origin}</span><ArrowUpRight className="size-3.5 flex-shrink-0" />
          </button>
        ) : <span className="truncate font-mono text-meta text-lab-dim">{origin}</span>)}
      </div>
      <blockquote
        onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)}
        className={cn("mt-2 border-l-2 pl-4 text-read text-lab-ink transition-colors", hover ? "border-lab-mark" : "border-white/25")}
      >
        «{children}»
      </blockquote>
    </figure>
  );
}
