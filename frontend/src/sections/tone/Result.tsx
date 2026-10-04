import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, FileText, History, RotateCcw } from "lucide-react";
import { conversationsLink, historyLink, reviewLink, toneCheckLink } from "../../app/links";
import { useCriteria } from "../../lab/criteria";
import { count } from "../../lab/format";
import { useProblems } from "../../lab/problems";
import { toneResult } from "../../lab/tone";
import type { LabState } from "../../lab/types";
import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/EmptyState";
import { queueOf } from "../problems/model";
import { seriousOf } from "../../lab/severity";
import { SeriousTag, SeverityStatus } from "../../product/Severity";
import { StageResult } from "../../product/StageResult";
import { Trust } from "../../product/Trust";
import { CompareLine, useComparison } from "../checks/Compare";
import { BriefSheet, ownCriteria, useToneBrief } from "./BriefSheet";
import { Finding } from "./Finding";
import { NextStage } from "./NextStage";

export function Result({ state, onAgain }: { state: LabState; onAgain: () => void }) {
  const result = toneResult(state);
  const { data, list } = useCriteria("tone");
  const evidence = useProblems("tone");
  const compare = useComparison("tone");
  const [selected, setSelected] = useState<string | null>(null);
  const [showReport, setShowReport] = useState(false);
  const brief = useToneBrief(state);
  if (!result) return null;
  const { summary } = result;
  const measured = summary.measured;
  const problems = queueOf(ownCriteria(result, list), "log");
  const selectedFinding = problems.find((c) => c.r.id === selected) ?? problems[0];
  const current = data?.log?.finishedAt === result.finishedAt;
  const previousRevision = result.criteriaRevision !== state.toneOfVoice?.revision;
  const modelError = !measured ? result.results.find((r) => r.error)?.error : null;
  return (
    <section aria-labelledby="tone-result-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-small font-medium text-fg-3">Проверка завершена</p>
          <h2 id="tone-result-title" className="mt-2 text-page font-semibold text-fg">
            {summary.failed
              ? "Что нашла модель"
              : measured
                ? "Модель не нашла ошибок общения"
                : "Разговоры не удалось проверить"}
          </h2>
          <p className="mt-2 text-body text-fg-3">
            В выборке {result.sampled}
            {"\u00a0"}из{"\u00a0"}
            {count(state.logs.total, "разговора", "разговоров", "разговоров")} ·{" "}
            {count(result.topics.flatMap((t) => t.rules).length, "критерий", "критерия", "критериев")}
          </p>
        </div>
        <Button
          className="hidden sm:inline-flex"
          size="lg"
          icon={FileText}
          disabled={!brief}
          onClick={() => setShowReport(true)}
        >
          Отчёт для письма
        </Button>
      </div>
      {previousRevision && (
        <div role="status" className="mt-5 rounded-block bg-inset p-4 text-read text-fg-2">
          Критерии изменились. Этот итог посчитан по их предыдущей версии.
          <Button className="mt-3 block" size="lg" onClick={onAgain} disabled={state.job.running}>
            Проверить по новым критериям
          </Button>
        </div>
      )}
      {measured > 0 && (
        <div className="my-8">
          <StageResult
            failed={summary.failed}
            checked={measured}
            unchecked={summary.unmeasured}
            size="display"
            link={(part) => conversationsLink("tone", { v: { bad: "fail", ok: "pass", none: "none" }[part] })}
          />
          <Trust
            result={result}
            check="tone"
            serious={current && <SeverityStatus data={data} check="tone" />}
            compare={
              <CompareLine check="tone" compare={compare} serious={current ? seriousOf(data)?.marked : undefined} />
            }
            className="mt-4"
          />
          <Link
            to={conversationsLink("tone")}
            className="mt-4 inline-flex items-center gap-1 text-read font-medium text-run hover:underline"
          >
            Все разговоры
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        </div>
      )}
      {modelError && (
        <div role="alert" className="mb-6 text-read text-fg-2">
          <p>Модель не ответила. Проверьте настройки и запустите проверку снова.</p>
          <Link to="/settings" className="mt-2 inline-block text-run underline">
            Настройки моделей
          </Link>
          <details className="mt-2 text-body text-fg-3">
            <summary className="cursor-pointer">Причина</summary>
            <p className="mt-1 break-words">{modelError}</p>
          </details>
        </div>
      )}
      {!current ? (
        evidence.error ? (
          <div role="alert" className="py-5 text-read text-fg-2">
            <p>Не удалось загрузить находки. Итог проверки сохранён.</p>
            <Button className="mt-3" size="lg" onClick={() => void evidence.refetch()}>
              Загрузить снова
            </Button>
          </div>
        ) : (
          <Skeleton className="h-80" />
        )
      ) : selectedFinding ? (
        <>
          <div
            id="tone-finding"
            tabIndex={-1}
            className="mb-3 flex scroll-mt-6 flex-wrap items-baseline justify-between gap-2 outline-none"
          >
            <h3 className="text-lead font-semibold text-fg">
              {selected ? "Выбранная находка" : "Начните с этой находки"}
            </h3>
            <span className="text-small text-fg-3">
              {problems.some((c) => c.r.serious) ? "Серьёзные первыми, дальше по частоте" : "По частоте в этой выборке"}
            </span>
          </div>
          <Finding
            key={result.finishedAt + "-" + selectedFinding.r.id}
            criterion={selectedFinding}
            result={result}
            draft={state.toneOfVoice}
            busy={state.job.running}
          />
          {problems.length > 1 && (
            <div className="mt-8">
              <h3 className="text-lead font-semibold text-fg">Другие находки</h3>
              <ul className="mt-3 divide-y divide-line">
                {problems
                  .filter((c) => c.r.id !== selectedFinding.r.id)
                  .map((c) => (
                    <li key={c.r.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(c.r.id);
                          document.getElementById("tone-finding")?.scrollIntoView({ block: "start" });
                          document.getElementById("tone-finding")?.focus({ preventScroll: true });
                        }}
                        className="flex min-h-16 w-full items-center gap-4 rounded-control px-2 py-4 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-read font-medium text-fg">
                            {c.r.title.replace(/^Ошибка:\s*/i, "")}
                            {c.r.serious && <SeriousTag rule={c.r} className="relative -top-px ml-2 align-middle" />}
                          </span>
                          <span className="mt-1 block text-small text-fg-3">
                            Критерий{"\u00a0"}
                            {c.n} · {c.name}
                          </span>
                        </span>
                        <span className="shrink-0 text-body tabular-nums text-fg-2">
                          {c.r.log.failed}
                          {"\u00a0"}из{"\u00a0"}
                          {c.r.log.failed + c.r.log.passed}
                        </span>
                        <ArrowRight aria-hidden className="size-4 shrink-0 text-fg-3" />
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <div className="py-5 text-read text-fg-2">
          <p>
            {measured
              ? "Чтобы доверять итогу, проверьте несколько оценок вручную."
              : "Посмотрите, почему разговоры не удалось проверить."}
          </p>
          <Link
            to={measured ? reviewLink("tone") : conversationsLink("tone", { v: "none" })}
            className="mt-4 inline-flex min-h-11 items-center gap-2 font-medium text-run hover:underline"
          >
            {measured ? "Проверить оценки вручную" : "Посмотреть разговоры"}
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        </div>
      )}
      <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-line pt-5">
        <Button className="sm:hidden" size="lg" icon={FileText} disabled={!brief} onClick={() => setShowReport(true)}>
          Отчёт для письма
        </Button>
        <Link
          to={reviewLink("tone")}
          className="inline-flex min-h-11 items-center gap-1 text-body font-medium text-run hover:underline"
        >
          Проверить оценки вручную
          <ArrowRight aria-hidden className="size-4" />
        </Link>
        <Button variant="ghost" size="lg" icon={RotateCcw} disabled={state.job.running} onClick={onAgain}>
          Проверить снова
        </Button>
        <Link
          to={toneCheckLink("materials")}
          className="inline-flex min-h-11 items-center text-body text-fg-2 hover:underline"
        >
          Загрузить новую выгрузку
        </Link>
        <Link
          to={historyLink("tone")}
          className="inline-flex min-h-11 items-center gap-1.5 text-body text-fg-2 hover:underline"
        >
          <History aria-hidden className="size-4 text-fg-3" />
          История проверок
        </Link>
      </div>
      <NextStage state={state} onRecheck={onAgain} />
      <BriefSheet open={showReport} onClose={() => setShowReport(false)} brief={brief} />
    </section>
  );
}
