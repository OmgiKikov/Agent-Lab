import { Fragment, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, RotateCcw } from "lucide-react";
import { stageRoot } from "../../app/links";
import { CHECK_NAME, CHECKS, resultOf } from "../../lab/checks";
import { useDatasets, type Dataset } from "../../lab/datasets";
import { count, longDay } from "../../lab/format";
import type { LabState } from "../../lab/types";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Field";
import { LoadFailed } from "../../ui/LoadFailed";
import { Menu, type MenuItem } from "../../ui/Menu";
import { Modal } from "../../ui/Modal";
import { Sheet } from "../../ui/Sheet";

const conversations = (n: number) => count(n, "разговор", "разговора", "разговоров");

/**
 * What a person did with the datasets just now, said once under the title: a switch (from which dataset), or the
 * dataset in use sent to the archive, with its undo.
 */
type Done = { switched: Dataset; from: Dataset | null } | { archived: Dataset };

/**
 * The dataset the checks go by, as the page's title: its name, how many conversations, when it came, which checks
 * read it. The title opens the other datasets (one of them chosen, the checks go by it) and the rare actions: rename,
 * archive, the archive itself.
 */
export function DatasetHead({ state }: { state: LabState }) {
  const library = useDatasets(true);
  const [, setParams] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<Done | null>(null);
  const [renaming, setRenaming] = useState<Dataset | null>(null);
  const [name, setName] = useState("");
  const [archiving, setArchiving] = useState<Dataset | null>(null);
  const [archive, setArchive] = useState(false);
  /** One change of the datasets; `swaps` — another dataset is in use after it, so the open conversation goes. */
  const act = async (work: () => Promise<unknown>, note: Done | null, swaps: boolean) => {
    setBusy(true);
    setError("");
    setDone(null);
    try {
      await work();
      setDone(note);
      if (swaps)
        setParams(
          (prev) => {
            const n = new URLSearchParams(prev);
            n.delete("d");
            return n;
          },
          { replace: true },
        );
      setRenaming(null);
      setArchiving(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const blocked = busy || library.changing || !!state.job.running;
  if (library.isError)
    return (
      <div className="px-4 pt-6 lg:px-10">
        <LoadFailed title="Не удалось загрузить датасеты" error={library.error} onRetry={() => library.refetch()} />
      </div>
    );
  const all = library.data?.datasets ?? [];
  const active = all.filter((d) => !d.archivedAt);
  const archived = all.filter((d) => d.archivedAt);
  const current = all.find((d) => d.id === library.data?.activeId) ?? null;
  const title = current?.name || state.logs.name || state.logs.file || "Датасет";
  const items: MenuItem[] = [
    ...(active.length > 1
      ? active.map((d) => ({
          key: d.id,
          label: d.name,
          sub: `${conversations(d.total)} · загружен ${longDay(d.createdAt)}`,
          on: d.id === current?.id,
          run: () => {
            if (d.id !== current?.id)
              void act(() => library.change("select", d.id), { switched: d, from: current }, true);
          },
        }))
      : []),
    ...(current
      ? [
          {
            key: "rename",
            label: "Переименовать",
            run: () => {
              setRenaming(current);
              setName(current.name);
              setError("");
            },
          },
          {
            key: "archive",
            label: "Убрать в архив",
            run: () => {
              setArchiving(current);
              setError("");
            },
          },
        ]
      : []),
    ...(archived.length
      ? [
          {
            key: "archived",
            label: "Архив",
            sub: count(archived.length, "датасет", "датасета", "датасетов"),
            run: () => setArchive(true),
          },
        ]
      : []),
  ];
  const checked = CHECKS.flatMap((c) => {
    const result = resultOf(state, c);
    return result ? [{ check: c, measured: result.summary.measured }] : [];
  });
  const facts = [
    conversations(state.logs.total),
    current ? `загружен ${longDay(current.createdAt)}` : null,
    current?.file && current.file !== title ? `файл ${current.file}` : null,
  ].filter(Boolean);
  return (
    <section aria-label="Датасет" className="flex-shrink-0 border-b border-line px-4 py-5 lg:px-10">
      <h2 className="sr-only">{title}</h2>
      {items.length ? (
        <Menu
          disabled={blocked}
          items={items}
          className="max-w-full"
          trigger={
            <span className="flex min-w-0 items-center gap-1.5 text-left">
              <span className="min-w-0 break-words text-page font-semibold text-fg">{title}</span>
              <ChevronDown aria-hidden className="size-5 flex-shrink-0 text-fg-3" />
            </span>
          }
        />
      ) : (
        <p aria-hidden className="break-words text-page font-semibold text-fg">
          {title}
        </p>
      )}
      <p className="mt-1.5 text-read text-fg-3">
        {facts.join(" · ")}
        {checked.map(({ check, measured }) => (
          <Fragment key={check}>
            {" · "}
            <Link to={stageRoot(check)} className="text-fg-2 underline-offset-2 hover:text-fg hover:underline">
              {CHECK_NAME[check]}: проверено {measured}
            </Link>
          </Fragment>
        ))}
      </p>
      {done && "switched" in done && (
        <p role="status" className="mt-3 text-body text-fg-2">
          Проверки теперь идут по этому датасету.
          {done.from && ` Итоги «${done.from.name}» вернутся, когда выберете его снова.`}
        </p>
      )}
      {done && "archived" in done && (
        <p role="status" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-body text-fg-2">
          <span>
            «{done.archived.name}» в архиве.{current && ` Проверки теперь идут по «${current.name}».`}
          </span>
          <Button
            size="sm"
            icon={RotateCcw}
            disabled={blocked}
            onClick={() =>
              void act(
                async () => {
                  // Back as it was: in the choice again, and in use, as it was before the archive.
                  await library.change("archive", done.archived.id, { undo: true });
                  await library.change("select", done.archived.id);
                },
                null,
                true,
              )
            }
          >
            Вернуть
          </Button>
        </p>
      )}
      {error && !renaming && !archiving && (
        <p role="alert" className="mt-3 text-body text-bad">
          {error}
        </p>
      )}
      <Modal
        open={!!renaming}
        onClose={() => !busy && setRenaming(null)}
        title="Название датасета"
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setRenaming(null)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={blocked || !name.trim()}
              onClick={() => renaming && void act(() => library.change("rename", renaming.id, { name }), null, false)}
            >
              Сохранить
            </Button>
          </>
        }
      >
        <label className="text-body text-fg">
          Название
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={160} className="mt-2" />
        </label>
        {error && (
          <p role="alert" className="mt-3 text-bad">
            {error}
          </p>
        )}
      </Modal>
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
              onClick={() =>
                archiving && void act(() => library.change("archive", archiving.id), { archived: archiving }, true)
              }
            >
              В архив
            </Button>
          </>
        }
      >
        <p className="text-read text-fg-2">
          «{archiving?.name}» исчезнет из выбора. Сохранённые проверки и их разговоры останутся в истории, а датасет
          можно вернуть из архива.
        </p>
        {error && (
          <p role="alert" className="mt-3 text-bad">
            {error}
          </p>
        )}
      </Modal>
      <Sheet
        open={archive}
        onClose={() => setArchive(false)}
        title="Архив датасетов"
        sub="Датасеты, убранные из выбора. Их разговоры и проверки сохранены."
      >
        <ul className="divide-y divide-line px-5 sm:px-7">
          {archived.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 py-4">
              <span className="min-w-0 flex-1">
                <span className="block break-words text-read font-medium text-fg">{d.name}</span>
                <span className="mt-0.5 block text-small text-fg-3">
                  {conversations(d.total)} · загружен {longDay(d.createdAt)}
                </span>
              </span>
              <Button
                size="sm"
                icon={RotateCcw}
                disabled={blocked}
                onClick={() => void act(() => library.change("archive", d.id, { undo: true }), null, false)}
              >
                Вернуть
              </Button>
            </li>
          ))}
          {!archived.length && <li className="py-6 text-body text-fg-3">Архив пуст.</li>}
        </ul>
      </Sheet>
    </section>
  );
}

/** The page without a dataset in use, when every one went to the archive: they come back from here. */
export function ArchivedOnly() {
  const library = useDatasets(true);
  const archived = (library.data?.datasets ?? []).filter((d) => d.archivedAt);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  if (!archived.length) return null;
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
    <div className="mt-6 rounded-block bg-inset p-4 text-body text-fg-2">
      <p>Все датасеты в архиве. Верните нужный или загрузите новый.</p>
      <ul className="mt-3 space-y-2">
        {archived.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center gap-3">
            <span className="min-w-0 flex-1 break-words">
              {d.name} · {conversations(d.total)}
            </span>
            <Button
              size="sm"
              icon={RotateCcw}
              loading={busy === d.id}
              disabled={!!busy || library.changing}
              onClick={() => void restore(d)}
            >
              Вернуть
            </Button>
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="mt-3 text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
