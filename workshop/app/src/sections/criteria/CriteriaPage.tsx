import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ChevronDown, RotateCcw } from "lucide-react";
import { Header } from "../../app/Header";
import { SectionJob } from "../../app/SectionJob";
import { useWide } from "../../app/useWide";
import { useCriteria, type Criterion } from "../../lab/criteria";
import { day, plural } from "../../lab/format";
import { useSource } from "../../lab/problems";
import { secondOf } from "../../lab/problemStats";
import { decisions } from "../../lab/verdicts";
import { useKeys } from "../../app/keys";
import { useLabState } from "../../lab/LabProvider";
import { Button } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Menu } from "../../ui/Menu";
import { Segmented } from "../../ui/Segmented";
import { Reextract } from "./Reextract";
import { CodeView } from "./CodeView";
import { CriteriaTable } from "./CriteriaTable";
import { CriterionPanel, type Shown } from "./CriterionPanel";
import { Files } from "./Files";
import { nameOf, type SideKey } from "./model";

type View = "code" | "list";

/** By frequency on the side, broken first: the order J and K walk, and the first one chosen. */
const byFrequency = (list: Criterion[], side: SideKey) => [...list].sort((a, b) => b.r[side].failed - a.r[side].failed || a.n - b.n);

/**
 * «Критерии»: what the agent must do, where its code says so and how it went. The prompt is shown as code with each
 * criterion lit in place and its count over it; the same criteria as a list for comparing; the chosen one with its dialogues.
 */
