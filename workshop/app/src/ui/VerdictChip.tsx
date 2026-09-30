import { cn } from "@/lib/utils";

const WORD = { FAIL: "нарушено", PASS: "выполнено", UNKNOWN: "не проверено" } as const;
const TONE = { FAIL: "text-lab-bad", PASS: "text-lab-ok", UNKNOWN: "text-lab-warn" } as const;

/** «критерий · вердикт»: the criterion in plain text, the verdict alone in colour (red or green live only here). */
export function VerdictChip({ label, status, className }: { label: string; status: keyof typeof WORD; className?: string }) {
  return (
    <span title={`${label} · ${WORD[status]}`} className={cn("inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border border-white/[0.1] px-2 text-meta text-lab-mute", className)}>
      <span className="truncate">{label}</span>
      <span className="flex-shrink-0 text-lab-faint">·</span>
      <span className={cn("flex-shrink-0", TONE[status])}>{WORD[status]}</span>
    </span>
  );
}
