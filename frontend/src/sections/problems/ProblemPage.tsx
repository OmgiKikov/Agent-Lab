import { useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Code2,
  PencilLine,
  Send,
  WandSparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Header } from "../../app/Header";
import { useKeys } from "../../app/keys";
import {
  conversationsLink,
  criterionLink,
  problemLink,
  reviewLink,
  side,
  stageLink,
  type Stage,
} from "../../app/links";
import { CHECK_NAME } from "../../lab/checks";
import { dialogOf } from "../../lab/dialogs";
import { useCriteria } from "../../lab/criteria";
import { Duty } from "../../product/Duty";
import { count, longDay, plural } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { answersWait, useReview, type Decision, type Example } from "../../lab/problems";
import { humansOf, rightOf, rightText, secondOf } from "../../lab/problemStats";
import { yesNoText } from "../../lab/answers";
import { conversationKey, exampleAt } from "../../lab/verdicts";
import { ExampleCard } from "../../product/ExampleCard";
import { SeverityControl } from "../../product/Severity";
import { SourceSheet } from "../../product/SourceSheet";
import { shortOrigin } from "../../product/text";
import { Button } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { useToast } from "../../ui/toast";
import { NoSuchRun, useSimRuns } from "../simulations/stage";
import { Advice } from "../tone/Advice";
import { Handoff } from "./Handoff";
import { Reproduce } from "./Reproduce";
import { checked, violationsOf } from "./model";
import { shareBase } from "../../app/agent";

/**
 * One problem, read top to bottom: what the agent does wrong, what it must do instead, whether its errors are serious
 * («Серьёзная ошибка» on its criterion, with whose decision it is: the automatic check's proposal with its reason and
 * «Подтвердить», or the person's), how often (one line of numbers), then the case itself — the conversation as the
 * customer saw it — and the person's answer. One stage at a time: in a check, its conversations; in the simulation,
 * one run of that check's scenarios. The other is one link away. Another problem of the same stage opens afresh: the
 * page is keyed by the problem, so nothing unfolded, opened or lit on one stays on the next.
 */
export function ProblemPage({ stage }: { stage: Stage }) {
  const { id = "" } = useParams();
  return <Problem key={id} stage={stage} id={id} />;
}

