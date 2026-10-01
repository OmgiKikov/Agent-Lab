import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Header } from "../../app/Header";
import { problemLink, SECTIONS } from "../../app/links";
import { useCriteria } from "../../lab/criteria";
import { count, longDay } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { summarySentence } from "../../lab/problemReport";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Segmented } from "../../ui/Segmented";
import { queueOf, type SideKey } from "./model";
import { ProblemRow } from "./ProblemRow";

/** «Проблемы»: every criterion the agent breaks, most frequent first, in the logs or in the last simulation, never mixed. */
export function ProblemsPage() {
  const { state, offline } = useLabState();
  const [params, setParams] = useSearchParams();
  const side: SideKey = params.get("src") === "sim" ? "sim" : "log";
  const { data, list } = useCriteria(side === "sim" ? params.get("run") : null);
  const header = <Header title="Проблемы" />;
  if (offline && !state) return <div className="flex h-full flex-col">{header}<ServiceDown /></div>;
  if (!data) return <div className="flex h-full flex-col">{header}<div className="p-8"><Skeleton className="h-96" /></div></div>;
  const rows = queueOf(list, side);
  const clean = list.length - rows.length;
  const counts = { log: queueOf(list, "log").length, sim: queueOf(list, "sim").length };
  const runQuery = side === "sim" && data.sim ? { src: "sim", run: data.sim.runId } : {};
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[1080px] space-y-5 px-4 pb-20 pt-6 lg:px-8 lg:pt-8">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-balance text-page font-semibold text-fg">{summarySentence(data, side)}</h2>
              <p className="mt-1.5 text-small text-fg-3">
                {side === "log"
                  ? data.log ? `Логи проверены ${longDay(data.log.finishedAt)}: ${count(data.log.assessed, "разговор", "разговора", "разговоров")} из ${data.log.sampled}` : "Логи ещё не оценены"
                  : data.sim ? `Симуляция ${longDay(data.sim.finishedAt)}: ${count(data.sim.dialogs, "разговор", "разговора", "разговоров")}` : "Симуляций ещё не было"}
              </p>
            </div>
            {counts.sim > 0 && (
              <Segmented<SideKey> label="Откуда" value={side} onChange={v => setParams(v === "sim" ? { src: "sim" } : {}, { replace: true })}
                options={[{ value: "log", label: "Логи", count: counts.log }, { value: "sim", label: "Симуляция", count: counts.sim }]} />
            )}
          </div>
          {rows.length > 0 && (
            <ol className="overflow-hidden rounded-sheet border border-line bg-list shadow-card">
              {rows.map((c, i) => <li key={c.r.id} className="border-t border-line first:border-t-0"><ProblemRow c={c} side={side} rank={i + 1} to={problemLink(c.r.id, runQuery)} /></li>)}
            </ol>
          )}
          {clean > 0 && (
            <Link to={SECTIONS.criteria} className="flex items-center justify-between gap-3 rounded-sheet border border-line bg-list px-5 py-4 text-body text-fg-2 shadow-card transition-colors hover:bg-hover">
              <span>Ещё {count(clean, "критерий", "критерия", "критериев")} без обнаруженных нарушений</span>
              <span className="inline-flex items-center gap-1 text-small font-medium text-fg">Все критерии<ArrowRight aria-hidden className="size-3.5" /></span>
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
