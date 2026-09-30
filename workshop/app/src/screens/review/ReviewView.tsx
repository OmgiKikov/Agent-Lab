import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowRight, Check, ChevronLeft, ChevronRight, SkipForward, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { plural } from "../../lab/format";
import { sourceLabel } from "../../lab/problemReport";
import { useProblems, useReview, type Decision } from "../../lab/problems";
import { exampleKey, queueOf, QUEUE_TITLE, type Queue } from "../../lab/verdicts";
import { useKeys } from "../../shell/keys";
import { Button } from "../../ui/Button";
import { EmptyState, Skeleton } from "../../ui/EmptyState";
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
  const [hover, setHover] = useState(false);
  const judged = current ? VERDICT[current.example.status] : undefined;
  const answeredAt = (k: string) => answered[k] ?? (byKey.get(k)?.example.review ?? null);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/[0.06] px-4 py-2">
        <Segmented value={queue} onChange={setQueue} options={QUEUES.map(q => ({ value: q, label: QUEUE_TITLE[q], count: counts[q] }))} />
        {rule && <span className="flex min-w-0 items-center gap-1 text-meta text-lab-dim"><span title={rule.rule.text} className="truncate">критерий: {rule.rule.text}</span><button type="button" onClick={() => setParams(prev => { const n = new URLSearchParams(prev); n.delete("rule"); return n; }, { replace: true })} aria-label="Снять отбор по критерию" className="hover:text-lab-text"><X className="size-3" /></button></span>}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-body text-lab-ink">{Math.min(at + 1, keys.length)} <span className="text-lab-dim">из {keys.length}</span></span>
          <Button variant="ghost" size="sm" icon={ChevronLeft} aria-label="Назад (←)" title="Назад (←)" disabled={at <= 0} onClick={() => setAt(a => Math.max(0, a - 1))} />
          <Button variant="ghost" size="sm" icon={ChevronRight} aria-label="Дальше (→)" title="Дальше (→)" disabled={at >= keys.length} onClick={next} />
        </div>
        {keys.length > 0 && keys.length <= 48 ? (
          <div className="order-last flex w-full gap-1" role="presentation">
            {keys.map((k, i) => {
              const d = answeredAt(k);
              return <button key={k} type="button" tabIndex={-1} aria-label={`Вердикт ${i + 1}`} onClick={() => setAt(i)}
                className={cn("h-1.5 min-w-0 flex-1 rounded-full transition-colors", i === at ? "bg-lab-ink" : d === "agree" ? "bg-lab-ok/60" : d === "disagree" ? "bg-lab-bad/60" : "bg-white/[0.12] hover:bg-white/25")} />;
            })}
          </div>
        ) : keys.length > 0 && (
          <div className="order-last h-1 w-full overflow-hidden rounded-full bg-white/[0.12]"><div className="h-full bg-lab-ink transition-[width] duration-300" style={{ width: `${(100 * at) / keys.length}%` }} /></div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
      {!data || !frozen ? <div className="p-6"><Skeleton className="h-[480px]" /></div>
        : !keys.length ? (
          <EmptyState drop title={`Здесь нечего проверять: ${QUEUE_TITLE[queue]} — пусто`} className="h-full justify-center">
            {queue === "disputed" ? "Второй судья согласен с первым во всех вердиктах этого отбора." : "Все нарушения этого отбора уже проверены."}
          </EmptyState>
        ) : done ? (
          <EmptyState drop title={made.length ? `Проверено ${made.length}: верно ${agree}, неверно ${made.length - agree}` : "Очередь пройдена"} className="h-full justify-center"
            action={<>
              <Button onClick={() => setAt(0)}>Пройти ещё раз</Button>
              <Button variant="primary" onClick={exit}>К нарушениям<ArrowRight className="size-3.5" /></Button>
            </>}
          >
            Решения сохранены: по ним видно, где судья ошибается и насколько верить счётам.
          </EmptyState>
        ) : current ? (
          <div className="mx-auto max-w-[760px] px-6 pb-16 pt-6">
            <Label>Критерий</Label>
            <p className="mt-1 text-title text-lab-ink">{current.rule.title}</p>
            <div className="mt-4 rounded-lg border border-white/[0.07] bg-lab-surface p-4" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
              <Label className={cn(judged?.tone)}>{judged?.word}</Label>
              <div className="mt-2 text-body"><JudgeNote example={current.example} marked={view.marked} verdict={false} hover={hover} onHover={setHover} /></div>
              <div className="mt-5 flex flex-wrap items-center gap-2">
                <Button size="md" icon={Check} kbd="V" className="min-w-[120px]" onClick={() => decide("agree")}>Верно</Button>
                <Button size="md" icon={X} kbd="N" className="min-w-[120px]" onClick={() => decide("disagree")}>Неверно</Button>
                <Button variant="ghost" icon={SkipForward} kbd="→" onClick={next}>Пропустить</Button>
                <span className="ml-auto text-meta text-lab-dim">V · N · →</span>
              </div>
              {current.example.review && (
                <p className="mt-3 text-meta text-lab-dim">
                  Уже отмечено: {current.example.review === "agree" ? "верно" : "неверно"}{current.example.reviewScope === "dialogue" ? " (для диалога целиком)" : ""}. Новое решение заменит его.
                </p>
              )}
            </div>
            <div className="mt-6">
              <ExampleMeta example={current.example} />
              <ConversationBox className="mt-2" view={view} example={current.example} hover={hover} onHover={setHover} />
            </div>
            <div className="mt-6">
              <Quote label={sourceLabel(current.rule.rule.kind)} origin={current.rule.rule.origin || undefined} hover={hover} onHover={setHover}>{current.rule.rule.quote}</Quote>
            </div>
            <p className="mt-6 text-meta text-lab-dim">
              {made.length ? `В этом проходе: ${made.length} ${plural(made.length, "решение", "решения", "решений")}. ` : "Решение сохраняется сразу. "}Дальше открывается следующий вердикт.
            </p>
          </div>
        ) : (
          <EmptyState title="Этого вердикта больше нет" className="h-full justify-center" action={<Button onClick={next}>Дальше</Button>}>Его могли переоценить.</EmptyState>
        )}
      </div>
    </div>
  );
}
