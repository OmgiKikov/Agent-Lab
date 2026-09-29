import { useMemo } from "react";
import NumberFlow from "@number-flow/react";
import { Play, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Trend, type TrendPoint } from "../charts/Trend";
import { compareFindings, deriveFindings, TRUST_TEXT, trustOf, type Change } from "../findings";
import { plural, when } from "../format";
import { JobLine } from "../JobLine";
import { typesOfRun, unitOf } from "../logic";
import { setupSteps } from "../nav";
import type { LabRun, LabState } from "../types";
import { useRunContext } from "../useRunContext";
import { Button, Delta, EmptyState, Eyebrow, Page, Panel, Skeleton, titleFont } from "../ui";
import { FindingRow } from "./FindingRow";
import { DropPixelGrid } from "../../components/DropPixelGrid";

const GROUPS: { change: Change | null; title: string }[] = [
  { change: "new", title: "Новые" }, { change: "remains", title: "Остались" }, { change: "fixed", title: "Исправлено" }, { change: null, title: "Найдено" },
];

/** First run: what is left to do before the first number, as a checklist. */
function FirstRun({ state, go }: { state: LabState; go: (to: string) => void }) {
  const steps = setupSteps(state);
  const next = steps.findIndex(s => !s.done);
  return (
    <Panel className="mt-5 overflow-hidden">
      <div className="flex flex-col items-center border-b border-white/[0.06] px-6 pb-6 pt-8 text-center">
        <div className="mb-3"><DropPixelGrid px={2} gap={1.5} fillRgb="142,157,166" /></div>
        <div className="text-[16px] font-medium text-lab-ink" style={titleFont}>Начнём с четырёх шагов</div>
        <div className="mt-1.5 max-w-[460px] text-[12px] leading-relaxed text-lab-dim">Потом здесь будет главное: качество агента, что в нём сломалось и как это менялось от версии к версии.</div>
      </div>
      {steps.map((s, i) => (
        <div key={s.label} className={cn("flex items-center gap-4 border-t border-white/[0.06] px-5 py-3.5 first:border-t-0", s.done && "opacity-55")}>
          <span className={cn("flex size-6 flex-shrink-0 items-center justify-center rounded-full border font-mono text-[11px]", s.done ? "border-white/15 text-lab-dim" : i === next ? "border-white/60 text-lab-ink" : "border-white/15 text-lab-dim")}>{s.done ? "✓" : i + 1}</span>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium text-lab-text">{s.label}</div>
            <div className="text-[11px] text-lab-dim">{s.hint}</div>
          </div>
          {!s.done && <Button size="sm" variant={i === next ? "primary" : "secondary"} onClick={() => go(s.to)}>{s.cta}</Button>}
        </div>
      ))}
    </Panel>
  );
}

