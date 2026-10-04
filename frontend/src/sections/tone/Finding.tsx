import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Check, ChevronLeft, ChevronRight, PencilLine, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { conversationsLink } from "../../app/links";
import type { Criterion } from "../../lab/criteria";
import { dialogOf } from "../../lab/dialogs";
import { count } from "../../lab/format";
import { reliabilityWord } from "../../lab/problemReport";
import { useReview } from "../../lab/problems";
import type { Discover, ToneDraft } from "../../lab/types";
import { Button } from "../../ui/Button";
import { Advice } from "./Advice";

/** A finding keeps the evidence, its original criterion and the person's decision together. */
export function Finding({
  criterion: c,
  result,
  draft,
  busy,
}: {
  criterion: Criterion;
  result: Discover;
  draft?: ToneDraft | null;
  busy: boolean;
}) {
  const examples = c.r.log.examples.filter((e) => e.status === "FAIL");
  const [chosen, setChosen] = useState<string | null>(examples[0]?.dialogueId ?? null);
  const [mode, setMode] = useState<"rewrite" | "clarify" | null>(null);
  const e = examples.find((x) => x.dialogueId === chosen) ?? examples[0];
  const at = examples.indexOf(e);
  const review = useReview();
  const current = result.criteriaRevision === draft?.revision;
  const savedCriterion = result.topics.flatMap((t) => t.rules).find((r) => r.id === e?.ruleId);
  if (!e) return null;
  const decide = (decision: "agree" | "disagree") =>
    review.mutate({
      example: e,
      decision: e.review === decision ? null : decision,
      finishedAt: result.finishedAt,
    });
  return (
    <article aria-label={`Находка: ${c.name}`} className="overflow-hidden rounded-sheet border border-line bg-canvas">
      <div className="px-5 pb-5 pt-6 sm:px-7">
        <div className="flex flex-wrap items-center justify-between gap-3 text-small text-fg-3">
          <span>
            Критерий {c.n} · {c.name}
          </span>
          <Link
            to={conversationsLink("tone", { rule: c.r.id, v: "fail" })}
            className="font-medium text-run hover:underline"
          >
            {c.r.log.failed}
            {"\u00a0"}из {count(c.r.log.failed + c.r.log.passed, "разговора", "разговоров", "разговоров")}
          </Link>
        </div>
        <h3 className="mt-3 text-title font-semibold text-fg">{c.r.title.replace(/^Ошибка:\s*/i, "")}</h3>
        <p className="mt-2 text-read text-fg-2">{e.reason}</p>
      </div>
      <div className="bg-inset px-5 py-5 sm:px-7">
        <p className="text-small text-fg-3">Клиент</p>
        <p className="mt-1 text-read text-fg-2">{e.opening}</p>
        <p className="mt-4 text-small text-fg-3">Фрагмент ответа агента</p>
        <blockquote className="mt-2 whitespace-pre-wrap break-words text-lead text-fg">
          {e.agentQuote ? (
            <mark className="bg-mark px-0.5 text-fg">{e.agentQuote}</mark>
          ) : (
            "Цитата не сохранена. Посмотрите разговор целиком."
          )}
        </blockquote>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <Link
            to={dialogOf(e)}
            className="inline-flex min-h-11 items-center gap-1 text-body font-medium text-run hover:underline"
          >
            Весь разговор
            <ArrowUpRight aria-hidden className="size-4" />
          </Link>
          {examples.length > 1 && (
            <div className="flex items-center gap-2">
              <Button
                size="lg"
                icon={ChevronLeft}
                aria-label="Предыдущий пример"
                disabled={at === 0}
                onClick={() => setChosen(examples[at - 1].dialogueId!)}
              />
              <span className="text-small tabular-nums text-fg-3">
                {at + 1} / {examples.length}
              </span>
              <Button
                size="lg"
                icon={ChevronRight}
                aria-label="Следующий пример"
                disabled={at === examples.length - 1}
                onClick={() => setChosen(examples[at + 1].dialogueId!)}
              />
            </div>
          )}
        </div>
      </div>
      <div className="px-5 py-5 sm:px-7">
        <details className="text-read">
          <summary className="cursor-pointer py-1 font-medium text-fg">Основание и исключения из ваших правил</summary>
          <div className="mt-3 max-h-72 space-y-4 overflow-auto rounded-control bg-inset p-4">
            <blockquote className="whitespace-pre-wrap break-words border-l-2 border-mark-strong pl-3 text-body text-fg-2">
              {c.r.rule.quote || c.r.rule.text}
            </blockquote>
            {c.r.rule.condition && <p className="whitespace-pre-wrap text-body text-fg-3">{c.r.rule.condition}</p>}
            {c.r.rule.acceptable && (
              <div>
                <p className="text-small font-medium text-fg">Исключения и общие принципы</p>
                <p className="mt-1 whitespace-pre-wrap text-body text-fg-2">{c.r.rule.acceptable}</p>
              </div>
            )}
            {!!savedCriterion?.clarifications?.length && (
              <div>
                <p className="text-small font-medium text-fg">Ваши уточнения в этой проверке</p>
                {savedCriterion.clarifications.map((text, i) => (
                  <p key={i} className="mt-2 whitespace-pre-wrap text-body text-fg-2">
                    {text}
                  </p>
                ))}
              </div>
            )}
          </div>
        </details>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-5">
          <div>
            <p className="text-read font-medium text-fg">Это действительно ошибка?</p>
            <p aria-live="polite" className="mt-1 text-small text-fg-3">
              {review.isPending ? "Сохраняем ответ…" : e.review || e.second ? reliabilityWord(e) : ""}
            </p>
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            <Button
              size="lg"
              icon={X}
              className={cn(
                "flex-1 sm:min-w-[104px] sm:flex-none",
                e.review === "disagree" && "bg-bad/10 text-bad hover:bg-bad/15",
              )}
              disabled={busy || review.isPending}
              aria-pressed={e.review === "disagree"}
              onClick={() => decide("disagree")}
            >
              Нет
            </Button>
            <Button
              size="lg"
              className={cn(
                "flex-1 sm:min-w-[104px] sm:flex-none",
                e.review === "agree" && "bg-ok/10 text-ok hover:bg-ok/15",
              )}
              variant={e.review === "agree" ? "outline" : "primary"}
              icon={Check}
              disabled={busy || review.isPending}
              aria-pressed={e.review === "agree"}
              onClick={() => decide("agree")}
            >
              Да
            </Button>
          </div>
        </div>
        {current && draft && (
          <div className="mt-4 flex flex-wrap gap-2">
            {e.review === "disagree" && (
              <Button size="lg" icon={PencilLine} disabled={busy} onClick={() => setMode("clarify")}>
                Уточнить критерий
              </Button>
            )}
            <Button size="lg" variant="ghost" disabled={busy || !e.agentQuote} onClick={() => setMode("rewrite")}>
              Как можно переформулировать
            </Button>
          </div>
        )}
        {e.review === "agree" && (
          <p className="mt-3 text-body text-fg-3">
            Добавьте подтверждённый пример в отчёт для команды. Следующая выгрузка поможет проверить, встречается ли эта
            проблема снова.
          </p>
        )}
        {review.isError && (
          <p role="alert" className="mt-3 text-body text-bad">
            Не удалось сохранить ответ. Попробуйте ещё раз.
          </p>
        )}
      </div>
      {mode && draft && (
        <Advice
          key={`${e.dialogueId}-${mode}`}
          mode={mode}
          example={e}
          finishedAt={result.finishedAt}
          draft={draft}
          onClose={() => setMode(null)}
        />
      )}
    </article>
  );
}
