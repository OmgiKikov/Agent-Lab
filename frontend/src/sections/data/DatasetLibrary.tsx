import { useState } from "react";
import { Archive, Check, Pencil, RotateCcw } from "lucide-react";
import { useDatasets, type Dataset } from "../../lab/datasets";
import { when, count, fileSize } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { LoadFailed } from "../../ui/LoadFailed";

export function DatasetLibrary() {
  const library = useDatasets(true);
  const [showArchive, setShowArchive] = useState(false);
  const { state } = useLabState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [archiving, setArchiving] = useState<Dataset | null>(null);
  const [editing, setEditing] = useState<Dataset | null>(null);
  const [name, setName] = useState("");
  const [removed, setRemoved] = useState<Dataset | null>(null);
  const change = async (
    action: "select" | "archive" | "rename",
    item: Dataset,
    extra: { name?: string; undo?: boolean } = {},
  ) => {
    setBusy(true);
    setError("");
    try {
      await library.change(action, item.id, extra);
      if (action === "archive") setRemoved(extra.undo ? null : item);
      setArchiving(null);
      setEditing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const blocked = busy || !!state?.job.running;
  if (library.isError)
    return <LoadFailed title="Не удалось загрузить датасеты" error={library.error} onRetry={() => library.refetch()} />;
  if (library.data && !library.data.datasets.length) return null;
  return (
    <section className="mt-7" aria-label="Датасеты агента">
      <div className="mb-4 flex gap-2">
        <Button variant={showArchive ? "ghost" : "outline"} onClick={() => setShowArchive(false)}>
          Датасеты
        </Button>
        <Button variant={showArchive ? "outline" : "ghost"} onClick={() => setShowArchive(true)}>
          Архив · {library.data?.datasets.filter((d) => d.archivedAt).length ?? 0}
        </Button>
      </div>
      {removed && (
        <div role="status" className="mb-4 flex flex-wrap items-center gap-3 rounded-control bg-inset p-3 text-body">
          «{removed.name}» в архиве.
          <Button
            size="sm"
            icon={RotateCcw}
            disabled={blocked}
            onClick={() => change("archive", removed, { undo: true })}
          >
            Вернуть
          </Button>
        </div>
      )}
      <ul className="divide-y divide-line overflow-hidden rounded-block border border-line">
        {library.data?.datasets
          .filter((item) => !!item.archivedAt === showArchive)
          .map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-3 p-4 sm:flex-nowrap sm:px-5">
              <button
                type="button"
                aria-pressed={library.data?.activeId === item.id}
                disabled={blocked || !!item.archivedAt}
                onClick={() => change("select", item)}
                className="flex min-w-0 flex-1 items-start gap-3 text-left"
              >
                <span className="mt-1 flex size-5 shrink-0 items-center justify-center rounded-full border border-line-strong">
                  {library.data?.activeId === item.id && <Check aria-hidden className="size-3.5 text-ok" />}
                </span>
                <span className="min-w-0">
                  <span className="block break-words text-read font-semibold text-fg">{item.name}</span>
                  <span className="mt-1 block break-all text-small text-fg-3">
                    {item.file} · {count(item.total, "разговор", "разговора", "разговоров")}
                    {item.bytes > 0 ? ` · ${fileSize(item.bytes)}` : ""} · {when(item.createdAt)}
                  </span>
                </span>
              </button>
              <div className="flex items-center gap-1">
                {item.archivedAt ? (
                  <Button
                    size="sm"
                    icon={RotateCcw}
                    disabled={blocked}
                    onClick={() => change("archive", item, { undo: true })}
                  >
                    Вернуть
                  </Button>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={Pencil}
                      aria-label={`Переименовать ${item.name}`}
                      disabled={blocked}
                      onClick={() => {
                        setEditing(item);
                        setName(item.name);
                        setError("");
                      }}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={Archive}
                      aria-label={`В архив: ${item.name}`}
                      disabled={blocked}
                      onClick={() => {
                        setArchiving(item);
                        setError("");
                      }}
                    />
                  </>
                )}
              </div>
            </li>
          ))}
      </ul>
      {error && (
        <p role="alert" className="mt-3 text-body text-bad">
          {error}
        </p>
      )}
      <Modal
        open={!!archiving}
        onClose={() => !busy && setArchiving(null)}
        title="Убрать датасет в архив?"
        footer={
          <>
            <Button disabled={busy} variant="ghost" onClick={() => setArchiving(null)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={blocked}
              onClick={() => archiving && change("archive", archiving)}
            >
              В архив
            </Button>
          </>
        }
      >
        <p className="text-read text-fg-2">
          «{archiving?.name}» исчезнет из списка выбора. Сохранённые проверки и их диалоги останутся в истории.
        </p>
        {error && (
          <p role="alert" className="mt-3 text-bad">
            {error}
          </p>
        )}
      </Modal>
      <Modal
        open={!!editing}
        onClose={() => !busy && setEditing(null)}
        title="Название датасета"
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setEditing(null)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={blocked || !name.trim()}
              onClick={() => editing && change("rename", editing, { name })}
            >
              Сохранить
            </Button>
          </>
        }
      >
        <label className="text-body text-fg">
          Название
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={160}
            className="mt-2 w-full rounded-control border border-line-strong bg-canvas px-3 py-2"
          />
        </label>
        {error && (
          <p role="alert" className="mt-3 text-bad">
            {error}
          </p>
        )}
      </Modal>
    </section>
  );
}
