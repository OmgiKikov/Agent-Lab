import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Example } from "../../lab/problems";
import { exampleKey } from "../../lab/verdicts";
import { Button } from "../../ui/Button";
import { useLabState } from "../../shell/LabProvider";
import { exampleWhere } from "./Example";

export type EvidenceMode = "rec" | "first" | "last" | "all";
const MODES: { value: EvidenceMode; label: string; title: string }[] = [
  { value: "rec", label: "Рекомендуемый", title: "Лучше всего подкреплённый: судьи согласны, цитата найдена" },
  { value: "first", label: "Первый", title: "По порядку диалогов: с начала" },
  { value: "last", label: "Последний", title: "По порядку диалогов: с конца" },
  { value: "all", label: "Все", title: "Все примеры списком" },
];

export const modeOf = (raw: string | null): EvidenceMode => (MODES.some(m => m.value === raw) ? (raw as EvidenceMode) : "rec");

/** The examples in the order the mode asks for: the service's own order is the recommended one. */
export function orderExamples(list: Example[], mode: EvidenceMode): Example[] {
  if (mode === "first" || mode === "last") {
    const sorted = [...list].sort((a, b) => exampleKey(a).localeCompare(exampleKey(b), "ru", { numeric: true }));
    return mode === "last" ? sorted.reverse() : sorted;
  }
  return list;
}

/** Raindrop's evidence bar: «Рекомендуемый · Первый · Последний · Все», then «1/3», back and «Дальше». */
export function EvidenceBar({ mode, onMode, at, total, onAt }: { mode: EvidenceMode; onMode: (m: EvidenceMode) => void; at: number; total: number; onAt: (n: number) => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div role="tablist" aria-label="Порядок примеров" className="flex items-center gap-1">
        {MODES.map(m => (
          <button
            key={m.value} type="button" role="tab" aria-selected={mode === m.value} title={m.title} onClick={() => onMode(m.value)}
            className={cn("rounded-md px-2.5 py-1 text-body transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-lab-accent", mode === m.value ? "bg-lab-active text-lab-ink" : "text-lab-dim hover:text-lab-text")}
          >
            {m.label}
          </button>
        ))}
      </div>
      {mode !== "all" && total > 0 && (
        <div className="flex items-center gap-1.5">
          <span className="mr-1 text-body text-lab-dim">{at + 1}/{total}</span>
          <Button size="sm" variant="ghost" icon={ChevronLeft} kbd="←" disabled={at <= 0} onClick={() => onAt(at - 1)}>Назад</Button>
          <Button size="sm" kbd="→" disabled={at >= total - 1} onClick={() => onAt(at + 1)}>Дальше<ChevronRight aria-hidden className="size-3.5" /></Button>
        </div>
      )}
    </div>
  );
}

/** «Все»: every example as a row; a click opens it in the recommended view. */
export function EvidenceAll({ list, onPick }: { list: Example[]; onPick: (i: number) => void }) {
  const { state } = useLabState();
  return (
    <div className="mt-3 rounded-lg border border-white/[0.07]">
      {list.map((e, i) => (
        <button key={exampleKey(e)} type="button" onClick={() => onPick(i)} className="block w-full border-b border-white/[0.06] px-4 py-2.5 text-left last:border-b-0 hover:bg-lab-hover">
          <div className="truncate text-body text-lab-ink">{e.opening}</div>
          <div className="mt-0.5 truncate text-meta text-lab-dim">{exampleWhere(e, state?.personas ?? [])} · {e.reason}</div>
        </button>
      ))}
    </div>
  );
}
