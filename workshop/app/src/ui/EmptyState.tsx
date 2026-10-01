import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { DropPixelGrid } from "../components/DropPixelGrid";

/** The shape of content that is still loading. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-control bg-raised/70", className)} />;
}

/** An empty place with its reason and the next step. Raindrop's pixel drop appears only in empty places. */
export function EmptyState({ title, children, action, drop, className }: { title: string; children?: ReactNode; action?: ReactNode; drop?: boolean; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center px-8 py-16 text-center", className)}>
      {drop && <div className="mb-5"><DropPixelGrid px={2} gap={1.5} fillRgb="141,148,158" /></div>}
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
      Запустите <code className="rounded bg-well px-1.5 py-0.5 font-mono text-meta text-fg-2">sh bin/start.sh</code>, он поднимет всё, что нужно.
    </EmptyState>
  );
}
