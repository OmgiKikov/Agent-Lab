import { plural, when } from "../../lab/format";
import { isRunning, runTitle, runTypes } from "../../lab/runs";
import type { LabRun, LabState } from "../../lab/types";
import { IssueRow } from "../../ui/IssueRow";

/** A run: which agent and version, when, how many dialogues, which customer types, how many repeats. Nothing of the verdicts. */
function RunRow({ run, state, selected, onClick }: { run: LabRun; state: LabState; selected: boolean; onClick: () => void }) {
  const live = isRunning(run);
  const job = state.job.running && state.job.progress.run === run.id ? state.job.progress : null;
  const total = run.metric?.total;
  const meta = [
    when(run.startedAt),
    runTypes(run, state).join(", "),
    run.repeats && run.repeats > 1 ? `повторы ×${run.repeats}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <IssueRow
      selected={selected} onClick={onClick} tone="mute" title={runTitle(run)} sub={meta}
      tags={live ? [job?.total ? `идёт ${job.done ?? 0} из ${job.total}` : "идёт"] : run.status === "failed" ? ["прервался"] : run.status === "stopped" ? ["остановлен"] : undefined}
      stats={total !== undefined ? [{ value: total, label: plural(total, "диалог", "диалога", "диалогов"), share: live && job?.total ? (job.done ?? 0) / job.total : undefined }] : []}
    />
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
