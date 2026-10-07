import { useState } from "react";
import { Check as CheckIcon, Download, Plus, Pencil, Sparkles } from "lucide-react";
import { Header } from "../../app/Header";
import { StageTabs } from "../../app/StageTabs";
import { CHECK_NAME } from "../../lab/checks";
import { useJudges, type JudgeVersion } from "../../lab/judges";
import { api, textFile } from "../../lab/api";
import { useLabState } from "../../lab/LabProvider";
import { download } from "../../lab/problemReport";
import { count, when } from "../../lab/format";
import type { Check } from "../../lab/types";
import { Button } from "../../ui/Button";
import { LoadFailed } from "../../ui/LoadFailed";
import { RuleEditor } from "./RuleEditor";

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
  const blocked = busy || !!state?.job.running;
  return (
    <div>
      <Header
        title={`${CHECK_NAME[check]} · Правила судьи`}
        tabs={<StageTabs stage={check} />}
        actions={
          <Button variant="primary" icon={Plus} disabled={blocked} onClick={() => setEditing(null)}>
            Новый набор
          </Button>
        }
      />
      <div className="max-w-[1120px] px-4 py-8 lg:px-10">
        <h2 className="text-title font-semibold text-fg">Наборы правил и версии</h2>
        <p className="mt-2 max-w-[65ch] text-read text-fg-3">
          Выберите правила перед запуском. Изменения сохраняются новой версией, старые проверки остаются
          воспроизводимыми.
        </p>
        {check === "code" && (
          <Button
            className="mt-5"
            disabled={blocked || !library.data?.selectedId}
            onClick={() => act(() => library.select(null))}
          >
            Использовать критерии из кода агента
          </Button>
        )}
        {check === "tone" && library.selected && (
          <Button
            className="mt-5"
            icon={Sparkles}
            disabled={blocked || !state?.logs.total}
            onClick={() =>
              act(async () => {
                await api("/api/tone-of-voice/criteria", {});
                await library.reload();
              })
            }
          >
            Сформировать критерии из выбранных правил
          </Button>
        )}
        <Button
          className="mt-5 ml-2"
          icon={Download}
          onClick={() => act(async () => download(`rules-${check}.md`, await textFile(`/api/judges/${check}/export`)))}
        >
          Скачать текущие правила
        </Button>
        {error && (
          <p role="alert" className="mt-4 text-bad">
            {error}
          </p>
        )}
        {library.isError && (
          <LoadFailed title="Не удалось загрузить правила" error={library.error} onRetry={() => library.refetch()} />
        )}
        <div className="mt-6 space-y-4">
          {library.data?.versions
            .slice()
            .reverse()
            .map((v) => (
              <section key={v.id} className="rounded-block border border-line p-5">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-read font-semibold text-fg">
                      {v.name} <span className="font-normal text-fg-3">· v{v.version}</span>
                    </h3>
                    <p className="mt-1 text-small text-fg-3">
                      {count(v.criteria.length, "критерий", "критерия", "критериев")} ·{" "}
                      {v.builtin ? "Встроенный набор" : when(v.createdAt)}
                    </p>
                  </div>
                  <Button
                    icon={v.id === library.data?.selectedId ? CheckIcon : undefined}
                    disabled={blocked || v.id === library.data?.selectedId}
                    onClick={() => act(() => library.select(v.id))}
                  >
                    {v.id === library.data?.selectedId ? "Выбран" : "Выбрать"}
                  </Button>
                  <Button variant="ghost" icon={Pencil} disabled={blocked} onClick={() => setEditing(v)}>
                    {v.builtin ? "Создать копию" : "Изменить"}
                  </Button>
                  <Button
                    variant="ghost"
                    icon={Download}
                    aria-label={`Скачать ${v.name} v${v.version}`}
                    onClick={() =>
                      act(async () =>
                        download(`rules-v${v.version}.md`, await textFile(`/api/judge-versions/${v.id}/download`)),
                      )
                    }
                  />
                </div>
                <details className="mt-4 border-t border-line pt-3">
                  <summary className="cursor-pointer text-body text-fg-3">Посмотреть критерии</summary>
                  <ol className="mt-3 list-inside list-decimal space-y-3">
                    {v.criteria.map((r) => (
                      <li key={r.id} className="text-body text-fg">
                        <b>{r.name}</b>
                        <p className="mt-1 whitespace-pre-wrap text-fg-3">{r.text}</p>
                      </li>
                    ))}
                  </ol>
                </details>
              </section>
            ))}
        </div>
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
