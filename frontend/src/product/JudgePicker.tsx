import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { judgesLink } from "../app/links";
import { useJudges } from "../lab/judges";
import { useLabState } from "../lab/LabProvider";
import type { Check } from "../lab/types";
import { Select } from "../ui/Field";
import { LoadFailed } from "../ui/LoadFailed";
import { Skeleton } from "../ui/EmptyState";

export function JudgePicker({ check }: { check: Check }) {
  const id = useId();
  const library = useJudges(check);
  const { state } = useLabState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (library.isError)
    return <LoadFailed title="Правила не загрузились" error={library.error} onRetry={() => library.refetch()} />;
  if (!library.data) return <Skeleton className="h-16" />;
  return (
    <div className="text-body">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="font-medium text-fg">
          Правила судьи
        </label>
        <Link to={judgesLink(check)} className="text-small text-run hover:underline">
          Настроить правила
        </Link>
      </div>
      <Select
        id={id}
        value={library.data.selectedId ?? ""}
        disabled={busy || library.changing || state?.job.running}
        onChange={async (e) => {
          setBusy(true);
          setError("");
          try {
            await library.select(e.target.value || null);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setBusy(false);
          }
        }}
      >
        <option value="" disabled={check === "tone"}>
          {check === "code" ? "Критерии из кода агента" : "Выберите набор правил"}
        </option>
        {library.data.versions
          .slice()
          .reverse()
          .map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} · v{v.version}
              {v.builtin ? " · встроенный" : ""}
            </option>
          ))}
      </Select>
      {error && (
        <p role="alert" className="mt-2 text-small text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
