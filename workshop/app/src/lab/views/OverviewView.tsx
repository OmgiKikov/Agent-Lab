import { useMemo, useState } from "react";
import { ArrowRight, Check, ChevronDown, FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";
import { KIND_LABEL, type Criterion } from "../criteria";
import { count, whenLong } from "../format";
import { JobLine } from "../JobLine";
import { useLabContext } from "../LabContext";
import { HUE, type Hue } from "../look";
import { setupSteps } from "../nav";
import type { LabState } from "../types";
import type { Scope } from "../useScope";
import { Button, Hero, LabMark, LinkButton, Numbers, Page, Section, Skeleton, type FactRow } from "../ui";

type Go = (to: string) => void;

const dialogs = (n: number) => count(n, "диалога", "диалогов", "диалогов");
/**
 * lab/metric.py opens with «the one quality number and how far it can be trusted»: the check's accuracy is the page's one big number
 * (with what it is made of and the previous check's own number under it); the second judge, the human check and the repeats —
 * how far to trust it — sit beside it, small.
 */
function Result({ scope, go }: { scope: Scope; go: Go }) {
  const run = scope.finished!;
  const m = run.metric!;
  const before = scope.previous?.metric;
  const facts: FactRow[] = [
    { label: "Второй судья", value: m.secondJudge ? `согласен в ${m.secondJudge.agree} из ${m.secondJudge.checked}` : "не оценивал", title: m.secondJudge?.model, onClick: () => go("/lab/judge") },
    { label: "Сверка с человеком", value: m.human ? `сверено ${m.human.reviewed} из ${m.total}, судья прав в ${m.human.agree}` : "ещё не было", onClick: () => go("/lab/judge") },
    { label: "Повторы", value: m.repeats ? `одинаковый результат в ${m.repeats.stable} из ${m.repeats.scenarios}` : "не было" },
  ];
  return (
    <Numbers className="mt-8" facts={facts} hero={
      <Hero
        label="Без нарушений"
        value={m.accuracy === null ? "—" : `${m.accuracy}%`}
        sub={<>{m.passed} из {dialogs(m.measured)}{m.unmeasured ? ` · ещё ${m.unmeasured} без оценки` : ""}</>}
        note={scope.previous && before ? `В ${scope.previous.version} — ${before.accuracy === null ? "—" : `${before.accuracy}%`}, ${before.passed} из ${before.measured}` : undefined}
      />
    } />
  );
}

type Group = { id: string; title: string; tone?: Hue; rows: Criterion[]; folded?: boolean };

/** One criterion: what the agent must do, where it comes from, how many of this check's dialogues broke it, and the previous check's count beside it. */
function CriterionRow({ c, scope, onOpen, tone }: { c: Criterion; scope: Scope; onOpen: () => void; tone?: Hue }) {
  const now = c.by.sim;
  const n = now.failed + now.passed;
  const was = scope.previousCriteria.get(c.key)?.by.sim;
  return (
    <button onClick={onOpen} className="lab-focus-inset group flex w-full items-center gap-4 px-4 py-3 text-left transition-colors duration-100 hover:bg-white/[0.03]">
      <span className="flex size-4 flex-shrink-0 items-center justify-center"><span className={cn("size-1.5 rounded-full", tone ? HUE[tone].solid : "bg-lab-faint")} /></span>
      <span className="min-w-0 flex-1">
        <span className={cn("line-clamp-2 block text-reading sm:truncate", now.failed ? "text-lab-ink" : "text-lab-soft")} title={c.title}>{c.title}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-caption text-lab-mute">
          {c.kind && <span className="flex-shrink-0">{KIND_LABEL[c.kind] ?? c.kind}</span>}
          {c.quote && <span className="hidden min-w-0 items-center gap-1.5 sm:flex">{c.kind && <span aria-hidden className="text-lab-faint">·</span>}<span className="truncate" title={c.quote}>«{c.quote}»</span></span>}
        </span>
      </span>
      <span className="w-[72px] flex-shrink-0 text-right sm:w-[92px]">
        <span className="block text-body tabular-nums text-lab-soft">{n ? <><b className={cn("font-medium", now.failed ? "text-lab-ink" : "text-lab-soft")}>{now.failed}</b> из {n}</> : "—"}</span>
        {scope.previous && was && was.failed + was.passed > 0 && <span className="block text-caption tabular-nums text-lab-faint">в {scope.previous.version}: {was.failed} из {was.failed + was.passed}</span>}
      </span>
      <ArrowRight className="hidden size-3.5 flex-shrink-0 text-lab-faint transition-colors duration-100 group-hover:text-lab-mute sm:block" />
    </button>
  );
}

/** The check's criteria: the ones its dialogues broke, most often first; the kept ones folded. */
function Criteria({ scope, go }: { scope: Scope; go: Go }) {
  const [unfold, setUnfold] = useState<Record<string, boolean>>({});
  const groups = useMemo<Group[]>(() => {
    const played = scope.criteria.filter(c => c.by.sim.failed + c.by.sim.passed > 0);
    return [
      { id: "broken", title: "Нарушается", tone: "bad", rows: played.filter(c => c.by.sim.failed > 0).sort((a, b) => b.by.sim.failed - a.by.sim.failed) },
      { id: "fine", title: "Выполняется", rows: played.filter(c => c.by.sim.failed === 0), folded: true },
    ];
  }, [scope.criteria]);

  const open = (key: string) => go(`/lab/criteria/${encodeURIComponent(key)}`);
  return (
    <>
      {groups.filter(g => g.rows.length).map(g => {
        const shown = !g.folded || unfold[g.id];
        return (
          <Section key={g.id} id={`group-${g.id}`} title={g.title} count={g.rows.length} tone={g.tone} className="scroll-mt-20">
            <div className="overflow-hidden rounded-lg border border-lab-line bg-lab-panel divide-y divide-lab-line">
              {shown && g.rows.map(c => <CriterionRow key={c.key} c={c} scope={scope} tone={g.tone} onOpen={() => open(c.key)} />)}
              {g.folded && (
                <button onClick={() => setUnfold(u => ({ ...u, [g.id]: !u[g.id] }))} className="lab-focus-inset flex w-full items-center gap-2 px-4 py-2.5 text-body text-lab-mute transition-colors duration-100 hover:bg-white/[0.03] hover:text-lab-ink">
                  <ChevronDown className={cn("size-3.5 transition-transform duration-100", shown && "rotate-180")} />
                  {shown ? "Свернуть" : `Показать ${count(g.rows.length, "критерий", "критерия", "критериев")}`}
                </button>
              )}
            </div>
          </Section>
        );
      })}
    </>
  );
}

/** The log audit, apart from any version: its own summary (lab/discover.py) and the way to it. */
function RealLogs({ state, go }: { state: LabState; go: Go }) {
  const d = state.discover;
  if (!d) return null;
  const s = d.summary;
  return (
    <Section title="Реальные диалоги" hint="оценка логов, без запуска агента">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-lab-line px-4 py-3">
        <span className="text-body tabular-nums text-lab-text">Без нарушений {s.passed} из {dialogs(s.measured)}</span>
        {s.unmeasured > 0 && <span className="text-body tabular-nums text-lab-mute">ещё {s.unmeasured} без оценки</span>}
        <span className="text-body text-lab-mute">оценены {whenLong(d.finishedAt)}</span>
        <LinkButton className="ml-auto" onClick={() => go("/lab/logs")}>Логи<ArrowRight className="size-3.5" /></LinkButton>
      </div>
    </Section>
  );
}

/**
 * Before the first check: the service's steps in the order it needs them — sources from the agent's code, the log audit
 * (it extracts the criteria and judges the real dialogues), the scenarios built from it, then the check itself.
 */
function FirstRun({ state, go, onRun }: { state: LabState; go: Go; onRun: () => void }) {
  const steps = [
    ...setupSteps(state).map(s => ({ ...s, run: () => go(s.to) })),
    { id: "run", label: "Проверьте версию агента", gives: "долю диалогов без нарушений и нарушенные критерии", done: false, cta: "Проверить версию", run: onRun },
  ];
  const next = steps.findIndex(s => !s.done);
  return (
    <div className="mx-auto max-w-[640px] pt-16">
      <div className="lab-dots flex h-28 items-center justify-center rounded-lg border border-lab-line"><LabMark size={40} className="text-lab-ink" /></div>
      <h2 className="mt-8 text-balance text-display font-medium text-lab-ink">Версия агента ещё не проверялась.</h2>
      <p className="mt-2 text-pretty text-lead text-lab-soft">Симулятор клиента играет сценарии с агентом, судья оценивает каждый диалог по критериям и подтверждает вердикт цитатой агента.</p>
      <ol className="mt-8 divide-y divide-lab-line rounded-lg border border-lab-line bg-lab-panel">
        {steps.map((s, i) => {
          const current = i === next;
          return (
            <li key={s.id} className={cn("flex items-center gap-4 px-4 py-3.5", s.done && "opacity-60")}>
              <span className={cn("flex size-6 flex-shrink-0 items-center justify-center rounded font-mono text-micro", s.done ? "bg-lab-ok/15 text-lab-ok" : current ? "bg-lab-ink text-black" : "border border-lab-strong text-lab-mute")}>
                {s.done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-reading text-lab-ink">{s.label}</span>
                <span className="block text-caption text-lab-mute">Даёт {s.gives}</span>
              </span>
              {!s.done && current && <Button variant="primary" size="sm" disabled={state.job.running} onClick={s.run}>{s.cta}</Button>}
            </li>
          );
        })}
      </ol>
      <div className="mt-4"><JobLine state={state} kind="run" /></div>
    </div>
  );
}

/** The version's check: the run record, the service's numbers, then the criteria its dialogues broke. */
export function OverviewView({ state, scope, go, onPick }: { state: LabState; scope: Scope; go: Go; onPick: (id: string) => void; onRun?: () => void }) {
  const { openNewRun } = useLabContext();
  if (!scope.finished) {
    // No finished check yet (the first one may be running: its numbers come when it ends).
    if (!state.runs.length || state.runs.every(r => r.status === "running")) {
      return <Page title="Версия" icon={FlaskConical} noContext><FirstRun state={state} go={go} onRun={openNewRun} /></Page>;
    }
    return (
      <Page title="Версия" icon={FlaskConical} noContext>
        <Skeleton className="mt-8 h-4 w-1/2" />
        <Skeleton className="mt-4 h-[104px]" />
        <Skeleton className="mt-10 h-4 w-40" /><Skeleton className="mt-3 h-[196px]" />
      </Page>
    );
  }
  return (
    <Page title="Обзор" icon={FlaskConical} noContext>
      <Result scope={scope} go={go} />
      <Criteria scope={scope} go={go} />
      <RealLogs state={state} go={go} />
    </Page>
  );
}
