import { useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowRight, ArrowUpRight, ChevronLeft, ChevronRight, Code2, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { Header } from "../../app/Header";
import { useKeys } from "../../app/keys";
import { conversationsLink, criterionLink, problemLink, reviewLink, stageLink, type Stage } from "../../app/links";
import { dialogOf } from "../../lab/dialogs";
import { useCriteria } from "../../lab/criteria";
import { count, longDay, plural } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { useReview, type Decision, type Example } from "../../lab/problems";
import { humansOf, secondOf } from "../../lab/problemStats";
import { ExampleCard } from "../../product/ExampleCard";
import { SourceSheet } from "../../product/SourceSheet";
import { shortOrigin } from "../../product/text";
import { Button } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { useToast } from "../../ui/toast";
import { Handoff } from "./Handoff";
import { Reproduce } from "./Reproduce";
import { checked, violationsOf } from "./model";

/**
 * One problem, read top to bottom: what the agent does wrong, what it must do instead, how often (one line of numbers),
 * then the case itself — the conversation as the customer saw it — and the person's answer. One stage at a time:
 * the other stage is one link away, never mixed in.
 */
export function ProblemPage({ stage }: { stage: Stage }) {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { state, offline } = useLabState();
  const { data, list } = useCriteria(stage === "sim" ? params.get("run") : null);
  const review = useReview();
  const [lit, setLit] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [source, setSource] = useState(false);
  const [more, setMore] = useState(false);
  const dir = useRef<1 | -1>(1);
  const c = list.find((x) => x.r.id === id);
  const runId = stage === "sim" ? (data?.sim?.runId ?? null) : null;

  const examples = c ? violationsOf(c, stage) : [];
  const at = Math.max(0, Math.min(examples.length - 1, Number(params.get("e") ?? 0) || 0));
  const example = examples[at];
  const go = (n: number) => {
    dir.current = n >= at ? 1 : -1;
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (n) p.set("e", String(n));
        else p.delete("e");
        return p;
      },
      { replace: true },
    );
  };
  const decide = (e: Example, d: Decision) => {
    const before = e.review;
    const next = e.review === d ? null : d;
    review.mutate({ example: e, decision: next });
    if (next)
      toast.notify(next === "agree" ? "Отмечено: это ошибка" : "Отмечено: ошибки нет", {
        label: "Отменить",
        run: () => review.mutate({ example: e, decision: before }),
      });
  };
  useKeys({
    ArrowLeft: () => go(Math.max(0, at - 1)),
    ArrowRight: () => go(Math.min(examples.length - 1, at + 1)),
    KeyV: () => {
      if (example) decide(example, "agree");
    },
    KeyN: () => {
      if (example) decide(example, "disagree");
    },
    KeyO: () => {
      if (example) navigate(dialogOf(example));
    },
  });

  const place = stage === "log" ? "Логи" : "Симуляции";
  const header = (
    <Header
      title={c?.r.title ?? "Проблема"}
      step={stage === "log" ? 1 : 2}
      crumbs={[{ label: place, to: stageLink(stage, runId) }]}
      actions={
        c && (
          <Button variant="primary" icon={Send} aria-label="Задача для разработчика" onClick={() => setHandoff(true)}>
            <span className="hidden sm:inline">Задача для разработчика</span>
          </Button>
        )
      }
    />
  );
  if (offline && !state)
    return (
      <div className="flex h-full flex-col">
        {header}
        <ServiceDown />
      </div>
    );
  if (!data)
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="max-w-[860px] space-y-6 px-4 pt-12 lg:px-10">
          <Skeleton className="h-28" />
          <Skeleton className="h-[480px]" />
        </div>
      </div>
    );
  if (!c) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <EmptyState
          drop
          title="Такой проблемы больше нет"
          className="h-full justify-center"
          action={<Button onClick={() => navigate(stageLink(stage, runId))}>{place}</Button>}
        >
          После новой оценки критерии и их счёт меняются.
        </EmptyState>
      </div>
    );
  }

  const r = c.r;
  const s = r[stage];
  const other: Stage = stage === "log" ? "sim" : "log";
  const second = secondOf(s.examples);
  const humans = humansOf(s);
  const run = stage === "sim" ? state?.runs.find((x) => x.id === runId) : undefined;
  const link = `${window.location.origin}${problemLink(r.id, stage, runId)}`;
  const { condition, acceptable, quote, origin } = r.rule;
  const linkCls =
    "rounded-sm underline decoration-line-strong underline-offset-4 transition-colors hover:text-fg hover:decoration-fg-3";

  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="max-w-[880px] px-4 pb-24 pt-8 lg:px-10 lg:pt-12">
          <p className="text-read text-fg-3">
            {stage === "log"
              ? "Проблема в логах"
              : `Проблема в симуляции${run ? ` · прогон ${longDay(run.startedAt)}` : ""}`}
          </p>
          <h2 className="mt-1 text-balance text-page font-semibold text-fg">{r.title}</h2>
          <p className="mt-4 max-w-[68ch] text-lead text-fg-2">
            <span className="text-fg-3">Агент должен: </span>
            {r.rule.text}
            {(condition || acceptable) && !more && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => setMore(true)}
                  className="text-read font-medium text-run hover:underline"
                >
                  Когда и что допустимо
                </button>
              </>
            )}
          </p>
          {more && (
            <dl className="mt-3 max-w-[68ch] space-y-1.5 text-read text-fg-2">
              {condition && (
                <div>
                  <dt className="inline font-medium text-fg">Когда это важно: </dt>
                  <dd className="inline">{condition}</dd>
                </div>
              )}
              {acceptable && (
                <div>
                  <dt className="inline font-medium text-fg">Допустимо: </dt>
                  <dd className="inline">{acceptable}</dd>
                </div>
              )}
            </dl>
          )}

          <p className="mt-6 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-read text-fg-2">
            <Link to={conversationsLink(stage, { run: runId, v: "fail", rule: r.id })} className={linkCls}>
              <b className="text-count font-semibold tabular-nums text-fg">{s.failed}</b> из {checked(s)}{" "}
              {plural(checked(s), "разговора", "разговоров", "разговоров")}
            </Link>
            {second.checked > 0 && (
              <>
                <span aria-hidden className="text-fg-4">
                  ·
                </span>
                <span>
                  две проверки совпали в {second.agree} из {second.checked}
                </span>
              </>
            )}
            <span aria-hidden className="text-fg-4">
              ·
            </span>
            <Link
              to={reviewLink(stage, {
                run: runId,
                queue: humans.checked < humans.of ? "unchecked" : "all",
                rule: r.id,
              })}
              className={linkCls}
            >
              {humans.checked ? `вы ответили на ${humans.checked} из ${humans.of}` : "вы ещё не отвечали"}
            </Link>
          </p>
          {s.unknown > 0 && (
            <p className="mt-1.5 text-small text-fg-3">
              Ещё в {count(s.unknown, "разговоре", "разговорах", "разговорах")} проверить не удалось: в счёт они не
              входят.
            </p>
          )}
          {r[other].failed > 0 && (
            <Link
              to={problemLink(r.id, other)}
              className="mt-3 inline-flex items-center gap-1 text-read font-medium text-run hover:underline"
            >
              {other === "sim" ? "В симуляции" : "В логах"} тоже: {r[other].failed} из {checked(r[other])}
              <ArrowRight aria-hidden className="size-4" />
            </Link>
          )}

          <section aria-label="Примеры" className="mt-12">
            <div className="flex items-center gap-3">
              <h3 className="text-title font-semibold text-fg">
                Пример {examples.length ? at + 1 : 0}{" "}
                <span className="font-normal text-fg-3">из {examples.length}</span>
              </h3>
              <span className="flex-1" />
              <Button
                icon={ChevronLeft}
                aria-label="Предыдущий пример"
                kbd="←"
                disabled={at <= 0}
                onClick={() => go(at - 1)}
              />
              <Button
                icon={ChevronRight}
                aria-label="Следующий пример"
                kbd="→"
                disabled={at >= examples.length - 1}
                onClick={() => go(at + 1)}
              />
            </div>
            <div className="mt-4">
              {example ? (
                <div
                  key={`${example.dialogueId ?? example.runId}-${example.index ?? ""}`}
                  className={cn(
                    "duration-300 animate-in fade-in-0",
                    dir.current > 0 ? "slide-in-from-right-4" : "slide-in-from-left-4",
                  )}
                >
                  <ExampleCard example={example} lit={lit} onLit={setLit} onDecide={(d) => decide(example, d)} />
                </div>
              ) : (
                <p className="text-read text-fg-3">Примеров нет.</p>
              )}
            </div>
          </section>

          {stage === "log" && (
            <div className="mt-12 border-t border-line pt-8">
              <Reproduce r={r} />
            </div>
          )}

          <details className="group mt-10 border-t border-line pt-6">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-read font-medium text-fg-2 transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
              <Code2 aria-hidden className="size-4 text-fg-3" />
              Для разработчика
              <span aria-hidden className="text-fg-3 transition-transform group-open:rotate-90">
                ›
              </span>
            </summary>
            <div className="mt-4 space-y-3 text-read text-fg-2">
              <div>
                <span className="text-small text-fg-3">Требование в промпте агента</span>
                <blockquote className="mt-1 border-l-2 border-mark-strong pl-3 text-read text-fg">
                  {quote ? `«${quote}»` : "Цитата из кода не сохранена в этом прогоне."}
                </blockquote>
              </div>
              {origin && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body">
                  <span className="font-mono text-small text-fg-2">{shortOrigin(origin)}</span>
                  {r.rule.sourceId && (
                    <button
                      type="button"
                      onClick={() => setSource(true)}
                      className="inline-flex items-center gap-0.5 font-medium text-run hover:underline"
                    >
                      Текст промпта
                      <ArrowUpRight aria-hidden className="size-3.5" />
                    </button>
                  )}
                  <Link
                    to={criterionLink(r.id, { view: "code" })}
                    className="inline-flex items-center gap-0.5 font-medium text-run hover:underline"
                  >
                    В коде агента
                    <ArrowUpRight aria-hidden className="size-3.5" />
                  </Link>
                </div>
              )}
              <p className="text-body text-fg-3">
                Проверяли:{" "}
                <span className="font-mono text-small text-fg-2">
                  {[state?.models.main, state?.models.second].filter(Boolean).join(" и ")}
                </span>
              </p>
            </div>
          </details>
        </div>
      </div>
      <Handoff open={handoff} onClose={() => setHandoff(false)} r={r} side={stage} link={link} />
      <SourceSheet
        open={source}
        onClose={() => setSource(false)}
        sourceId={r.rule.sourceId}
        origin={r.rule.origin}
        quote={r.rule.quote}
      />
    </div>
  );
}
