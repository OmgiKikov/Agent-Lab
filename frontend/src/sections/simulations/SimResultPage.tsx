import { Link, Navigate, useSearchParams } from "react-router-dom";
import { ArrowRight, ChevronDown, Hammer, Play, RotateCcw } from "lucide-react";
import { scenariosLink } from "../../app/links";
import { api } from "../../lab/api";
import { BY_CRITERIA, deckCriteria } from "../../lab/checks";
import { useCriteria } from "../../lab/criteria";
import { dialogOf } from "../../lab/dialogs";
import { count, longDay, plural } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { summarySentence } from "../../lab/problemReport";
import { isRunning, runTitle, useRun } from "../../lab/runs";
import type { LabRun, LabState, RunSummary } from "../../lab/types";
import { StageResult } from "../../product/StageResult";
import { Button } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { Menu } from "../../ui/Menu";
import { useToast } from "../../ui/toast";
import { ProblemList } from "../problems/ProblemList";
import { RunMatrix } from "./RunMatrix";
import { NoSuchRun, SimHeader, useSimRuns } from "./stage";

/**
 * «Симуляции»: synthetic customers play business scenarios with the agent, built from the conversations of the export,
 * and one check's criteria judge them. The result of one run as one number, the scenarios against the types of customers, and
 * the problems it found. Counted on its own: other conversations, other customers than the export.
 */
export function SimResultPage() {
  const [params] = useSearchParams();
  // Earlier addresses: the scenarios mode, a run as «r».
  if (params.get("mode") === "scenarios") return <Navigate to={scenariosLink(params.get("s") ?? undefined)} replace />;
  if (params.get("r") && !params.get("run"))
    return <Navigate to={`/simulations?run=${encodeURIComponent(params.get("r")!)}`} replace />;
  return <SimResult />;
}

