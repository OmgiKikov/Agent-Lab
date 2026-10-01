import { useEffect, useRef } from "react";
import { ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Criterion } from "../../lab/criteria";
import type { DialogRow } from "../../lab/dialogs";
import { personaName } from "../../lab/look";
import type { Persona } from "../../lab/types";
import { Menu } from "../../ui/Menu";
import { Search } from "../../ui/Search";
import { Segmented } from "../../ui/Segmented";
import { Tag } from "../../ui/Tag";
import { criteriaByText, matchesRow, VERDICTS, type Src, type Verdict } from "./model";

/** A dialogue's verdict as a sign and a word: colour never stands alone. */
export function VerdictWord({ status, className }: { status: DialogRow["status"]; className?: string }) {
  const [word, dot, text] = status === "FAIL" ? ["нарушение", "bg-bad", "text-bad"]
    : status === "PASS" ? ["без нарушений", "bg-ok", "text-ok"]
    : status === "RUNNING" ? ["идёт", "bg-run", "text-run"]
    : status ? ["не оценён", "border border-dashed border-fg-3", "text-fg-3"] : [null, "", ""];
  if (!word) return null;
  return <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-meta", text, className)}><span aria-hidden className={cn("size-1.5 rounded-full", dot)} />{word}</span>;
}

function Row({ r, on, onOpen, numbers, personas }: { r: DialogRow; on: boolean; onOpen: () => void; numbers: number[]; personas: Persona[] }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (on) ref.current?.scrollIntoView({ block: "nearest" }); }, [on]);
  const who = r.source === "sim" ? [personaName(personas, r.persona), r.attempt && r.attempt > 1 ? `повтор ${r.attempt}` : ""].filter(Boolean).join(" · ") : "";
  return (
    <button ref={ref} type="button" onClick={onOpen} aria-current={on ? "true" : undefined}
      className={cn("relative block w-full border-b border-line py-3 pl-5 pr-4 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-run/60",
        on ? "bg-raised before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-fg" : "hover:bg-hover")}>
      <span className="flex items-center gap-2"><VerdictWord status={r.status} />{r.disputed && <Tag tone="warn">судьи расходятся</Tag>}</span>
      <span className="mt-1 line-clamp-2 text-body text-fg">{r.title}</span>
      <span className="mt-1 flex flex-wrap gap-x-1.5 text-meta text-fg-3">
        {r.topic && <span className="truncate">{r.topic}</span>}
        {who && <><span aria-hidden>·</span><span>{who}</span></>}
        {numbers.length > 0 && <><span aria-hidden>·</span><span>нарушены <span className="font-mono text-fg-2">{numbers.join(", ")}</span></span></>}
      </span>
    </button>
  );
}

/** The list of dialogues: whose (logs, a run, any trace), which verdict, a criterion, a search; one row per conversation. */
export function Rows({ src, onSrc, counts, all, rows, verdict, onVerdict, rule, onClearRule, query, onQuery, selected, onOpen, criteria, personas, runMenu, className }: {
  src: Src; onSrc: (s: Src) => void; counts: Record<Src, number | undefined>; all: DialogRow[]; rows: DialogRow[]; verdict: Verdict; onVerdict: (v: Verdict) => void;
  rule: Criterion | null; onClearRule: () => void; query: string; onQuery: (q: string) => void; selected: string | null; onOpen: (key: string) => void;
  criteria: Criterion[]; personas: Persona[]; runMenu?: React.ReactNode; className?: string;
}) {
  const find = criteriaByText(criteria);
  const numbers = (r: DialogRow) => [...new Set(r.rules.filter(x => x.status === "FAIL").flatMap(x => { const c = find(x.rule); return c ? [c.n] : []; }))].sort((a, b) => a - b);
  const count = (v: Verdict) => all.filter(r => matchesRow(r, v, "", null)).length;
  const current = VERDICTS.find(v => v.value === verdict)!;
  return (
    <div className={cn("flex min-h-0 flex-col border-line bg-list lg:border-r", className)}>
      <div className="space-y-2 border-b border-line px-4 py-3">
        <Segmented<Src> label="Чьи диалоги" value={src} onChange={onSrc} className="w-full" options={[
          { value: "log", label: "Логи", count: counts.log }, { value: "sim", label: "Симуляция", count: counts.sim }, { value: "traces", label: "Трейсы", count: counts.traces },
        ]} />
        <div className="flex flex-wrap items-center gap-2">
          {src !== "traces" && (
            <Menu trigger={<span className="inline-flex h-8 items-center gap-1.5 rounded-control border border-line-strong px-2.5 text-small text-fg-2 transition-colors hover:text-fg">{current.label}<span className="font-mono text-meta text-fg-3">{count(verdict)}</span><ChevronDown aria-hidden className="size-3.5" /></span>}
              items={VERDICTS.map(v => ({ key: v.value, label: v.label, sub: `${count(v.value)}`, on: v.value === verdict, run: () => onVerdict(v.value) }))} />
          )}
          {runMenu}
          <Search value={query} onChange={onQuery} placeholder="Найти по словам клиента" className="min-w-40 flex-1" />
        </div>
        {rule && (
          <span className="flex items-center gap-2 rounded-control border border-warn/35 bg-warn/[0.08] px-2.5 py-1.5 text-small text-fg">
            <span className="min-w-0 flex-1 truncate">нарушен критерий {rule.n}: {rule.name}</span>
            <button type="button" onClick={onClearRule} aria-label="Снять отбор по критерию" className="text-fg-3 hover:text-fg"><X className="size-3.5" /></button>
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto" role="list" aria-label="Диалоги">
        {rows.map(r => <Row key={r.key} r={r} on={r.key === selected} onOpen={() => onOpen(r.key)} numbers={numbers(r)} personas={personas} />)}
        {!rows.length && <p className="px-5 py-10 text-center text-small text-fg-3">{all.length ? "В этом отборе диалогов нет" : src === "log" ? "Логи ещё не загружены" : src === "sim" ? "В этом прогоне нет диалогов" : "Workshop ещё не записал трейсов"}</p>}
      </div>
      {rows.length > 0 && <div className="border-t border-line px-4 py-2 text-meta text-fg-3">{rows.length} из {all.length} · J и K листают</div>}
    </div>
  );
}
