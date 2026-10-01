import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A key to press, next to the action it triggers. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded border border-line-strong px-1 font-mono text-label text-fg-3",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
