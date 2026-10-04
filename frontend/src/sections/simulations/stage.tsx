import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Hammer, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { Header } from "../../app/Header";
import { SectionJob } from "../../app/SectionJob";
import { StageTabs } from "../../app/StageTabs";
import { runLink, toneCheckLink, type Check } from "../../app/links";
import { api } from "../../lab/api";
import { CHECK_NAME, CHECKS, resultOf } from "../../lab/checks";
import { count, longDay } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { useProblems } from "../../lab/problems";
import { isRunning } from "../../lab/runs";
import { toneResult } from "../../lab/tone";
import type { LabState } from "../../lab/types";
import { queueOf } from "../../lab/verdicts";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { useToast } from "../../ui/toast";
import { PlayDialog } from "./PlayDialog";

/** The runs of the simulation, newest first, and the one being looked at: named in the address, else the newest finished. */
export function useSimRuns(state: LabState | null, wanted: string | null) {
  const runs = useMemo(
    () => [...(state?.runs ?? [])].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)),
    [state?.runs],
  );
  const finished = useMemo(() => runs.filter((r) => r.items !== null && !isRunning(r)), [runs]);
  const run = runs.find((r) => r.id === wanted) ?? finished[0] ?? runs[0] ?? null;
  return { runs, finished, run };
}

/** The tabs of the simulation with their counts; the run being looked at travels with them. */
export function SimTabs({ state, runId }: { state: LabState | null; runId: string | null }) {
  const { run } = useSimRuns(state, runId);
  const { data } = useProblems(run?.check ?? null, run?.id ?? null);
  return (
    <StageTabs
      stage="sim"
      counts={{
        runs: state?.runs.length,
        scenarios: state?.cards?.cards.length,
        conversations: run?.metric?.total ?? run?.items?.length,
        review: data?.sim ? queueOf(data, "disputed", null, "sim").length : undefined,
      }}
    />
  );
}

/**
 * The head of every page of the simulation: its tabs and, where it plays, «Собрать сценарии» and «Сыграть». «Сыграть» opens
 * the same dialog from anywhere (?play=1, or ?play=<scenario>[,<scenario>…] with those chosen, and ?types=<type>[,…] with those customer types); once the run is named,
 * its result opens and fills in.
 */
export function SimHeader({ runId, actions = true }: { runId: string | null; actions?: boolean }) {
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
  useEffect(() => {
    if (follow && started) {
      setFollow(false);
      void navigate(runLink(started));
    }
  }, [follow, started, navigate]);

  const cards = state?.cards?.cards.length ?? 0;
  const busy = !!state?.job.running;
  // Scenarios come from the errors of one check. Tone of voice whose criteria changed after its result is checked
  // again first: its scenarios would carry the old criteria.
  const results = CHECKS.filter((c) => resultOf(state, c));
  const outdated = !!toneResult(state) && toneResult(state)?.criteriaRevision !== state?.toneOfVoice?.revision;
  const ready = results.filter((c) => !(c === "tone" && outdated));
  const [ask, setAsk] = useState(false);
  const send = (check: Check) => {
    api("/api/cards", { check })
      .then(() => {
        refresh();
        toast.notify("Собираем сценарии. Ход виден внизу навигации.");
      })
      .catch(toast.error);
  };
  // With two results the person says which check the scenarios come from; with one, that one.
  const build = () => (results.length > 1 ? setAsk(true) : ready[0] && send(ready[0]));
  const why = busy
    ? "Сейчас идёт другая задача"
    : !results.length
      ? "Сценарии собираются из ошибок проверки. Сначала проверьте разговоры."
      : !ready.length
        ? "Критерии tone of voice изменились. Сначала проверьте разговоры заново."
        : undefined;
  return (
    <>
      <Header
        title="Симуляции"
        tabs={<SimTabs state={state} runId={runId} />}
        actions={
          actions ? (
            <>
              <Button
                icon={Hammer}
                onClick={build}
                disabled={!!why}
                className="hidden md:inline-flex"
                title={why ?? "Из ошибок проверки разговоров"}
              >
                {cards ? "Собрать заново" : "Собрать сценарии"}
              </Button>
              <Button
                variant="primary"
                icon={Play}
                onClick={() => setPlay({ preset: null, types: null })}
                disabled={busy || !cards}
                title={busy ? "Сейчас идёт другая задача" : !cards ? "Сначала соберите сценарии" : undefined}
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
                <Link to={toneCheckLink("criteria")} className="text-run underline">
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
        Сценарии собираются из ошибок одной проверки. Прогоны считаются по её критериям.
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
