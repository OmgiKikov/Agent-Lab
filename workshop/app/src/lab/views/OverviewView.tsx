import { useMemo } from "react";
import NumberFlow from "@number-flow/react";
import { ArrowDownRight, ArrowRight, ArrowUpRight, Bot, Equal, FileText, FlaskConical, Play, ShieldCheck, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Sparkline } from "../charts/Sparkline";
import { Trend, type TrendPoint } from "../charts/Trend";
import type { Compared } from "../criteria";
import { count, plural, whenLong } from "../format";
import { AGENT_TITLE, HUE, type Hue } from "../look";
import { setupSteps } from "../nav";
import { wilson } from "../stats";
import { observationsOf, trustStory, verdictOf, type Verdict } from "../story";
import type { LabState } from "../types";
import type { Scope } from "../useScope";
import { Badge, Button, Delta, Eyebrow, IntervalBar, LabMark, LinkButton, Page, Panel, Section, Skeleton } from "../ui";

type Go = (to: string) => void;

const GLYPH: Record<Verdict["kind"], { icon: LucideIcon; hue: Hue }> = {
  better: { icon: ArrowUpRight, hue: "ok" }, "likely-better": { icon: ArrowUpRight, hue: "mute" }, same: { icon: Equal, hue: "mute" },
  "likely-worse": { icon: ArrowDownRight, hue: "mute" }, worse: { icon: ArrowDownRight, hue: "bad" },
  first: { icon: FlaskConical, hue: "mute" }, logs: { icon: FileText, hue: "mute" }, none: { icon: Bot, hue: "mute" },
};

/** The verdict, as a sentence. The only headline on the page. */
function Headline({ verdict, scope }: { verdict: Verdict; scope: Scope }) {
  const g = GLYPH[verdict.kind];
  const run = scope.finished;
  return (
    <header className="pt-10">
      <div className="flex flex-wrap items-center gap-x-2 text-body text-lab-mute">
        <span>{AGENT_TITLE}</span>
        {run && <><span aria-hidden>·</span><span>проверка от {whenLong(run.startedAt)}</span></>}
        {run?.label && <><span aria-hidden>·</span><span className="text-lab-text">{run.label}</span></>}
      </div>
      <h2 className="mt-3 flex items-start gap-3 text-balance text-display font-semibold text-lab-ink">
        <span className={cn("mt-0.5 inline-flex size-8 flex-shrink-0 items-center justify-center rounded-full", HUE[g.hue].bgStrong, HUE[g.hue].text)}><g.icon className="size-[18px]" strokeWidth={2.25} /></span>
        <span>{verdict.headline}</span>
      </h2>
      <p className="mt-3 max-w-[760px] text-pretty text-lead text-lab-text">{verdict.detail}</p>
    </header>
  );
}

