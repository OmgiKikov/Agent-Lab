import { plural, when } from "../../lab/format";
import { isRunning, runTitle, runTypes } from "../../lab/runs";
import type { LabRun, LabState } from "../../lab/types";
import { Tag } from "../../ui/Details";
import { Lead, Table, type Col } from "../../ui/Table";

const stateWord = (run: LabRun, state: LabState) => {
  const job = state.job.running && state.job.progress.run === run.id ? state.job.progress : null;
  return isRunning(run) ? (job?.total ? `идёт ${job.done ?? 0} из ${job.total}` : "идёт") : run.status === "failed" ? "прервался" : run.status === "stopped" ? "остановлен" : "завершён";
};

/** The runs as Raindrop's Issues table, newest first: which agent and version, when, how many dialogues, which customers. Nothing of the verdicts. */
export function RunList({ runs, state, onOpen }: { runs: LabRun[]; state: LabState; onOpen: (id: string) => void }) {
  const cols: Col<LabRun>[] = [
    {
      key: "run", label: "Прогон", sort: (a, b) => runTitle(a).localeCompare(runTitle(b), "ru"),
      cell: r => <Lead title={runTitle(r)} sub={r.label || runTypes(r, state).join(", ")} tags={isRunning(r) || r.status === "failed" || r.status === "stopped" ? <Tag>{stateWord(r, state)}</Tag> : undefined} />,
    },
    { key: "when", label: "Начат", width: "128px", sort: (a, b) => a.startedAt.localeCompare(b.startedAt), cell: r => <span className="text-small text-lab-soft">{when(r.startedAt)}</span> },
    { key: "types", label: "Типы клиентов", width: "200px", cell: r => <span className="line-clamp-2 text-small text-lab-soft">{runTypes(r, state).join(", ")}</span> },
    { key: "repeats", label: "Повторы", width: "80px", align: "right", sort: (a, b) => (a.repeats ?? 1) - (b.repeats ?? 1), cell: r => <span className="text-small text-lab-soft">{r.repeats && r.repeats > 1 ? `×${r.repeats}` : "—"}</span> },
    {
      key: "dialogs", label: "Диалогов", width: "88px", align: "right", sort: (a, b) => (a.metric?.total ?? 0) - (b.metric?.total ?? 0),
      cell: r => (r.metric ? <span title={plural(r.metric.total, "диалог", "диалога", "диалогов")} className="text-small font-medium text-lab-ink">{r.metric.total}</span> : <span className="text-lab-faint">—</span>),
    },
  ];
  return (
    <div className="h-full overflow-auto px-4 py-4">
      <Table rows={runs} cols={cols} rowKey={r => r.id} onOpen={r => onOpen(r.id)} initial={{ key: "when", dir: -1 }}
        empty={<div className="px-4 py-10 text-center text-small text-lab-dim">Прогонов пока нет</div>} />
    </div>
  );
}
