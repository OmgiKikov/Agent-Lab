import { useMemo } from "react";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { ENOUGH_CHECKED, judgeErrors, MIN_CHECKED } from "../findings";
import { count, pct } from "../format";
import { disputed } from "../logic";
import { HUE, type Hue } from "../look";
import { trustStory } from "../story";
import { wilson } from "../stats";
import type { Item, LabRun, LabState } from "../types";
import { useRunContext } from "../useRunContext";
import { Badge, Button, EmptyState, Kbd, Page, Panel, Section, Skeleton } from "../ui";

/** What can be measured about the customer simulator from the conversations it played. */
function simulatorFigures(items: Item[]) {
  let words = 0, replies = 0, offered = 0, pressed = 0;
  for (const item of items) {
    item.conversation.forEach((m, k) => {
      if (m.role !== "customer" || k === 0) return;
      replies++;
      words += m.text.trim().split(/\s+/).filter(Boolean).length;
      const before = item.conversation[k - 1];
      if (before?.role === "agent" && before.options?.length) { offered++; if (before.options.includes(m.text)) pressed++; }
    });
  }
  return { replies, avgWords: replies ? Math.round((words / replies) * 10) / 10 : null, offered, pressedShare: offered ? pct(pressed, offered) : null };
}

/** Criteria on which the two judges decide differently in the same dialogue: where the judge's instructions are ambiguous. */
function judgeSplits(items: Item[]) {
  const by = new Map<string, { rule: string; both: number; split: number }>();
  for (const item of items) {
    const second = new Map((item.second?.rules ?? []).map(r => [r.ruleId, r.status]));
    if (!second.size) continue;
    for (const r of item.rules) {
      const other = second.get(r.ruleId);
      if (!other || (r.status !== "PASS" && r.status !== "FAIL") || (other !== "PASS" && other !== "FAIL")) continue;
      const row = by.get(r.rule) ?? { rule: r.rule, both: 0, split: 0 };
      row.both++;
      if (other !== r.status) row.split++;
      by.set(r.rule, row);
    }
  }
  return [...by.values()].filter(r => r.split > 0).sort((a, b) => b.split / b.both - a.split / a.both || b.split - a.split);
}

/** A measure as a bullet bar: the value, a tick at the target, the words for what it means. */
function Measure({ label, value, share, target, hue, children }: { label: string; value: string; share: number | null; target?: number; hue: Hue; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-caption font-medium text-lab-mute">{label}</div>
      <div className={cn("mt-1 text-title font-semibold tabular-nums", share === null ? "text-lab-faint" : hue === "mute" ? "text-lab-ink" : HUE[hue].text)}>{value}</div>
      <div className="relative mt-3 h-1.5 rounded-full bg-white/[0.07]" aria-hidden>
        {share !== null && <div className={cn("h-full rounded-full", hue === "mute" ? "bg-lab-mute" : HUE[hue].solid)} style={{ width: `${Math.max(2, 100 * share)}%` }} />}
        {target !== undefined && <span className="absolute -top-1 h-3.5 w-px bg-lab-ink/70" style={{ left: `${100 * target}%` }} />}
      </div>
      <p className="mt-2 text-caption text-lab-mute">{children}</p>
    </div>
  );
}

const shareHue = (s: number | null, good = 0.8): Hue => (s === null ? "mute" : s >= good ? "ok" : s >= good - 0.2 ? "warn" : "bad");