export function HealthView({ state, run, onCheck, onJudge, onFinding, go }: {
  state: LabState; run: LabRun | null; onCheck: () => void; onJudge: (runId: string) => void; onFinding: (key: string) => void; go: (to: string) => void;
}) {
  const { finished, previous, previousItems, sameAgent, history } = useRunContext(state, run);
  const items = useMemo(() => finished?.items ?? [], [finished]);
  const compared = useMemo(() => compareFindings(deriveFindings(items), previousItems ? deriveFindings(previousItems) : null), [items, previousItems]);
  const title = "здоровье агента";
  const busy = state.job.running;
  const actions = (
    <>
      <JobLine state={state} kind="run" />
      <Button variant="primary" icon={Play} disabled={busy || !state.cards?.cards.length} onClick={onCheck}>Проверить агента</Button>
    </>
  );

  if (!state.runs.length) {
    return <Page wide title={title} lede="Качество агента, что в нём сломалось и как это менялось." actions={actions}><FirstRun state={state} go={go} /></Page>;
  }
  if (!finished?.metric || !finished.metric.total) {
    return (
      <Page wide title={title} lede={history.length ? "Загружаю последнюю проверку…" : "Ждём результатов первой проверки."} actions={actions}>
        <div className="mt-5 grid gap-4 min-[1100px]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]"><Skeleton className="h-[240px]" /><Skeleton className="h-[240px]" /></div>
        <Skeleton className="mt-6 h-[300px]" />
      </Page>
    );
  }

  const m = finished.metric;
  const trust = trustOf(finished);
  const unit = unitOf(items);
  const delta = previous?.metric?.accuracy != null && m.accuracy != null ? m.accuracy - previous.metric.accuracy : null;
  const played = typesOfRun(finished, state.personas).length;
  const points: TrendPoint[] = sameAgent.map(r => ({ id: r.id, value: r.metric!.accuracy ?? 0, label: r.version, title: `${r.version} · ${when(r.startedAt)}`, sub: `${r.metric!.passed} из ${r.metric!.measured} пройдено` }));
  const counts = { new: compared.filter(c => c.change === "new").length, fixed: compared.filter(c => c.change === "fixed").length };
  const open = compared.filter(c => c.change !== "fixed").length;

  return (
    <Page
      wide title={title}
      lede={<span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">{finished.targetName}<span className="font-mono">{finished.version}</span><span>проверка от {when(finished.startedAt)}</span></span>}
      actions={actions}
    >
      <div className="mt-5 grid gap-4 min-[1100px]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <Panel className="p-5">
          <Eyebrow>качество агента · {finished.version}</Eyebrow>
          <div className="mt-2 flex flex-wrap items-end gap-x-4 gap-y-2" style={titleFont}>
            <div className="flex items-baseline text-lab-ink">
              <span className="text-[88px] leading-[0.95] tracking-tight"><NumberFlow value={m.accuracy ?? 0} /></span>
              <span className="ml-1 text-[32px] text-lab-mute">%</span>
            </div>
            {delta !== null && <div className="mb-2 flex items-center gap-2 font-sans"><Delta value={delta} /><span className="text-[11px] text-lab-dim">к {previous!.version}</span></div>}
          </div>
          <p className="mt-3 text-[13px] leading-snug text-lab-text">Агент справляется в <b>{m.passed}</b> из <b>{m.measured}</b> {unit === "разговоров" ? plural(m.measured, "разговора", "разговоров", "разговоров") : plural(m.measured, "сценария", "сценариев", "сценариев")}</p>
          <div className={cn("mt-4 flex items-center gap-3 rounded-lg border px-3.5 py-2.5", trust.level === "ok" ? "border-lab-ok/25 bg-lab-ok/[0.06]" : "border-lab-warn/25 bg-lab-warn/[0.06]")}>
            <TriangleAlert className={cn("size-4 flex-shrink-0", trust.level === "ok" ? "text-lab-ok" : "text-lab-warn")} />
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-medium text-lab-text">{TRUST_TEXT[trust.level][0].toUpperCase() + TRUST_TEXT[trust.level].slice(1)}</div>
              <div className="text-[11px] leading-snug text-lab-dim">
                {trust.level === "pending" ? `Судью проверили на ${trust.reviewed} из ${m.total} разговоров. Проверьте ещё, и цифре можно верить.` : trust.level === "partial" ? `Судья прав в ${Math.round((trust.humanShare ?? 0) * 100)}% проверенных. Для уверенности нужно больше проверок.` : "Судью проверили достаточно, он прав в большинстве случаев."}
              </div>
            </div>
            {trust.level !== "ok" && <Button size="sm" onClick={() => onJudge(finished.id)}>Проверить судью</Button>}
          </div>
        </Panel>
        <Panel className="flex flex-col p-5">
          <Eyebrow>по версиям</Eyebrow>
          <div className="mt-2 flex-1">
            {points.length > 1 ? <div className="h-full min-h-[190px]"><Trend points={points} selectedId={finished.id} fill /></div> : <div className="flex h-full min-h-[180px] items-center justify-center rounded-lg border border-dashed border-white/[0.1] px-8 text-center text-[12px] leading-relaxed text-lab-dim">Пока одна версия. Проверьте агента после правки, и здесь появится динамика.</div>}
          </div>
        </Panel>
      </div>

      <div className="mb-2.5 mt-7 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[14px] font-medium text-lab-text">Что сломалось</h2>
          <p className="mt-0.5 text-[11px] text-lab-dim">
            {open ? `${open} ${plural(open, "проблема", "проблемы", "проблем")}` : "Проблем не найдено"}{previous ? `: ${counts.new} новых, ${counts.fixed} исправлено против ${previous.version}` : ""}. Откройте любую: там разговоры и почему так случилось.
          </p>
        </div>
        <Button size="sm" onClick={() => go("/lab/findings")}>Все находки</Button>
      </div>
      {compared.length === 0 ? (
        <EmptyState drop title="Нарушений нет">Агент выполнил все критерии во всех разговорах этой проверки.</EmptyState>
      ) : (
        <Panel className="overflow-hidden">
          {GROUPS.map(g => {
            const rows = compared.filter(c => c.change === g.change);
            if (!rows.length) return null;
            return (
              <div key={g.title}>
                <div className="border-t border-white/[0.06] bg-white/[0.025] px-5 py-2 font-mono text-[10px] uppercase tracking-[0.09em] text-lab-dim first:border-t-0">{g.title} · {rows.length}</div>
                {rows.slice(0, 6).map(c => <FindingRow key={c.finding.key} item={c} personas={state.personas} played={played} previousVersion={previous?.version} onOpen={() => onFinding(c.finding.key)} />)}
              </div>
            );
          })}
        </Panel>
      )}
    </Page>
  );
}
