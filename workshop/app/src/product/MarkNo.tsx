import { cn } from "@/lib/utils";

/** The number that ties the judge's quote in the agent's words to the judge's note under the conversation. */
export function MarkNo({ n, on, className }: { n: number; on?: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn("inline-flex h-4 min-w-4 flex-shrink-0 items-center justify-center rounded-full bg-mark-strong px-1 font-sans text-label font-semibold leading-none text-white transition-shadow", on && "ring-2 ring-mark-strong/30", className)}>
      {n}
    </span>
  );
}
