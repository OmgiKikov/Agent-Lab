import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown } from "lucide-react";
import { Header } from "../../app/Header";
import { SectionJob } from "../../app/SectionJob";
import { useWide } from "../../app/useWide";
import { useRuns } from "../../hooks/use-runs";
import { useCriteria } from "../../lab/criteria";
import { logKey, logRows, simKey, simRows, traceRows } from "../../lab/dialogs";
import { day, plural } from "../../lab/format";
import { runTitle, useRun } from "../../lab/runs";
import { useKeys } from "../../app/keys";
import { useLabState } from "../../lab/LabProvider";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Menu } from "../../ui/Menu";
import { UploadButton } from "../../product/UploadLogs";
import { Dialog } from "./Dialog";
import { matchesRow, toSrc, toVerdict, type Src, type Verdict } from "./model";
import { Rows } from "./Rows";

const link = "rounded-sm text-fg-2 decoration-line-strong decoration-dotted underline underline-offset-4 hover:text-fg";

/**
 * «Разговоры»: every conversation in one list, the logs', a run's and any trace the Workshop recorded; one dialogue in full
 * with the judge's quotes, every verdict and its trace. Where a count of another screen leads, filtered by its criterion.
 */
export function DialogsPage() {
  const { state, offline } = useLabState();
  const [params, setParams] = useSearchParams();
  const wide = useWide();
  const src = toSrc(params.get("src"));
  const runParam = params.get("run");
  const { data: problems, list: criteria } = useCriteria(src === "sim" ? runParam : null);
  const finished = useMemo(() => [...(state?.runs ?? [])].filter(r => r.status !== "running" && r.items !== null).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)), [state?.runs]);
  const simRunId = src === "sim" ? runParam ?? problems?.sim?.runId ?? finished[0]?.id ?? null : null;
  const run = useRun(simRunId, state);
  const traces = useRuns();
  const [query, setQuery] = useState("");
  const verdict = toVerdict(params.get("v"));
  const ruleId = params.get("rule");
  const set = (edit: (n: URLSearchParams) => void, replace = true) => setParams(prev => { const n = new URLSearchParams(prev); edit(n); return n; }, { replace });

  const all = useMemo(() => (src === "log" ? (state ? logRows(state) : []) : src === "sim" ? simRows(run.data) : traceRows(traces.data ?? [])), [src, state, run.data, traces.data]);
  const rule = ruleId && src !== "traces" ? problems?.rules.find(r => r.id === ruleId) : undefined;
  const only = useMemo(() => (rule && src !== "traces"
    ? new Set(rule[src].examples.filter(e => e.status === "FAIL").map(e => (src === "log" ? logKey(e.dialogueId ?? "") : simKey(e.runId ?? "", e.index ?? 0))))
    : null), [rule, src]);
  const rows = useMemo(() => all.filter(r => matchesRow(r, verdict, query, only)), [all, verdict, query, only]);
  const key = params.get("d") ?? (wide ? rows[0]?.key ?? null : null);
  const selected = key ? all.find(r => r.key === key) : undefined;
  const open = (k: string | null) => set(n => { if (k) n.set("d", k); else n.delete("d"); n.delete("dt"); }, wide);
  const step = (d: 1 | -1) => {
    if (!rows.length) return;
    const i = rows.findIndex(r => r.key === key);
    open(rows[Math.max(0, Math.min(rows.length - 1, (i < 0 ? -1 : i) + d))].key);
  };
  useKeys({ KeyJ: () => step(1), KeyK: () => step(-1) });

  const header = <Header title="Разговоры" actions={<UploadButton />} below={<SectionJob kinds={["discover", "run", "rejudge"]} />} />;
  if (offline && !state) return <div className="flex h-full flex-col">{header}<ServiceDown /></div>;
  if (!state) return <div className="flex h-full flex-col">{header}<div className="p-5"><Skeleton className="h-[480px]" /></div></div>;

  const log = problems?.log;
  const r = run.data;
  const summary = src === "log"
    ? <>
        <span className="text-fg-2">{state.logs.total} {plural(state.logs.total, "разговор", "разговора", "разговоров")} в выгрузке{state.logs.file ? ` «${state.logs.file}»` : ""}{state.logs.updatedAt ? ` от ${day(state.logs.updatedAt)}` : ""}</span>
        {log && <> · оценены {log.assessed} из {log.sampled} {day(log.finishedAt)} · без оценки {log.unassessed}</>}
      </>
    : src === "sim"
    ? r ? <><span className="text-fg-2">{r.label || runTitle(r)}</span> · прогон {day(r.startedAt)} · {r.items?.length ?? 0} разговоров{r.metric ? ` · нарушения в ${r.metric.failed} из ${r.metric.measured}` : ""}</> : "Прогонов ещё не было"
    : <>Трейсы всех агентов, которые записал Workshop · <Link to="/saved" className={link}>Сохранённые</Link> · <Link to="/search" className={link}>Поиск по содержимому</Link></>;
  const runMenu = src === "sim" && finished.length > 1 ? (
    <Menu trigger={<span className="inline-flex h-8 items-center gap-1.5 rounded-control border border-line-strong px-2.5 text-small text-fg-2 hover:text-fg">прогон {day(r?.startedAt)}<ChevronDown aria-hidden className="size-3.5" /></span>}
      items={finished.map(x => ({ key: x.id, label: x.label || runTitle(x), sub: `${day(x.startedAt)}${x.metric ? ` · нарушения в ${x.metric.failed} из ${x.metric.measured}` : ""}`, on: x.id === simRunId, run: () => set(n => { n.set("run", x.id); n.delete("d"); n.delete("rule"); }) }))} />
  ) : null;
  const showDetail = !!selected && (wide || !!params.get("d"));
  return (
    <div className="flex h-full flex-col">
      {header}
      <p className="border-b border-line px-4 py-3 text-small text-fg-3 lg:px-5">{summary}</p>
      <div className="grid min-h-0 flex-1 lg:grid-cols-[420px_minmax(0,1fr)]">
        <Rows className={showDetail && !wide ? "hidden" : undefined} src={src}
          onSrc={s => set(n => { if (s === "log") n.delete("src"); else n.set("src", s); n.delete("d"); n.delete("rule"); n.delete("v"); n.delete("run"); })}
          counts={{ log: state.logs.total || undefined, sim: src === "sim" ? r?.items?.length : finished[0]?.metric?.total, traces: traces.data ? traceRows(traces.data).length : undefined }}
          all={all} rows={rows} verdict={verdict} onVerdict={(v: Verdict) => set(n => { if (v === "all") n.delete("v"); else n.set("v", v); n.delete("d"); })}
          rule={rule ? criteria.find(c => c.r.id === rule.id) ?? null : null} onClearRule={() => set(n => n.delete("rule"))}
          query={query} onQuery={setQuery} selected={key} onOpen={k => open(k)} criteria={criteria} personas={state.personas} runMenu={runMenu} />
        {showDetail && selected
          ? <Dialog key={selected.key} row={selected} criteria={criteria} onBack={wide ? undefined : () => open(null)} />
          : wide && <EmptyState drop title={all.length ? "Выберите разговор" : "Разговоров нет"} className="justify-center">{all.length ? "Слева разговоры. J и K листают." : src === "log" ? "Загрузите выгрузку чата: кнопка справа вверху." : src === "sim" ? "Запустите прогон в «Симуляциях»." : "Workshop ещё ничего не записал."}</EmptyState>}
      </div>
    </div>
  );
}
