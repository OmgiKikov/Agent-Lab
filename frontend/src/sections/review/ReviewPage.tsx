import { useEffect, useMemo, useState } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Header } from "../../app/Header";
import { useKeys } from "../../app/keys";
import { side, stageLink, type Stage } from "../../app/links";
import { yesNoText } from "../../lab/answers";
import { count } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { answersWait, useProblems, useReview, type Decision } from "../../lab/problems";
import { exampleKey, queueOf, QUEUE_TITLE, saysError, type Queue } from "../../lab/verdicts";
import { Duty } from "../../product/Duty";
import { ExampleCard } from "../../product/ExampleCard";
import { Button } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Menu } from "../../ui/Menu";
import { useToast } from "../../ui/toast";
import { CheckHeader } from "../checks/CheckHeader";
import { SimTabs, useSimRuns } from "../simulations/stage";

const QUEUES: Queue[] = ["disputed", "unchecked", "all"];
/** The queues count cases (one criterion in one conversation, an error or «без ошибки») and say so. */
const cases = (n: number) => count(n, "случай", "случая", "случаев");

/**
 * «Проверка» of a stage: a person answers, one case at a time, whether what the checks found is an error — disputed cases
 * first. Among the cases without an answer every fifth is one the model found no error in («Здесь правда нет ошибки?»),
 * so its misses are checked too. The answer is saved and the next case comes; «Отменить» brings the last one back. The
 * queue is fixed when it opens, so answering does not reshuffle it.
 */
