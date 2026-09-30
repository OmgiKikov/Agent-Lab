import { useMemo, useState } from "react";
import { ArrowRight, Check, ChevronDown, FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";
import { Sparkline } from "../charts/Sparkline";
import { KIND_LABEL, type Compared } from "../criteria";
import { count, plural, whenLong } from "../format";
import { useLabContext } from "../LabContext";
import { HUE, type Hue } from "../look";
import { setupSteps } from "../nav";
import { attentionOf, trustStory, VERDICT_CHIP, verdictOf } from "../story";
import type { LabState } from "../types";
import type { Scope } from "../useScope";
import { VersionSwitch } from "../VersionSwitch";
import { Button, Label, LabMark, LinkButton, Page, Section, Skeleton, Stat, Strip, TrendBars, Verdict } from "../ui";

type Go = (to: string) => void;

/** The answer, in one line: the verdict chip, the headline, by how much, and what was changed in this version. */
function Headline({ scope }: { scope: Scope }) {
  const verdict = verdictOf(scope);
  const chip = VERDICT_CHIP[verdict.kind];
  const run = scope.finished;
  return (
    <header className="pt-10">
      <Verdict hue={chip.hue} solid={chip.hue !== "mute"}>{chip.text}</Verdict>
      <h2 className="mt-4 max-w-[860px] text-balance text-display font-medium text-lab-ink">{verdict.headline}</h2>
      <p className="mt-2 max-w-[760px] text-pretty text-lead text-lab-soft">{verdict.detail}</p>
      {run && (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-caption text-lab-mute">
          {run.label && <span className="inline-flex min-w-0 items-center gap-2"><Label>Что изменили</Label><span className="truncate text-lab-text">{run.label}</span></span>}
          <span className="inline-flex items-center gap-2"><Label>Проверка</Label>{whenLong(run.startedAt)} · {run.targetName}</span>
        </div>
      )}
    </header>
  );
}

/** The numbers behind the verdict in one strip; each is a way to its evidence. */
function Numbers({ scope, go }: { scope: Scope; go: Go }) {
  const { finished, previous, change, compared, interval } = scope;
  const logsOnly = !scope.sims.length;
  const s = logsOnly ? scope.log : scope.sim;
  const trust = trustStory(finished, interval);
  const fresh = compared.filter(c => c.change === "new").length;
  const fixed = compared.filter(c => c.change === "fixed").length;
  const broken = compared.filter(c => (logsOnly ? c.criterion.by.log.failed : c.criterion.by.sim.failed) > 0).length;
  const history = scope.sameAgent.filter(r => r.metric?.accuracy !== null && r.metric?.accuracy !== undefined).map(r => r.metric!.accuracy!);
  const noise = change && (change.direction === "likely-better" || change.direction === "likely-worse" || change.direction === "same");
  const changeHue: Hue = !change ? "mute" : change.direction === "better" ? "ok" : change.direction === "worse" ? "bad" : "mute";
  const half = interval ? Math.round((100 * (interval[1] - interval[0])) / 2) : null;
  const human = finished?.metric?.human;
  const humanShare = human && human.reviewed >= 10 ? Math.round((100 * human.agree) / human.reviewed) : null;
  const scroll = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <Strip className="mt-8">
      <Stat label={logsOnly ? "Реальные без нарушений" : "Без нарушений"} value={s.share === null ? "—" : `${s.share}%`}
        sub={<>{s.clean} из {count(s.measured, "диалога", "диалогов", "диалогов")}{half !== null && !logsOnly ? ` · ±${half}\u00a0п.п.` : ""}</>}
        onClick={() => go(logsOnly ? "/lab/logs" : "/lab/dialogs")}>
        {history.length > 1 && !logsOnly && <Sparkline values={history} width={96} height={20} className="mt-2" />}
      </Stat>
      {change && previous && (
        <Stat label={`К ${previous.version}`} hue={changeHue}
          value={change.delta === 0 ? "0" : `${change.delta > 0 ? "+" : "−"}${Math.abs(change.delta)}\u00a0п.п.`}
          sub={noise ? "в пределах шума" : `${scope.prevSim?.share ?? "—"}% → ${s.share}%`} />
      )}
      {scope.comparing ? (
        <>
          <Stat label="Сломалось" value={fresh} hue={fresh ? "bad" : undefined} sub={fresh ? plural(fresh, "новое нарушение", "новых нарушения", "новых нарушений") : "новых нарушений нет"} onClick={() => scroll("group-new")} />
          <Stat label="Исправлено" value={fixed} hue={fixed ? "ok" : undefined} sub={plural(fixed, "критерий", "критерия", "критериев")} onClick={() => scroll("group-fixed")} />
        </>
      ) : (
        <Stat label="Нарушается" value={broken} hue={broken ? "bad" : undefined} sub={`из ${count(compared.length, "критерия", "критериев", "критериев")}`} onClick={() => scroll("group-broken")} />
      )}
      {trust && (
        <Stat label="Судья прав" hue={trust.level === "ok" ? "ok" : humanShare === null ? "warn" : undefined}
          value={humanShare === null ? "—" : `${humanShare}%`}
          sub={humanShare === null ? `сверено ${human?.reviewed ?? 0} из 10 нужных` : `сверено ${human?.reviewed ?? 0} из ${finished?.metric?.total ?? 0}`} onClick={() => go("/lab/judge")} />
      )}
    </Strip>
  );
}

