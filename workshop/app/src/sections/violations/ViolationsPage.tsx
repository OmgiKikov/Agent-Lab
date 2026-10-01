import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { FileText } from "lucide-react";
import { Header } from "../../app/Header";
import { SectionJob } from "../../app/SectionJob";
import { useWide } from "../../app/useWide";
import { useCriteria } from "../../lab/criteria";
import { plural } from "../../lab/format";
import { useKeys } from "../../shell/keys";
import { useLabState } from "../../shell/LabProvider";
import { Button } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { AssessSheet } from "./AssessSheet";
import { Case } from "./Case";
import { FirstRun } from "./FirstRun";
import { matches, queueOf, toFilter, toSide, type Filter, type SideKey } from "./model";
import { Queue } from "./Queue";
import { ReportSheet } from "./ReportSheet";
import { Summary } from "./Summary";

/**
 * «Нарушения», the product's first screen: the result in one sentence and where its numbers come from, the queue of
 * criteria the agent breaks, and the chosen one read as an argument with its proof. Everything chosen is in the address.
 */
export function ViolationsPage() {
  const { state, offline } = useLabState();
  const [params, setParams] = useSearchParams();
  const wide = useWide();
  const runId = params.get("run");
  const { data, list } = useCriteria(runId);
  const filter = toFilter(params.get("s"));
  const [query, setQuery] = useState("");
  const [assess, setAssess] = useState(params.get("assess") === "1");
  const [report, setReport] = useState(false);
  const items = useMemo(() => queueOf(list, filter).filter(c => matches(c, query)), [list, filter, query]);

  const set = (edit: (n: URLSearchParams) => void, replace = true) => setParams(prev => { const n = new URLSearchParams(prev); edit(n); return n; }, { replace });
  const chosenId = params.get("v") ?? (wide ? items[0]?.r.id ?? null : null);
  const chosen = chosenId ? list.find(c => c.r.id === chosenId) ?? null : null;
  const side: SideKey = toSide(params.get("es")) ?? (filter === "sim" || (chosen && !chosen.r.log.failed) ? "sim" : "log");
  const at = Math.max(0, (Number(params.get("e")) || 1) - 1);
  const open = (id: string | null) => set(n => { if (id) n.set("v", id); else n.delete("v"); n.delete("e"); n.delete("es"); }, wide);
  const step = (d: 1 | -1) => {
    if (!items.length) return;
    const i = items.findIndex(c => c.r.id === chosenId);
    open(items[Math.max(0, Math.min(items.length - 1, (i < 0 ? -1 : i) + d))].r.id);
  };
  useKeys({ KeyJ: () => step(1), KeyK: () => step(-1), ArrowDown: () => step(1), ArrowUp: () => step(-1) });

  const busy = !!state?.job.running;
  const broken = data?.log ? data.rules.filter(r => r.log.failed > 0).length : 0;
  let body;
  if (offline && !state) body = <ServiceDown />;
  else if (!state || !data) body = (
    <div className="p-5"><Skeleton className="h-7 w-[min(520px,80%)]" /><Skeleton className="mt-3 h-4 w-[min(720px,90%)]" /><div className="mt-6 grid gap-6 lg:grid-cols-[400px_1fr]"><Skeleton className="h-[420px]" /><Skeleton className="h-[420px]" /></div></div>
  );
  else if (!data.log && !data.sim) body = <div className="min-h-0 flex-1 overflow-auto"><FirstRun onAssess={() => setAssess(true)} /></div>;
  else {
    const showCase = !!chosen && (wide || !!params.get("v"));
    body = (
      <>
        <div className={showCase && !wide ? "hidden" : undefined}><Summary data={data} onRun={id => set(n => { n.set("run", id); n.delete("e"); }, false)} /></div>
        <div className="grid min-h-0 flex-1 lg:grid-cols-[400px_minmax(0,1fr)]">
          <Queue className={showCase && !wide ? "hidden" : undefined} list={list} items={items} filter={filter}
            onFilter={(f: Filter) => set(n => { if (f === "all") n.delete("s"); else n.set("s", f); n.delete("v"); n.delete("e"); n.delete("es"); })}
            query={query} onQuery={setQuery} selected={chosenId} onOpen={id => open(id)} />
          {showCase && chosen ? (
            <Case key={chosen.r.id} c={chosen} side={side} at={at} runId={data.sim?.runId ?? runId} hasLog={!!data.log} hasSim={!!data.sim}
              onSide={s => set(n => { n.set("es", s); n.delete("e"); })}
              onAt={i => set(n => n.set("e", String(i + 1)))}
              onBack={wide ? undefined : () => open(null)} />
          ) : wide && (
            items.length
              ? <EmptyState title="Выберите нарушение" className="justify-center">Слева нарушения по частоте. J и K листают, стрелки — примеры.</EmptyState>
              : <EmptyState drop title={broken ? "Ничего не нашлось" : "Судья не нашёл нарушений"} className="justify-center">{broken ? "Поменяйте поиск или источник." : `Ни один из ${data.rules.length} ${plural(data.rules.length, "критерия", "критериев", "критериев")} не нарушен в оценённых диалогах. Это не значит, что агент исправен: см. «без оценки».`}</EmptyState>
          )}
        </div>
      </>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <Header title="Нарушения"
        actions={<>
          <Button icon={FileText} onClick={() => setReport(true)} disabled={!data?.log && !data?.sim} className="hidden sm:inline-flex">Отчёт</Button>
          <Button variant="primary" onClick={() => setAssess(true)} disabled={busy} title={busy ? "Сейчас идёт другая задача" : undefined}>Оценить логи</Button>
        </>}
        below={<SectionJob kinds={["discover"]} />}
      />
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
      <AssessSheet open={assess} onClose={() => { setAssess(false); if (params.get("assess")) set(n => n.delete("assess")); }} criteria={data?.rules.length ?? 0} />
      {data && (data.log || data.sim) && <ReportSheet open={report} onClose={() => setReport(false)} data={data} list={list} />}
    </div>
  );
}
