import { useMemo, useState } from "react";
import NumberFlow from "@number-flow/react";
import { ChevronDown, ChevronRight, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Sparkline } from "../charts/Sparkline";
import { Trend, type TrendPoint } from "../charts/Trend";
import { DropPixelGrid } from "../../components/DropPixelGrid";
import { KIND_LABEL, rate, type Change, type Compared } from "../criteria";
import { TRUST_TEXT, trustOf } from "../findings";
import { plural, when } from "../format";
import { setupSteps } from "../nav";
import type { LabState } from "../types";
import type { Scope } from "../useScope";
import { Badge, Button, Delta, EmptyState, Eyebrow, Page, Panel, Skeleton, titleFont } from "../ui";

const CHANGE_TEXT: Record<Change, string> = { new: "новое", remains: "остаётся", fixed: "исправлено" };

/** The first-run path: what is left before the first criterion has evidence. */
function FirstRun({ state, go }: { state: LabState; go: (to: string) => void }) {
  const steps = setupSteps(state);
  const next = steps.findIndex(s => !s.done);
  return (
    <Panel className="mt-5 overflow-hidden">
      <div className="flex flex-col items-center border-b border-white/[0.06] px-6 pb-6 pt-8 text-center">
        <div className="mb-3"><DropPixelGrid px={2} gap={1.5} fillRgb="142,157,166" /></div>
        <div className="text-[16px] font-medium text-lab-ink" style={titleFont}>Начнём с трёх шагов</div>
        <div className="mt-1.5 max-w-[480px] text-[12px] leading-relaxed text-lab-dim">Потом здесь будет главное: что агент должен делать, как он с этим справляется и что изменилось между версиями.</div>
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

function CriterionRow({ item, scope, onOpen }: { item: Compared; scope: Scope; onOpen: () => void }) {
  const { criterion: c, change } = item;
  const share = rate(c);
  const both = c.by.log.passed + c.by.log.failed > 0 && c.by.sim.passed + c.by.sim.failed > 0;
  const pct = (t: { passed: number; failed: number }) => Math.round(100 * (rate(t) ?? 0));
  const spark = scope.history(c.key).filter((v): v is number => v !== null);
  const fixed = change === "fixed";
  const broken = c.failed > 0;
  return (
    <button
      onClick={onOpen}
      className={cn("flex w-full items-center gap-4 border-t border-white/[0.06] px-5 py-3.5 text-left transition-colors first:border-t-0 hover:bg-white/[0.025] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/50", !broken && !fixed && "opacity-75")}
    >
      <span className={cn("size-[7px] flex-shrink-0 rounded-full", fixed ? "bg-lab-ok" : broken ? "bg-lab-bad" : "bg-lab-faint")} />
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium text-lab-ink">{c.title}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-lab-dim">
          {c.kind && <span className="flex-shrink-0 rounded-[3px] bg-white/[0.08] px-1 font-mono text-[9px] uppercase leading-[15px] tracking-wide">{KIND_LABEL[c.kind] ?? c.kind}</span>}
          <span className="truncate">{fixed ? `было нарушено в ${item.before} ${plural(item.before, "диалоге", "диалогах", "диалогах")}, теперь нигде` : c.quote ? `«${c.quote}»` : c.rule !== c.title ? c.rule : ""}</span>
        </span>
      </span>
      <span className="hidden w-[168px] flex-shrink-0 min-[820px]:block">
        {fixed ? <span className="text-[12px] text-lab-ok">выполняется везде</span> : (
          <>
            <span className="flex items-baseline gap-2"><span className={cn("text-[15px] font-medium", broken ? "text-lab-ink" : "text-lab-mute")} style={titleFont}>{share === null ? "—" : Math.round(100 * share)}%</span><span className="font-mono text-[11px] text-lab-dim">{c.passed} из {c.passed + c.failed}</span></span>
            <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-white/[0.07]"><span className={cn("block h-full rounded-full", broken && (share ?? 1) < 0.9 ? "bg-lab-bad" : "bg-white/30")} style={{ width: `${Math.round(100 * (share ?? 0))}%` }} /></span>
          </>
        )}
      </span>
      <span className="hidden w-[118px] flex-shrink-0 font-mono text-[11px] text-lab-dim min-[1100px]:block">
        {both && !fixed && <><span className="block">логи <span className="text-lab-mute">{pct(c.by.log)}%</span></span><span className="block">сим. <span className="text-lab-mute">{pct(c.by.sim)}%</span></span></>}
      </span>
      <span className="hidden w-[64px] flex-shrink-0 min-[1240px]:block">{spark.length > 1 && <Sparkline values={spark} width={64} height={26} />}</span>
      <span className="w-[74px] flex-shrink-0 text-right">{change && <Badge hue={change === "new" ? "bad" : change === "fixed" ? "ok" : "mute"}>{CHANGE_TEXT[change]}</Badge>}</span>
      <ChevronRight className="size-4 flex-shrink-0 text-lab-faint" />
    </button>
  );
}

export function CriteriaView({ state, scope, scopeBar, onCriterion, onJudge, go }: {
  state: LabState; scope: Scope; scopeBar: React.ReactNode; onCriterion: (key: string) => void; onJudge: () => void; go: (to: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const { summary, prevSim: prevSummary, compared, finished, previous } = scope;
  const rank = (c: Compared) => (c.change === "new" ? 0 : c.criterion.failed > 0 ? 1 : c.change === "fixed" ? 2 : 3);
  const rows = useMemo(() => [...compared].sort((a, b) => rank(a) - rank(b) || b.criterion.failed - a.criterion.failed), [compared]);
  const problems = rows.filter(r => r.criterion.failed > 0 || r.change === "fixed");
  const fine = rows.filter(r => !(r.criterion.failed > 0 || r.change === "fixed"));
  const counts = { broken: rows.filter(r => r.criterion.failed > 0).length, new: rows.filter(r => r.change === "new").length, fixed: rows.filter(r => r.change === "fixed").length };
  const title = "критерии";
  const lede = "Контракт агента: что он обязан делать. Одни и те же критерии проверяются и на настоящих логах, и на симуляторе.";

  if (scope.empty && !state.runs.length) return <Page wide title={title} lede={lede}><FirstRun state={state} go={go} /></Page>;
  if (!scope.ready) return <Page wide title={title} lede={lede} nav={scopeBar}><div className="mt-5 grid gap-4 min-[1100px]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]"><Skeleton className="h-[240px]" /><Skeleton className="h-[240px]" /></div><Skeleton className="mt-6 h-[300px]" /></Page>;
  if (!scope.dialogs.length) {
    return (
      <Page wide title={title} lede={lede} nav={scopeBar}>
        <EmptyState className="mt-5" drop title="В этой выборке диалогов нет">Переключите источник наверху или добавьте диалоги: оцените логи или прогоните симулятор.</EmptyState>
      </Page>
    );
  }

  const trust = finished ? trustOf(finished) : null;
  const delta = prevSummary?.share != null && summary.share != null ? summary.share - prevSummary.share : null;
  const second = state.discover?.summary.secondJudge;
  const points: TrendPoint[] = scope.sameAgent.filter(r => r.metric?.total).map(r => ({ id: r.id, value: r.metric!.accuracy ?? 0, label: r.version, title: `${r.version} · ${when(r.startedAt)}`, sub: `${r.metric!.passed} из ${r.metric!.measured} пройдено` }));
  const shown = showAll ? [...problems, ...fine] : problems;

  return (
    <Page wide title={title} lede={lede} nav={scopeBar}>
      <div className="mt-5 grid gap-4 min-[1100px]:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <Panel className="p-5">
          <Eyebrow>диалогов без нарушений</Eyebrow>
          <div className="mt-2 flex flex-wrap items-end gap-x-4 gap-y-2" style={titleFont}>
            <div className="flex items-baseline text-lab-ink">
              <span className="text-[88px] leading-[0.95] tracking-tight"><NumberFlow value={summary.share ?? 0} /></span>
              <span className="ml-1 text-[32px] text-lab-mute">%</span>
            </div>
            {delta !== null && <div className="mb-2 flex items-center gap-2 font-sans"><Delta value={delta} /><span className="text-[11px] text-lab-dim">к {previous?.version}</span></div>}
          </div>
          <p className="mt-3 text-[13px] leading-snug text-lab-text">Агент справляется в <b>{summary.clean}</b> из <b>{summary.measured}</b> {plural(summary.measured, "диалога", "диалогов", "диалогов")}{summary.unmeasured ? <span className="text-lab-dim"> · ещё {summary.unmeasured} без оценки</span> : null}</p>
          <div className="mt-4 flex gap-8">
            <div><div className={cn("text-[22px] font-medium leading-none", counts.broken ? "text-lab-ink" : "text-lab-mute")} style={titleFont}>{counts.broken}</div><div className="mt-1 text-[11px] text-lab-dim">{plural(counts.broken, "критерий нарушается", "критерия нарушаются", "критериев нарушаются")}</div></div>
            {scope.comparing && <div><div className={cn("text-[22px] font-medium leading-none", counts.new ? "text-lab-bad" : "text-lab-mute")} style={titleFont}>{counts.new}</div><div className="mt-1 text-[11px] text-lab-dim">новых в {finished?.version}</div></div>}
            {scope.comparing && <div><div className={cn("text-[22px] font-medium leading-none", counts.fixed ? "text-lab-ok" : "text-lab-mute")} style={titleFont}>{counts.fixed}</div><div className="mt-1 text-[11px] text-lab-dim">исправлено</div></div>}
          </div>
          {trust ? (
            <div className={cn("mt-4 flex items-center gap-3 rounded-lg border px-3.5 py-2.5", trust.level === "ok" ? "border-lab-ok/25 bg-lab-ok/[0.06]" : "border-lab-warn/25 bg-lab-warn/[0.06]")}>
              <TriangleAlert className={cn("size-4 flex-shrink-0", trust.level === "ok" ? "text-lab-ok" : "text-lab-warn")} />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium text-lab-text">{TRUST_TEXT[trust.level][0].toUpperCase() + TRUST_TEXT[trust.level].slice(1)}</div>
                <div className="text-[11px] leading-snug text-lab-dim">
                  {trust.level === "pending" ? `Судью проверили на ${trust.reviewed} из ${finished?.metric?.total ?? 0} диалогов симулятора. Проверьте ещё, и цифре можно верить.` : trust.level === "partial" ? `Судья прав в ${Math.round((trust.humanShare ?? 0) * 100)}% проверенных. Для уверенности нужно больше проверок.` : "Судью проверили достаточно, он прав в большинстве случаев."}
                </div>
              </div>
              {trust.level !== "ok" && <Button size="sm" onClick={onJudge}>Проверить судью</Button>}
            </div>
          ) : second ? (
            <div className="mt-4"><Badge hue="ok">второй судья согласен в {Math.round((100 * second.agree) / Math.max(1, second.checked))}%</Badge></div>
          ) : null}
        </Panel>
        <Panel className="flex flex-col p-5">
          <Eyebrow>симулятор по версиям</Eyebrow>
          <div className="mt-2 flex-1">
            {points.length > 1 && finished ? <div className="h-full min-h-[190px]"><Trend points={points} selectedId={finished.id} fill /></div> : <div className="flex h-full min-h-[180px] items-center justify-center rounded-lg border border-dashed border-white/[0.1] px-8 text-center text-[12px] leading-relaxed text-lab-dim">Пока одна версия. Прогоните симулятор после правки агента, и здесь появится динамика.</div>}
          </div>
        </Panel>
      </div>

      <div className="mb-2.5 mt-7">
        <h2 className="text-[14px] font-medium text-lab-text">Критерии</h2>
        <p className="mt-0.5 text-[11px] text-lab-dim">
          {counts.broken ? `${counts.broken} из ${rows.length} ${plural(counts.broken, "нарушается", "нарушаются", "нарушаются")}` : "Нарушений нет"}
          {scope.comparing ? `, против ${previous?.version}: ${counts.new} новых, ${counts.fixed} исправлено` : ""}. Откройте любой: там диалоги, цитата судьи и откуда критерий взялся.
        </p>
      </div>
      {rows.length === 0 ? (
        <EmptyState drop title="Критериев пока нет">Они появятся, когда судья оценит первые диалоги.</EmptyState>
      ) : (
        <Panel className="overflow-hidden">
          {shown.map(r => <CriterionRow key={r.criterion.key + r.change} item={r} scope={scope} onOpen={() => onCriterion(r.criterion.key)} />)}
          {fine.length > 0 && (
            <button onClick={() => setShowAll(v => !v)} className="flex w-full items-center justify-center gap-1.5 border-t border-white/[0.06] px-5 py-3 text-[12px] text-lab-dim transition-colors hover:bg-white/[0.025] hover:text-lab-soft">
              <ChevronDown className={cn("size-3.5 transition-transform", showAll && "rotate-180")} />
              {showAll ? "Скрыть выполняющиеся" : `Ещё ${fine.length} ${plural(fine.length, "критерий выполняется", "критерия выполняются", "критериев выполняются")} везде`}
            </button>
          )}
        </Panel>
      )}
    </Page>
  );
}
