import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight, Download, Loader2, Plus, RotateCcw, Sparkles } from "lucide-react";
import { launchLink } from "../../app/links";
import { api, textFile } from "../../lab/api";
import { CHECK_NAME, resultOf } from "../../lab/checks";
import { useJudges, type JudgeVersion } from "../../lab/judges";
import { useLabState } from "../../lab/LabProvider";
import { download } from "../../lab/problemReport";
import type { Check } from "../../lab/types";
import { TONE_ID } from "../../lab/tone";
import { Button, buttonClass } from "../../ui/Button";
import { Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { Modal } from "../../ui/Modal";
import { Sheet } from "../../ui/Sheet";
import { DocumentRules } from "./DocumentRules";
import { RuleEditor } from "./RuleEditor";
import { RuleSet } from "./RuleSet";

/**
 * «Правила» of a check, over its criteria: the rule sets with their versions, which one the checks go by, a new
 * version or set, and for tone of voice the criteria collected from the bank's document (?doc=1 opens it). Taking
 * other rules sends the current result to the history (the result is always by the current rules), so it is asked
 * first when there is one.
 */
export function RulesSheet({ check, open, onClose }: { check: Check; open: boolean; onClose: () => void }) {
  const library = useJudges(check);
  const { state, refresh } = useLabState();
  const [params, setParams] = useSearchParams();
  const doc = check === "tone" && params.get("doc") === "1";
  const showDoc = (on: boolean) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (on) n.set("doc", "1");
        else n.delete("doc");
        return n;
      },
      { replace: true },
    );
  // Collecting the criteria is long work of the agent: said here while it goes, and why it stopped when it failed.
  const collecting = !!state?.job.running && state.job.kind === "tone-criteria";
  const collectFailed =
    check === "tone" && !state?.job.running && state?.job.kind === "tone-criteria" && !!state.job.error
      ? state.job.error
      : null;
  const hasDocument = !!state?.sources.some((s) => s.id === TONE_ID);
  // The criteria were just collected and nothing ran since: the next step is the check itself.
  const collected = check === "tone" && !state?.job.running && state?.job.kind === "tone-criteria" && !state.job.error;
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
        open={open && editing === undefined && !doc}
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
              <Button variant="ghost" icon={Sparkles} disabled={blocked || collecting} onClick={() => showDoc(true)}>
                Собрать из документа
              </Button>
            )}
          </div>
          {collecting && (
            <div role="status" className="flex flex-wrap items-center gap-3 rounded-block bg-inset p-4 text-body">
              <Loader2 aria-hidden className="size-4 animate-spin text-fg-3" />
              <span className="min-w-0 flex-1">Собираем критерии из правил общения. Это займёт пару минут.</span>
              <Button
                size="sm"
                onClick={() =>
                  void act(async () => {
                    await api("/api/job/stop", {});
                    await refresh();
                  })
                }
              >
                Остановить
              </Button>
            </div>
          )}
          {collected && (
            <div role="status" className="flex flex-wrap items-center gap-3 rounded-block bg-inset p-4 text-body">
              <span className="min-w-0 flex-1 text-fg-2">
                Критерии собраны: {library.selected?.name ?? "правила общения"}. Следующий шаг — проверка разговоров.
              </span>
              <Link to={launchLink("tone")} className={buttonClass({ variant: "primary", size: "sm" })}>
                Новая проверка
                <ArrowRight aria-hidden className="size-3.5" />
              </Link>
            </div>
          )}
          {collectFailed && collectFailed !== "Остановлено" && (
            <p role="alert" className="text-body text-bad">
              Критерии не собрались: {collectFailed}
            </p>
          )}
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
            {check === "tone" && hasDocument && (
              <button
                type="button"
                disabled={blocked || collecting}
                onClick={() => showDoc(true)}
                className="inline-flex items-center gap-1.5 text-fg-2 hover:text-fg hover:underline disabled:opacity-40"
              >
                <RotateCcw aria-hidden className="size-3.5" />
                Собрать критерии заново из документа
              </button>
            )}
          </div>
        </div>
      </Sheet>
      <DocumentRules open={open && doc} onClose={() => showDoc(false)} />
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
