import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowRight, Check, SkipForward, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { plural } from "../../lab/format";
import { sourceLabel } from "../../lab/problemReport";
import { useProblems, useReview, type Decision } from "../../lab/problems";
import { exampleKey, queueOf, QUEUE_TITLE, type Queue } from "../../lab/verdicts";
import { useKeys } from "../../shell/keys";
import { Button } from "../../ui/Button";
import { EmptyState, Skeleton } from "../../ui/EmptyState";
import { Kbd } from "../../ui/Kbd";
import { Label } from "../../ui/Label";
import { Quote } from "../../ui/Quote";
import { Segmented } from "../../ui/Segmented";
import { ConversationBox, ExampleMeta, JudgeNote, useExample } from "../verdicts/Example";

const QUEUES: Queue[] = ["disputed", "unchecked", "all"];
const VERDICT: Record<string, { word: string; tone: string }> = {
  FAIL: { word: "Судья: нарушено", tone: "text-lab-bad" },
  PASS: { word: "Судья: выполнено", tone: "text-lab-ok" },
};

/**
 * Проверка вердиктов of one source: one verdict at a time, a person says «верно» or «неверно» (V / N) and the next one comes.
 * The queue is fixed when it opens, so answering does not reshuffle it.
 */
export function ReviewView({ source, runId }: { source: "log" | "sim"; runId?: string | null }) {
  const [params, setParams] = useSearchParams();
  const { data } = useProblems(runId ?? null);
  const review = useReview();
  const ruleId = params.get("rule");
  const wanted = params.get("queue") as Queue | null;
  const [frozen, setFrozen] = useState<{ id: string; keys: string[] } | null>(null);
  const [at, setAt] = useState(0);
  const [answered, setAnswered] = useState<Record<string, Decision>>({});
  const counts = useMemo(() => Object.fromEntries(QUEUES.map(q => [q, data ? queueOf(data, q, ruleId, source).length : 0])) as Record<Queue, number>, [data, ruleId]);
  const queue: Queue = wanted ?? (counts.disputed ? "disputed" : counts.unchecked ? "unchecked" : "all");
  const id = `${source}|${queue}|${ruleId ?? ""}`;
  useEffect(() => {
    if (!data || frozen?.id === id) return;
    setFrozen({ id, keys: queueOf(data, queue, ruleId, source).map(v => exampleKey(v.example)) });
    setAt(0);
    setAnswered({});
  }, [data, id, queue, ruleId, frozen?.id]);
  const byKey = useMemo(() => new Map((data ? queueOf(data, "all", ruleId, source) : []).map(v => [exampleKey(v.example), v])), [data, ruleId]);
  const keys = frozen?.id === id ? frozen.keys : [];
  const current = keys[at] ? byKey.get(keys[at]) : undefined;
  const view = useExample(current?.example);
  const done = at >= keys.length;
  const next = () => setAt(a => Math.min(keys.length, a + 1));
  const decide = (d: Decision) => {
    if (!current) return;
    review.mutate({ example: current.example, decision: d });
    setAnswered(a => ({ ...a, [exampleKey(current.example)]: d }));
    next();
  };
  const exit = () => setParams(prev => { const n = new URLSearchParams(prev); n.delete("queue"); n.delete("rule"); n.set("tab", "problems"); return n; }, { replace: true });
  useKeys({
    KeyV: () => decide("agree"),
    KeyN: () => decide("disagree"),
    ArrowRight: next,
    ArrowLeft: () => setAt(a => Math.max(0, a - 1)),
  });
  const setQueue = (q: Queue) => setParams(prev => { const n = new URLSearchParams(prev); n.set("queue", q); return n; }, { replace: true });
  const made = Object.values(answered);
  const agree = made.filter(d => d === "agree").length;

  const rule = ruleId && data ? data.rules.find(r => r.id === ruleId) : undefined;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex-shrink-0 border-b border-white/[0.06]">
        <div className="flex flex-wrap items-center gap-3 px-4 py-2">
          <Segmented value={queue} onChange={setQueue} options={QUEUES.map(q => ({ value: q, label: QUEUE_TITLE[q], count: counts[q] }))} />
          {rule && <span className="flex min-w-0 items-center gap-1 text-meta text-lab-dim"><span title={rule.rule.text} className="truncate">критерий: {rule.rule.text}</span><button type="button" onClick={() => setParams(prev => { const n = new URLSearchParams(prev); n.delete("rule"); return n; }, { replace: true })} aria-label="Снять отбор по критерию" className="hover:text-lab-text"><X className="size-3" /></button></span>}
          <span className="ml-auto font-mono text-meta text-lab-dim">{Math.min(at + 1, keys.length)} из {keys.length}</span>
        </div>
        <div className="h-px bg-white/[0.06]"><div className="h-px bg-lab-accent transition-[width] duration-300" style={{ width: `${keys.length ? (100 * at) / keys.length : 0}%` }} /></div>
      </div>
      {!data || !frozen ? <div className="p-6"><Skeleton className="h-[480px]" /></div>
        : !keys.length ? (
          <EmptyState drop title={`Здесь нечего проверять: ${QUEUE_TITLE[queue]} — пусто`} className="flex-1">
            {queue === "disputed" ? "Второй судья согласен с первым во всех вердиктах этого отбора." : "Все нарушения этого отбора уже проверены."}
          </EmptyState>
        ) : done ? (
          <EmptyState drop title={made.length ? `Проверено ${made.length}: верно ${agree}, неверно ${made.length - agree}` : "Очередь пройдена"} className="flex-1"
            action={<>
              <Button onClick={() => setAt(0)}>Пройти ещё раз</Button>
              <Button variant="primary" onClick={exit}>К нарушениям<ArrowRight className="size-3.5" /></Button>
            </>}
          >
            Решения сохранены: по ним видно, где судья ошибается и насколько верить счётам.
          </EmptyState>
        ) : current ? (
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <section className="min-h-0 flex-1 overflow-auto p-6">
              <ExampleMeta example={current.example} />
              <ConversationBox className="mt-2" view={view} example={current.example} />
            </section>
            <aside className="min-h-0 overflow-auto border-t border-white/[0.06] bg-lab-surface p-6 lg:w-[440px] lg:flex-shrink-0 lg:border-l lg:border-t-0">
              <Quote label={sourceLabel(current.rule.rule.kind)} origin={current.rule.rule.origin || undefined}>{current.rule.rule.quote}</Quote>
              <p className="mt-3 text-small text-lab-mute">{current.rule.rule.text}</p>
              <div className="mt-6">
                <Label className={cn(VERDICT[current.example.status]?.tone)}>{VERDICT[current.example.status]?.word}</Label>
                <div className="mt-2"><JudgeNote example={current.example} marked={view.marked} verdict={false} /></div>
              </div>
              <div className="mt-8 grid grid-cols-2 gap-2">
                <button type="button" onClick={() => decide("agree")} className="flex h-12 items-center justify-center gap-2 rounded-lg border border-lab-ok/40 text-body text-lab-ok transition-colors hover:bg-lab-ok/10">
                  <Check className="size-4" />Верно<Kbd className="ml-1">V</Kbd>
                </button>
                <button type="button" onClick={() => decide("disagree")} className="flex h-12 items-center justify-center gap-2 rounded-lg border border-lab-bad/40 text-body text-lab-bad transition-colors hover:bg-lab-bad/10">
                  <X className="size-4" />Неверно<Kbd className="ml-1">N</Kbd>
                </button>
              </div>
              <Button variant="ghost" icon={SkipForward} kbd="→" onClick={next} className="mt-2 w-full">Пропустить</Button>
              {current.example.review && (
                <p className="mt-3 text-meta text-lab-dim">
                  Уже отмечено: {current.example.review === "agree" ? "верно" : "неверно"}{current.example.reviewScope === "dialogue" ? " (для диалога целиком)" : ""}. Новое решение заменит его.
                </p>
              )}
              <p className="mt-6 text-meta text-lab-dim">
                {made.length ? `В этом проходе: ${made.length} ${plural(made.length, "решение", "решения", "решений")}.` : "Решение сохраняется сразу."} ← — назад.
              </p>
            </aside>
          </div>
        ) : (
          <EmptyState title="Этого вердикта больше нет" className="flex-1" action={<Button onClick={next}>Дальше</Button>}>Его могли переоценить.</EmptyState>
        )}
    </div>
  );
}
