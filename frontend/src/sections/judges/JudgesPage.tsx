import { useState } from "react";
import { Link } from "react-router-dom";
import { Download, Plus, Sparkles } from "lucide-react";
import { toneCheckLink } from "../../app/links";
import { useJudges, type JudgeVersion } from "../../lab/judges";
import { textFile } from "../../lab/api";
import { useLabState } from "../../lab/LabProvider";
import { download } from "../../lab/problemReport";
import type { Check } from "../../lab/types";
import { Button, buttonClass } from "../../ui/Button";
import { Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { CheckHeader } from "../checks/CheckHeader";
import { CriteriaNav } from "../criteria/CriteriaNav";
import { RuleEditor } from "./RuleEditor";
import { RuleSet } from "./RuleSet";

export function JudgesPage({ check }: { check: Check }) {
  const library = useJudges(check);
  const { state } = useLabState();
  const [editing, setEditing] = useState<JudgeVersion | null | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
    <div>
      <CheckHeader check={check} />
      <CriteriaNav check={check} />
      <div className="max-w-[1120px] px-4 py-8 lg:px-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-[65ch]">
            <h2 className="text-title font-semibold text-fg">Правила для следующей проверки</h2>
            <p className="mt-2 text-read text-fg-3">
              Каждый набор хранит свои версии. Новая версия применяется к следующим запускам; оценки и ответы людей в
              истории сохраняются.
            </p>
          </div>
          <Button icon={Plus} disabled={blocked || !library.data} onClick={() => setEditing(null)}>
            Новый набор
          </Button>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          {check === "tone" && (
            <Link to={toneCheckLink("materials")} className={buttonClass({ variant: "ghost" })}>
              <Sparkles aria-hidden className="size-3.5" />
              Собрать из документа
            </Link>
          )}
          {check === "code" && (
            <Button disabled={blocked || !library.data?.selectedId} onClick={() => act(() => library.select(null))}>
              Использовать критерии из кода агента
            </Button>
          )}
          <Button
            variant="ghost"
            icon={Download}
            disabled={busy || !library.data}
            onClick={() =>
              act(async () => download(`rules-${check}.md`, await textFile(`/api/judges/${check}/export`)))
            }
          >
            Скачать текущие правила
          </Button>
        </div>
        {check === "code" && library.data && !library.selected && (
          <p className="mt-3 text-body text-fg-3">
            Для запуска выбраны критерии из кода агента. Наборы ниже можно использовать вместо них.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-4 text-bad">
            {error}
          </p>
        )}
        {library.isError ? (
          <LoadFailed title="Не удалось загрузить правила" error={library.error} onRetry={() => library.refetch()} />
        ) : !library.data ? (
          <Skeleton className="mt-6 h-60" />
        ) : (
          <div className="mt-6 divide-y divide-line overflow-hidden rounded-block border border-line">
            {sets.map((versions) => (
              <RuleSet
                key={versions[0].setId}
                versions={versions}
                selectedId={library.data.selectedId}
                blocked={blocked}
                onSelect={(id) => void act(() => library.select(id))}
                onEdit={setEditing}
                onDownload={(v) =>
                  void act(async () =>
                    download(`rules-v${v.version}.md`, await textFile(`/api/judge-versions/${v.id}/download`)),
                  )
                }
              />
            ))}
          </div>
        )}
      </div>
      {editing !== undefined && (
        <RuleEditor
          key={editing?.id ?? "new"}
          check={check}
          version={editing}
          baseId={library.data?.versions.filter((v) => v.setId === editing?.setId).slice(-1)[0]?.id}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}
