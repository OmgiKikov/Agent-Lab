import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, ArrowUpRight, ChevronLeft, ChevronRight, User } from "lucide-react";
import type { Criterion } from "../../lab/criteria";
import { dialogOf } from "../../lab/dialogs";
import { plural } from "../../lab/format";
import { reliabilityWord } from "../../lab/problemReport";
import { useReview, type Decision, type Example } from "../../lab/problems";
import { humansOf, secondOf } from "../../lab/problemStats";
import { LINKS } from "../../shell/links";
import { useKeys } from "../../shell/keys";
import { useLabState } from "../../shell/LabProvider";
import { cn } from "@/lib/utils";
import { Mark } from "../../ui/Mark";
import { Caption, Floating } from "../../ui/Tile";
import { Scope } from "../agent/Criteria";
import { ConversationBox, exampleWhere, JudgeNote, useExample } from "./Example";
import { orderExamples } from "./EvidenceBar";

/** How one side's conversations divide on a criterion: violated, fulfilled, unclear. One thin bar, every part counted. */
export function SplitBar({ failed, passed, unknown, className }: { failed: number; passed: number; unknown: number; className?: string }) {
  const total = failed + passed + unknown;
  const part = (n: number) => `${total ? (100 * n) / total : 0}%`;
  return (
    <div className={cn("flex h-1.5 overflow-hidden rounded-full bg-white/[0.06]", className)} role="img" aria-label={`нарушено ${failed}, выполнено ${passed}, не ясно ${unknown}`}>
      <span className="bg-lab-bad" style={{ width: part(failed) }} />
      <span className="bg-lab-ok/45" style={{ width: part(passed) }} />
      <span className="bg-white/[0.22]" style={{ width: part(unknown) }} />
    </div>
  );
}

/**
 * The evidence of one criterion on one side (logs or a run), floating over the grid: what it is, how the
 * conversations divide, then one violation at a time — the customer, the conversation with the agent's words
 * marked, the judge, the second judge, and «верно / неверно».
 */
