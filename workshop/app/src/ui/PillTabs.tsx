import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Raindrop's tabs: quiet words, the chosen one on a soft pill. `small` is the row under a card. */
export function PillTabs<T extends string>({ value, tabs, onChange, small, className, label }: {
  value: T; tabs: { value: T; label: ReactNode; count?: number; title?: string }[]; onChange: (v: T) => void; small?: boolean; className?: string; label?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={cn("flex min-w-0 items-center gap-0.5 overflow-x-auto", className)}>
      {tabs.map(t => (
        <button
          key={t.value} type="button" role="tab" aria-selected={value === t.value} title={t.title} onClick={() => onChange(t.value)}
          className={cn(
            "flex-shrink-0 whitespace-nowrap rounded-[5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-lab-accent",
            small ? "h-6 px-2 text-meta" : "h-[26px] px-2.5 text-small",
            value === t.value ? "bg-white/[0.13] text-lab-ink" : "text-lab-mute hover:text-lab-text",
          )}
        >
          {t.label}{t.count !== undefined && t.count > 0 && <span className="ml-1.5 text-meta font-normal text-lab-dim">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
