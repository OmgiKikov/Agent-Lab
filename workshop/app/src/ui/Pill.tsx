import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A rounded tag: a type («Промпт»), a topic with its colour dot, a place («Во всех разговорах»).
 * With a hue it takes a faint tint of it; without, it is neutral.
 */
export function Pill({ children, dot, hue, icon: Icon, mono, className, title }: {
  children: ReactNode; dot?: string; hue?: string; icon?: LucideIcon; mono?: boolean; className?: string; title?: string;
}) {
  return (
    <span title={title}
      className={cn("inline-flex h-[22px] max-w-full items-center gap-1.5 rounded-full border px-2 text-[11px] leading-none",
        !hue && "border-white/[0.1] bg-white/[0.04] text-lab-soft", mono && "font-mono", className)}
      style={hue ? { background: `${hue}12`, borderColor: `${hue}30`, color: `color-mix(in srgb, ${hue} 50%, #e1e8ec)` } : undefined}>
      {dot && <span className="size-1.5 flex-shrink-0 rounded-full" style={{ background: dot }} />}
      {Icon && <Icon className="size-3 flex-shrink-0 opacity-75" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

export type Chip<T> = { value: T; label: ReactNode; count?: number; icon?: LucideIcon; dot?: string; title?: string };

/** Filters over a grid, as rounded chips; the chosen one is lit, choosing it again clears it. */
export function Chips<T>({ value, options, onChange, className }: { value: T | null; options: Chip<T | null>[]; onChange: (v: T | null) => void; className?: string }) {
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {options.map((o, i) => {
        const on = value === o.value;
        return (
          <button key={i} type="button" title={o.title} onClick={() => onChange(on ? null : o.value)} aria-pressed={on}
            className={cn("inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-lab-accent",
              on ? "border-white/[0.3] bg-white/[0.1] text-lab-ink" : "border-white/[0.08] text-lab-mute hover:border-white/[0.16] hover:text-lab-text")}>
            {o.icon && <o.icon className="size-3" />}
            {o.dot && <span className="size-1.5 rounded-full" style={{ background: o.dot }} />}
            {o.label}
            {o.count !== undefined && <span className="text-lab-dim">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
