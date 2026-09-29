import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ExternalLink, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { count, pct } from "../format";
import { disputed } from "../logic";
import type { Item, LabRun, LabState } from "../types";
import { Badge, Button, PersonaTag } from "../ui";
import { Conversation } from "./RunView";

type Decision = "agree" | "disagree";
/** Below this many answers a percentage says nothing, so it is not shown. */
const MIN_CHECKED = 10;

/**
 * Checking the judge: a person goes through the verdicts one by one and says whether the judge is right.
 * Disputed verdicts (the second judge disagrees) come first, then violations, then passes; the unchecked before the checked.
 * The answers are the run's `review` (POST /api/review), so «судья прав в N%» is the service's own number.
 */
export function JudgeCheck({ run, state, onReview, onOpen }: {
  run: LabRun; state: LabState; onReview: (index: number, decision: Decision | null) => Promise<unknown>; onOpen: (item: Item) => void;
}) {
  const items = run.items ?? [];
  // The order is fixed when the check opens, so answering does not reshuffle the queue.
  const queue = useMemo(() => {
    const rank = (i: Item) => (disputed(i) ? 0 : i.status === "FAIL" ? 1 : 2) + (i.review ? 10 : 0);
    return items.map((item, index) => ({ item, index })).filter(x => x.item.status === "PASS" || x.item.status === "FAIL")
      .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index).map(x => x.index);
  }, [run.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [local, setLocal] = useState<Record<number, Decision | null>>({});
  const decisionOf = (index: number) => (index in local ? local[index] : items[index]?.review ?? null);
  const [at, setAt] = useState(() => Math.max(0, queue.findIndex(i => !items[i]?.review)));

  const reviewed = queue.filter(i => decisionOf(i));
  const agree = reviewed.filter(i => decisionOf(i) === "agree").length;
  const done = queue.length > 0 && reviewed.length === queue.length;
  const index = queue[Math.min(at, queue.length - 1)];
  const item = items[index];

  const decide = (decision: Decision) => {
    const next = decisionOf(index) === decision ? null : decision;
    setLocal(l => ({ ...l, [index]: next }));
    onReview(index, next);
    if (next) setAt(a => Math.min(a + 1, queue.length - 1));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable)) return;
      if (e.code === "Digit1") decide("agree");
      else if (e.code === "Digit2") decide("disagree");
      else if (e.code === "ArrowRight") setAt(a => Math.min(a + 1, queue.length - 1));
      else if (e.code === "ArrowLeft") setAt(a => Math.max(a - 1, 0));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!queue.length) return <div className="flex h-full items-center justify-center text-body text-lab-mute">В этой проверке нет оценённых диалогов</div>;
  const share = reviewed.length >= MIN_CHECKED ? pct(agree, reviewed.length) : null;
  const decision = decisionOf(index);
  const verdictWord = item.status === "PASS" ? "без нарушений" : "нарушение";

  return (
    <div className="flex h-full flex-col">
      <div className="flex-shrink-0 border-b border-lab-line px-6 py-4">
        <div className="mx-auto flex max-w-[800px] items-end justify-between gap-6">
          <div className="min-w-0">
            <div className="text-lead font-semibold text-lab-ink">Прав ли судья?</div>
            <div className="mt-0.5 text-body text-lab-mute">Прочитайте диалог и ответьте, верен ли вердикт. Спорные идут первыми, поэтому процент строже, чем на всех диалогах.</div>
          </div>
          <div className="flex-shrink-0 text-right">
            <div className="text-title font-semibold tabular-nums text-lab-ink">{share === null ? "—" : `${share}%`}</div>
            <div className="text-caption tabular-nums text-lab-mute">
              {share === null ? `ещё ${MIN_CHECKED - reviewed.length} до первого процента` : `судья прав · сверено ${reviewed.length} из ${queue.length}`}
            </div>
          </div>
        </div>
        <div className="mx-auto mt-4 flex max-w-[800px] gap-[2px]" role="list" aria-label="Очередь вердиктов">
          {queue.map((i, k) => {
            const d = decisionOf(i);
            return (
              <button key={i} role="listitem" onClick={() => setAt(k)} aria-label={`Вердикт ${k + 1}${d ? d === "agree" ? ": верно" : ": неверно" : ""}`}
                className={cn("h-1.5 flex-1 rounded-full transition-colors duration-100", d === "agree" ? "bg-lab-mute" : d === "disagree" ? "bg-lab-bad" : "bg-white/[0.08] hover:bg-white/20", k === at && "ring-1 ring-lab-ink ring-offset-1 ring-offset-lab-canvas")} />
            );
          })}
        </div>
      </div>

      {done && (
        <div className="flex-shrink-0 border-b border-lab-line bg-lab-panel px-6 py-3">
          <div className="mx-auto max-w-[800px] text-body text-lab-text">
            Сверены все {count(queue.length, "вердикт", "вердикта", "вердиктов")}: судья прав в {agree} из {queue.length}.
            {share !== null && share < 80 ? " Это мало: числу пока верить рано. Посмотрите на экране «Доверие», в каких критериях судья ошибается." : " Числу версии можно верить."}
          </div>
        </div>
      )}

      <div className="flex flex-shrink-0 items-center border-b border-lab-line px-6 py-2.5">
        <div className="mx-auto flex w-full max-w-[800px] flex-wrap items-center gap-2.5">
          <span className="text-caption tabular-nums text-lab-mute">{at + 1} из {queue.length}</span>
          <span className="min-w-0 truncate text-body font-medium text-lab-ink">{item.name}</span>
          <PersonaTag personas={state.personas} id={item.persona} />
          {disputed(item) && <Badge hue="warn">судьи расходятся</Badge>}
          <span className="ml-auto flex items-center gap-1">
            {item.runId && <a href={`/runs/${item.runId}`} className="lab-focus inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-caption font-medium text-lab-mute transition-colors duration-100 hover:bg-lab-raised hover:text-lab-ink"><ExternalLink className="size-3.5" />Трейс</a>}
            <Button size="sm" variant="ghost" onClick={() => onOpen(item)}>Открыть в диалогах</Button>
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <Conversation key={index} item={item} state={state} />
      </div>

      <div className="flex-shrink-0 border-t border-lab-line bg-lab-panel px-6 py-3">
        <div className="mx-auto flex max-w-[800px] flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" icon={ArrowLeft} disabled={at === 0} onClick={() => setAt(a => a - 1)}>Назад</Button>
          <span className="mx-auto flex flex-wrap items-center justify-center gap-2">
            <span className="text-body text-lab-mute">Вердикт «{verdictWord}» верный?</span>
            <Button variant={decision === "agree" ? "primary" : "secondary"} icon={Check} kbd="1" onClick={() => decide("agree")} aria-pressed={decision === "agree"}>Верно</Button>
            <Button variant={decision === "disagree" ? "danger" : "secondary"} icon={X} kbd="2" onClick={() => decide("disagree")} aria-pressed={decision === "disagree"}>Неверно</Button>
          </span>
          <Button size="sm" variant="ghost" onClick={() => setAt(a => Math.min(a + 1, queue.length - 1))} disabled={at >= queue.length - 1}>Пропустить<ArrowRight className="size-3.5" /></Button>
        </div>
      </div>
    </div>
  );
}
