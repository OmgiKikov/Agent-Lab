import { useEffect } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lab/api";
import { useLabState } from "../../lab/LabProvider";
import { toneResult } from "../../lab/tone";
import type { LabState } from "../../lab/types";
import { Button } from "../../ui/Button";

export function Checking({ state, onBack, onDone }: { state: LabState; onBack: () => void; onDone: () => void }) {
  const { refresh } = useLabState();
  const job = state.job;
  const active = job.kind === "tone-check";
  const finished = !!toneResult(state);
  useEffect(() => {
    if (!job.running && !job.error && finished) onDone();
  }, [job.running, job.error, finished, onDone]);
  const done = active ? (job.progress.done ?? 0) : 0;
  const total = active ? (job.progress.total ?? 0) : 0;
  const error = active && !job.running ? job.error : null;
  return (
    <section aria-labelledby="checking-title">
      <h2 id="checking-title" className="text-title font-semibold text-fg">
        Проверяем, как агент общался с клиентами
      </h2>
      {error ? (
        <div role="alert" className="mt-6">
          <p className="text-read text-bad">
            {error === "Остановлено" ? "Проверка остановлена. Разговоры и критерии сохранены." : error}
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button onClick={onBack}>Вернуться к критериям</Button>
            <Link to="/settings" className="self-center text-body text-fg-3 underline">
              Настройки моделей
            </Link>
          </div>
        </div>
      ) : (
        <>
          <p role="status" className="mt-8 text-display font-semibold tabular-nums text-fg">
            {done} <span className="font-normal text-fg-3">из {total || "…"}</span>
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
