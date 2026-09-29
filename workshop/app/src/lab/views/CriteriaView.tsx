import { useMemo, useState } from "react";
import { ChevronDown, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import { Sparkline } from "../charts/Sparkline";
import { KIND_LABEL, type Change, type Compared } from "../criteria";
import { count, plural } from "../format";
import type { Hue } from "../look";
import { setupSteps } from "../nav";
import type { LabState } from "../types";
import type { Scope } from "../useScope";
import { Badge, Button, Chip, EmptyState, Page, Panel, Row, Skeleton } from "../ui";

type Filter = "broken" | "new" | "fixed" | "ok" | "all";

const CHANGE_TAG: Record<Change, { hue: Hue; text: string }> = { new: { hue: "bad", text: "новое" }, fixed: { hue: "ok", text: "исправлено" }, remains: { hue: "mute", text: "осталось" } };

/** Column widths, shared by the header and the rows. The secondary columns give way as the window narrows (the sidebar takes 232 px from 768). */
const COL = {
  measure: "w-[88px] sm:w-[148px]",
  change: "hidden w-[88px] sm:block",
  logs: "hidden w-[72px] min-[1000px]:block",
  trend: "hidden w-[64px] min-[1180px]:block",
};

/** The first-run path: what is left before the first criterion exists. */
function FirstRun({ state, go }: { state: LabState; go: (to: string) => void }) {
  const steps = setupSteps(state);
  const next = steps.find(s => !s.done);
  return (
    <Page wide title="Критерии">
      <div className="mx-auto mt-10 max-w-[640px]">
        <EmptyState
          icon={ListChecks} title="Критериев пока нет"
          action={next && <Button variant="primary" onClick={() => go(next.to)}>{next.cta}</Button>}
        >
          Судья находит их в промптах, инструментах и базе знаний агента и подтверждает цитатой. Три шага до первых критериев.
        </EmptyState>
        <Panel className="mt-4">
          {steps.map((s, i) => (
            <Row first={!i} key={s.id} className={cn("flex items-start gap-3.5 px-5 py-3.5", s.done && "opacity-70")}>
              <span className={cn("mt-px inline-flex size-6 flex-shrink-0 items-center justify-center rounded-full text-caption font-semibold tabular-nums", s.done ? "bg-lab-ok/20 text-lab-ok" : s === next ? "bg-lab-ink text-lab-canvas" : "border border-lab-strong text-lab-mute")}>{s.done ? "✓" : i + 1}</span>
              <span className="min-w-0">
                <span className="block text-body font-medium text-lab-ink">{s.label}</span>
                <span className="block text-body text-lab-mute">{s.hint}</span>
              </span>
            </Row>
          ))}
        </Panel>
      </div>
    </Page>
  );
}

/** Same shape as the table, while the version is still loading. */
function Loading() {
  return (
    <Page wide title="Критерии">
      <Skeleton className="mt-6 h-5 w-2/3 max-w-[560px]" />
      <div className="mt-5 flex gap-2">{["w-28", "w-20", "w-24", "w-28", "w-14"].map((w, i) => <Skeleton key={i} className={cn("h-7 rounded-full", w)} />)}</div>
      <div className="mt-4 space-y-px">{Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="h-[66px] rounded-md" />)}</div>
    </Page>
  );
}

/** How often the criterion is violated: «3 из 10» and a thin bar as long as the share of violations. */
function Measure({ failed, total, className }: { failed: number; total: number; className?: string }) {
  if (!total) return <span className={cn("text-body text-lab-mute", className)}>—</span>;
  return (
    <span className={cn("block", className)}>
      <span className="block whitespace-nowrap text-body tabular-nums text-lab-mute"><b className={cn("font-semibold", failed ? "text-lab-ink" : "text-lab-text")}>{failed}</b> из {total}</span>
      <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-white/[0.07]"><span className="block h-full rounded-full bg-lab-bad/70" style={{ width: `${(100 * failed) / total}%` }} /></span>
    </span>
  );
}