/** At most two lines the numbers do not say: where to look next. */
function Attention({ scope, state, go }: { scope: Scope; state: LabState; go: Go }) {
  const list = attentionOf(scope, state);
  if (!list.length) return null;
  return (
    <div className="mt-3 space-y-1">
      {list.map(o => (
        <button key={o.id} onClick={() => o.to && go(o.to)} className="lab-focus group flex w-full items-start gap-2.5 rounded-md px-1 py-1 text-left">
          <span className={cn("mt-[7px] size-1.5 flex-shrink-0 rounded-full", HUE[o.hue].solid)} />
          <span className="min-w-0 flex-1 text-body text-lab-soft transition-colors duration-100 group-hover:text-lab-ink">{o.text}</span>
          {o.cta && <span className="mt-px inline-flex flex-shrink-0 items-center gap-1 text-caption text-lab-mute group-hover:text-lab-ink">{o.cta}<ArrowRight className="size-3" /></span>}
        </button>
      ))}
    </div>
  );
}

type Group = { id: string; title: string; tone?: Hue; rows: Compared[]; folded?: boolean };

/** One criterion: what the agent must do, where it comes from, and how often it breaks now and before. */
function CriterionRow({ item, scope, logsOnly, onOpen, tone }: { item: Compared; scope: Scope; logsOnly: boolean; onOpen: () => void; tone?: Hue }) {
  const c = item.criterion;
  const now = logsOnly ? c.by.log : c.by.sim;
  const n = now.failed + now.passed;
  const logN = c.by.log.failed + c.by.log.passed;
  const trend = logsOnly ? [] : scope.history(c.key).map(v => (v === null ? null : 100 - v));
  const fixed = item.change === "fixed";
  return (
    <button onClick={onOpen} className="lab-focus-inset group flex w-full items-center gap-4 px-4 py-3 text-left transition-colors duration-100 hover:bg-white/[0.03]">
      <span className="flex size-4 flex-shrink-0 items-center justify-center">
        {fixed ? <Check className="size-3.5 text-lab-ok" strokeWidth={2.5} /> : <span className={cn("size-1.5 rounded-full", tone ? HUE[tone].solid : "bg-lab-faint")} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("line-clamp-2 block text-reading sm:truncate", now.failed || fixed ? "text-lab-ink" : "text-lab-soft")} title={c.title}>{c.title}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-caption text-lab-mute">
          {c.kind && <span className="flex-shrink-0">{KIND_LABEL[c.kind] ?? c.kind}</span>}
          {c.quote && <span className="hidden min-w-0 items-center gap-1.5 sm:flex"><span aria-hidden className="text-lab-faint">·</span><span className="truncate" title={c.quote}>«{c.quote}»</span></span>}
          {!logsOnly && logN > 0 && <><span aria-hidden className="text-lab-faint">·</span><span className="flex-shrink-0 tabular-nums">в логах {c.by.log.failed} из {logN}</span></>}
        </span>
      </span>
      {trend.length > 1 && <TrendBars values={trend} labels={scope.versions} className="hidden flex-shrink-0 sm:inline-flex" hue={fixed ? "ok" : "bad"} />}
      <span className="w-[72px] flex-shrink-0 text-right sm:w-[92px]">
        <span className="block text-body tabular-nums text-lab-soft">{n ? <><b className={cn("font-medium", now.failed ? "text-lab-ink" : "text-lab-soft")}>{now.failed}</b> из {n}</> : "—"}</span>
        {scope.comparing && item.change && <span className="block text-caption tabular-nums text-lab-faint">в {scope.previous?.version}: {item.before}</span>}
      </span>
      <ArrowRight className="hidden size-3.5 flex-shrink-0 text-lab-faint transition-colors duration-100 group-hover:text-lab-mute sm:block" />
    </button>
  );
}

