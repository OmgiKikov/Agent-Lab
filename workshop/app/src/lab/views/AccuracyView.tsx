import { useMemo, useState } from "react";
import NumberFlow from "@number-flow/react";
import { Download, Quote as QuoteIcon, Repeat, ShieldCheck, UserCheck, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Heatmap } from "../charts/Heatmap";
import { Sparkline } from "../charts/Sparkline";
import { Trend, type TrendPoint } from "../charts/Trend";
import { day, pct, plural, when } from "../format";
import { failureReasons, itemKey, passShare, previousOf, scenariosOfRun, typesOfRun, unitOf } from "../logic";
import { HUE, type Hue } from "../look";
import { download, report } from "../report";
import type { Item, LabRun, LabState } from "../types";
import { useRunDetails } from "../useLab";
import { Badge, Button, Delta, Eyebrow, Page, Panel, Section, StackBar, titleFont } from "../ui";

function Trust({ icon: Icon, label, value, sub, ok }: { icon: LucideIcon; label: string; value: string; sub?: string; ok?: boolean }) {
  const hue: Hue = ok === undefined ? "mute" : ok ? "ok" : "warn";
  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      <span className={cn("mt-0.5 flex size-7 flex-shrink-0 items-center justify-center rounded-md", HUE[hue].bg, HUE[hue].text)}><Icon className="size-3.5" /></span>
      <div className="min-w-0">
        <div className="text-[12px] leading-snug text-lab-text"><span className="text-lab-dim">{label}.</span> {value}</div>
        {sub && <div className="mt-0.5 text-[11px] leading-snug text-lab-dim">{sub}</div>}
      </div>
    </div>
  );
}

function Figure({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div>
      <div className="text-[11px] text-lab-dim">{label}</div>
      <div className="mt-1.5 flex min-h-[24px] items-center text-[20px] font-medium leading-none text-lab-ink" style={titleFont}>{value}</div>
      {sub && <div className="mt-1.5 font-mono text-[10px] text-lab-dim">{sub}</div>}
    </div>
  );
}

/** Scenarios that got better or worse against the previous run of the same agent. */
function compareRuns(items: Item[], previousItems: Item[]) {
  const better: string[] = [], worse: string[] = [];
  let same = 0;
  for (const { id, name } of scenariosOfRun(items)) {
    const now = passShare(items, id), before = passShare(previousItems, id);
    if (now === null || before === null || now === before) { same++; continue; }
    (now > before ? better : worse).push(name);
  }
  return { better, worse, same };
}

/** The answer to «what do I fix»: the criteria failed most often, and what moved since the last run. */
function WhatToFix({ items, previous, previousItems }: { items: Item[]; previous: LabRun | null; previousItems: Item[] | null }) {
  const top = failureReasons(items).slice(0, 5);
  const max = Math.max(1, ...top.map(t => t[1]));
  const change = previous && previousItems ? compareRuns(items, previousItems) : null;
  return (
    <Panel className="flex flex-col">
      <div className="px-5 pt-4">
        <div className="text-[14px] font-medium text-lab-text">Что чинить</div>
        <div className="mt-0.5 text-[11px] text-lab-dim">Критерии, которые агент нарушает чаще всего</div>
      </div>
      <div className="flex-1 space-y-3.5 px-5 pb-4 pt-4">
        {top.map(([rule, n], i) => (
          <div key={rule}>
            <div className="flex items-start justify-between gap-4 text-[12px] leading-snug text-lab-text">
              <span><span className="mr-2 font-mono text-[11px] text-lab-dim">{i + 1}</span>{rule}</span>
              <span className="flex-shrink-0 font-mono text-[11px] text-lab-dim">{n} {plural(n, "раз", "раза", "раз")}</span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/[0.07]"><div className="h-full rounded-full bg-lab-bad" style={{ width: `${pct(n, max)}%` }} /></div>
          </div>
        ))}
        {!top.length && <div className="text-[12px] text-lab-dim">Провалов нет: агент выполнил все критерии.</div>}
      </div>
      <div className="border-t border-white/[0.06] px-5 py-3 text-[11px]">
        {!previous && <span className="text-lab-dim">Это первый прогон этого агента: сравнивать пока не с чем.</span>}
        {previous && !change && <span className="text-lab-dim">Загружаю {previous.version} для сравнения…</span>}
        {change && (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-lab-mute">
              <span className="text-lab-dim">Против {previous!.version}:</span>
              <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-lab-ok" />лучше {change.better.length}</span>
              <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-lab-bad" />хуже {change.worse.length}</span>
              <span className="text-lab-dim">без изменений {change.same}</span>
            </div>
            {change.worse.length > 0 && <div className="leading-snug text-lab-bad">Стало хуже: {change.worse.slice(0, 4).join(", ")}{change.worse.length > 4 ? ` и ещё ${change.worse.length - 4}` : ""}</div>}
          </div>
        )}
      </div>
    </Panel>
  );
}

