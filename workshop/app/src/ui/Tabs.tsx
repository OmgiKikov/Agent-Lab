import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The tabs of an object's detail, underlined like the Workshop's trace tabs; a tab may carry a count. */
export function Tabs<T extends string>({ value, tabs, onChange, className, end }: {
  value: T; tabs: { value: T; label: ReactNode; count?: number }[]; onChange: (v: T) => void; className?: string; end?: ReactNode;
}) {
  return (
    <div className={cn("flex items-center border-b border-white/[0.08]", className)}>
    <div role="tablist" className="flex min-w-0 flex-1 overflow-x-auto">
      {tabs.map(t => (
        <button
          key={t.value} type="button" role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}
          className={cn(
            "-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-small transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-lab-accent",
            value === t.value ? "border-lab-ink text-lab-ink" : "border-transparent text-lab-dim hover:text-lab-soft",
          )}
        >
          {t.label}{t.count !== undefined && t.count > 0 && <span className="ml-1.5 text-micro text-lab-dim">{t.count}</span>}
        </button>
      ))}
    </div>
    {end && <div className="ml-3 flex flex-shrink-0 items-center gap-2">{end}</div>}
    </div>
  );
}
