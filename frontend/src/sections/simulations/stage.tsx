import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Hammer, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { Header } from "../../app/Header";
import { SectionJob } from "../../app/SectionJob";
import { StageTabs } from "../../app/StageTabs";
import { launchLink, runLink, scenariosLink, type Check } from "../../app/links";
import { api } from "../../lab/api";
import { CHECK_NAME, CHECKS, resultOf, UNJUDGED } from "../../lab/checks";
import { count, longDay } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { isRunning } from "../../lab/runs";
import { toneResult } from "../../lab/tone";
import type { LabState, RunSummary } from "../../lab/types";
import { Button, buttonClass } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { Modal } from "../../ui/Modal";
import { useToast } from "../../ui/toast";
import { UploadButton } from "../../product/UploadLogs";
import { PlayDialog } from "./PlayDialog";

/**
 * The runs of the simulation, newest first, and the one being looked at: named in the address, else the newest finished
 * (`newest`). A run the address names that this agent does not have is `missing`: then no run is looked at, so another
 * one never stands in its place (NoSuchRun says so).
 */
export function useSimRuns(state: LabState | null, wanted: string | null) {
  const runs = useMemo(
    () => [...(state?.runs ?? [])].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)),
    [state?.runs],
  );
  const finished = useMemo(() => runs.filter((r) => r.items !== null && !isRunning(r)), [runs]);
  const newest = finished[0] ?? runs[0] ?? null;
  const missing = !!state && !!wanted && !runs.some((r) => r.id === wanted);
  const run = missing ? null : (runs.find((r) => r.id === wanted) ?? newest);
  return { runs, finished, run, newest, missing };
}

/**
 * The run an address names is not among this agent's runs (a link from another agent, or an old one): said, with the
 * newest run one click away.
 */
export function NoSuchRun({ newest }: { newest: RunSummary | null }) {
  return (
    <EmptyState
      drop
      title="Такого прогона нет"
      className="h-full justify-center"
      action={
        <Link to={newest ? runLink(newest.id) : scenariosLink()} className={buttonClass({ variant: "primary" })}>
          {newest ? "Открыть последний прогон" : "Открыть сценарии"}
        </Link>
      }
    >
      {newest
        ? `Прогона из ссылки у этого агента нет. Последний прогон ${isRunning(newest) ? "идёт с" : newest.status === "failed" ? "начат" : "сыгран"} ${longDay(newest.startedAt)}.`
        : "Прогона из ссылки у этого агента нет. Прогонов ещё не было."}
    </EmptyState>
  );
}

/**
 * The tabs of the simulation with their counts; the run being looked at travels with them (StageTabs, from the
 * address). A run's conversations and the person's answers open from its result.
 */
export function SimTabs({ state }: { state: LabState | null }) {
  return <StageTabs stage="sim" counts={{ runs: state?.runs.length, scenarios: state?.cards?.cards.length }} />;
}

/**
 * The head of every page of the simulation: its tabs and, where it plays, «Собрать сценарии» and «Сыграть». «Сыграть» opens
 * the same dialog from anywhere (?play=1, or ?play=<scenario>[,<scenario>…] with those chosen, and ?types=<type>[,…] with those customer types); once the run is named,
 * its result opens and fills in.
 */
