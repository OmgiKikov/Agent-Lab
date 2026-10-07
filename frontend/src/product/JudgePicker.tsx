import { useState } from "react";
import { Link } from "react-router-dom";
import { Settings2 } from "lucide-react";
import { stageRoot } from "../app/links";
import { useJudges } from "../lab/judges";
import { useLabState } from "../lab/LabProvider";
import type { Check } from "../lab/types";

export function JudgePicker({ check }: { check: Check }) {
  const library = useJudges(check);
  const { state } = useLabState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="text-body">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`judge-${check}`} className="text-fg-3">
          Правила судьи
        </label>
        <select
          id={`judge-${check}`}
          value={library.data?.selectedId ?? ""}
          disabled={busy || state?.job.running || library.isPending}
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
          className="min-w-0 max-w-full flex-1 rounded-control border border-line-strong bg-canvas px-3 py-2 text-fg"
        >
          <option value="" disabled={check === "tone"}>
            {check === "code" ? "Критерии из кода агента" : "Выберите набор правил"}
          </option>
          {library.data?.versions.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} · v{v.version}
              {v.builtin ? " · встроенный" : ""}
            </option>
          ))}
        </select>
        <Link
          aria-label="Настроить правила судьи"
          to={`${stageRoot(check)}/judges`}
          className="rounded-control p-2 text-fg-3 hover:bg-hover"
        >
          <Settings2 className="size-4" />
        </Link>
      </div>
      {(error || library.isError) && (
        <p role="alert" className="mt-2 text-small text-bad">
          {error || "Не удалось загрузить наборы правил."}
        </p>
      )}
    </div>
  );
}