export function EvidencePanel({ c, source, at, onAt, onClose }: { c: Criterion; source: "log" | "sim"; at: number; onAt: (n: number) => void; onClose: () => void }) {
  const navigate = useNavigate();
  const { state } = useLabState();
  const review = useReview();
  const [hover, setHover] = useState(false);
  const side = c.r[source];
  const list = orderExamples(side.examples.filter(e => e.status === "FAIL"), "rec");
  const i = Math.max(0, Math.min(list.length - 1, at));
  const example: Example | undefined = list[i];
  const view = useExample(example);
  const decide = (d: Decision) => { if (example) review.mutate({ example, decision: example.review === d ? null : d }); };
  const go = (n: number) => onAt(Math.max(0, Math.min(list.length - 1, n)));
  useKeys({ ArrowLeft: () => go(i - 1), ArrowRight: () => go(i + 1), KeyV: () => decide("agree"), KeyN: () => decide("disagree"), KeyO: () => { if (example) navigate(dialogOf(example)); } });
  const total = side.failed + side.passed + side.unknown;
  const second = secondOf(side.examples);
  const humans = humansOf(side);

  return (
    <Floating wide onClose={onClose} head={<><Mark n={c.n} on /><span className="text-[11px] text-lab-dim">Критерий {c.n} · {source === "log" ? "в логах" : "в прогоне"}</span></>}>
      <div className="flex flex-wrap gap-1.5"><Scope c={c} max={4} /></div>
      <h2 className="mt-3 text-[20px] font-medium leading-[26px] tracking-[-0.4px] text-lab-ink">{c.name}</h2>
      <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-[19px] text-lab-mute" title={c.r.rule.text}>{c.r.rule.text}</p>

      <div className="mt-4 grid grid-cols-3 overflow-hidden rounded-[8px] border border-white/[0.08] bg-[rgb(35,35,35)]">
        {[
          { label: "Нарушен", value: side.failed, of: total, tone: "text-lab-bad" },
          { label: "Второй судья согласен", value: second.checked ? second.agree : "—", of: second.checked || undefined },
          { label: "Проверено людьми", value: humans.checked || "—", of: humans.checked ? humans.of : undefined },
        ].map((s, k) => (
          <div key={s.label} className={cn("px-3 py-2", k > 0 && "border-l border-white/[0.08]")}>
            <div className="text-[10px] text-lab-mute">{s.label}</div>
            <div className="text-[17px] font-semibold leading-[24px] text-lab-ink"><span className={s.tone}>{s.value}</span>{s.of !== undefined && <span className="ml-1 text-[11px] font-normal text-lab-dim">из {s.of}</span>}</div>
          </div>
        ))}
      </div>
      <SplitBar className="mt-3" failed={side.failed} passed={side.passed} unknown={side.unknown} />
      <div className="mt-1.5 flex flex-wrap gap-x-4 text-[11px] text-lab-dim">
        <span><span className="mr-1 inline-block size-1.5 rounded-full bg-lab-bad" />нарушен {side.failed}</span>
        <span><span className="mr-1 inline-block size-1.5 rounded-full bg-lab-ok/60" />выполнен {side.passed}</span>
        {side.unknown > 0 && <span><span className="mr-1 inline-block size-1.5 rounded-full bg-white/[0.35]" />не ясно {side.unknown}</span>}
      </div>

      <div className="mt-6 flex items-center gap-2">
        <Caption>{list.length ? "Нарушение" : "Нарушений нет"}</Caption>
        {list.length > 0 && (
          <div className="ml-auto flex items-center gap-1 text-[11px]">
            <span className="mr-1.5 tabular-nums text-lab-dim">{i + 1} / {list.length}</span>
            <button type="button" onClick={() => go(i - 1)} disabled={i <= 0} title="Назад (←)" className="inline-flex h-[26px] items-center gap-0.5 rounded-[5px] px-1.5 text-lab-mute hover:text-lab-ink disabled:opacity-35"><ChevronLeft className="size-3" />Назад</button>
            <button type="button" onClick={() => go(i + 1)} disabled={i >= list.length - 1} title="Дальше (→)" className="inline-flex h-[26px] items-center gap-0.5 rounded-[5px] border border-white/[0.15] bg-[rgb(40,40,40)] px-2 text-lab-text hover:text-lab-ink disabled:opacity-35">Дальше<ChevronRight className="size-3" /></button>
          </div>
        )}
      </div>
      {example ? (
        <div className="mt-2 overflow-hidden rounded-[12px] border border-white/[0.08] bg-[rgb(33,33,33)]">
          <div className="flex items-center gap-2 border-b border-white/[0.06] px-3.5 py-2 text-[11px] text-lab-mute">
            <User className="size-3.5 flex-shrink-0" />
            <span className="min-w-0 truncate">{exampleWhere(example, state?.personas ?? [])}</span>
            <span className="flex-shrink-0 text-lab-dim">· {reliabilityWord(example)}</span>
            <Link to={dialogOf(example)} title="Открыть диалог целиком (O)" className="ml-auto flex-shrink-0 text-lab-dim hover:text-lab-text"><ArrowUpRight className="size-3.5" /></Link>
          </div>
          <div className="px-3.5 pb-4 pt-3.5">
            <ConversationBox view={view} example={example} hover={hover} onHover={setHover} />
            <div className="mt-4 border-t border-white/[0.06] pt-3.5"><JudgeNote example={example} marked={view.marked} onDecide={decide} hover={hover} onHover={setHover} /></div>
          </div>
        </div>
      ) : (
        <p className="mt-2 rounded-[12px] border border-dashed border-white/[0.1] px-4 py-6 text-center text-[12px] text-lab-dim">
          {total ? `Во всех ${total} ${plural(total, "разговоре", "разговорах", "разговорах")} критерий выполнен или не применим.` : "Этот критерий ещё не встречался в оценённых разговорах."}
        </p>
      )}
      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-lab-dim">
        <Link to={`${LINKS.criteria}?c=${encodeURIComponent(c.r.id)}`} className="inline-flex items-center gap-1 hover:text-lab-text">Критерий целиком<ArrowRight className="size-3" /></Link>
        <span className="text-lab-faint">← → листают · V верно · N неверно · O весь диалог</span>
      </div>
    </Floating>
  );
}
