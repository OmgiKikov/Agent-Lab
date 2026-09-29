import { useMemo, useState } from "react";
import { GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import { Heatmap } from "../charts/Heatmap";
import { compareFindings, deriveFindings } from "../findings";
import { day } from "../format";
import { scenariosOfRun, typesOfRun } from "../logic";
import { HUE, type Hue } from "../look";
import type { LabRun, LabState } from "../types";
import { useRunContext } from "../useRunContext";
import { Delta, EmptyState, Eyebrow, inputClass, Page, Panel, Section, Skeleton, titleFont } from "../ui";
import { FindingRow } from "./FindingRow";

const label = (r: LabRun) => `${r.version} · ${day(r.startedAt)}`;

/** Two runs of the same agent side by side: what got fixed, what broke, cell by cell. */
export function VersionsView({ state, run, onFinding }: { state: LabState; run: LabRun | null; onFinding: (key: string) => void }) {
  const [toId, setToId] = useState<string | null>(null);
  const [fromId, setFromId] = useState<string | null>(null);
  const base = useRunContext(state, run);
  const to = base.history.find(r => r.id === toId) ?? base.head;
  const ctx = useRunContext(state, to, fromId);
  const { finished, previous, previousItems, sameAgent, recent, details } = ctx;
  const items = useMemo(() => finished?.items ?? [], [finished]);
  const compared = useMemo(() => compareFindings(deriveFindings(items), previousItems ? deriveFindings(previousItems) : null), [items, previousItems]);
  const changed = compared.filter(c => c.change === "new" || c.change === "fixed");
  const counts = { fixed: compared.filter(c => c.change === "fixed").length, new: compared.filter(c => c.change === "new").length, remains: compared.filter(c => c.change === "remains").length };

  if (sameAgent.length < 2) {
    return <Page wide title="версии агента"><EmptyState className="mt-5" drop title="Нужны две проверки">Сравнивать можно версии одного агента. Проверьте агента после правки, и здесь появится, что исправилось и что сломалось.</EmptyState></Page>;
  }
  if (!finished?.metric || !previous) return <Page wide title="версии агента"><Skeleton className="mt-5 h-[320px]" /></Page>;

  const delta = finished.metric.accuracy != null && previous.metric?.accuracy != null ? finished.metric.accuracy - previous.metric.accuracy : null;
  const types = typesOfRun(finished, state.personas);
  const options = [...sameAgent].reverse();
  const deck = state.cards?.cards ?? [];

  return (
    <Page
      wide title="версии агента"
      lede="Что изменилось между двумя проверками одного агента."
      actions={
        <span className="inline-flex items-center gap-2">
          <select aria-label="С какой версией сравнить" value={previous.id} onChange={e => setFromId(e.target.value)} className={cn(inputClass, "w-auto cursor-pointer pr-7")}>{options.filter(r => r.id !== finished.id).map(r => <option key={r.id} value={r.id}>{label(r)}</option>)}</select>
          <GitBranch className="size-3.5 rotate-90 text-lab-dim" />
          <select aria-label="Какую версию смотреть" value={finished.id} onChange={e => { setToId(e.target.value); setFromId(null); }} className={cn(inputClass, "w-auto cursor-pointer pr-7")}>{options.map(r => <option key={r.id} value={r.id}>{label(r)}</option>)}</select>
        </span>
      }
    >
      <Panel className="mt-5 flex flex-wrap items-center gap-x-10 gap-y-4 px-6 py-5">
        <div>
          <Eyebrow>качество</Eyebrow>
          <div className="mt-1.5 flex items-baseline gap-3.5">
            <span className="text-[28px] text-lab-mute" style={titleFont}>{previous.metric?.accuracy ?? "—"}%</span>
            <span className="text-lab-faint">→</span>
            <span className="text-[56px] leading-none text-lab-ink" style={titleFont}>{finished.metric.accuracy ?? "—"}<span className="ml-1 text-[24px] text-lab-mute">%</span></span>
            {delta !== null && <Delta value={delta} />}
          </div>
        </div>
        <div className="ml-auto flex gap-9">
          {([["исправлено", counts.fixed, "text-lab-ok"], ["новых проблемы", counts.new, "text-lab-bad"], ["остались", counts.remains, "text-lab-mute"]] as const).map(([name, n, cls]) => (
            <div key={name}><div className={cn("text-[28px] leading-none", cls)} style={titleFont}>{n}</div><div className="mt-1.5 text-[11px] text-lab-dim">{name}</div></div>
          ))}
        </div>
      </Panel>

      <div className="mt-4 grid gap-4">
        <Panel className="overflow-hidden">
          <div className="px-5 py-3.5"><div className="text-[14px] font-medium text-lab-text">Что изменилось</div><div className="mt-0.5 text-[11px] text-lab-dim">Проблемы, которых не было или которые пропали</div></div>
          {changed.length ? changed.map(c => <FindingRow key={c.finding.key + c.change} item={c} personas={state.personas} played={types.length} previousVersion={previous.version} onOpen={() => onFinding(c.finding.key)} />) : <div className="border-t border-white/[0.06] px-5 py-6 text-center text-[12px] text-lab-dim">Набор проблем не изменился.</div>}
        </Panel>
        <Panel className="p-5">
          <div className="text-[14px] font-medium text-lab-text">Где стало лучше или хуже</div>
          <div className="mb-4 mt-0.5 text-[11px] text-lab-dim">Сценарий × тип клиента. Обведены изменения к {previous.version}.</div>
          <Heatmap personas={types} scenarios={scenariosOfRun(items)} items={items} previous={previousItems} compare accuracy={finished.metric.personas} onOpen={() => {}} />
        </Panel>
      </div>

      {recent.length > 1 && deck.length > 0 && (
        <Section title="Динамика по сценариям" hint="Доля пройденных разговоров сценария в последних проверках">
          <Panel className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-[12px]">
              <thead>
                <tr className="text-lab-dim">
                  <th className="px-4 py-2.5 text-left font-normal"><Eyebrow>Сценарий</Eyebrow></th>
                  {recent.map(r => (
                    <th key={r.id} className={cn("px-3 py-2.5 text-center font-normal", r.id === finished.id && "text-lab-text")}>
                      <div className="font-mono text-[11px]">{r.version}</div><div className="font-mono text-[10px] text-lab-dim">{day(r.startedAt)}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {deck.map(c => (
                  <tr key={c.id} className="border-t border-white/[0.06]">
                    <td className="px-4 py-2 text-lab-text">{c.name}</td>
                    {recent.map(r => {
                      const own = details(r)?.items?.filter(i => i.cardId === c.id && (i.status === "PASS" || i.status === "FAIL")) ?? [];
                      const ok = own.filter(i => i.status === "PASS").length;
                      const hue: Hue = !own.length ? "mute" : ok === own.length ? "ok" : ok === 0 ? "bad" : "warn";
                      return (
                        <td key={r.id} className="px-3 py-2 text-center">
                          {own.length ? <span className={cn("inline-flex min-w-[42px] items-center justify-center rounded px-2 py-0.5 font-mono text-[11px]", HUE[hue].bg, HUE[hue].text)}>{ok}/{own.length}</span> : <span className="text-lab-faint">·</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </Section>
      )}
    </Page>
  );
}
