import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Fact = { label: string; value: ReactNode; onClick?: () => void; title?: string };

/** Raindrop's run meta: a small capital chip, then the value; one wrapping line. A fact with onClick opens what it counts. */
export function Facts({ facts, className }: { facts: Fact[]; className?: string }) {
  return (
    <dl className={cn("flex flex-wrap items-center gap-x-4 gap-y-1.5", className)}>
      {facts.map(f => (
        <div key={f.label} className="flex min-w-0 items-center gap-1.5">
          <dt className="rounded bg-white/[0.08] px-1 font-mono text-micro uppercase tracking-wide text-lab-dim">{f.label}</dt>
          <dd className="truncate text-small text-lab-soft">
            {f.onClick ? (
              <button type="button" onClick={f.onClick} title={f.title} className="underline decoration-white/20 underline-offset-2 transition-colors hover:text-lab-ink hover:decoration-white/50">
                {f.value}
              </button>
            ) : <span title={f.title}>{f.value}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}
