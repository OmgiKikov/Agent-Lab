import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { RotateCcw } from "lucide-react";
import { datasetLink } from "../../app/links";
import { datasetFacts, useDatasets, type Dataset } from "../../lab/datasets";
import { count, fileSize, longDay, time } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Field";
import { Sheet } from "../../ui/Sheet";

/** A dataset as people call it: the name given at the upload, or its file without the extension. */
export const shownName = (d: Dataset) => (d.name === d.file ? d.name.replace(/\.(jsonl|json|csv|xlsx)$/i, "") : d.name);

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-body text-fg-3">{label}</dt>
      <dd className="min-w-0 break-words text-body text-fg">{children}</dd>
    </div>
  );
}

/**
 * «Подробности» of a dataset (ⓘ): its name to change, its file, when it came, what its upload left out; the archive.
 * Sending the dataset in work to the archive says first which one the Обзор shows after it (`next`).
 */
export function DatasetInfo({
  open,
  onClose,
  dataset: d,
  inWork,
  next,
  onArchived,
}: {
  open: boolean;
  onClose: () => void;
  dataset: Dataset;
  inWork: boolean;
  next: Dataset | null;
  onArchived: (d: Dataset, inWork: boolean) => void;
}) {
  const library = useDatasets(true);
  const { state } = useLabState();
  const [name, setName] = useState(d.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(d.name);
    setError("");
    setConfirm(false);
  }, [open, d.name]);
  const blocked = busy || library.changing || !!state?.job.running;
  const run = async (work: () => Promise<unknown>, then?: () => void) => {
    setBusy(true);
    setError("");
    try {
      await work();
      then?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const renamed = name.trim() && name.trim() !== d.name;
  return (
    <Sheet open={open} onClose={() => !busy && onClose()} title="Подробности" sub={shownName(d)}>
      <div className="p-5 sm:p-7">
        <label className="block text-body font-medium text-fg">
          Название
          <span className="mt-2 flex gap-2">
            <Input value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
            {renamed && (
              <Button
                variant="primary"
                loading={busy}
                disabled={blocked}
                onClick={() => void run(() => library.change("rename", d.id, { name }))}
              >
                Сохранить
              </Button>
            )}
          </span>
        </label>
        <dl className="mt-6 divide-y divide-line border-y border-line">
          <Line label="Файл">
            {d.file || "Без имени"}
            {d.bytes > 0 ? ` · ${fileSize(d.bytes)}` : ""}
          </Line>
          <Line label="Загружен">
            {longDay(d.createdAt)}, {time(d.createdAt)}
          </Line>
          <Line label="Разговоров">{d.total}</Line>
          {d.skipped != null && (
            <Line label="Не загружено">
              {d.skipped
                ? `${count(d.skipped, "разговор", "разговора", "разговоров")}: в них первым пишет агент или он не отвечает. Проверки такие разговоры не читают.`
                : "Ни одного: прочитаны все разговоры файла."}
            </Line>
          )}
          {d.archivedAt && <Line label="В архиве">с {longDay(d.archivedAt)}</Line>}
        </dl>
        {error && (
          <p role="alert" className="mt-4 text-body text-bad">
            {error}
          </p>
        )}
        <div className="mt-6">
          {d.archivedAt ? (
            <Button
              icon={RotateCcw}
              loading={busy}
              disabled={blocked}
              onClick={() => void run(() => library.change("archive", d.id, { undo: true }))}
            >
              Вернуть из архива
            </Button>
          ) : confirm ? (
            <div className="rounded-block bg-inset p-4">
              <p className="text-body text-fg-2">
                «{shownName(d)}» уйдёт из выбора. Разговоры и сохранённые проверки останутся, вернуть его можно из
                архива.
                {inWork &&
                  (next
                    ? ` Обзор покажет «${shownName(next)}».`
                    : " Других датасетов нет: Обзор будет пустым, пока вы не вернёте его или не загрузите новый.")}
              </p>
              <div className="mt-3 flex gap-2">
                <Button
                  variant="primary"
                  loading={busy}
                  disabled={blocked}
                  onClick={() =>
                    void run(
                      () => library.change("archive", d.id),
                      () => onArchived(d, inWork),
                    )
                  }
                >
                  В архив
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setConfirm(false)}>
                  Отмена
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" disabled={blocked} onClick={() => setConfirm(true)}>
              Убрать в архив
            </Button>
          )}
        </div>
      </div>
    </Sheet>
  );
}

/** The datasets put away: each opens as before, and «Вернуть» brings it back to the choice. */
export function ArchiveSheet({ open, onClose, archived }: { open: boolean; onClose: () => void; archived: Dataset[] }) {
  const library = useDatasets(true);
  const { state } = useLabState();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const restore = async (d: Dataset) => {
    setBusy(d.id);
    setError("");
    try {
      await library.change("archive", d.id, { undo: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Архив датасетов"
      sub="Их разговоры и сохранённые проверки на месте. Вернуть можно любой."
    >
      <ul className="divide-y divide-line px-5 sm:px-7">
        {archived.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-3 py-4">
            <Link to={datasetLink(d.id)} onClick={onClose} className="min-w-0 flex-1 rounded-control hover:underline">
              <span className="block break-words text-read font-medium text-fg">{shownName(d)}</span>
              <span className="mt-0.5 block text-small text-fg-3">{datasetFacts(d).join(" · ")}</span>
            </Link>
            <Button
              size="sm"
              icon={RotateCcw}
              loading={busy === d.id}
              disabled={!!busy || library.changing || !!state?.job.running}
              onClick={() => void restore(d)}
            >
              Вернуть
            </Button>
          </li>
        ))}
        {!archived.length && <li className="py-6 text-body text-fg-3">Архив пуст.</li>}
      </ul>
      {error && (
        <p role="alert" className="px-5 pb-5 text-body text-bad sm:px-7">
          {error}
        </p>
      )}
    </Sheet>
  );
}
