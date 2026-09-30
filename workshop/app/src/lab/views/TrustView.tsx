import { useMemo } from "react";
import { ArrowRight, Scale } from "lucide-react";
import { ENOUGH_CHECKED, judgeErrors, MIN_CHECKED } from "../findings";
import { count } from "../format";
import { disputed } from "../logic";
import type { Hue } from "../look";
import { trustStory } from "../story";
import { wilson } from "../stats";
import type { Item, LabRun, LabState } from "../types";
import { useRunContext } from "../useRunContext";
import { Button, EmptyState, Kbd, Label, Page, Section, Skeleton, Stat, Strip, Verdict } from "../ui";

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

const shareHue = (s: number | null, good = 0.8): Hue | undefined => (s === null ? undefined : s >= good ? "ok" : s >= good - 0.2 ? "warn" : "bad");

/** A list of criteria with one number each: where the judge goes wrong, or where the two judges disagree. */
function Rows({ rows, empty }: { rows: { rule: string; value: string; hue: Hue }[]; empty: string }) {
  if (!rows.length) return <p className="rounded-lg border border-lab-line px-4 py-4 text-body text-lab-mute">{empty}</p>;
  return (
    <div className="divide-y divide-lab-line rounded-lg border border-lab-line bg-lab-panel">
      {rows.map(r => (
        <div key={r.rule} className="flex items-center gap-3 px-4 py-2.5">
          <span className="min-w-0 flex-1 text-body text-lab-text">{r.rule}</span>
          <Verdict hue={r.hue}>{r.value}</Verdict>
        </div>
      ))}
    </div>
  );
}

/** «Можно ли верить числу?»: the level in words, the measures behind it, and the way to raise it — a person checking the judge. */
export function TrustView({ state, run, onJudge }: { state: LabState; run: LabRun | null; onJudge: (runId: string) => void }) {
  const { finished } = useRunContext(state, run);
  const items = useMemo(() => finished?.items ?? [], [finished]);
  const errors = useMemo(() => judgeErrors(items), [items]);
  const splits = useMemo(() => judgeSplits(items), [items]);

  if (!state.runs.length) {
    return <Page title="Судья" icon={Scale}><EmptyState icon={Scale} title="Пока нечего проверять">Доверие к оценке меряется на диалогах симулятора: сверка с человеком, второй судья, повторы. Проверьте версию агента хотя бы раз.</EmptyState></Page>;
  }
  if (!finished?.metric) return <Page title="Судья" icon={Scale}><Skeleton className="mt-10 h-5 w-32" /><Skeleton className="mt-4 h-9 w-2/3" /><Skeleton className="mt-8 h-[104px]" /></Page>;

  const m = finished.metric;
  const trust = trustStory(finished, m.measured ? wilson(m.passed, m.measured) : null)!;
  const left = items.filter(i => (i.status === "PASS" || i.status === "FAIL") && !i.review).length;
  const disputes = items.filter(disputed).length;
  const reviewed = m.human?.reviewed ?? 0;
  const human = reviewed >= MIN_CHECKED ? m.human!.agree / reviewed : null;
  const second = m.secondJudge?.checked ? m.secondJudge.agree / m.secondJudge.checked : null;
  const repeats = m.repeats?.scenarios ? m.repeats.stable / m.repeats.scenarios : null;
  const chip = trust.level === "ok" ? { text: "можно верить", hue: "ok" as const } : trust.level === "partial" ? { text: "условно", hue: "warn" as const } : { text: "предварительно", hue: "warn" as const };

  return (
    <Page
      title="Судья" icon={Scale}
      primary={<Button variant="primary" disabled={!left && !!m.human?.reviewed} onClick={() => onJudge(finished.id)}>{reviewed ? `Продолжить сверку · ${left}` : "Сверить судью"}<ArrowRight className="size-3.5" /></Button>}
    >
      <header className="pt-10">
        <Verdict hue={chip.hue}>{chip.text}</Verdict>
        <h2 className="mt-4 text-balance text-display font-medium text-lab-ink">{trust.label}.</h2>
        <p className="mt-2 max-w-[760px] text-pretty text-lead text-lab-soft">{trust.reason}</p>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-caption text-lab-mute">
          <span className="inline-flex items-center gap-2"><Label>Версия</Label>{finished.version} · {count(m.measured, "оценённый диалог", "оценённых диалога", "оценённых диалогов")}</span>
          <span className="inline-flex items-center gap-2"><Label>Сверка</Label>спорные первыми, ответ клавишами <Kbd>1</Kbd><Kbd>2</Kbd></span>
        </div>
      </header>

      <Strip className="mt-8">
        <Stat label="Сверено с человеком" value={`${reviewed}`} hue={reviewed < MIN_CHECKED ? "warn" : undefined}
          sub={reviewed < ENOUGH_CHECKED ? `из ${m.total} · цель ${ENOUGH_CHECKED}` : `из ${m.total}`} onClick={() => onJudge(finished.id)} />
        <Stat label="Судья прав" value={human === null ? "—" : `${Math.round(100 * human)}%`} hue={shareHue(human)}
          sub={human === null ? `процент появится после ${MIN_CHECKED} сверок` : `в ${m.human!.agree} из ${reviewed} сверенных`} />
        <Stat label="Второй судья согласен" value={second === null ? "—" : `${Math.round(100 * second)}%`} hue={shareHue(second)}
          sub={m.secondJudge?.checked ? `${m.secondJudge.agree} из ${m.secondJudge.checked} · другой вендор` : "не проверял эти диалоги"} />
        <Stat label="Стабильно на повторах" value={repeats === null ? "—" : `${m.repeats!.stable} из ${m.repeats!.scenarios}`} hue={shareHue(repeats, 0.9)}
          sub={repeats === null ? "повторов не было" : "сценариев с одним результатом"} />
      </Strip>

      <div className="grid gap-x-8 lg:grid-cols-2">
        <Section title="Где судья ошибается" count={errors.filter(e => e.wrong).length || undefined} hint={errors.length ? "по сверке с человеком" : undefined}>
          <Rows
            rows={errors.slice(0, 8).map(e => ({ rule: e.rule, value: e.wrong ? `неверно ${e.wrong} из ${e.checked}` : `верно ${e.checked} из ${e.checked}`, hue: e.wrong / e.checked >= 0.3 ? "bad" : e.wrong ? "warn" : "ok" }))}
            empty="Ни один вердикт ещё не сверен с человеком."
          />
        </Section>
        <Section title="Где судьи расходятся" count={disputes || undefined} hint={disputes ? count(disputes, "диалог", "диалога", "диалогов") : undefined}>
          <Rows
            rows={splits.slice(0, 8).map(r => ({ rule: r.rule, value: `${r.split} из ${r.both}`, hue: "warn" }))}
            empty={disputes ? "Судьи расходятся в итоге диалога, но не по отдельным критериям." : "Расхождений нет."}
          />
        </Section>
      </div>

      <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-lab-line pt-4 text-caption text-lab-mute">
        <span className="inline-flex items-center gap-2"><Label>Судья и клиент</Label><span className="font-mono">{state.models.main ?? "новейшая из каталога"}</span></span>
        <span className="inline-flex items-center gap-2"><Label>Второй судья</Label><span className="font-mono">{state.models.second ?? "новейшая из каталога"}</span></span>
        <span className="inline-flex items-center gap-2"><Label>Через</Label>{state.models.via}</span>
      </div>
    </Page>
  );
}
