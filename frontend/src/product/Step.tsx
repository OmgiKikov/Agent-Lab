import { cn } from "@/lib/utils";

/**
 * The number of a stage in the order of the work: 1 the logs, 2 the simulation. The same mark in the navigation, on the
 * overview and over each stage's pages, so the two are never mixed up.
 */
export function Step({
  n,
  on = true,
  size = "md",
  className,
}: {
  n: 1 | 2;
  on?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex flex-shrink-0 items-center justify-center rounded-full font-semibold tabular-nums leading-none transition-colors",
        size === "sm" ? "size-[18px] text-[11px]" : size === "md" ? "size-6 text-small" : "size-7 text-small",
        on ? "bg-fg text-white" : "border border-fg-3/70 text-fg-3",
        className,
      )}
    >
      {n}
    </span>
  );
}
