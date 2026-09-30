import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ListRow } from "./ListRow";

export type RowStat = { value: ReactNode; of?: string; label?: string; share?: number; title?: string };

/** The little bar under a number: how much of the whole it is. Red only where it counts violations. */
function Bar({ share, tone }: { share: number; tone: "bad" | "mute" }) {
  return (
    <div className="mt-1 h-[3px] w-full overflow-hidden rounded-full bg-white/[0.08]" aria-hidden>
      <div className={cn("h-full rounded-full", tone === "bad" ? "bg-lab-bad" : "bg-white/40")} style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%` }} />
    </div>
  );
}

/**
 * A row of a list as in Raindrop's Issues: a phrase, one line of explanation with its tags, and numbers on the right
 * with a small bar. Two lines, about 55 px.
 */
export function IssueRow({ selected, onClick, lead, title, sub, tags, stats, tone = "bad", className }: {
  selected: boolean; onClick: () => void; lead?: ReactNode; title: ReactNode; sub?: ReactNode; tags?: ReactNode[];
  stats?: RowStat[]; tone?: "bad" | "mute"; className?: string;
}) {
  return (
    <ListRow selected={selected} onClick={onClick} className={className}>
      <div className="flex items-center gap-3">
        {lead}
        <div className="min-w-0 flex-1">
          <div className="truncate text-body text-lab-ink">{title}</div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-meta text-lab-dim">
            {tags?.map((t, i) => <span key={i} className="flex-shrink-0 rounded border border-white/[0.1] px-1.5 text-lab-mute">{t}</span>)}
            {sub && <span className="truncate">{sub}</span>}
          </div>
        </div>
        {stats?.map((s, i) => (
          <div key={i} title={s.title} className="min-w-[52px] flex-shrink-0 text-right">
            <div className="flex items-baseline justify-end gap-1 whitespace-nowrap">
              <span className="text-title text-lab-ink">{s.value}</span>
              {s.of && <span className="text-meta text-lab-dim">{s.of}</span>}
            </div>
            {s.label && <div className="text-meta text-lab-dim">{s.label}</div>}
            {s.share !== undefined && <Bar share={s.share} tone={tone} />}
          </div>
        ))}
      </div>
    </ListRow>
  );
}
