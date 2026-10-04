import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { runLink } from "../../app/links";
import { BY_CRITERIA } from "../../lab/checks";
import { count, longDay, time } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { isRunning, runTitle } from "../../lab/runs";
import type { LabState, RunSummary } from "../../lab/types";
import { ENTER, stagger } from "../../product/motion";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { SimHeader, useSimRuns } from "./stage";

/**
 * «Прогоны»: every run of the simulation, newest first, each with its own count and the check whose criteria it is
 * counted by. A run opens as its result. Runs are not versions of each other, so nothing here is compared: no arrows,
 * no «лучше».
 */
export function RunListPage() {
  const { state, offline } = useLabState();
  const { runs } = useSimRuns(state, null);
  const header = <SimHeader runId={null} />;
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
        <div className="px-4 pt-10 lg:px-10">
          <Skeleton className="h-80 max-w-[880px]" />
        </div>
      </div>
    );
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="max-w-[880px] px-4 pb-24 pt-6 lg:px-10 lg:pt-8">
          {runs.length ? (
            <ul className="divide-y divide-line" aria-label="Прогоны">
              {runs.map((r, i) => (
                <RunRow key={r.id} run={r} state={state} i={i} />
              ))}
            </ul>
          ) : (
            <EmptyState drop title="Здесь будут прогоны" className="py-24">
              {state.cards?.cards.length
                ? "Сыграйте сценарии с агентом."
                : "Сначала соберите сценарии из ошибок проверки разговоров."}
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}

function RunRow({ run, state, i }: { run: RunSummary; state: LabState; i: number }) {
  const m = run.metric;
  const live = isRunning(run);
  const job = live && state.job.running && state.job.progress.run === run.id ? state.job.progress : null;
  const total = m?.total ?? run.items?.length ?? 0;
  return (
    <li className={ENTER} style={stagger(i)}>
      <Link
        to={runLink(run.id)}
        className="group -mx-3 grid grid-cols-[minmax(0,1fr)_auto_16px] items-center gap-x-6 rounded-block px-3 py-5 transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
      >
        <span className="min-w-0">
          <span className="block text-small text-fg-3">
            {longDay(run.startedAt)}, {time(run.startedAt)} · {BY_CRITERIA[run.check]}
            {run.repeats && run.repeats > 1 ? ` · каждый сценарий ×${run.repeats}` : ""}
          </span>
          <span className="mt-1 block truncate text-lead font-semibold text-fg">{run.label || runTitle(run)}</span>
          <span className="mt-0.5 block truncate text-read text-fg-3">
            {run.label ? `${runTitle(run)} · ` : ""}
            {total
              ? count(total, "разговор", "разговора", "разговоров")
              : live
                ? "разговоры появляются"
                : "разговоров нет"}
          </span>
        </span>
        <span className="w-36 text-right sm:w-44">
          {live ? (
            <>
              <span className="block text-read font-medium text-run">
                идёт{job?.total ? ` · ${job.done ?? 0} из ${job.total}` : ""}
              </span>
              <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-well">
                <span
                  className="block h-full rounded-full bg-run transition-[width] duration-500"
                  style={{ width: `${job?.total ? Math.max(4, (100 * (job.done ?? 0)) / job.total) : 8}%` }}
                />
              </span>
            </>
          ) : run.status === "failed" ? (
            <span className="text-read font-medium text-bad">прервался</span>
          ) : m?.measured ? (
            <>
              <span className="block text-read text-fg-3">
                <span className={cn("text-count font-semibold tabular-nums", m.failed ? "text-fg" : "text-ok")}>
                  {m.failed}
                </span>{" "}
                из <span className="tabular-nums">{m.measured}</span>
              </span>
              <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-well">
                <span
                  className="block h-full rounded-full bg-fg/60"
                  style={{ width: `${(100 * m.failed) / m.measured}%` }}
                />
              </span>
              <span className="mt-1 block text-small text-fg-3">с ошибкой агента</span>
            </>
          ) : (
            <span className="text-read text-fg-3">ещё не оценён</span>
          )}
        </span>
        <ChevronRight aria-hidden className="size-4 text-fg-4 transition-transform group-hover:translate-x-0.5" />
      </Link>
    </li>
  );
}
