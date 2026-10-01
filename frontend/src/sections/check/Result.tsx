import { Link } from "react-router-dom";
import { ArrowRight, Download, RotateCcw } from "lucide-react";
import { conversationsLink, reviewLink } from "../../app/links";
import { useCriteria } from "../../lab/criteria";
import { download, problemsReport } from "../../lab/problemReport";
import { toneResult } from "../../lab/tone";
import type { LabState } from "../../lab/types";
import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/EmptyState";
import { ProblemList } from "../problems/ProblemList";

export function Result({ state, onAgain }: { state: LabState; onAgain: () => void }) {
  const result = toneResult(state);
  const { data, list } = useCriteria(null);
  if (!result) return null;
  const summary = result.summary;
  const measured = summary.measured;
  const percentage = measured ? Math.round((100 * summary.passed) / measured) : null;
  const quotes = new Set(result.topics.flatMap((t) => t.rules.map((r) => r.quote)));
  const own = list.filter((c) => quotes.has(c.r.rule.quote));
  const current = data?.log?.finishedAt === result.finishedAt;
  const report = data && current ? { ...data, rules: data.rules.filter((r) => quotes.has(r.rule.quote)) } : null;
  const modelError = !measured ? result.results.find((r) => r.error)?.error : null;
  const outcomes = [
    { label: "Без найденных ошибок", n: summary.passed, verdict: "pass", cls: "text-fg" },
    { label: "С ошибкой tone of voice", n: summary.failed, verdict: "fail", cls: "text-bad" },
    { label: "Не удалось оценить", n: summary.unmeasured, verdict: "none", cls: "text-fg-3" },
  ];
  return (
    <section aria-labelledby="tone-result-title">
      <h2 id="tone-result-title" className="text-title font-semibold text-fg">
        Результат проверки tone of voice
      </h2>
      {percentage !== null ? (
        <Link
          to={conversationsLink("log", { v: "pass" })}
          className="mt-7 inline-block rounded-block text-hero font-semibold tabular-nums text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run"
        >
          {percentage === null ? "—" : `${percentage}%`}
        </Link>
      ) : (
        <p className="mt-7 text-hero font-semibold text-fg">—</p>
      )}
      <p className="mt-2 text-lead text-fg-2">
        {measured
          ? `${summary.passed} из ${measured} проверенных разговоров — без найденных ошибок`
          : modelError
            ? "Модель проверки не ответила. Проверьте настройки и запустите оценку снова."
            : "Не хватило данных для оценки. Посмотрите разговоры и уточните критерии."}
      </p>
      <p className="mt-2 text-body text-fg-3">
        В выборке {result.sampled} из {state.logs.total} разговоров. Критериев:{" "}
        {result.topics.flatMap((t) => t.rules).length}.
      </p>
      {modelError && (
        <div className="mt-4 text-body text-fg-3">
          <Link to="/settings" className="text-run underline">
            Настройки моделей
          </Link>
          <details className="mt-2">
            <summary className="cursor-pointer">Причина</summary>
            <p className="mt-1">{modelError}</p>
          </details>
        </div>
      )}
      <div className="mt-7 grid grid-cols-3 gap-3 border-y border-line py-5 sm:gap-5">
        {outcomes.map((o) => (
          <Link
            key={o.verdict}
            to={conversationsLink("log", { v: o.verdict })}
            className="rounded-control hover:bg-hover"
          >
            <span className={`block text-page font-semibold tabular-nums ${o.cls}`}>{o.n}</span>
            <span className="mt-1 block text-body text-fg-3">{o.label}</span>
          </Link>
        ))}
      </div>
      <div className="mt-7 flex flex-wrap items-center gap-3">
        <Link to={conversationsLink("log", { v: summary.failed ? "fail" : "all" })}>
          <Button variant="primary" size="lg">
            Посмотреть разговоры
            <ArrowRight aria-hidden className="size-4" />
          </Button>
        </Link>
        <Button
          icon={Download}
          disabled={!report}
          onClick={() => report && download("tone-of-voice.md", problemsReport(report, window.location.origin, "log"))}
        >
          Скачать отчёт
        </Button>
        <Button variant="ghost" icon={RotateCcw} onClick={onAgain}>
          Проверить снова
        </Button>
      </div>
      <div className="mt-12">
        <h3 className="text-lead font-semibold text-fg">Где агент ошибается</h3>
        {current ? <ProblemList list={own} stage="log" /> : <Skeleton className="mt-4 h-32" />}
      </div>
      <Link to={reviewLink("log")} className="mt-4 inline-flex items-center gap-1 text-read text-run hover:underline">
        Проверить оценки вручную
        <ArrowRight aria-hidden className="size-4" />
      </Link>
    </section>
  );
}