function SimResult() {
  const { state, offline } = useLabState();
  const [params, setParams] = useSearchParams();
  const { finished, run, newest, missing } = useSimRuns(state, params.get("run"));
  const criteria = useCriteria(run?.check ?? null, run && !isRunning(run) ? run.id : null);
  const { data, list } = criteria;
  const header = <SimHeader runId={run?.id ?? null} />;
  if (offline && !state)
    return (
      <div className="flex h-full flex-col">
        {header}
        <ServiceDown />
      </div>
    );
  if (!state)
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="space-y-6 px-4 pt-10 lg:px-10">
          <Skeleton className="h-36 max-w-3xl" />
          <Skeleton className="h-80 max-w-5xl" />
        </div>
      </div>
    );
  if (missing)
    return (
      <div className="flex h-full flex-col">
        {header}
        <NoSuchRun newest={newest} />
      </div>
    );
  if (!run) {
    const deck = state.cards?.cards.length ? state.cards : null;
    // Built before any check, the scenarios can be read, not played: no «Сыграть» for them.
    const playable = !!deck?.cards.some((card) => card.criteria.length);
    const ask = (play: string) => setParams({ play }, { replace: true });
    const open = (
      <Link to={scenariosLink()}>
        <Button variant={playable ? "outline" : "primary"} icon={Hammer}>
          Открыть сценарии
        </Button>
      </Link>
    );
    // The scenarios built stay here until the next run: coming back to the simulation shows them, never a blank page.
    return (
      <div className="flex h-full flex-col">
        {header}
        {deck ? (
          <EmptyState
            drop
            title={`Собрано ${count(deck.cards.length, "сценарий", "сценария", "сценариев")} ${deckCriteria(deck.check)}`}
            className="h-full justify-center"
            action={
              <>
                {open}
                {playable && (
                  <Button variant="primary" icon={Play} onClick={() => ask("1")}>
                    Сыграть сценарии
                  </Button>
                )}
              </>
            }
          >
            {deck.createdAt ? `Собраны ${longDay(deck.createdAt)}. ` : ""}
            {playable
              ? "Прогонов ещё не было: синтетические клиенты сыграют сценарии с агентом, разговоры оценят по критериям проверки."
              : "Видны клиенты настоящих разговоров и их бизнес-сценарии. Чтобы сыграть их, проверьте разговоры и соберите сценарии заново."}
          </EmptyState>
        ) : (
          <EmptyState
            drop
            title="Здесь будет итог прогона"
            className="h-full justify-center"
            action={
              <Link to={scenariosLink()}>
                <Button variant="primary" icon={Hammer}>
                  Открыть сценарии
                </Button>
              </Link>
            }
          >
            Синтетические клиенты сыграют с агентом сценарии из настоящих разговоров. Разговоры оценят по критериям
            проверки.
          </EmptyState>
        )}
      </div>
    );
  }

  const m = run.metric;
  const total = m?.total ?? run.items?.length ?? 0;
  const live = isRunning(run);
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="max-w-[1040px] px-4 pb-24 pt-8 lg:px-10 lg:pt-12">
          <RunLine
            run={run}
            finished={finished}
            state={state}
            onPick={(id) => setParams({ run: id }, { replace: true })}
          />
          {live ? (
            <Live run={run} state={state} />
          ) : m?.measured ? (
            <StageResult
              className="mt-4"
              failed={m.failed}
              checked={m.measured}
              unchecked={Math.max(0, total - m.measured)}
            />
          ) : run.status === "failed" ? (
            // Why, in place: «Агент не ответил ни в одном разговоре. …» (backend simulate.unanswered).
            <div className="mt-6">
              <p className="text-title font-semibold text-fg">Прогон прервался</p>
              {run.error && <p className="mt-2 max-w-[68ch] text-lead text-fg-2">{run.error}</p>}
            </div>
          ) : (
            <p className="mt-6 text-title font-semibold text-fg">Разговоры этого прогона ещё не оценены</p>
          )}
          {!live && m?.sets && Object.keys(m.sets).length > 0 && (
            <p className="mt-3 max-w-[68ch] text-read text-fg-2">
              {Object.keys(m.sets).length > 1 ? "Наборы считаются отдельно: " : ""}
              {Object.entries(m.sets)
                .map(([key, s]) => `${SET_NAMES[key] ?? key}: ошибка в ${s.measured - s.passed} из ${s.measured}`)
                .join(" · ")}
              {m.sets.representative?.partial && ". Сыграна только часть сценариев, не вся выгрузка"}
            </p>
          )}
          <Matrix run={run} state={state} />
          {!live && (data?.sim || criteria.loading || criteria.error) && (
            <section aria-label="Проблемы" className="mt-16">
              <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-line pb-3">
                <h2 className="text-title font-semibold text-fg">Проблемы</h2>
                {data?.sim && <p className="text-read text-fg-3">{summarySentence(data, "sim")}</p>}
              </div>
              <div className="mt-2">
                <ProblemList list={list} record={criteria} stage="sim" runId={run.id} />
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

const SET_NAMES: Record<string, string> = {
  representative: "все сценарии",
  stress: "стрессовый",
};

/** A run that is still playing: how many conversations are done, filling in as the agent answers. */
function Live({ run, state }: { run: LabRun; state: LabState }) {
  const job = state.job.running && state.job.progress.run === run.id ? state.job.progress : null;
  const done = job?.done ?? run.items?.length ?? 0;
  const total = job?.total ?? 0;
  return (
    <div className="mt-4" role="status">
      <p className="font-semibold leading-none tracking-tight text-fg">
        <span className="text-hero tabular-nums">{done}</span>
        {total > 0 && (
          <span className="text-display font-normal text-fg-3">
            {" "}
            из <span className="tabular-nums">{total}</span>
          </span>
        )}
      </p>
      <p className="mt-3 text-lead text-fg-2">
        {/* After «из 21» the word agrees with the number in the genitive: «из 21 разговора», «из 4 разговоров». */}
        {total
          ? `${plural(total, "разговора", "разговоров", "разговоров")} сыграно`
          : plural(done, "разговор сыгран", "разговора сыграно", "разговоров сыграно")}{" "}
        · модель оценивает их по ходу прогона
      </p>
      <div className="mt-6 h-2 max-w-[640px] overflow-hidden rounded-full bg-well">
        <div
          className="h-full rounded-full bg-run transition-[width] duration-700 ease-out"
          style={{ width: `${total ? Math.max(2, (100 * done) / total) : 4}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Which run this is, as a check says which export: whose criteria count it, who played, its name, when; the other runs
 * one click away, and judging it again.
 */
function RunLine({
  run,
  finished,
  state,
  onPick,
}: {
  run: RunSummary;
  finished: RunSummary[];
  state: LabState;
  onPick: (id: string) => void;
}) {
  const { refresh } = useLabState();
  const toast = useToast();
  const rejudge = () => {
    api(`/api/runs/${encodeURIComponent(run.id)}/rejudge`, {})
      .then(() => refresh())
      .catch(toast.error);
  };
  const others = finished.filter((r) => r.id !== run.id);
  const failed = run.status === "failed";
  const text = (
    <>
      Прогон {BY_CRITERIA[run.check]}
      {run.label ? ` · «${run.label}»` : ""} · {isRunning(run) ? "идёт с" : failed ? "начат" : "сыгран"}{" "}
      <span className="whitespace-nowrap">{longDay(run.startedAt)}</span>
    </>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-read text-fg-3">
      {others.length ? (
        <Menu
          trigger={
            <span
              className="inline-flex items-center gap-1 text-left transition-colors hover:text-fg"
              title={runTitle(run)}
            >
              {text}
              <ChevronDown aria-hidden className="size-4 flex-shrink-0" />
            </span>
          }
          items={[run, ...others].map((r) => ({
            key: r.id,
            label: `${longDay(r.startedAt)}${r.label ? ` · «${r.label}»` : ""}`,
            sub: [
              BY_CRITERIA[r.check],
              r.metric?.measured ? `ошибка в ${r.metric.failed} из ${r.metric.measured}` : "",
              runTitle(r),
            ]
              .filter(Boolean)
              .join(" · "),
            on: r.id === run.id,
            run: () => onPick(r.id),
          }))}
        />
      ) : (
        <span title={runTitle(run)}>{text}</span>
      )}
      {/* The summary has no conversations, only their count: a run with none has nothing to judge again, nor one that
          failed before anything was checked (the agent answered nothing: its reason is on the page). */}
      {!isRunning(run) && (run.metric?.total ?? 0) > 0 && !(failed && !run.metric?.measured) ? (
        <button
          type="button"
          onClick={rejudge}
          disabled={!!state.job.running}
          title="Модель заново оценит разговоры прогона. Агента не вызываем."
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-small font-medium text-fg-3 transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40"
        >
          <RotateCcw aria-hidden className="size-3.5" />
          Оценить заново
        </button>
      ) : null}
    </div>
  );
}

/**
 * The run's signature: scenarios down, types of customers across, each cell the verdict of that play. Until the run's
 * conversations come, their shape; if they could not be loaded, that and «Повторить», never «no conversations».
 */
function Matrix({ run, state }: { run: LabRun; state: LabState }) {
  const { data, error, isFetching, refetch } = useRun(run.id, state);
  const items = data?.items ?? [];
  return (
    <section aria-label="Сценарии и типы клиентов" className="mt-16">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-line pb-3">
        <h2 className="text-title font-semibold text-fg">Сценарии и клиенты</h2>
        <Link
          to={scenariosLink()}
          className="inline-flex items-center gap-1 text-read font-medium text-run hover:underline"
        >
          Все сценарии
          <ArrowRight aria-hidden className="size-4" />
        </Link>
      </div>
      {!data ? (
        error && !isFetching ? (
          <LoadFailed
            title="Не удалось загрузить разговоры прогона"
            error={error}
            onRetry={() => void refetch()}
            className="mt-4"
          />
        ) : (
          <Skeleton className="mt-4 h-64" />
        )
      ) : items.length ? (
        <RunMatrix
          run={data}
          items={items}
          hrefOf={(i) => dialogOf({ source: "sim", runId: run.id, index: i })}
          scores
        />
      ) : (
        <p className="mt-4 text-read text-fg-3">
          {isRunning(run)
            ? "Первые разговоры появятся, когда агент ответит."
            : "В этом прогоне нет сыгранных разговоров."}
        </p>
      )}
    </section>
  );
}
