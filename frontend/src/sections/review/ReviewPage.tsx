import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Header } from "../../app/Header";
import { useKeys } from "../../app/keys";
import { stageLink, type Stage } from "../../app/links";
import { count } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { useProblems, useReview, type Decision } from "../../lab/problems";
import { exampleKey, queueOf, QUEUE_TITLE, type Queue } from "../../lab/verdicts";
import { ExampleCard } from "../../product/ExampleCard";
import { Button } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Menu } from "../../ui/Menu";
import { useToast } from "../../ui/toast";
import { useLogTabs } from "../logs/LogsPage";
import { SimTabs } from "../simulations/stage";

const QUEUES: Queue[] = ["disputed", "unchecked", "all"];

/**
 * «Проверка» of a stage: a person answers, one case at a time, whether what the checks found is an error — disputed cases
 * first. The answer is saved and the next case comes; «Отменить» brings the last one back. The queue is fixed when it
 * opens, so answering does not reshuffle it.
 */
export function ReviewPage({ stage }: { stage: Stage }) {
  const { state, offline } = useLabState();
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const runId = stage === "sim" ? params.get("run") : null;
  const { data } = useProblems(runId);
  const review = useReview();
  const ruleId = params.get("rule");
  const wanted = params.get("queue") as Queue | null;
  const set = (edit: (n: URLSearchParams) => void) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        edit(n);
        return n;
      },
      { replace: true },
    );
  const logTabs = useLogTabs();

  const counts = useMemo(
    () =>
      Object.fromEntries(QUEUES.map((q) => [q, data ? queueOf(data, q, ruleId, stage).length : 0])) as Record<
        Queue,
        number
      >,
    [data, ruleId, stage],
  );
  const queue: Queue = wanted ?? (counts.disputed ? "disputed" : counts.unchecked ? "unchecked" : "all");
  const id = `${stage}|${runId ?? ""}|${queue}|${ruleId ?? ""}`;
  const [frozen, setFrozen] = useState<{ id: string; keys: string[] } | null>(null);
  const [at, setAt] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [answered, setAnswered] = useState<Record<string, Decision>>({});
  const [lit, setLit] = useState(false);
  useEffect(() => {
    if (!data || frozen?.id === id) return;
    setFrozen({ id, keys: queueOf(data, queue, ruleId, stage).map((v) => exampleKey(v.example)) });
    setAt(0);
    setAnswered({});
  }, [data, id, queue, ruleId, stage, frozen?.id]);
  const byKey = useMemo(
    () => new Map((data ? queueOf(data, "all", ruleId, stage) : []).map((v) => [exampleKey(v.example), v])),
    [data, ruleId, stage],
  );
  const keys = frozen?.id === id ? frozen.keys : [];
  const current = keys[at] ? byKey.get(keys[at]) : undefined;
  const done = keys.length > 0 && at >= keys.length;
  const next = () => {
    setDir(1);
    setAt((a) => Math.min(keys.length, a + 1));
  };
  const back = () => {
    setDir(-1);
    setAt((a) => Math.max(0, a - 1));
  };
  const decide = (d: Decision) => {
    if (!current) return;
    const e = current.example;
    const before = e.review;
    const k = exampleKey(e);
    const was = at;
    review.mutate({ example: e, decision: d });
    setAnswered((a) => ({ ...a, [k]: d }));
    next();
    toast.notify(d === "agree" ? "Отмечено: это ошибка" : "Отмечено: ошибки нет", {
      label: "Отменить",
      run: () => {
        review.mutate({ example: e, decision: before });
        setAnswered((a) => {
          const n = { ...a };
          delete n[k];
          return n;
        });
        setDir(-1);
        setAt(was);
      },
    });
  };
  useKeys({ KeyV: () => decide("agree"), KeyN: () => decide("disagree"), ArrowRight: next, ArrowLeft: back });

  const made = Object.values(answered);
  const agree = made.filter((d) => d === "agree").length;
  const rule = ruleId && data ? data.rules.find((r) => r.id === ruleId) : undefined;
  const stateOf = (k: string) => answered[k] ?? byKey.get(k)?.example.review ?? null;

  const tabs = stage === "log" ? logTabs : <SimTabs state={state} runId={runId ?? data?.sim?.runId ?? null} />;
  const header = <Header title={stage === "log" ? "Логи" : "Симуляции"} step={stage === "log" ? 1 : 2} tabs={tabs} />;
  if (offline && !data)
    return (
      <div className="flex h-full flex-col">
        {header}
        <ServiceDown />
      </div>
    );

  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="max-w-[880px] px-4 pb-24 pt-8 lg:px-10 lg:pt-10">
          {data && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <Menu
                trigger={
                  <span className="inline-flex items-center gap-1.5 text-lead font-semibold text-fg">
                    {QUEUE_TITLE[queue]}
                    <span className="font-normal tabular-nums text-fg-3">{counts[queue]}</span>
                    <ChevronDown aria-hidden className="size-4 text-fg-3" />
                  </span>
                }
                items={QUEUES.map((q) => ({
                  key: q,
                  label: QUEUE_TITLE[q],
                  sub: `${counts[q]}`,
                  on: q === queue,
                  run: () => set((n) => n.set("queue", q)),
                }))}
              />
              {keys.length > 0 && (
                <Progress
                  keys={keys}
                  at={at}
                  stateOf={stateOf}
                  onAt={(n) => {
                    setDir(n >= at ? 1 : -1);
                    setAt(n);
                  }}
                />
              )}
              {keys.length > 0 && !done && (
                <span className="flex items-center gap-2">
                  <span className="text-read tabular-nums text-fg-3">
                    {at + 1} из {keys.length}
                  </span>
                  <Button icon={ChevronLeft} aria-label="Предыдущий случай" kbd="←" disabled={at <= 0} onClick={back} />
                  <Button icon={ChevronRight} aria-label="Следующий случай" kbd="→" onClick={next} />
                </span>
              )}
            </div>
          )}
          {rule && (
            <p className="mt-3 flex items-center gap-2 text-read text-fg-3">
              Только «{rule.title}»
              <button
                type="button"
                onClick={() => set((n) => n.delete("rule"))}
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-small font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg"
              >
                <X aria-hidden className="size-3.5" />
                все проблемы
              </button>
            </p>
          )}

          {!data || !frozen ? (
            <Skeleton className="mt-8 h-[480px]" />
          ) : !keys.length ? (
            <EmptyState
              drop
              title={
                queue === "disputed"
                  ? "Спорных случаев нет"
                  : queue === "unchecked"
                    ? "На все случаи вы уже ответили"
                    : "Случаев пока нет"
              }
              className="py-24"
              action={
                queue !== "all" && counts.all > 0 ? (
                  <Button onClick={() => set((n) => n.set("queue", "all"))}>Все случаи · {counts.all}</Button>
                ) : undefined
              }
            >
              {queue === "disputed"
                ? "Две проверки совпали во всех случаях этого отбора."
                : "Здесь появятся случаи, которые нашли проверки."}
            </EmptyState>
          ) : done ? (
            <EmptyState
              drop
              title={
                made.length
                  ? `Готово: вы ответили на ${count(made.length, "случай", "случая", "случаев")}`
                  : "Очередь пройдена"
              }
              className="py-24"
              action={
                <>
                  <Button
                    onClick={() => {
                      setDir(1);
                      setAt(0);
                    }}
                  >
                    Пройти ещё раз
                  </Button>
                  <Button variant="primary" onClick={() => navigate(stageLink(stage, runId))}>
                    К итогу
                    <ArrowRight aria-hidden className="size-4" />
                  </Button>
                </>
              }
            >
              {made.length
                ? `Это ошибка — ${agree}, ошибки нет — ${made.length - agree}. Ответы уже учтены в счёте.`
                : "Ответы уже учтены в счёте."}
            </EmptyState>
          ) : current ? (
            <div
              key={keys[at]}
              className={cn(
                "duration-300 animate-in fade-in-0",
                dir > 0 ? "slide-in-from-right-4" : "slide-in-from-left-4",
              )}
            >
              <h2 className="mt-8 text-balance text-page font-semibold text-fg">{current.rule.title}</h2>
              <p className="mt-3 max-w-[68ch] text-lead text-fg-2">
                <span className="text-fg-3">Агент должен: </span>
                {current.rule.rule.text}
              </p>
              <div className="mt-8">
                <ExampleCard
                  example={current.example}
                  lit={lit}
                  onLit={setLit}
                  onDecide={decide}
                  onSkip={next}
                  emphasis
                />
              </div>
            </div>
          ) : (
            <EmptyState
              title="Этого случая больше нет"
              className="py-24"
              action={<Button onClick={next}>Дальше</Button>}
            >
              Его могли переоценить.
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}

/** Where the person is in the queue: a mark per case, darker once answered; past 48 cases, one bar. */
function Progress({
  keys,
  at,
  stateOf,
  onAt,
}: {
  keys: string[];
  at: number;
  stateOf: (k: string) => Decision | null;
  onAt: (n: number) => void;
}) {
  if (keys.length > 48) {
    return (
      <div className="h-1.5 min-w-24 flex-1 overflow-hidden rounded-full bg-well">
        <div
          className="h-full rounded-full bg-fg transition-[width] duration-300 ease-out"
          style={{ width: `${(100 * at) / keys.length}%` }}
        />
      </div>
    );
  }
  return (
    <div className="flex min-w-24 flex-1 flex-wrap items-center gap-1" role="presentation">
      {keys.map((k, i) => {
        const d = stateOf(k);
        return (
          <button
            key={k}
            type="button"
            tabIndex={-1}
            aria-label={`Случай ${i + 1}`}
            onClick={() => onAt(i)}
            className={cn(
              "h-1.5 rounded-full transition-all duration-200",
              i === at ? "w-7 bg-fg" : cn("w-4", d ? "bg-fg/45 hover:bg-fg/60" : "bg-fg/15 hover:bg-fg/30"),
            )}
          />
        );
      })}
    </div>
  );
}
