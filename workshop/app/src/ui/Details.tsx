import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Detail = { label: string; value: ReactNode; onClick?: () => void; title?: string };

/** Raindrop's «Details»: a bold heading, then label and value pairs, labels muted. */
export function Details({ title = "Детали", rows, className }: { title?: string; rows: Detail[]; className?: string }) {
  return (
    <section className={cn("mt-6", className)}>
      <h2 className="text-heading font-semibold text-lab-ink">{title}</h2>
      <dl className="mt-2.5 space-y-1.5">
        {rows.map(r => (
          <div key={r.label} className="grid grid-cols-[104px_minmax(0,1fr)] items-baseline gap-x-3 text-small">
            <dt className="text-meta text-lab-mute">{r.label}</dt>
            <dd className="min-w-0 break-words text-lab-soft">
              {r.onClick ? <button type="button" onClick={r.onClick} title={r.title} className="text-left underline decoration-white/20 underline-offset-2 transition-colors hover:text-lab-ink hover:decoration-white/50">{r.value}</button> : <span title={r.title}>{r.value}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** A small bordered word, as Raindrop's tags. */
export function Tag({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return <span title={title} className={cn("inline-flex max-w-full items-center truncate rounded border border-white/[0.1] bg-lab-raised px-1.5 text-meta text-lab-mute", className)}>{children}</span>;
}
