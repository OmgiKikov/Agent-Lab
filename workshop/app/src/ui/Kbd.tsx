import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A key to press, next to the action it triggers. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex h-4 min-w-4 items-center justify-center rounded border border-white/20 px-1 font-mono text-micro text-lab-dim", className)}>
      {children}
    </kbd>
  );
}
