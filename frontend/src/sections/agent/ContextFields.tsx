import { useState } from "react";
import { BookOpen, Plus, X } from "lucide-react";
import { api } from "../../lab/api";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Field";

/** What the judge is told about the agent besides its code (backend/lab/flows/agent_context.py). */
export type AgentContext = {
  repositoryUrl: string;
  tools: string[];
  idpUrl: string;
  idpIndex: string;
  idpEmbedder: string;
  idpFilter: string;
};

/** The agent's tools a person names: the judge counts them as available, beside the ones found in the code. */
export function ToolsField({ tools, onChange }: { tools: string[]; onChange: (tools: string[]) => void }) {
  const [tool, setTool] = useState("");
  const add = () => {
    const value = tool.trim();
    if (value && !tools.includes(value)) onChange([...tools, value]);
    setTool("");
  };
  return (
    <div>
      <label htmlFor="manual-tool" className="mb-1.5 block text-small font-medium text-fg-2">
        Инструменты агента
      </label>
      {tools.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {tools.map((t) => (
            <span
              key={t}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-hover py-1 pl-3 pr-1 font-mono text-small"
            >
              <span className="break-all">{t}</span>
              <Button
                size="sm"
                variant="ghost"
                icon={X}
                aria-label={`Убрать инструмент ${t}`}
                onClick={() => onChange(tools.filter((x) => x !== t))}
              />
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Input
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
          placeholder="Название инструмента и Enter"
          className="h-9 font-mono text-small"
          spellCheck={false}
        />
        <Button icon={Plus} disabled={!tool.trim() || tools.length >= 100} onClick={add}>
          Добавить
        </Button>
      </div>
      <p className="mt-1.5 text-small text-fg-3">
        Дополняет инструменты из кода агента, чтобы судья не принял их вызовы за выдумку.
      </p>
    </div>
  );
}

const KNOWLEDGE = [
  ["idpIndex", "Индекс"],
  ["idpUrl", "Адрес API"],
  ["idpEmbedder", "Модель эмбеддингов"],
  ["idpFilter", "Фильтр · по желанию"],
] as const;

/**
 * The agent's knowledge base in IDP: with it the judge checks facts against the articles IDP returns, and a
 * conversation without them says so. «Проверить IDP» asks the saved settings, so it waits for a save.
 */
export function KnowledgeField({
  value,
  onChange,
  saved,
}: {
  value: AgentContext;
  onChange: (key: (typeof KNOWLEDGE)[number][0], text: string) => void;
  saved: boolean;
}) {
  const [checked, setChecked] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; error?: string; sources: number }>("/api/agent/idp/check", {});
      setChecked({
        ok: r.ok,
        text: r.ok ? `IDP отвечает: статей по пробному вопросу — ${r.sources}` : r.error || "Статьи не найдены",
      });
    } catch (cause) {
      setChecked({ ok: false, text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <details open={!!value.idpIndex} className="group">
      <summary className="cursor-pointer list-none text-small font-medium text-fg-2 hover:text-fg [&::-webkit-details-marker]:hidden">
        <BookOpen aria-hidden className="mr-2 inline size-4 text-fg-3" />
        База знаний IDP
        <span className="font-normal text-fg-3"> · {value.idpIndex ? value.idpIndex : "не подключена"}</span>
      </summary>
      <p className="mt-2 text-small text-fg-3">
        С базой знаний судья сверяет факты в ответах агента со статьями, которые вернула IDP.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {KNOWLEDGE.map(([key, label]) => (
          <label key={key} className="block">
            <span className="mb-1.5 block text-small text-fg-3">{label}</span>
            <Input
              value={value[key]}
              onChange={(e) => {
                onChange(key, e.target.value);
                setChecked(null);
              }}
              className="h-9 font-mono text-small"
              spellCheck={false}
            />
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          loading={busy}
          disabled={!saved || !value.idpUrl || !value.idpIndex || !value.idpEmbedder}
          onClick={check}
          title={saved ? undefined : "Сначала сохраните изменения"}
        >
          Проверить IDP
        </Button>
        {checked && (
          <span role="status" className={checked.ok ? "text-small text-ok" : "text-small text-bad"}>
            {checked.text}
          </span>
        )}
      </div>
    </details>
  );
}
