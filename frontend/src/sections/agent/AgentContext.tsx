import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Check, Plus, X } from "lucide-react";
import { AGENT } from "../../app/agent";
import { api } from "../../lab/api";
import { useLabState } from "../../lab/LabProvider";
import { Button } from "../../ui/Button";
import { LoadFailed } from "../../ui/LoadFailed";

type Context = {
  repositoryUrl: string;
  tools: string[];
  idpUrl: string;
  idpIndex: string;
  idpEmbedder: string;
  idpFilter: string;
};
const INPUT = "mt-1 w-full rounded-control border border-line-strong bg-canvas px-3 py-2 text-body text-fg";
function Editor({ saved, onSaved }: { saved: Context; onSaved: () => Promise<unknown> }) {
  const { state, refresh } = useLabState();
  const [form, setForm] = useState(saved);
  const [tool, setTool] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checked, setChecked] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const patch = (key: keyof Context, value: string | string[]) => {
    setForm((v) => ({ ...v, [key]: value }));
    setDone(false);
    setChecked(null);
  };
  const run = async (work: () => Promise<unknown>) => {
    if (busy) return;
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
  const add = () => {
    const value = tool.trim();
    if (value && !form.tools.includes(value)) patch("tools", [...form.tools, value]);
    setTool("");
  };
  return (
    <section className="mt-10 border-t border-line pt-8">
      <h2 className="text-title font-semibold text-fg">Контекст для проверки</h2>
      <p className="mt-2 text-body text-fg-3">
        Укажите дополнительные инструменты и базу знаний, которые должен учитывать судья.
      </p>
      <fieldset disabled={busy || state?.job.running} className="mt-5 space-y-5">
        <label className="block text-body font-medium text-fg">
          Ссылка на репозиторий <span className="font-normal text-fg-3">· вместо локальной папки</span>
          <input
            type="url"
            value={form.repositoryUrl}
            onChange={(e) => patch("repositoryUrl", e.target.value)}
            placeholder="https://git.example/team/agent.git"
            className={INPUT}
          />
          <span className="mt-1 block text-small font-normal text-fg-3">
            После сохранения нажмите «Прочитать код». Используется ваш настроенный доступ Git.
          </span>
        </label>
        <div>
          <label htmlFor="manual-tool" className="text-body font-medium text-fg">
            Доступные инструменты
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            {form.tools.map((t) => (
              <span
                key={t}
                className="inline-flex max-w-full items-center gap-1 rounded-full bg-hover py-1 pl-3 pr-1 text-small"
              >
                <span className="break-all">{t}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={X}
                  aria-label={`Убрать инструмент ${t}`}
                  onClick={() =>
                    patch(
                      "tools",
                      form.tools.filter((x) => x !== t),
                    )
                  }
                />
              </span>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              id="manual-tool"
              value={tool}
              maxLength={200}
              onChange={(e) => setTool(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
              placeholder="Название инструмента"
              className={`${INPUT} !mt-0`}
            />
            <Button icon={Plus} disabled={!tool.trim() || form.tools.length >= 100} onClick={add}>
              Добавить
            </Button>
          </div>
          <p className="mt-1 text-small text-fg-3">Дополняет инструменты, найденные в коде агента.</p>
        </div>
        <details open={!!form.idpIndex}>
          <summary className="cursor-pointer text-read font-medium text-fg">
            <BookOpen className="mr-2 inline size-4" />
            База знаний IDP
          </summary>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {(
              [
                ["idpIndex", "Индекс IDP"],
                ["idpUrl", "Адрес API IDP"],
                ["idpEmbedder", "Модель эмбеддингов"],
                ["idpFilter", "Фильтр breadcrumbs · необязательно"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="text-body text-fg">
                {label}
                <input value={form[key]} onChange={(e) => patch(key, e.target.value)} className={INPUT} />
              </label>
            ))}
          </div>
          <p className="mt-3 text-small text-fg-3">
            Судья получает реальные источники из выбранного индекса. Если IDP недоступна, результат явно укажет
            отсутствие доказательств.
          </p>
          <Button
            className="mt-3"
            disabled={dirty || !form.idpUrl || !form.idpIndex || !form.idpEmbedder}
            onClick={() =>
              run(async () => {
                const r = await api<{ ok: boolean; error?: string; sources: number }>("/api/agent/idp/check", {});
                setChecked(r.ok ? `IDP отвечает · источников: ${r.sources}` : r.error || "Источники не найдены");
              })
            }
          >
            Проверить IDP
          </Button>
          {checked && (
            <p role="status" className="mt-2 text-body text-fg-2">
              {checked}
            </p>
          )}
        </details>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            loading={busy}
            disabled={!dirty}
            onClick={() =>
              run(async () => {
                await api("/api/agent/context", form);
                await onSaved();
                await refresh();
                setDone(true);
              })
            }
          >
            Сохранить контекст
          </Button>
          {done && (
            <span role="status" className="inline-flex items-center gap-1 text-small text-ok">
              <Check className="size-3.5" />
              Сохранено
            </span>
          )}
        </div>
        {error && (
          <p role="alert" className="text-body text-bad">
            {error}
          </p>
        )}
      </fieldset>
    </section>
  );
}
export function AgentContext() {
  const q = useQuery({ queryKey: ["agent-context", AGENT], queryFn: () => api<Context>("/api/agent/context") });
  if (q.isError) return <LoadFailed title="Контекст не загрузился" error={q.error} onRetry={() => q.refetch()} />;
  return q.data ? <Editor key={JSON.stringify(q.data)} saved={q.data} onSaved={() => q.refetch()} /> : null;
}
