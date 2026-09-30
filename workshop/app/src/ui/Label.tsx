import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/** Raindrop's capital micro-label: what the value next to it is. */
export function Label({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("font-mono text-label uppercase tracking-[0.08em] text-lab-dim", className)} {...rest} />;
}
