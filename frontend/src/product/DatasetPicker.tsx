import { useState } from "react";
import { Database } from "lucide-react";
import { count } from "../lab/format";
import { useDatasets } from "../lab/datasets";
import { useLabState } from "../lab/LabProvider";
import { Button } from "../ui/Button";

/** Dataset selection is shared by checks and simulations; changes are disabled while an agent job is running. */
export function DatasetPicker() {
  const { state } = useLabState();
  const library = useDatasets();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!library.data?.datasets.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-body">
      <Database aria-hidden className="size-4 text-fg-3" />
      <label htmlFor="working-dataset" className="text-fg-3">
        Датасет
      </label>
      <select
        id="working-dataset"
        value={library.data.activeId ?? ""}
        disabled={busy || state?.job.running}
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
        className="min-w-0 max-w-full flex-1 rounded-control border border-line-strong bg-canvas px-3 py-2 text-body text-fg sm:max-w-sm"
      >
        {!library.data.activeId && <option value="">Выберите датасет</option>}
        {library.data.datasets.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name} · {count(d.total, "разговор", "разговора", "разговоров")}
          </option>
        ))}
      </select>
      {busy && (
        <span role="status" className="text-small text-fg-3">
          Открываем…
        </span>
      )}
      {library.isError && (
        <Button size="sm" onClick={() => library.refetch()}>
          Обновить список
        </Button>
      )}
      {error && (
        <p role="alert" className="w-full text-small text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
