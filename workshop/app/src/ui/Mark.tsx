import { cn } from "@/lib/utils";

/** A criterion's number in Raindrop's orange ring: the same number on the criterion, in the prompt and in the evidence. */
export function Mark({ n, on, size = 20, title }: { n: number; on?: boolean; size?: number; title?: string }) {
  return (
    <span title={title} style={{ width: size, height: size }}
      className={cn("inline-flex flex-shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold tabular-nums",
        on ? "border-[rgba(232,145,45,0.9)] bg-[rgb(92,62,30)] text-[rgb(255,222,184)]" : "border-[rgba(232,145,45,0.44)] bg-[rgb(60,44,32)] text-[rgb(255,212,163)]")}>
      {n}
    </span>
  );
}

/** Numbers overlapping like a stack of avatars: which criteria come from this part. */
export function MarkStack({ ns, max = 4, empty = "без критериев", ring = "ring-[rgb(35,35,35)]" }: { ns: number[]; max?: number; empty?: string; ring?: string }) {
  if (!ns.length) return <span className="text-[11px] text-lab-faint">{empty}</span>;
  return (
    <span className="flex items-center">
      {ns.slice(0, max).map((n, i) => <span key={n} className={cn("rounded-full ring-2", ring, i > 0 && "-ml-1.5")}><Mark n={n} /></span>)}
      {ns.length > max && <span className="ml-1 text-[11px] text-[rgb(255,196,130)]">+{ns.length - max}</span>}
    </span>
  );
}

/** The words a criterion stands on, highlighted as Raindrop marks evidence. */
export const MARK_TEXT = "rounded-[2px] bg-[rgba(232,145,45,0.2)] px-0.5 text-lab-text";
