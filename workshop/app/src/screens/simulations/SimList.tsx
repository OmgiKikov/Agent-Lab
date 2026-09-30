import { plural, when } from "../../lab/format";
import { isRunning, runTitle, runTypes } from "../../lab/runs";
import type { LabRun, LabState } from "../../lab/types";
import { ListRow } from "../../ui/ListRow";

/** A run: which agent and version, when, how many dialogues, which customer types, how many repeats. Nothing of the verdicts. */
function RunRow({ run, state, selected, onClick }: { run: LabRun; state: LabState; selected: boolean; onClick: () => void }) {
  const live = isRunning(run);
  const job = state.job.running && state.job.progress.run === run.id ? state.job.progress : null;
  const total = run.metric?.total;
  const meta = [
    when(run.startedAt),
    total !== undefined ? `${total} ${plural(total, "диалог", "диалога", "диалогов")}` : null,
    runTypes(run, state).join(", "),
    run.repeats && run.repeats > 1 ? `повторы ×${run.repeats}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <ListRow selected={selected} onClick={onClick}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-small font-medium text-lab-ink">{runTitle(run)}</span>
        {live && <span className="flex flex-shrink-0 items-center gap-1.5 text-meta text-lab-accent"><span className="pulse-dot size-1.5 rounded-full bg-lab-accent" />{job?.total ? `${job.done ?? 0} из ${job.total}` : "идёт"}</span>}
        {run.status === "failed" && <span className="flex-shrink-0 text-meta text-lab-bad">прервался</span>}
        {run.status === "stopped" && <span className="flex-shrink-0 text-meta text-lab-warn">остановлен</span>}
      </div>
      <div className="mt-0.5 truncate text-meta text-lab-dim">{meta}</div>
    </ListRow>
  );
}

/** The runs, newest first. */
export function RunList({ runs, state, selectedId, onPick }: { runs: LabRun[]; state: LabState; selectedId: string | null; onPick: (id: string) => void }) {
  return (
    <div>
      {runs.map(r => <RunRow key={r.id} run={r} state={state} selected={r.id === selectedId} onClick={() => onPick(r.id)} />)}
      {!runs.length && <div className="px-4 py-10 text-center text-small text-lab-dim">Прогонов пока нет</div>}
    </div>
  );
}
