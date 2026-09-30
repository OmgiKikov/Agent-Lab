import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const TONE = {
  bad: "border-lab-bad/30 bg-lab-bad/10 text-lab-bad",
  ok: "border-lab-ok/30 bg-lab-ok/10 text-lab-ok",
  warn: "border-lab-warn/30 bg-lab-warn/10 text-lab-warn",
  live: "border-lab-accent/30 bg-lab-accent/10 text-lab-accent",
  mute: "border-white/[0.15] bg-white/[0.04] text-lab-mute",
} as const;

/** Raindrop's status chip over the title: a tinted word with a hairline of its own colour. */
export function Chip({ tone = "mute", children, className }: { tone?: keyof typeof TONE; children: ReactNode; className?: string }) {
  return <span className={cn("inline-flex h-[22px] items-center rounded-[3px] border px-2 text-meta font-medium", TONE[tone], className)}>{children}</span>;
}