/** «Можно ли верить числу?»: the level in words, the three measures behind it, and the way to raise it — a person checking the judge. */
export function TrustView({ state, run, onJudge }: { state: LabState; run: LabRun | null; onJudge: (runId: string) => void }) {
  const { finished } = useRunContext(state, run);
  const items = useMemo(() => finished?.items ?? [], [finished]);
  const errors = useMemo(() => judgeErrors(items), [items]);
  const splits = useMemo(() => judgeSplits(items), [items]);
  const sim = useMemo(() => simulatorFigures(items), [items]);

  if (!state.runs.length) {
    return <Page title="Доверие"><EmptyState className="mt-10" title="Пока нечего проверять">Доверие к оценке меряется на диалогах симулятора: сверка судьи с человеком, второй судья, повторы. Проверьте версию агента хотя бы раз.</EmptyState></Page>;
  }
  if (!finished?.metric) return <Page title="Доверие"><Skeleton className="mt-12 h-9 w-2/3" /><Skeleton className="mt-8 h-[180px]" /></Page>;

  const m = finished.metric;
  const measured = m.measured;
  const trust = trustStory(finished, measured ? wilson(m.passed, measured) : null)!;
  const left = items.filter(i => (i.status === "PASS" || i.status === "FAIL") && !i.review).length;
  const disputes = items.filter(disputed).length;
  const human = m.human?.reviewed ? m.human.agree / m.human.reviewed : null;
  const humanShown = (m.human?.reviewed ?? 0) >= MIN_CHECKED ? human : null;
  const second = m.secondJudge?.checked ? m.secondJudge.agree / m.secondJudge.checked : null;
  const repeats = m.repeats?.scenarios ? m.repeats.stable / m.repeats.scenarios : null;
  const hue: Hue = trust.level === "ok" ? "ok" : "warn";

  return (
    <Page title="Доверие">
      <header className="pt-10">
        <div className="text-body text-lab-mute">Версия {finished.version} · {count(measured, "оценённый диалог", "оценённых диалога", "оценённых диалогов")}</div>
        <h2 className="mt-3 flex items-start gap-3 text-balance text-display font-semibold text-lab-ink">
          <span className={cn("mt-0.5 inline-flex size-8 flex-shrink-0 items-center justify-center rounded-full", HUE[hue].bgStrong, HUE[hue].text)}><ShieldCheck className="size-[18px]" /></span>
          <span>{trust.label}</span>
        </h2>
        <p className="mt-3 max-w-[760px] text-pretty text-lead text-lab-text">{trust.reason}</p>
      </header>

      <Panel className="mt-8 grid gap-x-8 gap-y-6 p-6 md:grid-cols-3">
        <Measure label="Судья сверен с человеком" hue={humanShown === null ? "warn" : shareHue(humanShown)} target={0.8} share={humanShown}
          value={humanShown === null ? "—" : `прав в ${Math.round(100 * humanShown)}%`}>
          {(m.human?.reviewed ?? 0) < MIN_CHECKED
            ? `Проверено ${m.human?.reviewed ?? 0} из ${m.total}. Процент появится после ${MIN_CHECKED} проверок, надёжен после ${ENOUGH_CHECKED}.`
            : `Проверено ${m.human!.reviewed} из ${m.total}; цель — ${ENOUGH_CHECKED} проверок и не меньше 80% верных.`}
        </Measure>
        <Measure label="Второй судья согласен" hue={shareHue(second)} target={0.8} share={second}
          value={second === null ? "—" : `в ${Math.round(100 * second)}%`}>
          {m.secondJudge?.checked ? `${m.secondJudge.agree} из ${m.secondJudge.checked} диалогов · модель другого вендора` : "Второй судья этих диалогов не проверял."}
        </Measure>
        <Measure label="Устойчивость на повторах" hue={shareHue(repeats, 0.9)} target={0.9} share={repeats}
          value={repeats === null ? "—" : `${m.repeats!.stable} из ${m.repeats!.scenarios}`}>
          {repeats === null ? "Повторов не было. Добавьте 2–3 повтора при следующей проверке версии." : "Сценарии, где все повторы дали один и тот же результат."}
        </Measure>
      </Panel>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button variant="primary" disabled={!left && !!m.human?.reviewed} onClick={() => onJudge(finished.id)}>
          {m.human?.reviewed ? `Продолжить сверку · осталось ${left}` : "Сверить судью"}<ArrowRight className="size-3.5" />
        </Button>
        <span className="inline-flex items-center gap-1.5 text-body text-lab-mute">Спорные идут первыми · ответ клавишами <Kbd>1</Kbd><Kbd>2</Kbd></span>
      </div>

      {(errors.length > 0 || splits.length > 0 || disputes > 0) && (
        <div className="grid gap-x-8 lg:grid-cols-2">
          <Section title="Где судья ошибается" hint={errors.length ? "По сверке с человеком" : "Появится после сверки с человеком"}>
            {errors.length ? (
              <Panel>
                {errors.slice(0, 6).map((e, k) => (
                  <div key={e.rule} className={cn("flex items-center gap-3 px-4 py-3", k > 0 && "border-t border-lab-line")}>
                    <span className="min-w-0 flex-1 text-body text-lab-text">{e.rule}</span>
                    <Badge hue={e.wrong / e.checked >= 0.3 ? "bad" : e.wrong ? "warn" : "ok"}>{e.wrong ? `неверно ${e.wrong} из ${e.checked}` : `верно ${e.checked} из ${e.checked}`}</Badge>
                  </div>
                ))}
              </Panel>
            ) : <Panel className="px-4 py-5 text-body text-lab-mute">Ни одного вердикта ещё не сверили — сравнивать не с чем.</Panel>}
          </Section>
          <Section title="Где судьи расходятся" hint={disputes ? `${count(disputes, "диалог", "диалога", "диалогов")} с разными вердиктами` : "Судьи решают одинаково"}>
            {splits.length ? (
              <Panel>
                {splits.slice(0, 6).map((r, k) => (
                  <div key={r.rule} className={cn("flex items-center gap-3 px-4 py-3", k > 0 && "border-t border-lab-line")}>
                    <span className="min-w-0 flex-1 text-body text-lab-text">{r.rule}</span>
                    <Badge hue="warn">{r.split} из {r.both}</Badge>
                  </div>
                ))}
              </Panel>
            ) : <Panel className="px-4 py-5 text-body text-lab-mute">{disputes ? "Судьи расходятся в итоге диалога, но не по отдельным критериям." : "Расхождений нет."}</Panel>}
          </Section>
        </div>
      )}

      <div className="grid gap-x-8 lg:grid-cols-2">
        <Section title="Похож ли симулятор на клиентов" hint="Что можно измерить по сыгранным диалогам">
          <Panel>
            {([
              ["Слов в реплике клиента", sim.avgWords === null ? "—" : String(sim.avgWords).replace(".", ",")],
              ["Нажимает кнопку, если она есть", sim.pressedShare === null ? "—" : `${sim.pressedShare}%`],
              ["Реплик клиента сыграно", String(sim.replies)],
            ] as const).map(([label, value], k) => (
              <div key={label} className={cn("flex items-center justify-between gap-3 px-4 py-3 text-body", k > 0 && "border-t border-lab-line")}>
                <span className="text-lab-text">{label}</span>
                <span className="tabular-nums text-lab-ink">{value}</span>
              </div>
            ))}
            <div className="border-t border-lab-line px-4 py-3 text-caption text-lab-mute">Сравнить с настоящими клиентами пока нельзя: из логов берутся только первые реплики.</div>
          </Panel>
        </Section>
        <Section title="Кто оценивал" hint={`Запросы идут через ${state.models.via}`}>
          <Panel>
            {([["Судья", state.models.main], ["Второй судья", state.models.second], ["Клиент-симулятор", state.models.main]] as const).map(([role, model], k) => (
              <div key={role} className={cn("flex items-center justify-between gap-3 px-4 py-3 text-body", k > 0 && "border-t border-lab-line")}>
                <span className="text-lab-text">{role}</span>
                <span className="truncate font-mono text-caption text-lab-mute">{model ?? "новейшая из каталога"}</span>
              </div>
            ))}
          </Panel>
        </Section>
      </div>
    </Page>
  );
}