/** The number, its interval and the change. Big because it is the answer; honest because it says how sure it is. */
function Score({ scope, go }: { scope: Scope; go: Go }) {
  const { finished, previous, change, compared } = scope;
  const logsOnly = !scope.sims.length;
  const s = logsOnly ? scope.log : scope.sim;
  const ci = logsOnly ? (s.measured ? wilson(s.clean, s.measured) : null) : scope.interval;
  const broken = compared.filter(c => (logsOnly ? c.criterion.by.log.failed : c.criterion.by.sim.failed) > 0).length;
  const fresh = compared.filter(c => c.change === "new").length;
  const fixed = compared.filter(c => c.change === "fixed").length;
  const fact = (value: number, label: string, to: string, hue?: Hue) => (
    <button onClick={() => go(to)} className="lab-focus group rounded-md text-left">
      <div className={cn("text-title font-semibold tabular-nums", value && hue ? HUE[hue].text : "text-lab-ink")}>{value}</div>
      <div className="text-caption text-lab-mute transition-colors duration-100 group-hover:text-lab-text">{label}</div>
    </button>
  );
  return (
    <Panel className="flex flex-col p-6">
      <Eyebrow>{logsOnly ? "Реальных диалогов без нарушений" : "Диалогов без нарушений"}</Eyebrow>
      <div className="mt-2 flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="flex items-baseline text-lab-ink">
          <span className="text-hero font-semibold tabular-nums"><NumberFlow value={s.share ?? 0} /></span>
          <span className="ml-1 text-display font-medium text-lab-mute">%</span>
        </div>
        {change && previous && (
          <div className="mb-3 flex items-center gap-2">
            <Delta value={change.delta} direction={change.direction} />
            <span className="text-body text-lab-mute">к {previous.version}</span>
          </div>
        )}
      </div>
      {ci && s.share !== null && (
        <div className="mt-5">
          <IntervalBar value={s.share / 100} low={ci[0]} high={ci[1]} />
          <div className="mt-2 flex flex-wrap justify-between gap-x-4 text-caption text-lab-mute">
            <span className="tabular-nums">{s.clean} из {count(s.measured, "диалога", "диалогов", "диалогов")}{s.unmeasured ? ` · ещё ${s.unmeasured} без оценки` : ""}</span>
            <span className="tabular-nums" title="С вероятностью 95% настоящая доля лежит в этих границах">скорее всего от {Math.round(100 * ci[0])} до {Math.round(100 * ci[1])}%</span>
          </div>
        </div>
      )}
      <div className="mt-6 grid grid-cols-3 gap-4 border-t border-lab-line pt-4">
        {fact(broken, `${plural(broken, "критерий нарушается", "критерия нарушаются", "критериев нарушаются")}`, "/lab/criteria")}
        {scope.comparing && finished && previous ? (
          <>
            {fact(fresh, `${plural(fresh, "новое", "новых", "новых")} в ${finished.version}`, "/lab/criteria", "bad")}
            {fact(fixed, "исправлено", "/lab/criteria", "ok")}
          </>
        ) : fact(compared.length - broken, `${plural(compared.length - broken, "критерий выполняется", "критерия выполняются", "критериев выполняются")}`, "/lab/criteria")}
      </div>
    </Panel>
  );
}

function Versions({ scope, state, go, onPick, onRun }: { scope: Scope; state: LabState; go: Go; onPick: (id: string) => void; onRun: () => void }) {
  const points: TrendPoint[] = scope.sameAgent.filter(r => r.metric?.measured).map(r => {
    const m = r.metric!;
    const ci = wilson(m.passed, m.measured);
    return {
      id: r.id, value: m.accuracy ?? 0, label: r.version, title: `Версия ${r.version}`,
      sub: `${r.label ? `${r.label} · ` : ""}${m.passed} из ${m.measured}`,
      low: ci ? Math.round(100 * ci[0]) : undefined, high: ci ? Math.round(100 * ci[1]) : undefined,
    };
  });
  return (
    <Panel className="flex min-h-[300px] flex-col p-6">
      <div className="flex items-baseline justify-between gap-3">
        <Eyebrow>По версиям</Eyebrow>
        {points.length > 1 && <span className="text-caption text-lab-mute">полоса — где доля может быть на самом деле</span>}
      </div>
      {points.length > 1 ? (
        <div className="mt-3 min-h-[220px] flex-1"><Trend points={points} selectedId={scope.finished?.id} onPick={onPick} fill /></div>
      ) : (
        <div className="flex flex-1 flex-col items-start justify-center gap-3 pt-4">
          <p className="max-w-[360px] text-body text-lab-mute">
            {points.length ? "Пока проверена одна версия. Поправьте агента и проверьте снова: здесь появится динамика и сравнение."
              : state.cards?.cards.length ? "Версии агента ещё не проверялись на симуляторе." : "Чтобы проверять версии агента до выкладки, соберите из логов сценарии для симулятора клиента."}
          </p>
          {state.cards?.cards.length ? <Button icon={Play} onClick={onRun}>Проверить версию</Button> : <Button onClick={() => go("/lab/checks")}>Собрать сценарии</Button>}
        </div>
      )}
    </Panel>
  );
}

