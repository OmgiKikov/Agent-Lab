import { useState } from "react";
import { Check, Download, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { count, when } from "../../lab/format";
import type { JudgeVersion } from "../../lab/judges";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Field";
import { Tag } from "../../ui/Tag";

/** One rule set stays one row as its immutable versions accumulate. Inspecting a version never selects it for work. */
export function RuleSet({
  versions,
  selectedId,
  blocked,
  onSelect,
  onEdit,
  onDownload,
}: {
  versions: JudgeVersion[];
  selectedId: string | null;
  blocked: boolean;
  onSelect: (id: string) => void;
  onEdit: (version: JudgeVersion) => void;
  onDownload: (version: JudgeVersion) => void;
}) {
  const [viewed, setViewed] = useState<string | null>(null);
  const current =
    versions.find((v) => v.id === viewed) ?? versions.find((v) => v.id === selectedId) ?? versions[versions.length - 1];
  const on = current.id === selectedId;
  return (
    <section className={cn("px-5 py-5 sm:px-6", on && "bg-inset/40")}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-words text-read font-semibold text-fg">{current.name}</h3>
            {on && <Tag>Выбран для запуска</Tag>}
          </div>
          <p className="mt-1 text-small text-fg-3">
            {count(current.criteria.length, "критерий", "критерия", "критериев")} ·{" "}
            {current.builtin ? "Встроенный набор" : when(current.createdAt)}
          </p>
        </div>
        {versions.length > 1 ? (
          <Select
            aria-label={`Версия набора ${current.name}`}
            value={current.id}
            onChange={(e) => setViewed(e.target.value)}
            className="w-auto max-w-full"
          >
            {versions
              .slice()
              .reverse()
              .map((v, i) => (
                <option key={v.id} value={v.id}>
                  v{v.version}
                  {i === 0 ? " · последняя" : ""}
                  {v.id === selectedId ? " · выбрана" : ""}
                </option>
              ))}
          </Select>
        ) : (
          <span className="text-small text-fg-3">v{current.version}</span>
        )}
      </div>
      <details className="mt-4">
        <summary className="cursor-pointer text-body text-fg-2 hover:text-fg">Посмотреть критерии</summary>
        <ol className="mt-3 list-decimal space-y-4 pl-5">
          {current.criteria.map((rule) => (
            <li key={rule.id} className="pl-1 text-body text-fg">
              <p className="font-medium">{rule.name}</p>
              <p className="mt-1 whitespace-pre-wrap text-fg-3">{rule.text}</p>
              {rule.condition && <p className="mt-1 text-small text-fg-3">Когда применять: {rule.condition}</p>}
              {rule.acceptable && <p className="mt-1 text-small text-fg-3">Допустимо: {rule.acceptable}</p>}
            </li>
          ))}
        </ol>
      </details>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button icon={on ? Check : undefined} disabled={blocked || on} onClick={() => onSelect(current.id)}>
          {on ? `Выбрана v${current.version}` : `Выбрать v${current.version}`}
        </Button>
        <Button variant="ghost" icon={Pencil} disabled={blocked} onClick={() => onEdit(current)}>
          {current.builtin ? "Создать копию" : "Новая версия"}
        </Button>
        <Button
          variant="ghost"
          icon={Download}
          aria-label={`Скачать ${current.name} v${current.version}`}
          onClick={() => onDownload(current)}
        />
      </div>
    </section>
  );
}
