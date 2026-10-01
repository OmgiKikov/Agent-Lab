import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Hammer, Play } from "lucide-react";
import { Header } from "../../app/Header";
import { SectionJob } from "../../app/SectionJob";
import { StageTabs } from "../../app/StageTabs";
import { runLink } from "../../app/links";
import { api } from "../../lab/api";
import { useCriteria } from "../../lab/criteria";
import { useLabState } from "../../lab/LabProvider";
import { isRunning } from "../../lab/runs";
import type { LabState } from "../../lab/types";
import { queueOf } from "../../lab/verdicts";
import { Button } from "../../ui/Button";
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
  const { data } = useCriteria(run?.id ?? null);
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
 * the same dialog from anywhere (?play=1, or ?play=<scenario> for one); once the run is named, its result opens and fills in.
 */
export function SimHeader({ runId, actions = true }: { runId: string | null; actions?: boolean }) {
  const { state, refresh } = useLabState();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [play, setPlay] = useState<{ preset: string[] | null } | null>(null);
  const [follow, setFollow] = useState(false);
  const asked = params.get("play");
  useEffect(() => {
    if (!asked) return;
    setPlay({ preset: asked === "1" ? null : [asked] });
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        n.delete("play");
        return n;
      },
      { replace: true },
    );
  }, [asked, setParams]);
  const started = state?.job.running && state.job.kind === "run" ? state.job.progress.run : undefined;
  useEffect(() => {
    if (follow && started) {
      setFollow(false);
      void navigate(runLink(started));
    }
  }, [follow, started, navigate]);

  const cards = state?.cards?.cards.length ?? 0;
  const busy = !!state?.job.running;
  const outdated =
    state?.discover?.purpose === "tone-of-voice" && state.discover.criteriaRevision !== state.toneOfVoice?.revision;
  const build = () => {
    api("/api/cards", {})
      .then(() => {
        refresh();
        toast.notify("Сценарии собираются: ход виден внизу навигации");
      })
      .catch(toast.error);
  };
  return (
    <>
      <Header
        title="Симуляции"
        step={2}
        tabs={<SimTabs state={state} runId={runId} />}
        actions={
          actions ? (
            <>
              <Button
                icon={Hammer}
                onClick={build}
                disabled={busy || !state?.discover || outdated}
                className="hidden md:inline-flex"
                title={
                  busy
                    ? "Сейчас идёт другая задача"
                    : outdated
                      ? "Сначала повторите оценку по уточнённым критериям"
                      : !state?.discover
                        ? "Сначала оцените диалоги: сценарии собираются из их ошибок"
                        : "Собрать сценарии из оценённых диалогов"
                }
              >
                {cards ? "Собрать заново" : "Собрать сценарии"}
              </Button>
              <Button
                variant="primary"
                icon={Play}
                onClick={() => setPlay({ preset: null })}
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
                <Button size="lg" icon={Hammer} disabled={busy || !state?.discover || outdated} onClick={build}>
                  {cards ? "Собрать сценарии заново" : "Собрать сценарии"}
                </Button>
              </div>
            )}
            {outdated && (
              <p className="px-4 pb-3 text-body text-fg-3 lg:px-10">
                Критерии изменились.{" "}
                <Link to="/check?step=criteria" className="text-run underline">
                  Повторите оценку разговоров
                </Link>
                , затем соберите сценарии.
              </p>
            )}
          </>
        }
      />
      {state && (
        <PlayDialog
          open={!!play}
          onClose={() => setPlay(null)}
          state={state}
          preset={play?.preset}
          onStarted={() => setFollow(true)}
        />
      )}
    </>
  );
}
