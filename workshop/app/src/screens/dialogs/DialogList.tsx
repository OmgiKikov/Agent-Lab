import { useMemo } from "react";
import { AlertCircle, CheckCircle2, CircleDashed, Search, Swords, Users, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Criterion, Topic } from "../../lab/criteria";
import type { DialogRow, Source } from "../../lab/dialogs";
import { personaName } from "../../lab/look";
import type { Persona } from "../../lab/types";
import { MarkStack } from "../../ui/Mark";
import { Chips, Pill } from "../../ui/Pill";

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

const textKey = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

/** The verdict of a dialogue as a small pill: the colour of the status, the word beside it. */
function VerdictPill({ status }: { status: DialogRow["status"] }) {
  if (status === "FAIL") return <Pill dot="rgb(226,138,128)" className="border-lab-bad/30 bg-lab-bad/[0.08] text-[rgb(236,170,162)]">нарушение</Pill>;
  if (status === "PASS") return <Pill dot="rgb(116,185,142)" className="border-lab-ok/25 bg-lab-ok/[0.07] text-lab-ok">без нарушений</Pill>;
  if (status === "RUNNING") return <Pill dot="rgb(166,196,205)">идёт</Pill>;
  return <Pill dot="rgba(255,255,255,0.35)">не оценён</Pill>;
}

/**
 * The dialogues of one source as a list of rows: the customer's first words, the topic, the verdict, and the
 * numbers of the criteria broken in it (the same numbers as everywhere). Filters as chips and a search.
 */
export function DialogList({ rows, all, verdict, onVerdict, query, onQuery, rule, onClearRule, onOpen, personas, criteria, topics }: {
  rows: DialogRow[]; all: DialogRow[];
  verdict: Verdict; onVerdict: (v: Verdict) => void; query: string; onQuery: (q: string) => void;
  rule: Criterion | null; onClearRule: () => void; onOpen: (key: string) => void; personas: Persona[];
  criteria: Criterion[]; topics: Topic[];
}) {
  const count = (v: Verdict) => all.filter(r => matchesRow(r, "all", v, "", null)).length;
  const byText = useMemo(() => new Map(criteria.map(c => [textKey(c.r.rule.text), c.n])), [criteria]);
  const broken = (r: DialogRow) => [...new Set(r.rules.filter(x => x.status === "FAIL").flatMap(x => { const n = byText.get(textKey(x.rule)); return n ? [n] : []; }))].sort((a, b) => a - b);
  const hue = (topic: string) => topics.find(t => t.topic === topic);

  return (
    <div className="h-full overflow-auto px-6 pb-16 pt-5">
      <div className="flex flex-wrap items-center gap-2">
        <Chips<Verdict> value={verdict === "all" ? null : verdict} onChange={v => onVerdict(v ?? "all")} options={[
          { value: null, label: "Все", count: all.length },
          { value: "fail", label: "С нарушениями", count: count("fail"), icon: AlertCircle },
          { value: "pass", label: "Без нарушений", count: count("pass"), icon: CheckCircle2 },
          { value: "none", label: "Не оценены", count: count("none"), icon: CircleDashed },
          { value: "disputed", label: "Судьи расходятся", count: count("disputed"), icon: Swords },
        ]} />
        {rule && (
          <span className="inline-flex h-7 max-w-[340px] items-center gap-1.5 rounded-full border border-[rgba(232,145,45,0.4)] bg-[rgba(232,145,45,0.08)] px-2.5 text-[12px] text-[rgb(255,212,163)]">
            <span className="truncate">нарушен критерий {rule.n}: {rule.name}</span>
            <button type="button" onClick={onClearRule} aria-label="Снять отбор по критерию" className="text-[rgb(255,212,163)]/70 hover:text-white"><X className="size-3.5" /></button>
          </span>
        )}
        <label className="ml-auto flex h-8 w-[220px] items-center gap-2 rounded-lg border border-white/[0.1] bg-white/[0.03] px-2.5 focus-within:border-white/[0.22]">
          <Search className="size-3.5 text-lab-dim" />
          <input value={query} onChange={e => onQuery(e.target.value)} placeholder="Найти разговор" aria-label="Найти разговор" className="min-w-0 flex-1 bg-transparent text-[12px] text-lab-ink outline-none placeholder:text-lab-faint" />
        </label>
      </div>

      {rows.length ? (
        <div className="mt-4 overflow-hidden rounded-[12px] border border-white/[0.08] bg-[rgb(31,31,31)]">
          {rows.map(r => {
            const t = hue(r.topic);
            const who = r.source === "sim" ? [personaName(personas, r.persona), r.attempt && r.attempt > 1 ? `повтор ${r.attempt}` : ""].filter(Boolean).join(" · ") : "";
            const ns = broken(r);
            const humans = r.rules.filter(x => x.status === "FAIL" && x.review).length;
            return (
              <button key={r.key} type="button" onClick={() => onOpen(r.key)}
                className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-white/[0.06] px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-white/[0.03] md:grid-cols-[minmax(0,1fr)_130px_150px]">
                <span className="min-w-0">
                  <span className="block truncate text-[13px] text-lab-ink">{r.title}</span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {r.topic && <Pill dot={t?.hue} hue={t?.hue} title={r.topic}>{t?.short ?? r.topic.split(",")[0]}</Pill>}
                    {who && <Pill icon={Users}>{who}</Pill>}
                    {r.disputed && <Pill icon={Swords} title="Второй судья вынес другой вердикт">судьи расходятся</Pill>}
                    {humans > 0 && <span className="text-[11px] text-lab-dim">проверено людьми: {humans}</span>}
                  </span>
                </span>
                <span className="hidden md:block"><VerdictPill status={r.status} /></span>
                <span className={cn("flex justify-end")}>{ns.length ? <MarkStack ns={ns} max={5} ring="ring-[rgb(31,31,31)]" /> : <span className="text-[11px] text-lab-faint">—</span>}</span>
              </button>
            );
          })}
        </div>
      ) : <p className="mt-10 text-center text-[13px] text-lab-dim">В этом отборе разговоров нет</p>}
      {rows.length > 0 && <p className="mt-3 text-[11px] text-lab-faint">{rows.length} из {all.length} · номера справа — нарушенные критерии · J и K листают открытый разговор</p>}
    </div>
  );
}
