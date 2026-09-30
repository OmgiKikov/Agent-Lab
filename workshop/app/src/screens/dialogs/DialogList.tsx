import { Link } from "react-router-dom";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { when } from "../../lab/format";
import type { DialogRow, Source } from "../../lab/dialogs";
import { personaName } from "../../lab/look";
import type { Persona } from "../../lab/types";
import { ListRow } from "../../ui/ListRow";
import { Segmented } from "../../ui/Segmented";

export type Verdict = "all" | "fail" | "pass" | "none" | "disputed";
export type SourceFilter = "all" | Source;

export function matchesRow(r: DialogRow, source: SourceFilter, verdict: Verdict, query: string, only: Set<string> | null) {
  if (only && !only.has(r.key)) return false;
  if (source !== "all" && r.source !== source) return false;
  if (verdict === "fail" && r.status !== "FAIL") return false;
  if (verdict === "pass" && r.status !== "PASS") return false;
  if (verdict === "none" && (r.source === "trace" || r.status === "PASS" || r.status === "FAIL")) return false;
  if (verdict === "disputed" && !r.disputed) return false;
  const q = query.trim().toLowerCase();
  return !q || [r.title, r.topic, ...r.fails].some(s => s.toLowerCase().includes(q));
}

const SOURCE: Record<Source, string> = { log: "лог", sim: "симуляция", trace: "трейс" };

function Mark({ row }: { row: DialogRow }) {
  if (row.source === "trace") return <span className="mt-1.5 size-1.5 flex-shrink-0 rounded-full bg-white/20" />;
  const tone = row.status === "FAIL" ? "bg-lab-bad" : row.status === "PASS" ? "bg-white/25" : "bg-lab-warn";
  return <span className={cn("mt-1.5 size-1.5 flex-shrink-0 rounded-full", tone)} title={row.status === "FAIL" ? "нарушение" : row.status === "PASS" ? "без обнаруженных нарушений" : "не оценён"} />;
}

function Row({ row, selected, onClick, personas }: { row: DialogRow; selected: boolean; onClick: () => void; personas: Persona[] }) {
  const who = row.source === "sim" ? [personaName(personas, row.persona), row.attempt && row.attempt > 1 ? `повтор ${row.attempt}` : ""].filter(Boolean).join(" · ") : "";
  return (
    <ListRow selected={selected} onClick={onClick}>
      <div className="flex gap-3">
        <Mark row={row} />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-small text-lab-ink">{row.title}</div>
          <div className="mt-1 truncate text-meta text-lab-dim">{[row.topic, who].filter(Boolean).join(" · ")}</div>
          {row.fails.length > 0 && <div className="mt-0.5 truncate text-meta text-lab-bad">{row.fails[0]}{row.fails.length > 1 && ` и ещё ${row.fails.length - 1}`}</div>}
          {row.status === "UNMEASURED" && <div className="mt-0.5 text-meta text-lab-warn">не оценён</div>}
          {row.disputed && <div className="mt-0.5 text-meta text-lab-warn">судьи расходятся</div>}
        </div>
        <div className="flex-shrink-0 text-right text-meta text-lab-dim">
          <div>{SOURCE[row.source]}</div>
          {row.when && <div className="mt-0.5">{when(row.when)}</div>}
        </div>
      </div>
    </ListRow>
  );
}

const MODE = "inline-flex h-6 items-center rounded px-2.5 text-meta transition-colors";

/** All dialogues in one list: the logs, the simulator and any other trace; filters, a search, the rule it is narrowed to. */
export function DialogList({ rows, all, selected, source, onSource, verdict, onVerdict, query, onQuery, rule, onClearRule, onPick, personas }: {
  rows: DialogRow[]; all: DialogRow[]; selected: string | null; source: SourceFilter; onSource: (s: SourceFilter) => void;
  verdict: Verdict; onVerdict: (v: Verdict) => void; query: string; onQuery: (q: string) => void;
  rule: string | null; onClearRule: () => void; onPick: (key: string) => void; personas: Persona[];
}) {
  const judged = all.filter(r => r.source !== "trace");
  return (
    <div>
      <div className="sticky top-0 z-10 space-y-2 border-b border-white/[0.06] bg-lab-surface px-4 py-2.5">
        <nav aria-label="Режим" className="flex gap-0.5">
          <span className={cn(MODE, "bg-lab-active text-lab-ink")}>Все</span>
          <Link to="/saved" className={cn(MODE, "text-lab-mute hover:text-lab-text")}>Сохранённые</Link>
          <Link to="/search" className={cn(MODE, "text-lab-mute hover:text-lab-text")}>Поиск по трейсам</Link>
        </nav>
        <Segmented value={source} onChange={onSource} options={[
          { value: "all", label: "Все", count: all.length },
          { value: "log", label: "Логи", count: all.filter(r => r.source === "log").length },
          { value: "sim", label: "Симуляция", count: all.filter(r => r.source === "sim").length },
          { value: "trace", label: "Трейсы", count: all.filter(r => r.source === "trace").length },
        ]} />
        <Segmented value={verdict} onChange={onVerdict} options={[
          { value: "all", label: "Все" },
          { value: "fail", label: "Нарушения", count: judged.filter(r => r.status === "FAIL").length },
          { value: "pass", label: "Без нарушений", count: judged.filter(r => r.status === "PASS").length },
          { value: "none", label: "Не оценены", count: judged.filter(r => r.status !== "FAIL" && r.status !== "PASS").length },
          { value: "disputed", label: "Спорные", count: judged.filter(r => r.disputed).length },
        ]} />
        <label className="flex h-7 items-center gap-1.5 rounded-md border border-white/[0.08] px-2 text-meta text-lab-dim focus-within:border-white/25">
          <Search className="size-3.5 flex-shrink-0" />
          <input value={query} onChange={e => onQuery(e.target.value)} placeholder="Найти по реплике, теме, нарушению" aria-label="Найти диалог" className="min-w-0 flex-1 bg-transparent text-lab-text outline-none placeholder:text-lab-faint" />
        </label>
        {rule && (
          <div className="flex items-center gap-2 rounded-md bg-lab-bad/10 px-2 py-1 text-meta text-lab-bad">
            <span className="min-w-0 flex-1 truncate">Нарушено правило: {rule}</span>
            <button type="button" onClick={onClearRule} aria-label="Снять отбор по правилу" className="text-lab-dim hover:text-lab-text"><X className="size-3.5" /></button>
          </div>
        )}
      </div>
      {rows.map(r => <Row key={r.key} row={r} selected={r.key === selected} onClick={() => onPick(r.key)} personas={personas} />)}
      {!rows.length && <div className="px-4 py-10 text-center text-small text-lab-dim">В этом отборе диалогов нет</div>}
    </div>
  );
}
