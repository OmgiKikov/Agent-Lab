import { useState } from "react";
import { Link } from "react-router-dom";
import { Download, ListChecks, Plus, Sparkles } from "lucide-react";
import { toneCheckLink } from "../../app/links";
import { textFile } from "../../lab/api";
import { CHECK_NAME, resultOf } from "../../lab/checks";
import { useJudges, type JudgeVersion } from "../../lab/judges";
import { useLabState } from "../../lab/LabProvider";
import { download } from "../../lab/problemReport";
import type { Check } from "../../lab/types";
import { Button, buttonClass } from "../../ui/Button";
import { Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { Modal } from "../../ui/Modal";
import { Sheet } from "../../ui/Sheet";
import { RuleEditor } from "./RuleEditor";
import { RuleSet } from "./RuleSet";

/**
 * «Правила» of a check, over its criteria: the rule sets with their versions, which one the checks go by, a new
 * version or set. Taking other rules sends the current result to the history (the result is always by the current
 * rules), so it is asked first when there is one.
 */
export function RulesSheet({ check, open, onClose }: { check: Check; open: boolean; onClose: () => void }) {
  const library = useJudges(check);
  const { state } = useLabState();
  const [editing, setEditing] = useState<JudgeVersion | null | undefined>();
  const [asking, setAsking] = useState<{ id: string | null; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hasResult = !!resultOf(state, check);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const take = (id: string | null, name: string) => {
    if (hasResult) setAsking({ id, name });
    else void act(() => library.select(id));
  };
  const blocked = busy || library.changing || !!state?.job.running;
  const groups = new Map<string, JudgeVersion[]>();
  for (const version of library.data?.versions ?? [])
    groups.set(version.setId, [...(groups.get(version.setId) ?? []), version]);
  const sets = [...groups.values()].sort(
    (a, b) =>
      Number(b.some((v) => v.id === library.data?.selectedId)) -
      Number(a.some((v) => v.id === library.data?.selectedId)),
  );
  return (
    <>
      <Sheet
        open={open && editing === undefined}
        onClose={onClose}
        width="lg"
        title="Правила"
        sub="По ним проверяются разговоры. Новая версия или другой набор действуют со следующей проверки, прошлые проверки остаются со своими правилами."
      >
        <div className="space-y-5 p-5 sm:p-7">
          <div className="flex flex-wrap gap-2">
            <Button icon={Plus} disabled={blocked || !library.data} onClick={() => setEditing(null)}>
              Новый набор
            </Button>
            {check === "tone" && (
              <Link to={toneCheckLink("materials")} className={buttonClass({ variant: "ghost" })}>
                <Sparkles aria-hidden className="size-3.5" />
                Собрать из документа
              </Link>
            )}
          </div>
          {check === "code" &&
            library.data &&
            sets.length > 0 &&
            (library.selected ? (
              <p className="text-body text-fg-3">
                Точность проверяется по набору «{library.selected.name}».{" "}
                <button
                  type="button"
                  disabled={blocked}
                  onClick={() => take(null, "критерии из кода агента")}
                  className="text-run hover:underline disabled:opacity-40"
                >
                  Вернуться к критериям из кода агента
                </button>
              </p>
            ) : (
              <p className="text-body text-fg-3">
                Сейчас точность проверяется по критериям из кода агента. Набор ниже можно взять вместо них.
              </p>
            ))}
          {error && (
            <p role="alert" className="text-bad">
              {error}
            </p>
          )}
          {library.isError ? (
            <LoadFailed title="Не удалось загрузить правила" error={library.error} onRetry={() => library.refetch()} />
          ) : !library.data ? (
            <Skeleton className="h-60" />
          ) : sets.length ? (
            <div className="divide-y divide-line overflow-hidden rounded-block border border-line">
              {sets.map((versions) => (
                <RuleSet
                  key={versions[0].setId}
                  versions={versions}
                  selectedId={library.data.selectedId}
                  blocked={blocked}
                  onSelect={(v) => take(v.id, v.name)}
                  onEdit={setEditing}
                  onDownload={(v) =>
                    void act(async () =>
                      download(`rules-v${v.version}.md`, await textFile(`/api/judge-versions/${v.id}/download`)),
                    )
                  }
                />
              ))}
            </div>
          ) : (
            <p className="text-body text-fg-3">
              {check === "tone"
                ? "Правил пока нет. Соберите критерии из документа с правилами общения или создайте набор вручную."
                : "Своих наборов пока нет: точность проверяется по критериям из кода агента."}
            </p>
          )}
          <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-line pt-4 text-body">
            <button
              type="button"
              disabled={busy || !library.data}
              onClick={() =>
                void act(async () => download(`rules-${check}.md`, await textFile(`/api/judges/${check}/export`)))
              }
              className="inline-flex items-center gap-1.5 text-fg-2 hover:text-fg hover:underline disabled:opacity-40"
            >
              <Download aria-hidden className="size-3.5" />
              Скачать текущие правила
            </button>
            {check === "tone" && (
              <Link
                to={toneCheckLink("criteria")}
                className="inline-flex items-center gap-1.5 text-fg-2 hover:text-fg hover:underline"
              >
                <ListChecks aria-hidden className="size-3.5" />
                Проверить отдельные критерии
              </Link>
            )}
          </div>
        </div>
      </Sheet>
      {editing !== undefined && (
        <RuleEditor
          key={editing?.id ?? "new"}
          check={check}
          version={editing}
          baseId={library.data?.versions.filter((v) => v.setId === editing?.setId).slice(-1)[0]?.id}
          replacesResult={hasResult}
          onClose={() => setEditing(undefined)}
        />
      )}
      <Modal
        open={!!asking}
        onClose={() => !busy && setAsking(null)}
        title="Взять другие правила?"
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setAsking(null)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={blocked}
              onClick={() =>
                asking &&
                void act(async () => {
                  await library.select(asking.id);
                  setAsking(null);
                })
              }
            >
              Взять
            </Button>
          </>
        }
      >
        <p className="text-read text-fg-2">
          Итог {CHECK_NAME[check]} по прежним правилам уйдёт в историю вместе со сценариями из него. Следующая проверка
          пойдёт по {asking?.id ? `набору «${asking.name}»` : asking?.name}.
        </p>
      </Modal>
    </>
  );
}
