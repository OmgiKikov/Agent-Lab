import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Download, Play } from "lucide-react";
import { download, problemsReport } from "../../lab/problemReport";
import { useProblems, type RuleEntry } from "../../lab/problems";
import { JobStrip } from "../../shell/Activity";
import { useKeys } from "../../shell/keys";
import { useLabState } from "../../shell/LabProvider";
import { SectionHeader } from "../../shell/SectionHeader";
import { Button } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Split } from "../../ui/Split";
import { AssessDialog } from "./AssessDialog";
import { FirstRun } from "./FirstRun";
import { ProblemDetail } from "./ProblemDetail";
import { ProblemList, type Filter } from "./ProblemList";
import { Summary } from "./Summary";

const matches = (p: RuleEntry, filter: Filter, query: string) => {
  if (filter === "log" && !p.log.failed) return false;
  if (filter === "sim" && !p.sim.failed) return false;
  const q = query.trim().toLowerCase();
  return !q || [p.title, p.rule.text, p.rule.quote, ...p.topics].some(s => s.toLowerCase().includes(q));
};

/** Проблемы: what the agent does wrong, most frequent first, and the proof of the one selected. */
export function ProblemsPage() {
  const { problemId } = useParams<{ problemId?: string }>();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const runId = params.get("run");
  const { state, offline } = useLabState();
  const { data } = useProblems(runId);
  const filter: Filter = "all";
  const [query, setQuery] = useState("");
  const byId = useMemo(() => new Map((data?.rules ?? []).map(r => [r.id, r])), [data]);
  const problems = useMemo(() => (data?.problems ?? []).flatMap(id => byId.get(id) ?? []), [data, byId]);
  const shown = useMemo(() => problems.filter(p => matches(p, filter, query)), [problems, filter, query]);
  const selected = problemId ? byId.get(problemId) : undefined;
  const keep = runId ? `?run=${encodeURIComponent(runId)}` : "";
  const open = (id: string) => navigate(`/problems/${id}${keep}`);

  useEffect(() => {
    if (!problemId && shown[0] && window.matchMedia("(min-width: 1024px)").matches) navigate(`/problems/${shown[0].id}${keep}`, { replace: true });
  }, [problemId, shown, keep, navigate]);

  const step = (d: 1 | -1) => {
    if (!shown.length) return;
    const at = shown.findIndex(p => p.id === problemId);
    open(shown[at < 0 ? 0 : Math.max(0, Math.min(shown.length - 1, at + d))].id);
  };
  useKeys({ KeyJ: () => step(1), ArrowDown: () => step(1), KeyK: () => step(-1), ArrowUp: () => step(-1) });

  const change = (edit: (next: URLSearchParams) => void, replace = true) =>
    setParams(prev => { const next = new URLSearchParams(prev); edit(next); return next; }, { replace });
  const assessing = params.get("assess") === "1";
  const setAssess = (on: boolean) => change(next => (on ? next.set("assess", "1") : next.delete("assess")));
  const setRun = (id: string) => change(next => { next.set("run", id); next.delete("example"); next.delete("from"); }, false);

  if (offline && !state) return <ServiceDown />;
  const busy = !!state?.job.running;
  const canAssess = !!state?.sources.length && !!state?.logs.total && !busy;
  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        crumbs={[{ label: "Проблемы" }]}
        actions={<>
          <Button className="hidden sm:inline-flex" icon={Download} onClick={() => data && download("problems.md", problemsReport(data, window.location.origin))} disabled={!problems.length}>Отчёт</Button>
          <Button variant="primary" icon={Play} onClick={() => setAssess(true)} disabled={!canAssess} title={busy ? "Сейчас идёт другая задача" : undefined}>Оценить логи</Button>
        </>}
        below={<JobStrip kinds={["discover"]} />}
      />
      {!state ? <div className="p-6"><Skeleton className="h-7 w-96" /><Skeleton className="mt-3 h-4 w-[560px]" /><Skeleton className="mt-8 h-[420px]" /></div>
        : !state.discover ? <FirstRun state={state} onAssess={() => setAssess(true)} />
        : !data ? <div className="p-6"><Skeleton className="h-7 w-96" /><Skeleton className="mt-8 h-[420px]" /></div>
        : (
          <>
            <Summary data={data} runs={state.runs} runId={runId} onRun={setRun} />
            <Split
              showDetail={!!problemId}
              list={<ProblemList problems={shown} all={problems} rules={data.rules.length} selectedId={problemId ?? null} query={query} onQuery={setQuery} onPick={open} />}
              detail={selected ? <ProblemDetail key={selected.id} p={selected} data={data} onBack={() => navigate(`/problems${keep}`)} />
                : problemId ? <EmptyState title="Этой проблемы нет в текущей оценке" action={<Link to="/problems" className="text-small text-lab-ink underline underline-offset-4">Все проблемы</Link>}>Правила могли извлечь заново, или она пропала в этом отборе.</EmptyState>
                : <EmptyState drop title="Нарушений не найдено">Судья не нашёл нарушений в оценённых диалогах. Это хороший результат.</EmptyState>}
            />
          </>
        )}
      {state && <AssessDialog open={assessing} onClose={() => setAssess(false)} />}
    </div>
  );
}
