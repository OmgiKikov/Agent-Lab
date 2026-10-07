import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { SECTIONS } from "../app/links";
import { count } from "../lab/format";
import { useDatasets } from "../lab/datasets";
import { useLabState } from "../lab/LabProvider";
import { Select } from "../ui/Field";
import { LoadFailed } from "../ui/LoadFailed";
import { Skeleton } from "../ui/EmptyState";

/** Only preparation screens change the working dataset; evidence screens keep their result's provenance. */
export function DatasetPicker() {
  const id = useId();
  const { state } = useLabState();
  const library = useDatasets();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (library.isError)
    return <LoadFailed title="Датасеты не загрузились" error={library.error} onRetry={() => library.refetch()} />;
  if (!library.data) return <Skeleton className="h-16" />;
  return (
    <div className="text-body">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="font-medium text-fg">
          Датасет
        </label>
        <Link to={SECTIONS.data} className="text-small text-run hover:underline">
          Библиотека данных
        </Link>
      </div>
      {library.data.datasets.length ? (
        <Select
          id={id}
          value={library.data.activeId ?? ""}
          disabled={busy || library.changing || state?.job.running}
          onChange={async (event) => {
            setBusy(true);
            setError("");
            try {
              await library.change("select", event.target.value);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setBusy(false);
            }
          }}
        >
          {!library.data.activeId && <option value="">Выберите датасет</option>}
          {library.data.datasets.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} · {count(d.total, "разговор", "разговора", "разговоров")}
            </option>
          ))}
        </Select>
      ) : (
        <p className="text-small text-fg-3">Добавьте выгрузку чата в библиотеку данных.</p>
      )}
      {busy && (
        <p role="status" className="mt-2 text-small text-fg-3">
          Открываем…
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-small text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
