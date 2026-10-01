import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const TONE = {
  neutral: "border-line-strong text-fg-2",
  bad: "border-bad/35 text-bad",
  ok: "border-ok/35 text-ok",
  warn: "border-warn/35 text-warn",
  run: "border-run/35 text-run",
};

/** A small outlined word on a row: «один случай», «только в симуляции», «судьи расходятся в 2». */
export function Tag({
  children,
  tone = "neutral",
  className,
  title,
}: {
  children: ReactNode;
  tone?: keyof typeof TONE;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 max-w-full items-center whitespace-nowrap rounded border px-1.5 text-meta",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