/** What breaks, grouped the way a person reads a new version: new violations, still broken, fixed; what passes is folded. */
function Criteria({ scope, go }: { scope: Scope; go: Go }) {
  const [unfold, setUnfold] = useState<Record<string, boolean>>({});
  const logsOnly = !scope.sims.length;
  const version = scope.finished?.version ?? "";
  const groups = useMemo<Group[]>(() => {
    const main = (c: Compared) => (logsOnly ? c.criterion.by.log.failed : c.criterion.by.sim.failed);
    const byMain = (a: Compared, b: Compared) => main(b) - main(a) || b.criterion.failed - a.criterion.failed;
    const all = [...scope.compared];
    const onlyLogs = logsOnly ? [] : all.filter(c => !main(c) && c.change !== "fixed" && c.criterion.by.log.failed > 0);
    const fine = all.filter(c => !main(c) && c.change !== "fixed" && !onlyLogs.includes(c));
    if (scope.comparing) {
      return [
        { id: "new", title: `Сломалось в ${version}`, tone: "bad", rows: all.filter(c => c.change === "new").sort(byMain) },
        { id: "remains", title: "Нарушается, как и раньше", tone: "bad", rows: all.filter(c => c.change === "remains").sort(byMain) },
        { id: "fixed", title: `Исправлено в ${version}`, tone: "ok", rows: all.filter(c => c.change === "fixed").sort((a, b) => b.before - a.before) },
        { id: "logs", title: "Нарушается только в реальных диалогах", tone: "warn", rows: onlyLogs, folded: true },
        { id: "fine", title: "Выполняется", rows: fine, folded: true },
      ];
    }
    return [
      { id: "broken", title: "Нарушается", tone: "bad", rows: all.filter(c => main(c) > 0).sort(byMain) },
      { id: "logs", title: "Нарушается только в реальных диалогах", tone: "warn", rows: onlyLogs, folded: true },
      { id: "fine", title: "Выполняется", rows: fine, folded: true },
    ];
  }, [scope.compared, scope.comparing, logsOnly, version]);

  if (!scope.compared.length) return null;
  const open = (key: string) => go(`/lab/criteria/${encodeURIComponent(key)}`);
  return (
    <>
      {groups.filter(g => g.rows.length).map(g => {
        const shown = !g.folded || unfold[g.id];
        return (
          <Section key={g.id} id={`group-${g.id}`} title={g.title} count={g.rows.length} tone={g.tone} className="scroll-mt-20">
            <div className="overflow-hidden rounded-lg border border-lab-line bg-lab-panel divide-y divide-lab-line">
              {shown && g.rows.map(r => <CriterionRow key={r.criterion.key + r.change} item={r} scope={scope} logsOnly={logsOnly} tone={g.tone} onOpen={() => open(r.criterion.key)} />)}
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
      {!groups.some(g => !g.folded && g.rows.length) && (
        <p className="mt-10 flex items-center gap-2 text-reading text-lab-soft"><Check className="size-4 text-lab-ok" />Нарушений нет: все {count(scope.compared.length, "критерий выполняется", "критерия выполняются", "критериев выполняются")}.</p>
      )}
    </>
  );
}

/** The real logs, apart from any version: one line and the way to them. */
function RealLogs({ scope, state, go }: { scope: Scope; state: LabState; go: Go }) {
  const d = state.discover;
  if (!d || !scope.sims.length) return null;
  const s = scope.log;
  return (
    <Section title="Реальные диалоги" hint="без запуска агента, по логам">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-lab-line px-4 py-3">
        <span className="text-reading tabular-nums text-lab-ink">{s.share ?? "—"}% <span className="text-body text-lab-mute">без нарушений</span></span>
        <span className="text-body tabular-nums text-lab-mute">{s.clean} из {count(s.measured, "диалога", "диалогов", "диалогов")}</span>
        <span className="text-body text-lab-mute">оценены {whenLong(d.finishedAt)}</span>
        <LinkButton className="ml-auto" onClick={() => go("/lab/logs")}>Логи<ArrowRight className="size-3.5" /></LinkButton>
      </div>
    </Section>
  );
}

/** First run: what the Lab does in one sentence, and the three steps to the first verdict, the next one lit. */
function FirstRun({ state, go }: { state: LabState; go: Go }) {
  const steps = setupSteps(state);
  const next = steps.findIndex(s => !s.done);
  return (
    <div className="mx-auto max-w-[640px] pt-16">
      <div className="lab-dots flex h-28 items-center justify-center rounded-lg border border-lab-line"><LabMark size={40} className="text-lab-ink" /></div>
      <h2 className="mt-8 text-balance text-display font-medium text-lab-ink">Проверьте первую версию агента.</h2>
      <p className="mt-2 text-pretty text-lead text-lab-soft">Критерии берутся из промптов агента. Симулятор клиента играет с ним диалоги, судья подтверждает каждое нарушение цитатой. Три шага до первого вердикта.</p>
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
              {!s.done && <Button variant={current ? "primary" : "ghost"} size="sm" onClick={() => go(s.to)}>{s.cta}</Button>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The version's verdict: the first thing a person opening the Lab sees, and what breaks in it, worst first. */
export function OverviewView({ state, scope, go, onPick }: { state: LabState; scope: Scope; go: Go; onPick: (id: string) => void; onRun?: () => void }) {
  const { openNewRun } = useLabContext();
  const title = scope.finished
    ? <VersionSwitch asTitle versions={scope.sameAgent} current={scope.finished} previous={scope.previous} onPick={onPick} />
    : "Версия";
  if (scope.empty && !state.runs.length) return <Page title="Версия" icon={FlaskConical} noContext><FirstRun state={state} go={go} /></Page>;
  if (!scope.ready) {
    return (
      <Page title="Версия" icon={FlaskConical} noContext>
        <Skeleton className="mt-10 h-5 w-24" /><Skeleton className="mt-4 h-9 w-2/3" /><Skeleton className="mt-3 h-5 w-1/2" />
        <Skeleton className="mt-8 h-[104px]" />
        <Skeleton className="mt-10 h-4 w-40" /><Skeleton className="mt-3 h-[196px]" />
      </Page>
    );
  }
  return (
    <Page title={title} icon={FlaskConical} noContext>
      <Headline scope={scope} />
      <Numbers scope={scope} go={go} />
      <Attention scope={scope} state={state} go={go} />
      <Criteria scope={scope} go={go} />
      <RealLogs scope={scope} state={state} go={go} />
      {!scope.sims.length && state.cards?.cards.length ? (
        <div className="mt-10 flex flex-wrap items-center gap-3 rounded-lg border border-lab-line px-4 py-3">
          <span className="min-w-0 flex-1 text-body text-lab-soft">Сценарии готовы: проверьте версию агента на симуляторе, чтобы получить вердикт и сравнивать версии.</span>
          <Button variant="primary" size="sm" onClick={openNewRun}>Проверить версию</Button>
        </div>
      ) : null}
    </Page>
  );
}
