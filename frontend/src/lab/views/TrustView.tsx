import { useMemo } from "react";
import { ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { ENOUGH_CHECKED, judgeErrors, MIN_CHECKED, TRUST_TEXT, trustOf } from "../findings";
import { pct, plural } from "../format";
import { HUE } from "../look";
import type { Item, LabRun, LabState } from "../types";
import { useRunContext } from "../useRunContext";
import { Badge, Button, EmptyState, Eyebrow, Page, Panel, Skeleton, titleFont } from "../ui";

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

function Big({ value, unit, label }: { value: string; unit?: string; label: React.ReactNode }) {
  return (
    <div className="mt-2 flex items-end gap-3.5">
      <div className={value === "—" ? "leading-[0.95] text-lab-faint" : "leading-[0.95] text-lab-ink"} style={{ ...titleFont, fontSize: 56 }}>{value}{unit && <span className="ml-1 text-[24px] text-lab-mute">{unit}</span>}</div>
      <div className="mb-1.5 text-[12px] leading-snug text-lab-dim">{label}</div>
    </div>
  );
}

export function TrustView({ state, run, onJudge }: { state: LabState; run: LabRun | null; onJudge: (runId: string) => void }) {
  const { finished } = useRunContext(state, run);
  const items = useMemo(() => finished?.items ?? [], [finished]);
  const errors = useMemo(() => judgeErrors(items), [items]);
  const sim = useMemo(() => simulatorFigures(items), [items]);

  if (!state.runs.length) {
    return <Page wide title="судья"><EmptyState className="mt-5" drop title="Пока нечего проверять">Судью проверяют по диалогам симулятора. Прогоните его хотя бы раз.</EmptyState></Page>;
  }
  if (!finished?.metric) return <Page wide title="судья"><Skeleton className="mt-5 h-[320px]" /></Page>;

  const m = finished.metric;
  const trust = trustOf(finished);
  const left = items.filter(i => (i.status === "PASS" || i.status === "FAIL") && !i.review).length;
  const judgeModels = [...new Set(items.map(i => i.model).filter((model): model is string => !!model))].join(", ");
  const secondModels = [...new Set(items.map(i => i.second?.model).filter((model): model is string => !!model))].join(", ");
  const hue = trust.level === "ok" ? "ok" : "warn";
  const progress = Math.min(100, (100 * trust.reviewed) / ENOUGH_CHECKED);
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

  return (
    <Page
      wide title="судья"
      lede="Насколько можно верить цифрам на экране «Критерии»: правильно ли судит судья и похож ли симулятор на настоящих клиентов."
      actions={<Badge hue={hue} icon={ShieldCheck}>{TRUST_TEXT[trust.level]}</Badge>}
    >
      <div className="mt-5 grid gap-4 min-[1100px]:grid-cols-2">
        <Panel className="p-5">
          <Eyebrow>судья</Eyebrow>
          {trust.humanShare === null
            ? <Big value="—" label={<>процент появится после {MIN_CHECKED} проверок<br />проверено {trust.reviewed}</>} />
            : <Big value={String(Math.round(trust.humanShare * 100))} unit="%" label={<>судья прав<br />проверено {trust.reviewed} из {m.total}</>} />}
          <div className="relative mt-4 h-1.5 rounded-full bg-white/[0.07]">
            <div className="h-full rounded-full bg-lab-mute" style={{ width: `${progress}%` }} />
            <span className="absolute -top-1 h-3.5 border-l border-dashed border-lab-soft" style={{ left: "100%" }} />
          </div>
          <div className="mt-1.5 text-[11px] text-lab-dim">Цель: {ENOUGH_CHECKED} проверенных вердиктов, после этого цифре можно верить. Спорные вердикты идут первыми, поэтому цифра строже, чем на всех разговорах.</div>

          <Eyebrow className="mb-1 mt-5">где судья ошибается</Eyebrow>
          {errors.length ? (
            <table className="w-full text-[12px]">
              <tbody>
                {errors.slice(0, 5).map(e => (
                  <tr key={e.rule} className="border-t border-white/[0.06] first:border-t-0">
                    <td className="py-2 pr-3 text-lab-text">{e.rule}</td>
                    <td className="py-2 text-right"><Badge hue={e.wrong / e.checked >= 0.3 ? "bad" : e.wrong ? "warn" : "ok"}>{e.wrong} из {e.checked}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="py-2 text-[12px] text-lab-dim">Пока нет проверенных вердиктов: нечего сравнивать.</div>}

          {trust.secondShare !== null && (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-white/[0.03] px-3 py-2 text-[12px]">
              <span className="text-lab-mute">Второй судья согласен с первым</span>
              <span className={cn("font-mono", HUE[trust.secondShare >= 0.8 ? "ok" : "warn"].text)}>{m.secondJudge!.agree} из {m.secondJudge!.checked}</span>
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button variant="primary" disabled={!left && trust.reviewed > 0} onClick={() => onJudge(finished.id)}>{trust.reviewed ? `Продолжить проверку · ${left} ${plural(left, "осталась", "осталось", "осталось")}` : "Начать проверку"}</Button>
          </div>
        </Panel>

        <Panel className="p-5">
          <Eyebrow>симулятор клиента</Eyebrow>
          <p className="mt-2 text-[12px] leading-relaxed text-lab-mute">Хороший симулятор пишет так, что его не отличить от настоящего клиента. Здесь то, что можно измерить по сыгранным им разговорам.</p>
          <table className="mt-3 w-full text-[12px]">
            <thead>
              <tr><th className="pb-1.5 text-left font-mono text-[10px] font-normal uppercase tracking-[0.08em] text-lab-dim">показатель</th><th className="pb-1.5 text-right font-mono text-[10px] font-normal uppercase tracking-[0.08em] text-lab-dim">симулятор</th><th className="pb-1.5 text-right font-mono text-[10px] font-normal uppercase tracking-[0.08em] text-lab-dim">реальные</th></tr>
            </thead>
            <tbody>
              <tr className="border-t border-white/[0.06]"><td className="py-2.5 text-lab-text">Слов в реплике клиента</td><td className="py-2.5 text-right font-mono text-lab-text">{sim.avgWords ?? "—"}</td><td className="py-2.5 text-right text-lab-faint">нет данных</td></tr>
              <tr className="border-t border-white/[0.06]"><td className="py-2.5 text-lab-text">Нажимают кнопку, если она есть</td><td className="py-2.5 text-right font-mono text-lab-text">{sim.pressedShare === null ? "—" : `${sim.pressedShare}%`}</td><td className="py-2.5 text-right text-lab-faint">нет данных</td></tr>
              <tr className="border-t border-white/[0.06]"><td className="py-2.5 text-lab-text">Реплик клиента сыграно</td><td className="py-2.5 text-right font-mono text-lab-text">{sim.replies}</td><td className="py-2.5 text-right text-lab-faint">нет данных</td></tr>
            </tbody>
          </table>
          <div className="mt-3 rounded-lg border border-dashed border-white/[0.12] px-4 py-3.5">
            <div className="text-[12px] font-medium text-lab-text">Слепой тест и сравнение с реальными клиентами</div>
            <div className="mt-1 text-[11px] leading-snug text-lab-dim">Показать эксперту пары «настоящий разговор» и «симулированный» и посмотреть, узнает ли он симулятор. Пока недоступно: Отдельный слепой тест пока не реализован.</div>
          </div>
        </Panel>
      </div>

      <Panel className="mt-4 flex flex-wrap items-center gap-3.5 px-5 py-3.5">
        <Badge hue={hue}>{cap(TRUST_TEXT[trust.level])}</Badge>
        <span className="min-w-0 flex-1 text-[12px] leading-snug text-lab-soft">
          {trust.level === "pending" ? `Число ${m.accuracy}% можно использовать для сравнения версий, но не как точную оценку. Чтобы снять пометку, проверьте ещё ${Math.max(0, MIN_CHECKED - trust.reviewed)} вердиктов судьи.`
            : trust.level === "partial" ? `Число ${m.accuracy}% годится для сравнения версий. Чтобы ему верили как оценке, доведите проверку до ${ENOUGH_CHECKED} вердиктов и добейтесь, чтобы судья был прав в 80% и больше.`
            : `Судья проверен на ${trust.reviewed} вердиктах и прав в ${Math.round((trust.humanShare ?? 0) * 100)}%. Числу ${m.accuracy}% можно верить.`}
        </span>
      </Panel>

      <div className="mb-2.5 mt-7">
        <h2 className="text-[14px] font-medium text-lab-text">Кто оценивал</h2>
        <p className="mt-0.5 text-[11px] text-lab-dim">Модели, которыми оценён этот прогон</p>
      </div>
      <Panel className="divide-y divide-white/[0.06]">
        {([["Судья", judgeModels], ["Второй судья", secondModels], ["Клиент-симулятор", ""]] as const).map(([role, model]) => (
          <div key={role} className="flex items-center justify-between gap-3 px-5 py-2.5 text-[12px]">
            <span className="text-lab-mute">{role}</span>
            <span className="rounded bg-white/[0.06] px-2 py-0.5 font-mono text-[11px] text-lab-soft">{model || "не записана"}</span>
          </div>
        ))}
      </Panel>
    </Page>
  );
}
