import { cn } from "@/lib/utils";

/** The number that ties the judge's quote in the agent's words to the judge's note under the conversation. */
export function MarkNo({ n, on, className }: { n: number; on?: boolean; className?: string }) {
  return (
    <span aria-hidden className={cn("inline-flex size-4 flex-shrink-0 items-center justify-center rounded-full bg-warn font-sans text-label font-semibold leading-none text-canvas transition-shadow", on && "ring-2 ring-warn/40", className)}>
      {n}
    </span>
  );
}
