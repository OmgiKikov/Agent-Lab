import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Header } from "../../app/Header";
import { SECTIONS } from "../../app/links";
import { plural } from "../../lab/format";
import { useProblems, useReview, type Decision } from "../../lab/problems";
import { exampleKey, queueOf, QUEUE_TITLE, type Queue } from "../../lab/verdicts";
import { CodeQuote } from "../../product/CodeQuote";
import { ExampleCard } from "../../product/ExampleCard";
import { useKeys } from "../../app/keys";
import { useLabState } from "../../lab/LabProvider";
import { Button } from "../../ui/Button";
import { Label } from "../../ui/Label";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Menu } from "../../ui/Menu";

const QUEUES: Queue[] = ["disputed", "unchecked", "all"];
const ONE: Record<Queue, string> = { disputed: "Спорный вердикт", unchecked: "Непроверенное нарушение", all: "Вердикт" };

/**
 * «Проверка вердиктов»: a person goes through the judge's verdicts one at a time, disputed ones first, and says
 * «верно» or «неверно» (V / N); the next one comes. It reads like a case: the criterion in the code, then the proof.
 * The queue is fixed when it opens, so answering does not reshuffle it.
 */
export function ReviewPage() {
  const { offline } = useLabState();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const source = params.get("src") === "sim" ? "sim" : "log";
  const runId = source === "sim" ? params.get("run") : null;
  const { data } = useProblems(runId);
  const review = useReview();
  const ruleId = params.get("rule");
  const wanted = params.get("queue") as Queue | null;
  const set = (edit: (n: URLSearchParams) => void) => setParams(prev => { const n = new URLSearchParams(prev); edit(n); return n; }, { replace: true });

  const counts = useMemo(() => Object.fromEntries(QUEUES.map(q => [q, data ? queueOf(data, q, ruleId, source).length : 0])) as Record<Queue, number>, [data, ruleId, source]);
  const queue: Queue = wanted ?? (counts.disputed ? "disputed" : counts.unchecked ? "unchecked" : "all");
  const id = `${source}|${runId ?? ""}|${queue}|${ruleId ?? ""}`;
  const [frozen, setFrozen] = useState<{ id: string; keys: string[] } | null>(null);
  const [at, setAt] = useState(0);
  const [answered, setAnswered] = useState<Record<string, Decision>>({});
  const [lit, setLit] = useState(false);
  useEffect(() => {
    if (!data || frozen?.id === id) return;
    setFrozen({ id, keys: queueOf(data, queue, ruleId, source).map(v => exampleKey(v.example)) });
    setAt(0);
    setAnswered({});
  }, [data, id, queue, ruleId, source, frozen?.id]);
  const byKey = useMemo(() => new Map((data ? queueOf(data, "all", ruleId, source) : []).map(v => [exampleKey(v.example), v])), [data, ruleId, source]);
  const keys = frozen?.id === id ? frozen.keys : [];
  const current = keys[at] ? byKey.get(keys[at]) : undefined;
  const done = keys.length > 0 && at >= keys.length;
  const next = () => setAt(a => Math.min(keys.length, a + 1));
  const back = () => setAt(a => Math.max(0, a - 1));
  const decide = (d: Decision) => {
    if (!current) return;
    review.mutate({ example: current.example, decision: d });
    setAnswered(a => ({ ...a, [exampleKey(current.example)]: d }));
    next();
  };
  useKeys({ KeyV: () => decide("agree"), KeyN: () => decide("disagree"), ArrowRight: next, ArrowLeft: back });

  const made = Object.values(answered);
  const agree = made.filter(d => d === "agree").length;
  const rule = ruleId && data ? data.rules.find(r => r.id === ruleId) : undefined;
  const stateOf = (k: string) => answered[k] ?? byKey.get(k)?.example.review ?? null;
  const toViolations = () => navigate(source === "sim" && runId ? `${SECTIONS.problems}?src=sim&run=${encodeURIComponent(runId)}` : SECTIONS.problems);

  const header = (
    <Header title="Проверка вердиктов" sub={`${source === "log" ? "логи" : "симуляция"} · ${QUEUE_TITLE[queue]}`}
      actions={data && (
        <Menu
          trigger={<span className="inline-flex h-8 items-center gap-1.5 rounded-control border border-line-strong px-2.5 text-small text-fg-2 transition-colors hover:text-fg">{QUEUE_TITLE[queue]}<span className="font-mono text-meta text-fg-3">{counts[queue]}</span><ChevronDown aria-hidden className="size-3.5" /></span>}
          items={QUEUES.map(q => ({ key: q, label: QUEUE_TITLE[q], sub: `${counts[q]}`, on: q === queue, run: () => set(n => n.set("queue", q)) }))} />
      )} />
  );
  if (offline && !data) return <div className="flex h-full flex-col">{header}<ServiceDown /></div>;

  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-auto">
        {!data || !frozen ? <div className="p-5"><Skeleton className="h-[480px]" /></div>
          : !keys.length ? (
            <EmptyState drop title={`Здесь нечего проверять: ${QUEUE_TITLE[queue]} — пусто`} className="h-full justify-center"
              action={queue !== "all" && counts.all > 0 ? <Button onClick={() => set(n => n.set("queue", "all"))}>Все вердикты · {counts.all}</Button> : undefined}>
              {queue === "disputed" ? "Второй судья согласен с первым во всех вердиктах этого отбора." : "Все нарушения этого отбора уже проверены."}
            </EmptyState>
          ) : done ? (
            <EmptyState drop title={made.length ? `Проверено ${made.length}: верно ${agree}, неверно ${made.length - agree}` : "Очередь пройдена"} className="h-full justify-center"
              action={<><Button onClick={() => setAt(0)}>Пройти ещё раз</Button><Button variant="primary" onClick={toViolations}>К нарушениям<ArrowRight aria-hidden className="size-3.5" /></Button></>}>
              Решения сохранены: по ним видно, где судья ошибается и насколько верить счётам.
            </EmptyState>
          ) : (
            <div className="max-w-4xl px-4 pb-16 pt-5 lg:px-10 lg:pt-7">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Label>{ONE[queue]} · {source === "log" ? "логи" : "симуляция"}</Label>
                <Progress keys={keys} at={at} stateOf={stateOf} onAt={setAt} />
                <span className="flex items-center gap-1.5">
                  <span className="mr-1 font-mono text-meta text-fg-3">{at + 1} из {keys.length}</span>
                  <Button size="sm" icon={ChevronLeft} aria-label="Предыдущий вердикт" kbd="←" disabled={at <= 0} onClick={back} />
                  <Button size="sm" icon={ChevronRight} aria-label="Следующий вердикт" kbd="→" onClick={next} />
                </span>
              </div>
              {rule && (
                <p className="mt-2 flex items-center gap-1.5 text-small text-fg-3">
                  Только критерий «{rule.title}»
                  <button type="button" onClick={() => set(n => n.delete("rule"))} className="inline-flex items-center gap-1 rounded-sm text-fg-2 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60">
                    <X aria-hidden className="size-3.5" />все критерии
                  </button>
                </p>
              )}
              {current ? (
                <>
                  <h2 className="mt-4 text-balance text-title font-semibold text-fg">{current.rule.title}</h2>
                  <p className="mt-1.5 text-small text-fg-3">
                    Судья считает, что критерий {current.example.status === "FAIL" ? <span className="text-bad">нарушен</span> : <span className="text-ok">выполнен</span>}. Верно ли это?
                  </p>
                  <div className="mt-6"><CodeQuote r={current.rule} lit={lit} onLit={setLit} /></div>
                  <div className="mt-7">
                    <Label>Доказательство</Label>
                    <div className="mt-2.5"><ExampleCard example={current.example} lit={lit} onLit={setLit} onDecide={decide} onSkip={next} /></div>
                  </div>
                  <p className="mt-4 text-meta text-fg-3">
                    {made.length ? `В этом проходе ${made.length} ${plural(made.length, "решение", "решения", "решений")}. ` : "Решение сохраняется сразу. "}Дальше открывается следующий вердикт.
                    {current.example.review && <> Уже отмечено: {current.example.review === "agree" ? "верно" : "неверно"}; новое решение заменит его.</>}
                  </p>
                </>
              ) : (
                <EmptyState title="Этого вердикта больше нет" action={<Button onClick={next}>Дальше</Button>}>Его могли переоценить.</EmptyState>
              )}
            </div>
          )}
      </div>
    </div>
  );
}

/** Where the person is in the queue: a mark per verdict, filled by the word given; past 48 verdicts, one bar. */
function Progress({ keys, at, stateOf, onAt }: { keys: string[]; at: number; stateOf: (k: string) => Decision | null; onAt: (n: number) => void }) {
  if (keys.length > 48) {
    return <div className="h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-well"><div className="h-full rounded-full bg-fg-2 transition-[width] duration-300 ease-out" style={{ width: `${(100 * at) / keys.length}%` }} /></div>;
  }
  return (
    <div className="flex min-w-24 flex-1 flex-wrap items-center gap-1" role="presentation">
      {keys.map((k, i) => {
        const d = stateOf(k);
        return (
          <button key={k} type="button" tabIndex={-1} aria-label={`Вердикт ${i + 1}`} onClick={() => onAt(i)}
            className={cn("h-1.5 rounded-full transition-colors", i === at ? "w-6 bg-fg" : cn("w-4", d === "agree" ? "bg-ok/70" : d === "disagree" ? "bg-bad/70" : "bg-fg-4/40 hover:bg-fg-3"))} />
        );
      })}
    </div>
  );
}