export function SimHeader({ actions = true }: { actions?: boolean }) {
  const { state, refresh } = useLabState();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [play, setPlay] = useState<{ preset: string[] | null; types: string[] | null } | null>(null);
  const [follow, setFollow] = useState(false);
  const asked = params.get("play");
  const askedTypes = params.get("types");
  useEffect(() => {
    if (!asked) return;
    setPlay({
      preset: asked === "1" ? null : asked.split(",").filter(Boolean),
      types: askedTypes ? askedTypes.split(",").filter(Boolean) : null,
    });
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        n.delete("play");
        n.delete("types");
        return n;
      },
      { replace: true },
    );
  }, [asked, askedTypes, setParams]);
  const started = state?.job.running && state.job.kind === "run" ? state.job.progress.run : undefined;
  // The run started here opens once it is named. One that ended before it was named (the agent did not answer) is
  // followed no more: a run started later, from elsewhere, never takes this page away.
  const ended = !!state && !state.job.running;
  useEffect(() => {
    if (!follow) return;
    if (started) {
      setFollow(false);
      void navigate(runLink(started));
    } else if (ended) setFollow(false);
  }, [follow, started, ended, navigate]);

  const cards = state?.cards?.cards.length ?? 0;
  // Built before any check, the scenarios carry no criteria: they can be read, not played.
  const judged = !!state?.cards?.cards.some((card) => card.criteria.length);
  const busy = !!state?.job.running;
  // Scenarios are judged by the criteria of one check, and built without one before any check. Tone of voice whose
  // criteria changed after its result is checked again first: its scenarios would carry the old criteria.
  const results = CHECKS.filter((c) => resultOf(state, c));
  const outdated = !!toneResult(state) && toneResult(state)?.criteriaRevision !== state?.toneOfVoice?.revision;
  const ready = results.filter((c) => !(c === "tone" && outdated));
  const [ask, setAsk] = useState(false);
  const send = (check: Check | null) => {
    api("/api/cards", check ? { check } : {})
      .then(() => {
        refresh();
        toast.notify("Собираем сценарии. Ход виден внизу навигации.");
      })
      .catch(toast.error);
  };
  // With two results the person says which check the scenarios come from; with one, that one; with none, none.
  const build = () => (results.length > 1 ? setAsk(true) : results.length ? ready[0] && send(ready[0]) : send(null));
  const why = busy
    ? "Сейчас идёт другая задача"
    : !state?.logs.total
      ? "Сначала загрузите диалоги"
      : results.length && !ready.length
        ? "Критерии tone of voice изменились. Сначала проверьте разговоры заново."
        : undefined;
  return (
    <>
      <Header
        title="Симуляции"
        tabs={<SimTabs state={state} />}
        actions={
          actions ? (
            <>
              <UploadButton variant="outline" />
              <Button
                icon={Hammer}
                onClick={build}
                disabled={!!why}
                className="hidden md:inline-flex"
                title={
                  why ??
                  (results.length
                    ? "Из разговоров выгрузки, по каталогу бизнес-сценариев"
                    : "Из разговоров выгрузки, по каталогу бизнес-сценариев. Без проверки — без критериев: сыграть их можно будет после проверки")
                }
              >
                {cards ? "Собрать заново" : "Собрать сценарии"}
              </Button>
              <Button
                variant="primary"
                icon={Play}
                onClick={() => setPlay({ preset: null, types: null })}
                disabled={busy || !cards || !judged}
                title={
                  busy
                    ? "Сейчас идёт другая задача"
                    : !cards
                      ? "Сначала соберите сценарии"
                      : !judged
                        ? UNJUDGED
                        : undefined
                }
              >
                Сыграть
              </Button>
            </>
          ) : undefined
        }
        below={
          <>
            <SectionJob kinds={["run", "rejudge", "cards"]} />
            {actions && (
              <div className="border-t border-line px-4 py-3 md:hidden">
                <Button size="lg" icon={Hammer} disabled={!!why} onClick={build}>
                  {cards ? "Собрать сценарии заново" : "Собрать сценарии"}
                </Button>
              </div>
            )}
            {actions && outdated && (
              <p className="px-4 pb-3 text-body text-fg-3 lg:px-10">
                Критерии tone of voice изменились.{" "}
                <Link to={launchLink("tone")} className="text-run underline">
                  Проверьте разговоры заново
                </Link>
                , потом соберите сценарии.
              </p>
            )}
          </>
        }
      />
      {state && (
        <BuildFrom
          open={ask}
          state={state}
          ready={ready}
          onClose={() => setAsk(false)}
          onBuild={(check) => {
            setAsk(false);
            send(check);
          }}
        />
      )}
      {state && (
        <PlayDialog
          open={!!play}
          onClose={() => setPlay(null)}
          state={state}
          preset={play?.preset}
          presetTypes={play?.types}
          onStarted={() => setFollow(true)}
        />
      )}
    </>
  );
}

/**
 * «Собрать сценарии» when both checks have a result: which one the scenarios come from. Each check says its own number,
 * never next to a sum; the runs of the new scenarios are counted by its criteria.
 */
function BuildFrom({
  open,
  state,
  ready,
  onClose,
  onBuild,
}: {
  open: boolean;
  state: LabState;
  ready: Check[];
  onClose: () => void;
  onBuild: (check: Check) => void;
}) {
  const [choice, setChoice] = useState<Check | null>(null);
  const picked = choice && ready.includes(choice) ? choice : null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Из какой проверки собрать сценарии?"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" icon={Hammer} disabled={!picked} onClick={() => picked && onBuild(picked)}>
            Собрать сценарии
          </Button>
        </>
      }
    >
      <p className="text-body text-fg-2">
        Сценарии собираются из разговоров выгрузки. Прогоны оцениваются по критериям выбранной проверки.
        {state.cards?.cards.length ? " Новые сценарии заменят собранные. Сохранённые прогоны не изменятся." : ""}
      </p>
      <div role="radiogroup" aria-label="Проверка" className="mt-4 flex flex-col gap-2">
        {CHECKS.map((c) => {
          const result = resultOf(state, c);
          if (!result) return null;
          const off = !ready.includes(c);
          const on = picked === c;
          return (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={off}
              onClick={() => setChoice(c)}
              className={cn(
                "flex items-start gap-3 rounded-control border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60 disabled:cursor-default disabled:opacity-60",
                on ? "border-fg-3 bg-selected" : "border-line hover:bg-hover",
              )}
            >
              <span
                aria-hidden
                className={cn("mt-1 size-3 flex-shrink-0 rounded-full border", on ? "border-fg bg-fg" : "border-fg-4")}
              />
              <span className="min-w-0">
                <span className="block text-body font-medium text-fg">{CHECK_NAME[c]}</span>
                <span className="block text-small text-fg-3">
                  {result.summary.failed} из{" "}
                  {count(
                    result.summary.measured,
                    "проверенного разговора",
                    "проверенных разговоров",
                    "проверенных разговоров",
                  )}{" "}
                  — с ошибкой агента · <span className="whitespace-nowrap">{longDay(result.finishedAt)}</span>
                </span>
                {off && (
                  <span className="mt-0.5 block text-small text-warn">
                    Критерии изменились. Сначала проверьте разговоры заново.
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
