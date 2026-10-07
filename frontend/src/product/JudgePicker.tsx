import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { judgesLink } from "../app/links";
import { CHECK_NAME, resultOf } from "../lab/checks";
import { useJudges } from "../lab/judges";
import { useLabState } from "../lab/LabProvider";
import type { Check } from "../lab/types";
import { Button } from "../ui/Button";
import { Select } from "../ui/Field";
import { LoadFailed } from "../ui/LoadFailed";
import { Modal } from "../ui/Modal";
import { Skeleton } from "../ui/EmptyState";

/**
 * The rules the check goes by, chosen right here: other rules send the current result to the history (the result is
 * always by the current rules), so that is asked first when there is a result.
 */
export function JudgePicker({ check }: { check: Check }) {
  const id = useId();
  const library = useJudges(check);
  const { state } = useLabState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [asking, setAsking] = useState<string | null>(null);
  if (library.isError)
    return <LoadFailed title="Правила не загрузились" error={library.error} onRetry={() => library.refetch()} />;
  if (!library.data) return <Skeleton className="h-16" />;
  const take = async (value: string | null) => {
    setBusy(true);
    setError("");
    try {
      await library.select(value);
      setAsking(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const asked = library.data.versions.find((v) => v.id === asking);
  return (
    <div className="text-body">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="font-medium text-fg">
          Правила
        </label>
        <Link to={judgesLink(check)} className="text-small text-run hover:underline">
          Все правила
        </Link>
      </div>
      <Select
        id={id}
        value={library.data.selectedId ?? ""}
        disabled={busy || library.changing || state?.job.running}
        onChange={(e) => {
          const value = e.target.value || null;
          if (resultOf(state, check)) setAsking(value ?? "");
          else void take(value);
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
              {v.name} · версия {v.version}
            </option>
          ))}
      </Select>
      {error && (
        <p role="alert" className="mt-2 text-small text-bad">
          {error}
        </p>
      )}
      <Modal
        open={asking !== null}
        onClose={() => !busy && setAsking(null)}
        title="Взять другие правила?"
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setAsking(null)}>
              Отмена
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void take(asking || null)}>
              Взять
            </Button>
          </>
        }
      >
        <p className="text-read text-fg-2">
          Итог {CHECK_NAME[check]} по прежним правилам уйдёт в историю вместе со сценариями из него. Следующая проверка
          пойдёт по {asked ? `набору «${asked.name}»` : "критериям из кода агента"}.
        </p>
      </Modal>
    </div>
  );
}