function Problem({ stage, id }: { stage: Stage; id: string }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { state, offline } = useLabState();
  const { run: simRun, newest, missing } = useSimRuns(state, stage === "sim" ? params.get("run") : null);
  // A check's problem is of that check; a run's, of the check whose scenarios it played.
  const check = stage === "sim" ? (simRun?.check ?? null) : stage;
  const { data, list, error, retry } = useCriteria(check, stage === "sim" ? (simRun?.id ?? null) : null);
  const here = side(stage);
  const review = useReview();
  const [lit, setLit] = useState(false);
  const [handoff, setHandoff] = useState(false);
  const [source, setSource] = useState(false);
  const [more, setMore] = useState(false);
  const [advice, setAdvice] = useState<"clarify" | "rewrite" | null>(null);
  const dir = useRef<1 | -1>(1);
  const c = list.find((x) => x.r.id === id);
  const runId = stage === "sim" ? (data?.sim?.runId ?? null) : null;

  const examples = c ? violationsOf(c, here) : [];
  const toneDraft = state?.toneOfVoice ?? null;
  const toneResult = state?.checks.tone ?? null;
  const toneNow = stage === "tone" && !!toneDraft && !!toneResult && toneResult.criteriaRevision === toneDraft.revision;
  const { at, missing: lostExample } = exampleAt(examples, params.get("e"));
  const example = examples[at];
  /** The example in the address by its conversation: «Нет» sends it to the end of the order, it stays on screen. */
  const pin = (e: Example) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.set("e", conversationKey(e));
        return p;
      },
      { replace: true },
    );
  const go = (n: number) => {
    if (!examples[n]) return;
    dir.current = n >= at ? 1 : -1;
    pin(examples[n]);
  };
  const decide = (e: Example, d: Decision) => {
    if (answersWait(state, e)) return;
    if (params.get("e") !== conversationKey(e)) pin(e);
    const before = e.review;
    const next = e.review === d ? null : d;
    // The check's result the examples come from: the service takes the answer only on it.
    const finishedAt = data?.log?.finishedAt;
    review.mutate({ example: e, decision: next, finishedAt });
    if (next)
      toast.notify(next === "agree" ? "Отмечено как ошибка" : "Отмечено, что ошибки нет", {
        label: "Отменить",
        run: () => review.mutate({ example: e, decision: before, finishedAt, seen: next }),
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

  const place = stage === "sim" ? "Симуляции" : CHECK_NAME[stage];
  const header = (
    <Header
      title={c?.r.title ?? "Проблема"}
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
  if (missing)
    return (
      <div className="flex h-full flex-col">
        {header}
        <NoSuchRun newest={newest} />
      </div>
    );
  if (!data && error)
    return (
      <div className="flex h-full flex-col">
        {header}
        <LoadFailed page title="Не удалось загрузить проблему" error={error} onRetry={retry} />
      </div>
    );
  // Without any run the simulation has no problems to wait for.
  if (!data && !(stage === "sim" && state && !simRun))
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="max-w-[860px] space-y-6 px-4 pt-12 lg:px-10">
          <Skeleton className="h-28" />
          <Skeleton className="h-[480px]" />
        </div>
      </div>
    );
  if (!c || !data) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <EmptyState
          drop
          title="Такой проблемы больше нет"
          className="h-full justify-center"
          action={<Button onClick={() => navigate(stageLink(stage, runId))}>{place}</Button>}
        >
          После новой проверки критерии и счёт меняются.
        </EmptyState>
      </div>
    );
  }

  const r = c.r;
  const s = r[here];
  const second = secondOf(s.examples);
  const humans = humansOf(s);
  const right = rightText(rightOf(s));
  const run = stage === "sim" ? state?.runs.find((x) => x.id === runId) : undefined;
  const link = `${shareBase()}${problemLink(r.id, stage, runId)}`;
  const { condition, acceptable, quote, origin } = r.rule;
  const tone = r.rule.kind === "tone-of-voice";
  const linkCls =
    "rounded-sm underline decoration-line-strong underline-offset-4 transition-colors hover:text-fg hover:decoration-fg-3";

  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="max-w-[880px] px-4 pb-24 pt-8 lg:px-10 lg:pt-12">
          <p className="text-read text-fg-3">
            {stage === "sim"
              ? `Проблема в симуляции${run ? ` · прогон ${longDay(run.startedAt)}` : ""}`
              : `Проблема в диалогах · ${CHECK_NAME[stage]}`}
          </p>
          <h2 className="mt-1 text-balance text-page font-semibold text-fg">{r.title}</h2>
          <Duty key={r.id} text={r.rule.text} className="mt-4 max-w-[68ch] text-lead text-fg-2" />
          {(condition || acceptable) && !more && (
            <button
              type="button"
              onClick={() => setMore(true)}
              className="mt-2 text-read font-medium text-run hover:underline"
            >
              Когда применяется и что допустимо
            </button>
          )}
          {more && (
            <dl className="mt-3 max-w-[68ch] space-y-1.5 text-read text-fg-2">
              {condition && (
                <div>
                  <dt className="inline font-medium text-fg">Когда применяется: </dt>
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
          {/* The decision belongs to the criterion of the check, the same from its run's problem. */}
          {check && <SeverityControl check={check} rule={r} className="mt-5 max-w-[68ch]" />}

          <p className="mt-6 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-read text-fg-2">
            <Link to={conversationsLink(stage, { run: runId, v: "fail", rule: r.id })} className={linkCls}>
              <b className="text-count font-semibold tabular-nums text-fg">{s.failed}</b>
              {"\u00a0"}из{"\u00a0"}
              {checked(s)}
              {"\u00a0"}
              {plural(checked(s), "разговора", "разговоров", "разговоров")}
              <span className="text-fg-3">, где критерий удалось проверить</span>
            </Link>
            {second.checked > 0 && (
              <>
                <span aria-hidden className="text-fg-4">
                  ·
                </span>
                <span>
                  две модели совпали в {second.agree}
                  {"\u00a0"}из{"\u00a0"}
                  {second.checked}
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
              {humans.checked
                ? `вы ответили на ${humans.checked}\u00a0из\u00a0${humans.of}: ${yesNoText(humans.agree, humans.checked - humans.agree)}`
                : "вы ещё не отвечали"}
            </Link>
          </p>
          {right && <p className="mt-1.5 max-w-[72ch] text-read text-fg-2">{right}</p>}
          {s.unknown > 0 && (
            <p className="mt-1.5 text-small text-fg-3">
              Ещё в {count(s.unknown, "разговоре", "разговорах", "разговорах")} критерий не удалось проверить. В счёт
              они не входят.
            </p>
          )}
          {/* The same criterion on the other side: a check's last run, or the conversations of the run's check. */}
          {stage === "sim"
            ? r.log.failed > 0 &&
              data.check && (
                <Link
                  to={problemLink(r.id, data.check)}
                  className="mt-3 inline-flex items-center gap-1 text-read font-medium text-run hover:underline"
                >
                  В диалогах тоже: {r.log.failed}
                  {"\u00a0"}из{"\u00a0"}
                  {checked(r.log)}
                  <ArrowRight aria-hidden className="size-4" />
                </Link>
              )
            : r.sim.failed > 0 &&
              data.sim && (
                <Link
                  to={problemLink(r.id, "sim", data.sim.runId)}
                  className="mt-3 inline-flex items-center gap-1 text-read font-medium text-run hover:underline"
                >
                  В симуляции тоже: {r.sim.failed}
                  {"\u00a0"}из{"\u00a0"}
                  {checked(r.sim)}
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
            {/* The case an address names is not among the examples now: another one is shown, and that is said. */}
            {lostExample && example && (
              <p role="status" className="mt-3 text-read text-fg-3">
                Случая из ссылки среди примеров нет. Показан пример{"\u00a0"}
                {at + 1}.
              </p>
            )}
            <div className="mt-4">
              {example ? (
                <div
                  key={`${example.dialogueId ?? example.runId}-${example.index ?? ""}`}
                  className={cn(
                    "duration-300 animate-in fade-in-0",
                    dir.current > 0 ? "slide-in-from-right-4" : "slide-in-from-left-4",
                  )}
                >
                  <ExampleCard
                    example={example}
                    lit={lit}
                    onLit={setLit}
                    onDecide={(d) => decide(example, d)}
                    actions={
                      // Tone of voice learns from people: a case that is no error clarifies its criterion for the next
                      // check; an error can come with a better reply. Only on the result of the criteria in force.
                      toneNow && example.status === "FAIL" ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {example.review === "disagree" && (
                            <Button icon={PencilLine} onClick={() => setAdvice("clarify")}>
                              Уточнить критерий
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            icon={WandSparkles}
                            disabled={!example.agentQuote}
                            onClick={() => setAdvice("rewrite")}
                          >
                            Как ответить правильно
                          </Button>
                        </div>
                      ) : undefined
                    }
                  />
                </div>
              ) : (
                <p className="text-read text-fg-3">Примеров нет.</p>
              )}
            </div>
          </section>

          {stage !== "sim" && (
            <div className="mt-12 border-t border-line pt-8">
              <Reproduce r={r} check={stage} />
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
                <span className="text-small text-fg-3">
                  {tone ? "Цитата из правил общения" : "Цитата из кода агента"}
                </span>
                <blockquote className="mt-1 border-l-2 border-mark-strong pl-3 text-read text-fg">
                  {quote ? `«${quote}»` : tone ? "Цитата из правил не сохранена." : "Цитата из кода не сохранена."}
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
                      Весь текст
                      <ArrowUpRight aria-hidden className="size-3.5" />
                    </button>
                  )}
                  {/* The rules of communication are not in the agent's code: their text opens above. */}
                  {!tone && (
                    <Link
                      to={criterionLink("code", r.id, { view: "code" })}
                      className="inline-flex items-center gap-0.5 font-medium text-run hover:underline"
                    >
                      В коде агента
                      <ArrowUpRight aria-hidden className="size-3.5" />
                    </Link>
                  )}
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
      <Handoff open={handoff} onClose={() => setHandoff(false)} r={r} side={here} link={link} />
      {advice && example && toneDraft && toneResult && (
        <Advice
          key={`${conversationKey(example)}-${advice}`}
          mode={advice}
          example={example}
          finishedAt={toneResult.finishedAt}
          draft={toneDraft}
          onClose={() => setAdvice(null)}
        />
      )}
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
