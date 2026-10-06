import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { api } from "../../lab/api";
import { plural } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { PROPOSING, proposalCheck } from "../../lab/severity";
import { toneResult } from "../../lab/tone";
import type { LabState } from "../../lab/types";
import { Button } from "../../ui/Button";
import { useToast } from "../../ui/toast";

const STOPPED = "Остановлено";

/** «Не удалось остановить проверку. Задача уже закончилась.»: what failed first, then the service's words. */
export const stopFailed = (what: string, e: unknown) =>
  `Не удалось остановить ${what}. ${e instanceof Error ? e.message : String(e)}`;

export function Checking({
  state,
  onBack,
  onDone,
  onResult,
}: {
  state: LabState;
  onBack: () => void;
  /** The check finished: the page moves on by itself. */
  onDone: () => void;
  /** The person goes back to the result that is still there. */
  onResult: () => void;
}) {
  const { refresh } = useLabState();
  const toast = useToast();
  const job = state.job;
  const active = job.kind === "tone-check";
  const finished = !!toneResult(state);
  useEffect(() => {
    if (!job.running && !job.error && finished) onDone();
  }, [job.running, job.error, finished, onDone]);
  const done = active ? (job.progress.done ?? 0) : 0;
  const total = active ? (job.progress.total ?? 0) : 0;
  // The conversations are checked; the automatic check proposes which errors are serious (lab/severity): no count.
  const proposing = active && job.running && !!proposalCheck(job);
  const error = active && !job.running ? job.error : null;
  // A stop is the person's own choice, not a failure: no red, no model settings; the previous result stays.
  const stopped = error === STOPPED;
  // What a stop or a failure kept: the same start goes on from there (backend/lab/api/work.py, continuable).
  const input = job.input;
  const resumable = !!error && !!job.continuable && !!input?.ruleIds && !!input.count;
  const [resuming, setResuming] = useState(false);
  const resume = async () => {
    setResuming(true);
    try {
      await api("/api/tone-of-voice/check", { ...input, propose: true });
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setResuming(false);
    }
  };
  return (
    <section aria-labelledby="checking-title">
      <h2 id="checking-title" className="text-title font-semibold text-fg">
        Проверяем, как агент общался с клиентами
      </h2>
      {error ? (
        <div role={stopped ? "status" : "alert"} className="mt-6">
          <p className={cn("text-read", stopped ? "text-fg-2" : "text-bad")}>
            {resumable
              ? `${stopped ? `Проверка остановлена на ${job.kept}\u00a0из\u00a0${input.count}.` : error} Проверенное сохранено: продолжим с этого места.${stopped && finished ? " Прежний итог тоже на месте." : ""}`
              : stopped
                ? `Проверка остановлена. ${finished ? "Прежний итог сохранён." : "Диалоги и критерии сохранены."}`
                : error}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            {resumable && (
              <Button variant="primary" loading={resuming} onClick={() => void resume()}>
                Продолжить проверку
              </Button>
            )}
            {finished && (
              <Button variant={resumable ? undefined : "primary"} onClick={onResult}>
                К прежнему итогу
              </Button>
            )}
            <Button onClick={onBack}>К критериям</Button>
            {!stopped && (
              <Link to="/settings" className="self-center text-body text-fg-3 underline">
                Настройки моделей
              </Link>
            )}
          </div>
        </div>
      ) : (
        <>
          {proposing ? (
            <>
              <p role="status" className="mt-8 text-title font-semibold text-fg">
                {PROPOSING}
              </p>
              <p className="mt-2 text-read text-fg-3">
                Все разговоры проверены. Итог откроется, когда модель отметит серьёзные ошибки.
              </p>
              <div className="mt-5 h-2 overflow-hidden rounded-full bg-well">
                <div className="h-full w-full animate-pulse rounded-full bg-fg motion-reduce:animate-none" />
              </div>
            </>
          ) : (
            <>
              <p role="status" className="mt-8 text-display font-semibold tabular-nums text-fg">
                {done}
                {"\u00a0"}
                <span className="font-normal text-fg-3">
                  из{"\u00a0"}
                  {total || "…"}
                </span>
              </p>
              <p className="mt-2 text-read text-fg-3">
                {/* After «из 21» the noun agrees with the total: «разговора проверено», «из 53 разговоров». */}
                {plural(total, "разговора", "разговоров", "разговоров")} проверено
              </p>
              <p className="mt-1 text-read text-fg-3">Проверка продолжится, даже если перейти в другие разделы.</p>
              <div className="mt-5 h-2 overflow-hidden rounded-full bg-well">
                <div
                  className="h-full rounded-full bg-fg transition-[width] duration-500"
                  style={{ width: `${total ? (100 * done) / total : 0}%` }}
                />
              </div>
            </>
          )}
          <Button
            className="mt-6"
            disabled={!job.running}
            onClick={() =>
              api("/api/job/stop", {})
                .catch((e) => toast.error(stopFailed("проверку", e)))
                .finally(() => void refresh())
            }
          >
            Остановить проверку
          </Button>
        </>
      )}
    </section>
  );
}
