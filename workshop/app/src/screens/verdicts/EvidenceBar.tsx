import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Example } from "../../lab/problems";
import { exampleKey } from "../../lab/verdicts";
import { Button } from "../../ui/Button";
import { PillTabs } from "../../ui/PillTabs";
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

/** Raindrop's evidence bar: «Рекомендуемый · Первый · Последний · Все» on the left; on the right «1 / 3», «Назад» and «Дальше». */
export function EvidenceBar({ mode, onMode, at, total, onAt }: { mode: EvidenceMode; onMode: (m: EvidenceMode) => void; at: number; total: number; onAt: (n: number) => void }) {
  return (
    <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-white/[0.08] px-3 py-[7px]">
      <PillTabs<EvidenceMode> label="Порядок примеров" value={mode} onChange={onMode} tabs={MODES} />
      {mode !== "all" && total > 0 && (
        <div className="flex items-center gap-2">
          <span className="mr-1 text-meta text-lab-dim">{at + 1} / {total}</span>
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
    <div>
      {list.map((e, i) => (
        <button key={exampleKey(e)} type="button" onClick={() => onPick(i)} className="block w-full border-b border-white/[0.08] px-4 py-3 text-left hover:bg-lab-hover">
          <div className="truncate text-small font-medium text-lab-ink">{e.opening}</div>
          <div className="mt-0.5 truncate text-meta text-lab-mute">{exampleWhere(e, state?.personas ?? [])} · {e.reason}</div>
        </button>
      ))}
    </div>
  );
}
