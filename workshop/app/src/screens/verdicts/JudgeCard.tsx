import { useState } from "react";
import { Check, Minus, Scale, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { plural } from "../../lab/format";
import type { Decision } from "../../lab/problems";
import type { Rule } from "../../lab/types";
import { Mark } from "../../ui/Mark";

const ORDER: Record<string, number> = { FAIL: 0, PASS: 1, UNKNOWN: 2, NOT_APPLICABLE: 3 };

/** The status of one criterion as a filled circle: green tick, red cross, grey question. */
function StatusDot({ status }: { status: string }) {
  if (status === "PASS") return <span className="flex size-[22px] flex-shrink-0 items-center justify-center rounded-full bg-[rgb(116,185,142)]"><Check className="size-3.5 text-black/80" strokeWidth={3} /></span>;
  if (status === "FAIL") return <span className="flex size-[22px] flex-shrink-0 items-center justify-center rounded-full bg-[rgb(226,138,128)]"><X className="size-3.5 text-black/80" strokeWidth={3} /></span>;
  return <span className="flex size-[22px] flex-shrink-0 items-center justify-center rounded-full border border-white/[0.2] text-[11px] font-semibold text-lab-dim">?</span>;
}

export type JudgeRow = { rule: Rule; n?: number; name: string; second?: "agree" | "disagree" | null; review?: Decision | null };

/**
 * The judge's card of one conversation, as a checklist: «2 / 3 выполнено», then every criterion that applied —
 * a green tick or a red cross, its name, why; under a broken one the agent's words it stands on and the second judge.
 * Criteria that did not apply fold into one line.
 */
export function JudgeCard({ rows, model, active, onPick, onDecide }: {
  rows: JudgeRow[]; model?: string | null; active?: number | null; onPick?: (n: number) => void; onDecide?: (row: JudgeRow, d: Decision) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const sorted = [...rows].sort((a, b) => (ORDER[a.rule.status] ?? 9) - (ORDER[b.rule.status] ?? 9) || (a.n ?? 99) - (b.n ?? 99));
  const applied = sorted.filter(r => r.rule.status !== "NOT_APPLICABLE");
  const skipped = sorted.filter(r => r.rule.status === "NOT_APPLICABLE");
  const judged = applied.filter(r => r.rule.status === "PASS" || r.rule.status === "FAIL");
  const met = judged.filter(r => r.rule.status === "PASS").length;
  const broken = judged.length - met;

  return (
    <div className="overflow-hidden rounded-[14px] border border-white/[0.09] bg-[rgb(22,22,22)]">
      <div className="flex items-center gap-2.5 border-b border-white/[0.08] px-4 py-3">
        <Scale className="size-4 text-lab-dim" />
        <span className="text-[14px] text-lab-ink">Судья</span>
        {model && <span className="truncate font-mono text-[11px] text-lab-faint">{model}</span>}
        {judged.length > 0 && (
          <span className={cn("ml-auto rounded-full px-2.5 py-0.5 text-[12px] font-medium tabular-nums", broken ? "bg-lab-bad/[0.14] text-[rgb(236,170,162)]" : "bg-lab-ok/[0.16] text-lab-ok")}>
            {met} / {judged.length} выполнено
          </span>
        )}
      </div>
      <div className="space-y-4 px-4 py-4">
        {!applied.length && <p className="text-[12.5px] text-lab-dim">Ни один критерий в этом разговоре не применялся.</p>}
        {applied.map(r => {
          const on = r.n !== undefined && active === r.n;
          return (
            <div key={r.rule.ruleId} className={cn("flex gap-3 rounded-lg transition-colors", r.n && onPick && "cursor-pointer", on && "bg-[rgba(232,145,45,0.06)]")}
              onClick={r.n && onPick ? () => onPick(r.n!) : undefined}>
              <StatusDot status={r.rule.status} />
              <div className="min-w-0 flex-1">
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 text-[14px] leading-[21px] text-lab-ink">{r.name}</span>
                  {r.n !== undefined && <Mark n={r.n} on={on} />}
                </div>
                <p className="mt-0.5 text-[12.5px] leading-[19px] text-lab-mute">{r.rule.reason}</p>
                {r.rule.status === "FAIL" && (r.rule.agentQuote || r.second) && (
                  <div className="mt-2 space-y-1 border-l border-white/[0.12] pl-3">
                    {r.rule.agentQuote && (
                      <div className="flex gap-2 text-[12px] leading-[18px]">
                        <span className="mt-[6px] size-1.5 flex-shrink-0 rounded-full bg-[rgb(232,145,45)]" />
                        <span><span className="font-mono font-semibold text-lab-soft">Слова агента</span> <span className="text-lab-dim">«{r.rule.agentQuote}»</span></span>
                      </div>
                    )}
                    {r.second && (
                      <div className="flex gap-2 text-[12px] leading-[18px]">
                        <span className="mt-[6px] size-1.5 flex-shrink-0 rounded-full bg-[rgb(232,145,45)]" />
                        <span><span className="font-mono font-semibold text-lab-soft">Второй судья</span> <span className={r.second === "agree" ? "text-lab-dim" : "text-lab-warn"}>{r.second === "agree" ? "тоже видит нарушение" : "не видит нарушения"}</span></span>
                      </div>
                    )}
                  </div>
                )}
                {r.rule.status === "FAIL" && onDecide && (
                  <div className="mt-2 flex items-center gap-1.5 text-[11.5px]" onClick={e => e.stopPropagation()}>
                    <span className="text-lab-dim">Вердикт верный?</span>
                    {(["agree", "disagree"] as const).map(d => (
                      <button key={d} type="button" onClick={() => onDecide(r, d)} aria-pressed={r.review === d}
                        className={cn("rounded-full border px-2 py-0.5 transition-colors", r.review === d ? (d === "agree" ? "border-lab-ok/50 bg-lab-ok/[0.1] text-lab-ok" : "border-lab-bad/50 bg-lab-bad/[0.1] text-[rgb(236,170,162)]") : "border-white/[0.12] text-lab-mute hover:text-lab-text")}>
                        {d === "agree" ? "верно" : "неверно"}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {skipped.length > 0 && (
          <div className="border-t border-white/[0.06] pt-3">
            <button type="button" onClick={() => setShowAll(s => !s)} className="flex items-center gap-2 text-[12px] text-lab-dim hover:text-lab-text">
              <Minus className="size-3.5" />{skipped.length} {plural(skipped.length, "критерий не применялся", "критерия не применялись", "критериев не применялись")} в этом разговоре{showAll ? "" : " — показать"}
            </button>
            {showAll && <ul className="mt-2 space-y-1 pl-5 text-[12px] text-lab-faint">{skipped.map(r => <li key={r.rule.ruleId}>{r.n !== undefined && `${r.n}. `}{r.name}</li>)}</ul>}
          </div>
        )}
      </div>
    </div>
  );
}
