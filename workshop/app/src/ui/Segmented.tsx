import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A choice of a few, like a filter over a list. */
export function Segmented<T extends string>({ value, options, onChange, className }: {
  value: T; options: { value: T; label: ReactNode; count?: number }[]; onChange: (v: T) => void; className?: string;
}) {
  return (
    <div role="radiogroup" className={cn("inline-flex max-w-full flex-shrink-0 gap-0.5 overflow-x-auto rounded-md border border-white/[0.08] p-0.5", className)}>
      {options.map(o => (
        <button
          key={o.value} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded px-2.5 text-meta transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-lab-accent",
            o.value === value ? "bg-lab-active text-lab-ink" : "text-lab-mute hover:text-lab-text",
          )}
        >
          {o.label}
          {o.count !== undefined && <span className="font-mono text-micro text-lab-dim">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}
