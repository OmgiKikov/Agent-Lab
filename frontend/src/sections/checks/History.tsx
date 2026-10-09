import { Link, Navigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { historyLink, launchLink, type Check } from "../../app/links";
import { SIMULATIONS } from "../../app/product";
import { resultOf } from "../../lab/checks";
import { count, longDay, plural, time } from "../../lab/format";
import { cleanPct, comparisonText, loadHistory, type SavedCheck } from "../../lab/history";
import { MODE_NAME, useLaunches, type Launch, type Mode, type Outcome } from "../../lab/launches";
import { useLabState } from "../../lab/LabProvider";
import { Button } from "../../ui/Button";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { LaunchStatus } from "../launches/LaunchStatus";
import { CheckHeader } from "./CheckHeader";

/** «3 октября, 14:05»: when a check finished, to the minute, so two checks of one day are told apart. */
const finished = (iso: string) => `${longDay(iso)}, ${time(iso)}`;

/** What each history keeps, said above its list. */
const KEEPS: Record<Check, string> = {
  tone: "Каждая завершённая проверка сохраняется со своими разговорами, критериями и правилами общения. Ваши ответы остаются и после нового датасета.",
  code: "Каждая завершённая проверка сохраняется со своими разговорами, критериями из кода агента и итогом. Новый датасет её не стирает.",
};

/** «58% без найденных ошибок · 22 из 53 проверенных — с ошибкой агента»: what every row starts with, as «Итог». */
function CountLine({ failed, measured }: { failed: number; measured: number }) {
  if (!measured) return <>Ни один разговор не удалось проверить</>;
  return (
    <>
      <span className="font-semibold tabular-nums text-fg">{cleanPct({ failed, measured })}%</span> без найденных ошибок
      <span className="text-fg-3">
        {" · "}
        <span className={cn("font-semibold tabular-nums", failed ? "text-bad" : "text-fg-2")}>{failed}</span>
        {`\u00a0из\u00a0${measured} ${plural(measured, "проверенного", "проверенных", "проверенных")} — с ошибкой агента`}
      </span>
    </>
  );
}

const ROW =
  "flex w-full items-start gap-3 rounded-control px-1 py-4 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run";

/**
 * One saved check in the list: its number first, as on every screen, then when, which export, how it stands. It opens
 * on its own page (checks/RunPage); the latest one is «Итог».
 */
function CheckRow({
  of,
  check,
  previous,
  current,
}: {
  of: Check;
  check: SavedCheck;
  previous?: SavedCheck;
  current: boolean;
}) {
  const { failed, measured, unmeasured } = check.summary;
  return (
    <Link to={historyLink(of, check.id)} className={ROW}>
      <div className="min-w-0 flex-1">
        <p className="text-read text-fg-2">
          <CountLine failed={failed} measured={measured} />
          {current && <span className="ml-2 text-small text-fg-3">текущий итог</span>}
        </p>
        <p className="mt-1 break-words text-small text-fg-3">
          {finished(check.finishedAt)} · {check.file || "Загруженные разговоры"}
          {unmeasured ? ` · не удалось проверить ${unmeasured} из ${check.sampled}` : ""}
        </p>
        <p className="mt-2 text-small text-fg-3">{comparisonText(check, previous)}</p>
      </div>
      <ArrowRight aria-hidden className="mt-1 size-4 shrink-0 text-fg-3" />
    </Link>
  );
}

/** The ways a launch checked, in order; the simulations' only while they are shown (app/product). */
const ORDER = (["dataset", "questions", "simulations"] as Mode[]).filter(
  (mode) => mode !== "simulations" || SIMULATIONS,
);

/**
 * A launch in the history, one row whatever it checked: the first way it checked gives the number (the recorded
 * answers when they were checked), the others follow in a line. Its saved check of the recorded answers is this row,
 * not a second one.
 */
function LaunchRow({
  launch,
  saved,
  previous,
  current,
}: {
  launch: Launch;
  saved?: SavedCheck;
  previous?: SavedCheck;
  current: boolean;
}) {
  const modes = ORDER.filter((mode) => launch.modes[mode]).map((mode) => [mode, launch.modes[mode]!] as const);
  const [[firstMode, first], ...rest] = modes.length
    ? modes
    : [["dataset" as Mode, { status: launch.status } as Outcome]];
  const said = (mode: Mode, outcome: Outcome) =>
    outcome.metric
      ? `${MODE_NAME[mode]}: ${outcome.metric.failed} из ${outcome.metric.measured} с ошибкой`
      : `${MODE_NAME[mode]}: ${outcome.status === "failed" ? "не удалось" : outcome.status === "stopped" ? "остановлено" : "ещё нет итога"}`;
  // A launch that only checked the recorded answers is its saved check: it opens on that check's page («Итог» for the
  // latest), the launch's own page keeps the others' several ways and the ones that did not finish.
  const only = modes.length === 1 && firstMode === "dataset" && first.checkId;
  return (
    <Link to={only ? historyLink(launch.check, only) : launchLink(launch.check, launch.id)} className={ROW}>
      <div className="min-w-0 flex-1">
        <p className="text-read text-fg-2">
          {firstMode !== "dataset" && <span className="text-fg-3">{MODE_NAME[firstMode]}: </span>}
          {first.metric ? (
            <CountLine failed={first.metric.failed} measured={first.metric.measured} />
          ) : (
            <span className="text-fg-3">Итога ещё нет</span>
          )}
          {current && <span className="ml-2 text-small text-fg-3">текущий итог</span>}
          {launch.status !== "done" && (
            <span className="ml-2 inline-block align-middle">
              <LaunchStatus status={launch.status} />
            </span>
          )}
        </p>
        <p className="mt-1 break-words text-small text-fg-3">
          {finished(launch.startedAt)} · {launch.dataset?.name || launch.dataset?.file || "Датасет"}
          {launch.judge ? ` · правила «${launch.judge.name}»` : launch.check === "code" ? " · критерии из кода" : ""}
          {launch.ruleIds?.length ? ` · ${count(launch.ruleIds.length, "критерий", "критерия", "критериев")}` : ""}
          {launch.replan ? " · критерии извлечены заново" : ""}
          {launch.agentVersion ? ` · версия агента ${launch.agentVersion}` : ""}
        </p>
        {rest.length > 0 && (
          <p className="mt-2 text-small text-fg-3">{rest.map(([mode, outcome]) => said(mode, outcome)).join(" · ")}</p>
        )}
        {saved && <p className="mt-2 text-small text-fg-3">{comparisonText(saved, previous)}</p>}
      </div>
      <ArrowRight aria-hidden className="mt-1 size-4 shrink-0 text-fg-3" />
    </Link>
  );
}

/**
 * «История» of a check: every saved check, newest first, each with its own conversations and criteria (tone of voice
 * also with its document). One opens as a sheet (?id=), even after the export, the rules or the code were replaced.
 * Checks are compared only when the service says they can be: the same criteria and models.
 */
export function HistoryPage({ check }: { check: Check }) {
  const { state, offline } = useLabState();
  const [params] = useSearchParams();
  const result = resultOf(state, check);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["history", check, result?.finishedAt ?? null, String(state?.job.running)],
    queryFn: () => loadHistory(check),
    enabled: !!state,
    staleTime: Infinity,
  });
  const checks = data?.checks ?? [];
  const launches = useLaunches(check, `${state?.job.id}-${state?.job.running}`);
  // One list, newest first: a launch is one row with all it checked; a saved check that came from no launch (an older
  // one, or a check of chosen criteria) is a row of its own.
  // A launch that only played the simulations is not in the list while they are hidden (app/product).
  const shown = (launches.data?.launches ?? []).filter(
    (l) => ORDER.some((mode) => l.modes[mode]) || !l.modes.simulations,
  );
  const fromLaunch = new Set(shown.map((l) => l.modes.dataset?.checkId).filter(Boolean));
  const previousOf = (saved?: SavedCheck) => checks.find((item) => item.id === saved?.comparison.previousId);
  const rows = [
    ...shown.map((launch) => ({ at: launch.startedAt, launch, saved: undefined })),
    ...checks
      .filter((saved) => !fromLaunch.has(saved.id))
      .map((saved) => ({ at: saved.finishedAt, launch: undefined, saved })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const loading = isLoading || !state || (!launches.data && !launches.isError);
  // An older address of a saved check (?id=), as a report sent by mail has it: the check's own page now.
  const old = params.get("id");
  if (old) return <Navigate to={historyLink(check, old)} replace />;
  return (
    <div className="flex h-full flex-col">
      <CheckHeader check={check} />
      <div className="min-h-0 flex-1 overflow-auto">
        {offline && !state ? (
          <ServiceDown />
        ) : (
          <div className="max-w-[880px] px-4 pb-24 pt-8 lg:px-10 lg:pt-10">
            <h2 className="text-title font-semibold text-fg">История проверок</h2>
            <p className="mt-1 max-w-[64ch] text-read text-fg-3">{KEEPS[check]}</p>
            <div className="mt-6">
              {loading && <Skeleton className="h-40" />}
              {(error || launches.isError) && (
                <div className="py-3">
                  <p role="alert" className="text-body text-fg-3">
                    Не удалось загрузить историю.
                  </p>
                  <Button
                    className="mt-3"
                    icon={RotateCcw}
                    onClick={() => {
                      void refetch();
                      void launches.refetch();
                    }}
                  >
                    Повторить
                  </Button>
                </div>
              )}
              {!loading && !rows.length && !error && !launches.isError && (
                <p className="py-3 text-body text-fg-3">
                  {result && !result.checkId
                    ? "Текущий итог появился раньше истории. История начнётся со следующей проверки."
                    : "Здесь появятся завершённые проверки с их разговорами и критериями."}
                </p>
              )}
              {!loading && (
                <div className="divide-y divide-line">
                  {rows.map((row) => {
                    if (row.launch) {
                      const saved = checks.find((item) => item.id === row.launch.modes.dataset?.checkId);
                      return (
                        <LaunchRow
                          key={row.launch.id}
                          launch={row.launch}
                          saved={saved}
                          previous={previousOf(saved)}
                          current={!!saved && saved.id === result?.checkId}
                        />
                      );
                    }
                    return (
                      <CheckRow
                        key={row.saved!.id}
                        of={check}
                        check={row.saved!}
                        previous={previousOf(row.saved)}
                        current={row.saved!.id === result?.checkId}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