/** Trust is a property of the number, so it sits right under it: the level in words, why, and the facts behind it. */
function TrustStrip({ scope, go }: { scope: Scope; go: Go }) {
  const trust = trustStory(scope.finished, scope.interval);
  if (!trust) return null;
  const hue: Hue = trust.level === "ok" ? "ok" : "warn";
  return (
    <Panel className="mt-4 px-5 py-4">
      <div className="flex flex-wrap items-start gap-3">
        <span className={cn("mt-0.5 inline-flex size-7 flex-shrink-0 items-center justify-center rounded-full", HUE[hue].bgStrong, HUE[hue].text)}><ShieldCheck className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-body font-semibold text-lab-ink">{trust.label}</div>
          <div className="max-w-[720px] text-body text-lab-mute">{trust.reason}</div>
        </div>
        {trust.level !== "ok" && <Button onClick={() => go("/lab/judge/check")}>Сверить судью</Button>}
      </div>
      <div className="mt-4 grid gap-x-6 gap-y-3 border-t border-lab-line pt-4 sm:grid-cols-2 lg:grid-cols-4">
        {trust.facts.map(f => (
          <div key={f.id} className="min-w-0" title={f.hint}>
            <div className="text-caption text-lab-mute">{f.label}</div>
            <div className={cn("mt-0.5 text-body font-medium tabular-nums", f.hue === "mute" ? "text-lab-text" : HUE[f.hue].text)}>{f.value}</div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function Observations({ scope, state, go }: { scope: Scope; state: LabState; go: Go }) {
  const list = observationsOf(scope, state).slice(0, 6);
  if (!list.length) return null;
  return (
    <Section title="Что важно в этой версии">
      <Panel>
        {list.map((o, k) => (
          <button
            key={o.id} onClick={() => o.to && go(o.to)} disabled={!o.to}
            className={cn("lab-focus-inset group flex w-full items-start gap-3 px-5 py-3.5 text-left transition-colors duration-100 hover:bg-lab-raised/60", k > 0 && "border-t border-lab-line")}
          >
            <span className={cn("mt-[7px] size-2 flex-shrink-0 rounded-full", HUE[o.hue].solid)} />
            <span className="min-w-0 flex-1 text-reading text-lab-text">{o.text}</span>
            {o.cta && <span className="mt-0.5 inline-flex flex-shrink-0 items-center gap-1 text-body text-lab-mute transition-colors duration-100 group-hover:text-lab-ink">{o.cta}<ArrowRight className="size-3.5" /></span>}
          </button>
        ))}
      </Panel>
    </Section>
  );
}

const CHANGE_TAG: Record<string, { hue: Hue; text: string }> = { new: { hue: "bad", text: "новое" }, fixed: { hue: "ok", text: "исправлено" }, remains: { hue: "mute", text: "осталось" } };

/** The criteria that break, worst first; the rest are one click away. */
function Breaking({ scope, go }: { scope: Scope; go: Go }) {
  const logsOnly = !scope.sims.length;
  const t = (c: Compared) => (logsOnly ? c.criterion.by.log : c.criterion.by.sim);
  const rows = useMemo(() => scope.compared
    .filter(c => t(c).failed > 0 || c.change === "fixed")
    .sort((a, b) => (a.change === "new" ? 0 : 1) - (b.change === "new" ? 0 : 1) || (a.change === "fixed" ? 1 : 0) - (b.change === "fixed" ? 1 : 0) || t(b).failed - t(a).failed)
    .slice(0, 6), [scope.compared, logsOnly]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = scope.compared.length;
  if (!rows.length) return null;
  return (
    <Section
      title="Что нарушается"
      hint={logsOnly ? "По реальным диалогам" : `В диалогах симулятора версии ${scope.finished?.version ?? ""}`}
      right={<LinkButton onClick={() => go("/lab/criteria")}>Все критерии · {total}<ArrowRight className="size-3.5" /></LinkButton>}
    >
      <Panel>
        {rows.map((c, k) => {
          const tally = t(c);
          const n = tally.failed + tally.passed;
          const spark = scope.history(c.criterion.key).filter((v): v is number => v !== null);
          const tag = c.change ? CHANGE_TAG[c.change] : null;
          return (
            <button
              key={c.criterion.key} onClick={() => go(`/lab/criteria/${encodeURIComponent(c.criterion.key)}`)}
              className={cn("lab-focus-inset flex w-full items-center gap-4 px-5 py-3.5 text-left transition-colors duration-100 hover:bg-lab-raised/60", k > 0 && "border-t border-lab-line")}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-reading font-medium text-lab-ink">{c.criterion.title}</span>
                {c.criterion.quote && <span className="mt-0.5 block truncate text-caption text-lab-mute">«{c.criterion.quote}»</span>}
              </span>
              {tag && <Badge hue={tag.hue} className="hidden sm:inline-flex">{tag.text}</Badge>}
              <span className="hidden w-[150px] flex-shrink-0 md:block">
                {c.change === "fixed" && !tally.failed ? <span className="text-body text-lab-mute">нигде не нарушен</span> : (
                  <>
                    <span className="block text-body tabular-nums text-lab-text"><b className="font-semibold text-lab-ink">{tally.failed}</b> из {n}</span>
                    <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-white/[0.07]"><span className="block h-full rounded-full bg-lab-bad/70" style={{ width: `${n ? (100 * tally.failed) / n : 0}%` }} /></span>
                  </>
                )}
              </span>
              <span className="hidden w-[64px] flex-shrink-0 lg:block">{spark.length > 1 && <Sparkline values={spark} hue={c.change === "new" ? "bad" : c.change === "fixed" ? "ok" : undefined} />}</span>
            </button>
          );
        })}
      </Panel>
    </Section>
  );
}

/** Who the agent fails: the share per customer type, worst named. */
function Customers({ scope, state }: { scope: Scope; state: LabState }) {
  const rows = state.personas.map(p => {
    const own = scope.sims.filter(d => d.persona === p.id && (d.status === "PASS" || d.status === "FAIL"));
    const clean = own.filter(d => d.status === "PASS").length;
    return { p, n: own.length, clean, share: own.length ? Math.round((100 * clean) / own.length) : null };
  }).filter(r => r.n > 0);
  if (rows.length < 2) return null;
  const best = Math.max(...rows.map(r => r.share ?? 0));
  return (
    <Section title="По типам клиентов" hint="Суть обращения та же, меняется манера письма">
      <Panel className="px-5 py-4">
        <div className="grid grid-cols-[minmax(0,160px)_1fr_auto] items-center gap-x-4 gap-y-3">
          {rows.map(r => {
            const weak = r.share !== null && best - r.share >= 15;
            return (
              <div key={r.p.id} className="contents">
                <span className="truncate text-body text-lab-text" title={r.p.note}>{r.p.name}</span>
                <span className="h-1.5 overflow-hidden rounded-full bg-white/[0.07]"><span className={cn("block h-full rounded-full", weak ? "bg-lab-warn" : "bg-lab-mute")} style={{ width: `${r.share ?? 0}%` }} /></span>
                <span className="w-[112px] text-right text-body tabular-nums text-lab-text"><b className={cn("font-semibold", weak ? "text-lab-warn" : "text-lab-ink")}>{r.share}%</b> · {r.clean} из {r.n}</span>
              </div>
            );
          })}
        </div>
      </Panel>
    </Section>
  );
}

/** The real logs: how the agent in production does, apart from any version. */
function RealDialogs({ scope, state, go }: { scope: Scope; state: LabState; go: Go }) {
  const d = state.discover;
  if (!d || !scope.sims.length) return null;
  const s = scope.log;
  const patterns = [...(d.summary.patterns ?? [])].sort((a, b) => b.count - a.count).slice(0, 3);
  return (
    <Section title="Реальные диалоги" hint="Записанные разговоры агента в проде: судья читает их без запуска агента" right={<LinkButton onClick={() => go("/lab/logs")}>К логам<ArrowRight className="size-3.5" /></LinkButton>}>
      <Panel className="grid gap-6 p-5 md:grid-cols-[220px_1fr]">
        <div>
          <div className="text-display font-semibold tabular-nums text-lab-ink">{s.share ?? "—"}%</div>
          <div className="text-caption text-lab-mute">без нарушений · {s.clean} из {s.measured}</div>
          <div className="mt-1 text-caption text-lab-faint">оценены {whenLong(d.finishedAt)}</div>
        </div>
        {patterns.length > 0 && (
          <div className="min-w-0">
            <Eyebrow className="mb-2">Чаще всего в реальных диалогах</Eyebrow>
            <ol className="space-y-2">
              {patterns.map(p => (
                <li key={p.rule} className="flex items-baseline gap-3">
                  <span className="min-w-0 flex-1 text-body text-lab-text">{p.rule}</span>
                  <span className="flex-shrink-0 text-body tabular-nums text-lab-mute">{count(p.count, "диалог", "диалога", "диалогов")}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </Panel>
    </Section>
  );
}

const STEP_ICON: Record<string, LucideIcon> = { agent: Bot, logs: FileText, checks: FlaskConical };
const STEP_GIVES: Record<string, string> = { agent: "критерии из промптов", logs: "нарушения в реальных диалогах", checks: "вердикт по версии" };

/** First run: what the Lab does in one sentence, and the three steps to the first verdict, the next one highlighted. */
function FirstRun({ state, go }: { state: LabState; go: Go }) {
  const steps = setupSteps(state);
  const next = steps.findIndex(s => !s.done);
  return (
    <div className="pt-14">
      <LabMark size={32} className="text-lab-ink" />
      <h2 className="mt-5 max-w-[720px] text-balance text-display font-semibold text-lab-ink">Agent Lab проверяет, соблюдает ли ИИ-агент свои же правила, и стала ли новая версия лучше</h2>
      <p className="mt-3 max-w-[680px] text-pretty text-lead text-lab-text">Критерии берутся из промптов агента, судья читает диалоги и подтверждает каждое нарушение цитатой. Три шага до первой оценки:</p>
      <ol className="mt-8 grid gap-3 md:grid-cols-3">
        {steps.map((s, i) => {
          const Icon = STEP_ICON[s.id] ?? Bot;
          const current = i === next;
          return (
            <li key={s.id} className={cn("flex flex-col rounded-xl border p-5", current ? "border-lab-strong bg-lab-card" : "border-lab-line bg-lab-panel", s.done && "opacity-70")}>
              <div className="flex items-center gap-2.5">
                <span className={cn("inline-flex size-6 items-center justify-center rounded-full text-caption font-semibold tabular-nums", s.done ? "bg-lab-ok/15 text-lab-ok" : current ? "bg-lab-ink text-lab-canvas" : "border border-lab-strong text-lab-mute")}>{s.done ? "✓" : i + 1}</span>
                <Icon className="size-4 text-lab-mute" />
              </div>
              <div className="mt-4 text-reading font-semibold text-lab-ink">{s.label}</div>
              <div className="mt-1 flex-1 text-body text-lab-mute">{s.hint}</div>
              <div className="mt-4 text-caption text-lab-mute">Даёт: <span className="text-lab-text">{STEP_GIVES[s.id]}</span></div>
              {!s.done && <Button className="mt-4 self-start" variant={current ? "primary" : "secondary"} onClick={() => go(s.to)}>{s.cta}</Button>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The version's verdict: the first thing a person opening the Lab sees. */
export function OverviewView({ state, scope, go, onPick, onRun }: { state: LabState; scope: Scope; go: Go; onPick: (id: string) => void; onRun: () => void }) {
  if (scope.empty && !state.runs.length) return <Page title="Сводка"><FirstRun state={state} go={go} /></Page>;
  if (!scope.ready) {
    return (
      <Page title="Сводка">
        <Skeleton className="mt-12 h-9 w-2/3" /><Skeleton className="mt-4 h-5 w-1/2" />
        <div className="mt-8 grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]"><Skeleton className="h-[300px]" /><Skeleton className="h-[300px]" /></div>
        <Skeleton className="mt-4 h-[76px]" />
      </Page>
    );
  }
  const verdict = verdictOf(scope);
  return (
    <Page title="Сводка">
      <Headline verdict={verdict} scope={scope} />
      <div className="mt-8 grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
        <Score scope={scope} go={go} />
        <Versions scope={scope} state={state} go={go} onPick={onPick} onRun={onRun} />
      </div>
      <TrustStrip scope={scope} go={go} />
      <Observations scope={scope} state={state} go={go} />
      <Breaking scope={scope} go={go} />
      <Customers scope={scope} state={state} />
      <RealDialogs scope={scope} state={state} go={go} />
    </Page>
  );
}
