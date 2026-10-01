import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/** The mono capitals over a value or a block: «В ЛОГАХ», «КРИТЕРИЙ В КОДЕ АГЕНТА». */
export function Caps({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("font-mono text-label uppercase tracking-caps text-fg-3", className)} {...rest} />;
}
