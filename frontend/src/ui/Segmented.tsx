import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SegmentedOption<T extends string> = {
  value: T;
  label: ReactNode;
  count?: number;
  title?: string;
  disabled?: boolean;
};

/** A choice of a few over a list or a block: «Все 7 · Диалоги 6 · Симуляция 5». The count sits beside each word. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  size = "md",
  label,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (v: T) => void;
  className?: string;
  size?: "sm" | "md";
  label?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("inline-flex max-w-full flex-shrink-0 gap-0.5 overflow-x-auto rounded-lg bg-well p-0.5", className)}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors duration-150 ease-out",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60 disabled:pointer-events-none disabled:opacity-40",
              size === "sm" ? "h-6 px-2 text-meta" : "h-7 px-2.5 text-small",
              on ? "bg-raised text-fg ring-1 ring-line-strong" : "text-fg-3 hover:text-fg-2",
            )}
          >
            {o.label}
            {o.count !== undefined && (
              <span className={cn("text-meta tabular-nums", on ? "text-fg-3" : "text-fg-4")}>{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