function CriterionRow({ item, scope, logsOnly, onOpen }: { item: Compared; scope: Scope; logsOnly: boolean; onOpen: () => void }) {
  const { criterion: c, change } = item;
  const main = logsOnly ? c.by.log : c.by.sim;
  const logs = c.by.log;
  const tag = scope.comparing && change ? CHANGE_TAG[change] : null;
  const broken = c.failed > 0;
  const spark = scope.history(c.key).filter((v): v is number => v !== null);
  const tagTitle = change === "fixed" ? `Было нарушено в ${count(item.before, "диалоге", "диалогах", "диалогах")} версии ${scope.previous?.version}` : undefined;
  return (
    <button
      onClick={onOpen}
      className="lab-focus-inset group flex w-full items-center gap-4 border-t border-lab-line px-3 py-3.5 text-left transition-colors duration-100 first:border-t-0 hover:bg-lab-raised/60"
    >
      <span className="min-w-0 flex-1">
        <span className={cn("line-clamp-2 block text-reading font-medium", broken ? "text-lab-ink" : "text-lab-text")} title={c.title}>{c.title}</span>
        {(c.quote || c.kind || tag) && (
          <span className="mt-1 flex items-center gap-2 text-caption text-lab-mute">
            {tag && <Badge hue={tag.hue} title={tagTitle} className="sm:hidden">{tag.text}</Badge>}
            {c.kind && <Badge className="flex-shrink-0">{KIND_LABEL[c.kind] ?? c.kind}</Badge>}
            {c.quote && <span className="truncate" title={c.quote}>«{c.quote}»</span>}
          </span>
        )}
      </span>
      <Measure failed={main.failed} total={main.failed + main.passed} className={cn("flex-shrink-0", COL.measure)} />
      {scope.comparing && <span className={cn("flex-shrink-0", COL.change)}>{tag && <Badge hue={tag.hue} title={tagTitle}>{tag.text}</Badge>}</span>}
      {!logsOnly && (
        <span className={cn("flex-shrink-0 whitespace-nowrap text-body tabular-nums text-lab-mute", COL.logs)}>
          {logs.failed + logs.passed ? <><span className={cn(logs.failed && "font-medium text-lab-text")}>{logs.failed}</span> из {logs.failed + logs.passed}</> : "—"}
        </span>
      )}
      <span className={cn("flex-shrink-0", COL.trend)}>{spark.length > 1 && <Sparkline values={spark} hue={change === "new" ? "bad" : change === "fixed" ? "ok" : undefined} />}</span>
    </button>
  );
}

