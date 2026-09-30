import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { DropPixelGrid } from "../components/DropPixelGrid";

/** The shape of content that is still loading. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-white/[0.05]", className)} />;
}

/** An empty place with its reason and the next step. Raindrop's pixel drop appears only in empty places. */
export function EmptyState({ title, children, action, drop, className }: { title: string; children?: ReactNode; action?: ReactNode; drop?: boolean; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center px-8 py-16 text-center", className)}>
      {drop && <div className="mb-5"><DropPixelGrid px={2} gap={1.5} fillRgb="142,157,166" /></div>}
      <div className="text-body font-medium text-lab-ink">{title}</div>
      {children && <div className="mt-1.5 max-w-[440px] text-small text-lab-dim">{children}</div>}
      {action && <div className="mt-5 flex items-center gap-2">{action}</div>}
    </div>
  );
}

/** The service is not answering: the one command that brings everything up. */
export function ServiceDown() {
  return (
    <EmptyState drop title="Сервис не отвечает" className="h-full justify-center">
      Запустите <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-meta text-lab-text">sh bin/start.sh</code> — он поднимет всё, что нужно.
    </EmptyState>
  );
}
