import { useEffect } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { api } from "../../lab/api";
import { useLabState } from "../../lab/LabProvider";
import { PROPOSING } from "../../lab/severity";
import { toneResult } from "../../lab/tone";
import type { LabState } from "../../lab/types";
import { Button } from "../../ui/Button";

const STOPPED = "Остановлено";

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
  const job = state.job;
  const active = job.kind === "tone-check";
  const finished = !!toneResult(state);
  useEffect(() => {
    if (!job.running && !job.error && finished) onDone();
  }, [job.running, job.error, finished, onDone]);
  const done = active ? (job.progress.done ?? 0) : 0;
  const total = active ? (job.progress.total ?? 0) : 0;
  // The conversations are checked; the automatic check proposes which errors are serious (lab/severity): no count.
  const proposing = active && job.running && job.progress.message === PROPOSING;
  const error = active && !job.running ? job.error : null;
  // A stop is the person's own choice, not a failure: no red, no model settings; the previous result stays.
  const stopped = error === STOPPED;
  return (
    <section aria-labelledby="checking-title">
      <h2 id="checking-title" className="text-title font-semibold text-fg">
        Проверяем, как агент общался с клиентами
      </h2>
      {error ? (
        <div role={stopped ? "status" : "alert"} className="mt-6">
          <p className={cn("text-read", stopped ? "text-fg-2" : "text-bad")}>
            {stopped
              ? `Проверка остановлена. ${finished ? "Прежний итог сохранён." : "Разговоры и критерии сохранены."}`
              : error}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            {finished && (
              <Button variant="primary" onClick={onResult}>
                К прежнему итогу
              </Button>
            )}
            <Button onClick={onBack}>Вернуться к критериям</Button>
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
                Все разговоры проверены. Итог откроется сам, как только автоматическая проверка предложит, какие ошибки
                серьёзные.
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
                Проверено разговоров. Можно перейти в другие разделы — оценка продолжится.
              </p>
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
              api("/api/job/stop", {}).then(
                () => refresh(),
                () => refresh(),
              )
            }
          >
            Остановить проверку
          </Button>
        </>
      )}
    </section>
  );
}