export function CriteriaPage() {
  const { state, offline } = useLabState();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const wide = useWide();
  const { data, list } = useCriteria(null);
  const [reextract, setReextract] = useState(false);
  const set = (edit: (n: URLSearchParams) => void, replace = true) => setParams(prev => { const n = new URLSearchParams(prev); edit(n); return n; }, { replace });

  const side: SideKey = params.get("s") === "sim" || (params.get("s") !== "log" && !data?.log && !!data?.sim) ? "sim" : "log";
  const view: View = params.get("view") === "list" || params.get("view") === "code" ? (params.get("view") as View) : wide ? "code" : "list";
  const ordered = useMemo(() => byFrequency(list, side), [list, side]);
  const sources = state?.sources ?? [];
  const asked = params.get("c");
  const chosen = (asked ? list.find(c => c.r.id === asked) : wide ? ordered[0] : undefined) ?? null;
  const fileId = params.get("f") ?? chosen?.r.rule.sourceId ?? sources.find(s => list.some(c => c.r.rule.sourceId === s.id))?.id ?? null;
  const source = sources.find(s => s.id === fileId) ?? null;
  const { data: text, isLoading } = useSource(view === "code" ? fileId : null);
  const items = useMemo(() => list.filter(c => c.r.rule.sourceId === fileId), [list, fileId]);
  const shownRaw = params.get("x") as Shown | null;
  const shown: Shown = shownRaw === "FAIL" || shownRaw === "PASS" || shownRaw === "UNKNOWN" ? shownRaw : chosen && !chosen.r[side].failed ? "PASS" : "FAIL";

  const select = (id: string) => {
    const c = list.find(x => x.r.id === id);
    set(n => { n.set("c", id); n.delete("x"); if (c?.r.rule.sourceId) n.set("f", c.r.rule.sourceId); }, wide);
  };
  const step = (d: 1 | -1) => {
    if (!ordered.length) return;
    const i = ordered.findIndex(c => c.r.id === chosen?.r.id);
    select(ordered[Math.max(0, Math.min(ordered.length - 1, (i < 0 ? -1 : i) + d))].r.id);
  };
  useKeys({ KeyJ: () => step(1), KeyK: () => step(-1), Escape: () => { if (!wide && asked) set(n => n.delete("c"), false); } });

  const busy = !!state?.job.running;
  const sideOptions = ([["log", "Логи"], ["sim", "Симуляция"]] as const).filter(([k]) => (k === "log" ? !!data?.log : !!data?.sim));
  const header = (
    <Header title="Критерии"
      actions={<>
        <Button icon={RotateCcw} onClick={() => setReextract(true)} disabled={busy || !state?.sources.length} className="hidden md:inline-flex" title="Судья прочитает код заново и извлечёт критерии">Извлечь заново</Button>
        <Button variant="primary" onClick={() => navigate(side === "sim" && data?.sim ? `/review?src=sim&run=${encodeURIComponent(data.sim.runId)}` : "/review")} disabled={!data?.log}>Проверить вердикты</Button>
      </>}
      below={<SectionJob kinds={["discover", "names", "sources"]} />} />
  );
  if (offline && !state) return <div className="flex h-full flex-col">{header}<ServiceDown /></div>;
  if (!state || !data) return <div className="flex h-full flex-col">{header}<div className="p-5"><Skeleton className="h-6 w-[min(640px,90%)]" /><Skeleton className="mt-6 h-[480px]" /></div></div>;
  if (!list.length) return (
    <div className="flex h-full flex-col">{header}
      <EmptyState drop title="Критериев пока нет" className="flex-1 justify-center">Судья достанет их дословно из промптов агента при первой оценке логов. Сначала прочитайте код в «Агенте».</EmptyState>
    </div>
  );

  const second = list.reduce((acc, c) => { const s = secondOf(c.r.log.examples); return { checked: acc.checked + s.checked, agree: acc.agree + s.agree }; }, { checked: 0, agree: 0 });
  const people = decisions(data);
  const usedSources = new Set(list.map(c => c.r.rule.sourceId)).size;
  const panelOpen = !!chosen && (wide || !!asked);
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="flex flex-col gap-2 border-b border-line px-4 py-3 lg:flex-row lg:items-center lg:gap-4 lg:px-5">
        <p className="min-w-0 text-small text-fg-3 lg:flex-1">
          <span className="text-fg-2">{list.length} {plural(list.length, "критерий", "критерия", "критериев")} из {usedSources} {plural(usedSources, "источника", "источников", "источников")} кода</span>
          {data.log?.rulesSince && <>, зафиксированы {day(data.log.rulesSince)}</>}
          {second.checked > 0 && <> · второй судья согласен с первым в {second.agree} из {second.checked} нарушений логов</>}
          {people.agree + people.disagree > 0 && <> · люди проверили {people.agree + people.disagree} {plural(people.agree + people.disagree, "вердикт", "вердикта", "вердиктов")}, согласны с судьёй в {people.agree}</>}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {sideOptions.length > 1 && <Segmented<SideKey> size="sm" label="Чьи вердикты" value={side} onChange={v => set(n => { n.set("s", v); n.delete("x"); })} options={sideOptions.map(([k, l]) => ({ value: k, label: l }))} />}
          <Segmented<View> size="sm" label="Вид" value={view} onChange={v => set(n => n.set("view", v))} options={[{ value: "code", label: "В коде" }, { value: "list", label: "Списком" }]} />
        </div>
      </div>
      <div className={`grid min-h-0 flex-1 ${view === "code" ? "lg:grid-cols-[232px_minmax(0,1fr)_400px] xl:grid-cols-[248px_minmax(0,1fr)_440px]" : "lg:grid-cols-[minmax(0,1fr)_400px] xl:grid-cols-[minmax(0,1fr)_440px]"}`}>
        {view === "code" ? (
          <>
            <div className="hidden lg:contents"><Files sources={sources} list={list} side={side} current={fileId} onOpen={id => set(n => { n.set("f", id); const first = list.find(c => c.r.rule.sourceId === id); if (first) n.set("c", first.r.id); else n.delete("c"); })} /></div>
            <div className={`min-h-0 flex-col ${panelOpen && !wide ? "hidden" : "flex"}`}>
              {source && (
                <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 lg:px-6">
                  <div className="lg:hidden">
                    <Menu trigger={<span className="inline-flex h-8 items-center gap-1.5 rounded-control border border-line-strong px-2.5 font-mono text-small text-fg">{nameOf(source).file}<ChevronDown aria-hidden className="size-3.5" /></span>}
                      items={sources.map(s => ({ key: s.id, label: nameOf(s).file, sub: `${list.filter(c => c.r.rule.sourceId === s.id).length} критериев`, on: s.id === fileId, run: () => set(n => { n.set("f", s.id); n.delete("c"); }) }))} />
                  </div>
                  <span className="hidden truncate font-mono text-meta text-fg-3 lg:inline" title={source.origin}>{source.origin}</span>
                  <span className="ml-auto whitespace-nowrap text-meta text-fg-3">{items.length} {plural(items.length, "критерий", "критерия", "критериев")} · <span className="text-bad">{items.filter(c => c.r[side].failed > 0).length} нарушено</span></span>
                </div>
              )}
              {isLoading || !text ? <div className="p-6"><Skeleton className="h-[420px]" /></div>
                : source && <CodeView source={source} content={text.content} items={items} side={side} selected={chosen?.r.id ?? null} onSelect={select} />}
            </div>
          </>
        ) : (
          <CriteriaTable className={panelOpen && !wide ? "hidden" : undefined} list={list} sources={sources} selected={chosen?.r.id ?? null} onSelect={select} hasSim={!!data.sim} />
        )}
        {panelOpen && chosen && (
          <CriterionPanel key={`${chosen.r.id}-${side}`} c={chosen} side={side} shown={shown} onShown={v => set(n => n.set("x", v))}
            onBack={wide ? undefined : () => set(n => n.delete("c"), false)} />
        )}
      </div>
      <Reextract open={reextract} onClose={() => setReextract(false)} />
    </div>
  );
}