/** What the agent must do and where it fails: a table, the worst first; what passes everywhere is folded into one row. */
export function CriteriaView({ state, scope, onCriterion, go }: {
  state: LabState; scope: Scope; scopeBar?: React.ReactNode; onCriterion: (key: string) => void; onJudge?: () => void; go: (to: string) => void;
}) {
  const [picked, setPicked] = useState<Filter | null>(null);
  const [showFine, setShowFine] = useState(false);
  const { compared, finished, previous, comparing } = scope;
  // The version's numbers come from the simulator; with no version checked yet the real logs are all there is.
  const logsOnly = !scope.sims.length;
  const rank = (c: Compared) => (c.change === "new" ? 0 : c.criterion.failed > 0 ? 1 : c.change === "fixed" ? 2 : 3);
  const rows = useMemo(() => {
    const main = (c: Compared) => (logsOnly ? c.criterion.by.log : c.criterion.by.sim).failed;
    return [...compared].sort((a, b) => rank(a) - rank(b) || main(b) - main(a) || b.criterion.failed - a.criterion.failed);
  }, [compared, logsOnly]);

  if (scope.empty && !state.runs.length) return <FirstRun state={state} go={go} />;
  if (!scope.ready) return <Loading />;
  if (!scope.dialogs.length || !rows.length) {
    return (
      <Page wide title="Критерии">
        <EmptyState
          className="mt-10" icon={ListChecks} title="Критериев пока нет"
          action={<Button onClick={() => go(scope.dialogs.length ? "/lab/dialogs" : "/lab/logs")}>{scope.dialogs.length ? "Открыть диалоги" : "Загрузить логи"}</Button>}
        >
          Они появятся, когда судья оценит первые диалоги: реальные из логов или сыгранные симулятором.
        </EmptyState>
      </Page>
    );
  }

  const broken = rows.filter(r => r.criterion.failed > 0);
  const fresh = rows.filter(r => r.change === "new");
  const fixed = rows.filter(r => r.change === "fixed");
  const passing = rows.filter(r => r.criterion.failed === 0);
  const fine = passing.filter(r => r.change !== "fixed");
  const filter: Filter = picked ?? (broken.length ? "broken" : "all");
  const base = { broken, new: fresh, fixed, ok: passing, all: [...broken, ...fixed] }[filter];
  // What passes everywhere is one folded row under the list, not a hundred quiet ones.
  const foldable = (filter === "broken" || filter === "all") && fine.length > 0;
  const shown = foldable && showFine ? [...base, ...fine] : base;

  const simBroken = compared.filter(c => c.criterion.by.sim.failed > 0).length;
  const logBroken = compared.filter(c => c.criterion.by.log.failed > 0).length;
  const version = finished?.version;
  const num = (n: number) => <b className="font-semibold tabular-nums text-lab-ink">{n}</b>;
  const lede = (
    <>
      {broken.length ? <>Нарушаются {num(broken.length)} из {rows.length} {plural(rows.length, "критерия", "критериев", "критериев")}</> : <>Нарушений нет: все {num(rows.length)} {plural(rows.length, "критерий выполняется", "критерия выполняются", "критериев выполняются")}</>}
      {broken.length > 0 && !logsOnly && logBroken > 0 ? <>: {num(simBroken)} в симуляторе, {num(logBroken)} в реальных диалогах</> : broken.length > 0 && logsOnly ? " в реальных диалогах" : null}.
      {comparing && version && <> В {version} — {fresh.length ? <>{num(fresh.length)} {plural(fresh.length, "новое нарушение", "новых нарушения", "новых нарушений")}</> : "новых нарушений нет"}, {fixed.length ? <>{num(fixed.length)} исправлено</> : "исправленных нет"}.</>}
    </>
  );

  const empty: Record<Filter, [string, string]> = {
    broken: ["Нарушений нет", "Ни один критерий не нарушается ни в симуляторе, ни в реальных диалогах."],
    new: ["Новых нарушений нет", `В ${version} не появилось нарушений, которых не было в ${previous?.version}.`],
    fixed: ["Исправленных критериев нет", `Всё, что нарушалось в ${previous?.version}, нарушается и сейчас.`],
    ok: ["Выполняющихся критериев нет", "Каждый критерий нарушен хотя бы в одном диалоге."],
    all: ["Критериев нет", ""],
  };

  return (
    <Page wide title="Критерии" count={rows.length} lede={lede}>
      <div className="mt-5 flex flex-wrap gap-2">
        <Chip on={filter === "broken"} onClick={() => setPicked("broken")} count={broken.length}>Нарушаются</Chip>
        {comparing && <Chip on={filter === "new"} onClick={() => setPicked("new")} count={fresh.length} hue="bad">Новые</Chip>}
        {comparing && <Chip on={filter === "fixed"} onClick={() => setPicked("fixed")} count={fixed.length} hue="ok">Исправлено</Chip>}
        <Chip on={filter === "ok"} onClick={() => setPicked("ok")} count={passing.length}>Выполняются</Chip>
        <Chip on={filter === "all"} onClick={() => setPicked("all")} count={rows.length}>Все</Chip>
      </div>

      {shown.length === 0 ? (
        <EmptyState className="mt-4" icon={ListChecks} title={empty[filter][0]} action={<Button onClick={() => setPicked("all")}>Показать все критерии</Button>}>{empty[filter][1]}</EmptyState>
      ) : (
        <div className="-mx-3 mt-4">
          <div className="sticky top-[57px] z-10 hidden h-9 items-center gap-4 border-b border-lab-line bg-lab-canvas px-3 text-caption font-medium text-lab-mute sm:flex">
            <span className="min-w-0 flex-1">Критерий</span>
            <span className={cn("flex-shrink-0 whitespace-nowrap", COL.measure)}>{logsOnly ? "Нарушено в логах" : "Нарушено в симуляторе"}</span>
            {comparing && <span className={cn("flex-shrink-0 whitespace-nowrap", COL.change)} title={`Против версии ${previous?.version}`}>К {previous?.version}</span>}
            {!logsOnly && <span className={cn("flex-shrink-0 whitespace-nowrap", COL.logs)}>В логах</span>}
            <span className={cn("flex-shrink-0 whitespace-nowrap", COL.trend)} title="Доля диалогов без нарушения по версиям; последняя точка — эта версия">По версиям</span>
          </div>
          {shown.map(r => <CriterionRow key={r.criterion.key + r.change} item={r} scope={scope} logsOnly={logsOnly} onOpen={() => onCriterion(r.criterion.key)} />)}
          {foldable && (
            <button
              onClick={() => setShowFine(v => !v)}
              className="lab-focus-inset flex w-full items-center gap-2 border-t border-lab-line px-3 py-3 text-body text-lab-mute transition-colors duration-100 hover:bg-lab-raised/60 hover:text-lab-ink"
            >
              <ChevronDown className={cn("size-3.5 transition-transform duration-100", showFine && "rotate-180")} />
              {showFine ? "Скрыть выполняющиеся" : `Ещё ${fine.length} ${plural(fine.length, "критерий выполняется", "критерия выполняются", "критериев выполняются")} везде`}
            </button>
          )}
        </div>
      )}
    </Page>
  );
}