export function ReviewPage({ stage }: { stage: Stage }) {
  const { state, offline } = useLabState();
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const { run } = useSimRuns(state, stage === "sim" ? params.get("run") : null);
  const runId = stage === "sim" ? (run?.id ?? null) : null;
  // A check's cases are of its result; a run's, of the run, counted by the criteria of its check.
  const { data, isPlaceholderData } = useProblems(stage === "sim" ? (run?.check ?? null) : stage, runId);
  const source = side(stage);
  const review = useReview();
  const ruleId = params.get("rule");
  const rawQueue = params.get("queue");
  const wanted = QUEUES.find((q) => q === rawQueue) ?? null;
  const set = (edit: (n: URLSearchParams) => void) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        edit(n);
        return n;
      },
      { replace: true },
    );

  const counts = useMemo(
    () =>
      Object.fromEntries(QUEUES.map((q) => [q, data ? queueOf(data, q, ruleId, source).length : 0])) as Record<
        Queue,
        number
      >,
    [data, ruleId, source],
  );
  const context = stage === "sim" ? (runId ?? data?.sim?.runId ?? "") : (data?.log?.finishedAt ?? "");
  const id = `${stage}|${context}|${wanted ?? "default"}|${ruleId ?? ""}`;
  const [frozen, setFrozen] = useState<{ id: string; queue: Queue; keys: string[] } | null>(null);
  const queue: Queue =
    wanted ??
    (frozen?.id === id ? frozen.queue : counts.disputed ? "disputed" : counts.unchecked ? "unchecked" : "all");
  const [at, setAt] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [answered, setAnswered] = useState<Record<string, Decision>>({});
  const [lit, setLit] = useState(false);
  useEffect(() => {
    if (!data || isPlaceholderData || frozen?.id === id) return;
    setFrozen({ id, queue, keys: queueOf(data, queue, ruleId, source).map((v) => exampleKey(v.example)) });
    setAt(0);
    setAnswered({});
  }, [data, isPlaceholderData, id, queue, ruleId, source, frozen?.id]);
  const byKey = useMemo(
    () => new Map((data ? queueOf(data, "all", ruleId, source) : []).map((v) => [exampleKey(v.example), v])),
    [data, ruleId, source],
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
  /** Takes back the answer shown at once on case `k`, unless the person has answered it otherwise since. */
  const forget = (k: string, d?: Decision) =>
    setAnswered((a) => {
      if (!(k in a) || (d && a[k] !== d)) return a;
      const n = { ...a };
      delete n[k];
      return n;
    });
  const decide = (d: Decision) => {
    if (!current || answersWait(state, current.example)) return;
    const e = current.example;
    const before = e.review;
    const k = exampleKey(e);
    const was = at;
    // The check's result the queue shows: an answer on it never lands on a result that replaced it meanwhile.
    const finishedAt = data?.log?.finishedAt;
    review.mutateAsync({ example: e, decision: d, finishedAt }).catch(() => forget(k, d));
    setAnswered((a) => ({ ...a, [k]: d }));
    next();
    toast.notify(saysError(e.status, d) ? "Отмечено как ошибка" : "Отмечено, что ошибки нет", {
      label: "Отменить",
      run: () => {
        review.mutate({ example: e, decision: before, finishedAt });
        forget(k);
        setDir(-1);
        setAt(was);
      },
    });
  };
  useKeys({ KeyV: () => decide("agree"), KeyN: () => decide("disagree"), ArrowRight: next, ArrowLeft: back });

  const made = Object.keys(answered);
  // «Нет» on a case «без ошибки» says the model missed an error: the person's word on the conversation is what counts.
  const errors = made.filter((k) => {
    const status = byKey.get(k)?.example.status;
    return status && saysError(status, answered[k]);
  }).length;
  const saving = useIsMutating({ mutationKey: ["review"] }) > 0;
  const counted = saving ? "Сохраняем ответы…" : "Ответы уже учтены в счёте.";
  const rule = ruleId && data ? data.rules.find((r) => r.id === ruleId) : undefined;
  const stateOf = (k: string) => answered[k] ?? byKey.get(k)?.example.review ?? null;
  // Without a second model nothing can be disputed: an empty queue then says so, not that two checks agreed.
  const twice = [...byKey.values()].some((v) => !!v.example.second);

  const header =
    stage === "sim" ? (
      <Header title="Симуляции" tabs={<SimTabs state={state} runId={runId ?? data?.sim?.runId ?? null} />} />
    ) : (
      <CheckHeader check={stage} />
    );
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
      {/* The question stays at the bottom while the conversation scrolls under it (ExampleCard): whatever the browser
          brings into view — the last message, a word found, a focused link — stops above it, not behind it. */}
      <div className="min-h-0 flex-1 overflow-auto scroll-pb-40">
        <div className="max-w-[880px] px-4 pb-24 pt-8 lg:px-10 lg:pt-10">
          {data && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <Menu
                trigger={
                  <span className="inline-flex items-center gap-1.5 text-lead font-semibold text-fg">
                    {QUEUE_TITLE[queue]}
                    <span className="font-normal tabular-nums text-fg-3">{cases(counts[queue])}</span>
                    <ChevronDown aria-hidden className="size-4 text-fg-3" />
                  </span>
                }
                items={QUEUES.map((q) => ({
                  key: q,
                  label: QUEUE_TITLE[q],
                  sub: cases(counts[q]),
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
                    {at + 1}
                    {"\u00a0"}из{"\u00a0"}
                    {keys.length}
                  </span>
                  <Button icon={ChevronLeft} aria-label="Предыдущий случай" kbd="←" disabled={at <= 0} onClick={back} />
                  <Button icon={ChevronRight} aria-label="Следующий случай" kbd="→" onClick={next} />
                </span>
              )}
            </div>
          )}
          {/* «Все случаи 285» did not say what a case is. */}
          {data && <p className="mt-2 text-small text-fg-3">Один случай — один критерий в одном разговоре.</p>}
          {rule && (
            <p className="mt-3 flex items-center gap-2 text-read text-fg-3">
              Только «{rule.title}»
              <button
                type="button"
                onClick={() => set((n) => n.delete("rule"))}
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-small font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg"
              >
                <X aria-hidden className="size-3.5" />
                снять отбор
              </button>
            </p>
          )}

          {stage === "sim" && state && !run ? (
            <EmptyState drop title="Прогонов ещё не было" className="py-24">
              Здесь будут случаи из разговоров синтетических клиентов.
            </EmptyState>
          ) : !data || frozen?.id !== id ? (
            <Skeleton className="mt-8 h-[480px]" />
          ) : !keys.length ? (
            <EmptyState
              drop
              title={
                queue === "disputed"
                  ? "Спорных случаев нет"
                  : queue === "unchecked"
                    ? "Вы ответили на все случаи"
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
                ? twice
                  ? "Две проверки совпали во всех случаях этого отбора."
                  : "Второй проверки у этих разговоров не было."
                : queue === "unchecked"
                  ? counted
                  : "Случаи появятся после проверки разговоров."}
            </EmptyState>
          ) : done ? (
            <EmptyState
              drop
              title={
                made.length ? `Вы ответили на ${count(made.length, "случай", "случая", "случаев")}` : "Очередь пройдена"
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
              {made.length ? `${yesNoText(errors, made.length - errors)}. ${counted}` : counted}
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
              <Duty
                key={current.rule.id}
                text={current.rule.rule.text}
                className="mt-3 max-w-[68ch] text-lead text-fg-2"
              />
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
              Разговор могли проверить заново.
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
