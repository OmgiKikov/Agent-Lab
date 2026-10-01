import { cn } from "@/lib/utils";

/** «18 из 49»: a count never travels without its denominator. A violation's count may be red; the denominator never is. */
export function Count({ n, of, bad, className }: { n: number; of: number; bad?: boolean; className?: string }) {
  return (
    <span className={cn("whitespace-nowrap", className)}>
      <span className={cn("font-semibold tabular-nums", bad && n > 0 && "text-bad")}>{n}</span>
      <span className="text-fg-3"> из </span>
      <span className="tabular-nums">{of}</span>
    </span>
  );
}
