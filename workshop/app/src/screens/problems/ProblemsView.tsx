import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useProblems, type RuleEntry } from "../../lab/problems";
import { useKeys } from "../../shell/keys";
import { EmptyState, Skeleton } from "../../ui/EmptyState";
import { Split } from "../../ui/Split";
import { ProblemDetail } from "./ProblemDetail";
import { ProblemList } from "./ProblemList";

const wide = () => window.matchMedia("(min-width: 1024px)").matches;

/** The problems of one source: criteria the agent fails in the logs, or in a simulation run. List and the proof of the selected (?p=). */
export function ProblemsView({ source, runId }: { source: "log" | "sim"; runId?: string | null }) {
  const [params, setParams] = useSearchParams();
  const { data } = useProblems(runId ?? null);
  const [query, setQuery] = useState("");
  const selectedId = params.get("p");
  const problems = useMemo(() => (data?.rules ?? []).filter(r => r[source].failed > 0).sort((a, b) => b[source].failed - a[source].failed), [data, source]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? problems.filter((p: RuleEntry) => [p.title, p.rule.text, p.rule.quote, ...p.topics].some(s => s.toLowerCase().includes(q))) : problems;
  }, [problems, query]);
  const selected = selectedId ? problems.find(p => p.id === selectedId) : undefined;
  const open = (id: string | null, replace = false) => setParams(prev => {
    const next = new URLSearchParams(prev);
    if (id) next.set("p", id); else next.delete("p");
    next.delete("example");
    return next;
  }, { replace });

  useEffect(() => {
    if (!selectedId && shown[0] && wide()) open(shown[0].id, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, shown]);
  const step = (d: 1 | -1) => {
    if (!shown.length) return;
    const at = shown.findIndex(p => p.id === selectedId);
    open(shown[at < 0 ? 0 : Math.max(0, Math.min(shown.length - 1, at + d))].id, true);
  };
  useKeys({ KeyJ: () => step(1), ArrowDown: () => step(1), KeyK: () => step(-1), ArrowUp: () => step(-1) });

  if (!data) return <div className="p-6"><Skeleton className="h-7 w-96" /><Skeleton className="mt-8 h-[420px]" /></div>;
  if (source === "sim" && !data.sim) return <EmptyState drop title="Прогонов ещё не было">Результаты появятся после первого прогона.</EmptyState>;
  if (source === "log" && !data.log) return <EmptyState drop title="Логи ещё не оценены" />;
  return (
    <Split
      showDetail={!!selectedId}
      list={<ProblemList problems={shown} source={source} selectedId={selectedId} query={query} onQuery={setQuery} onPick={id => open(id)} />}
      detail={selected ? <ProblemDetail key={`${source}-${selected.id}`} p={selected} source={source} runId={runId} onBack={() => open(null)} />
        : selectedId ? <EmptyState title="Этого нарушения нет в текущей оценке">Критерии могли извлечь заново.</EmptyState>
        : <EmptyState drop title="Нарушений не найдено">{source === "log" ? "Судья не нашёл нарушений в оценённых логах." : "Судья не нашёл нарушений в диалогах этого прогона."}</EmptyState>}
    />
  );
}
