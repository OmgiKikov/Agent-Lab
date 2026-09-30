import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Label } from "./Label";

export type Fact = { label: string; value: ReactNode; onClick?: () => void; title?: string };

/** Raindrop's run facts: capital labels over values, in one row; a fact with onClick opens what it counts. */
export function Facts({ facts, className }: { facts: Fact[]; className?: string }) {
  return (
    <dl className={cn("flex flex-wrap gap-x-8 gap-y-3", className)}>
      {facts.map(f => (
        <div key={f.label} className="min-w-0">
          <dt><Label>{f.label}</Label></dt>
          <dd className="mt-1 text-body text-lab-ink">
            {f.onClick ? (
              <button type="button" onClick={f.onClick} title={f.title} className="text-left underline decoration-white/20 underline-offset-4 transition-colors hover:decoration-white/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-lab-accent">
                {f.value}
              </button>
            ) : <span title={f.title}>{f.value}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
