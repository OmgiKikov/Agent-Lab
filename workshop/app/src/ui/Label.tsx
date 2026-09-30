import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/** A small muted caption over a value, as Raindrop's Details labels: plain case, the muted grey. */
export function Label({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("text-meta text-lab-mute", className)} {...rest} />;
}