export function AccuracyView({ state, run: selected, onPickRun, onOpen }: { state: LabState; run: LabRun | null; onPickRun: (id: string) => void; onOpen: (key: string) => void }) {
  const [compare, setCompare] = useState(false);
  const history = useMemo(() => state.runs.filter(r => r.metric && r.metric.total && r.status !== "running"), [state.runs]);
  const deck = state.cards?.cards ?? [];

  // While a run is still going, the number shown is the last finished run's.
  const head = selected?.metric?.total && selected.status !== "running" ? selected : history[0];
  const sameAgent = useMemo(
    () => (head ? history.filter(r => r.target === head.target).sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1)).slice(-12) : []),
    [history, head],
  );
  const recent = sameAgent.slice(-5);
  const previous = head ? previousOf(state.runs, head) : null;
  const details = useRunDetails([...(head ? [head] : []), ...(previous ? [previous] : []), ...recent]);
  const finished: LabRun | null = head ? (head.items ? head : details(head)) : null;
  if (!finished?.metric || !finished.metric.total) {
    return <Page title="точность агента" lede={history.length ? "Загружаю прогон…" : "Сначала прогоните сценарии на агенте: точность считается по результатам прогонов."} />;
  }
  const m = finished.metric;
  const items = finished.items ?? [];
  const previousItems = previous ? details(previous)?.items ?? null : null;
  const delta = previous?.metric?.accuracy != null && m.accuracy != null ? m.accuracy - previous.metric.accuracy : null;
  const unit = unitOf(items);
  const of = unit === "разговоров" ? plural(m.measured, "разговора", "разговоров", "разговоров") : plural(m.measured, "сценария", "сценариев", "сценариев");
  const types = typesOfRun(finished, state.personas);

  const points: TrendPoint[] = sameAgent.map(r => ({
    id: r.id, value: r.metric!.accuracy ?? 0, label: day(r.startedAt), title: `${r.version} · ${when(r.startedAt)}`, sub: `${r.metric!.passed} из ${r.metric!.measured} пройдено`,
  }));
  const best = points.reduce((a, b) => (b.value > a.value ? b : a), points[0]);

  return (
    <Page
      wide title="точность агента"
      lede="Доля разговоров, в которых агент выполнил все критерии сценария. Разговоры со статусом «не измерено» в расчёт не входят."
      actions={<Button size="sm" icon={Download} title="Точность, матрица и причины провалов одним файлом Markdown" onClick={() => download(`agent-lab-${finished.version}.md`, report(finished, state.personas, previous))}>Скачать отчёт</Button>}
    >
      <div className="mt-5 grid gap-4 min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <Panel className="p-5">
          <Eyebrow>{finished.targetName} · {finished.version} · {when(finished.startedAt)}</Eyebrow>
          <div className="mt-2 flex flex-wrap items-end gap-x-4 gap-y-2" style={titleFont}>
            <div className="flex items-baseline text-lab-ink">
              <span className="text-[88px] leading-[0.95] tracking-tight"><NumberFlow value={m.accuracy ?? 0} /></span>
              <span className="ml-1 text-[32px] text-lab-mute">%</span>
            </div>
            {delta !== null && <div className="mb-2 flex items-center gap-2 font-sans"><Delta value={delta} /><span className="text-[11px] text-lab-dim">к {previous!.version}</span></div>}
            {points.length > 1 && <div className="mb-1 ml-auto"><Sparkline values={points.map(p => p.value)} /></div>}
          </div>
          <p className="mt-3 text-[13px] leading-snug text-lab-text">Агент выполнил все критерии в <b>{m.passed}</b> из <b>{m.measured}</b> {of}</p>
          <StackBar className="mt-4" parts={[{ value: m.passed, hue: "ok" }, { value: m.failed, hue: "bad" }, { value: m.unmeasured, hue: "warn" }]} />
          <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-lab-mute" title="«Не измерено» значит, что агент не ответил или судье не на что опереться">
            <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-lab-ok" />пройдено · {m.passed}</span>
            <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-lab-bad" />провалено · {m.failed}</span>
            <span className="inline-flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-lab-warn" />не измерено · {m.unmeasured}</span>
          </div>
        </Panel>
        <WhatToFix items={items} previous={previous} previousItems={previousItems} />
      </div>

      {items.length > 0 && (
        <Section
          title="Где агент ломается" hint="Каждая клетка: сценарий, который сыграл клиент одного типа. Нажмите на клетку, чтобы открыть разговор."
          right={previous && <Button size="sm" variant={compare ? "primary" : "secondary"} disabled={!previousItems} onClick={() => setCompare(v => !v)}>{compare ? "Сравнение с " + previous.version : `Сравнить с ${previous.version}`}</Button>}
        >
          <Panel className="p-5">
            <Heatmap
              personas={types} scenarios={scenariosOfRun(items)} items={items} previous={previousItems} compare={compare}
              accuracy={m.personas ?? (types.length === 1 ? { [types[0].id]: { accuracy: m.accuracy } } : undefined)}
              onOpen={i => onOpen(itemKey(i))}
            />
          </Panel>
        </Section>
      )}

      <div className="mt-4 grid gap-4 min-[1100px]:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Panel className="flex flex-col p-5">
          <div className="text-[14px] font-medium text-lab-text">Точность по прогонам</div>
          <div className="mt-0.5 text-[11px] text-lab-dim">{finished.targetName}. Нажмите на точку, чтобы открыть прогон.</div>
          <div className="mt-3 min-h-[240px] flex-1">
            {points.length > 1
              ? <Trend points={points} selectedId={finished.id} onPick={onPickRun} fill />
              : <div className="flex h-full min-h-[200px] items-center justify-center rounded-lg border border-dashed border-white/[0.1] px-8 text-center text-[12px] leading-relaxed text-lab-dim">Пока один прогон. Запустите агента ещё раз, и здесь появится динамика.</div>}
          </div>
          {points.length > 1 && (
            <div className="mt-4 grid grid-cols-3 gap-4 border-t border-white/[0.06] pt-4">
              <Figure label="Прогонов этого агента" value={points.length} />
              <Figure label="Лучший результат" value={`${best.value}%`} sub={best.title.split(" · ")[0]} />
              <Figure label="С первого прогона" value={<Delta value={points[points.length - 1].value - points[0].value} />} sub={points[0].title.split(" · ")[0]} />
            </div>
          )}
        </Panel>

        <div>
          <div className="mb-2.5">
            <div className="text-[14px] font-medium text-lab-text">Можно ли доверять оценке</div>
            <div className="mt-0.5 text-[11px] text-lab-dim">Четыре проверки самого судьи</div>
          </div>
          <Panel className="divide-y divide-white/[0.06]">
            <Trust icon={ShieldCheck} label="Второй судья" ok={m.secondJudge ? m.secondJudge.agree / m.secondJudge.checked >= 0.8 : undefined}
              value={m.secondJudge ? `Согласен в ${m.secondJudge.agree} из ${m.secondJudge.checked}` : "Не запускался"} />
            <Trust icon={Repeat} label="Повторы" ok={m.repeats ? m.repeats.stable / m.repeats.scenarios >= 0.8 : undefined}
              value={m.repeats ? `Одинаковый итог у ${m.repeats.stable} из ${m.repeats.scenarios}` : "Не запускались"} sub={m.repeats ? undefined : "Запустите с повторами, чтобы проверить стабильность"} />
            <Trust icon={QuoteIcon} label="Доказательства" ok value="У каждого вердикта есть цитата из ответа агента" />
            <Trust icon={UserCheck} label="Проверка человеком" ok={m.human ? m.human.agree / m.human.reviewed >= 0.8 : undefined}
              value={m.human ? `Проверено ${m.human.reviewed}, судья прав в ${m.human.agree}` : "Не проводилась"} sub={m.human ? undefined : "Кнопки «Верно» и «Неверно» в прогоне"} />
          </Panel>
        </div>
      </div>

      {recent.length > 1 && deck.length > 0 && (
        <Section title="Динамика по сценариям" hint="Доля пройденных разговоров сценария в последних прогонах">
          <Panel className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-[12px]">
              <thead>
                <tr className="text-lab-dim">
                  <th className="px-4 py-2.5 text-left font-normal"><Eyebrow>Сценарий</Eyebrow></th>
                  {recent.map(r => (
                    <th key={r.id} className={cn("px-3 py-2.5 text-center font-normal", r.id === finished.id && "text-lab-text")}>
                      <div className="font-mono text-[11px]">{r.version}</div>
                      <div className="font-mono text-[10px] text-lab-dim">{day(r.startedAt)}</div>
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
                          {own.length
                            ? <span className={cn("inline-flex min-w-[42px] items-center justify-center rounded px-2 py-0.5 font-mono text-[11px]", HUE[hue].bg, HUE[hue].text)}>{ok}/{own.length}</span>
                            : <span className="text-lab-faint">·</span>}
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
