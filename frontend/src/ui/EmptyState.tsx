import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Mark } from "../app/Mark";

/** The shape of content that is still loading. */
/** A placeholder in the shape of what loads. It shows only after 200 ms, so a fast answer never flashes it. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div className="delay-200 duration-150 animate-in fade-in-0 fill-mode-both motion-reduce:animate-none">
      <div className={cn("animate-pulse rounded-control bg-raised/70", className)} />
    </div>
  );
}

/** An empty place with its reason and the next step; the quiet mark of the product over it. */
export function EmptyState({
  title,
  children,
  action,
  drop,
  className,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  drop?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center px-8 py-16 text-center", className)}>
      {drop && <Mark quiet className="mb-5 size-12 rounded-2xl" />}
      <div className="text-body font-semibold text-fg">{title}</div>
      {children && <div className="mt-1.5 max-w-md text-small text-fg-3">{children}</div>}
      {action && <div className="mt-5 flex items-center gap-2">{action}</div>}
    </div>
  );
}

/** The service is not answering: the one command that brings everything up. */
export function ServiceDown() {
  return (
    <EmptyState drop title="Сервис не отвечает" className="h-full justify-center">
      Запустите его командой{" "}
      <code className="rounded bg-well px-1.5 py-0.5 font-mono text-small text-fg-2">sh bin/start.sh</code>.
    </EmptyState>
  );
}
