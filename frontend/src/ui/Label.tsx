import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/** The small label over a value or a block, in plain words: «В логах», «Что должен делать агент». */
export function Label({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("text-small font-medium text-fg-3", className)} {...rest} />;
}
