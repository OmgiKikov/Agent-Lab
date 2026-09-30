/**
 * The Lab's sentences. Each one states numbers the service computed (lab/metric.py for a run, the audit's summary for the logs)
 * and nothing beyond them: the service never compares versions or judges a change, so no sentence here does either.
 */
import { rate, type Dialog } from "./criteria";
import { trustOf } from "./findings";
import { count } from "./format";
import type { Hue } from "./look";
import type { LabRun } from "./types";
import type { Scope } from "./useScope";

/** Before any version is checked: what the judge found in the real logs, or that there is nothing to judge yet. */
export function logsHeadline(scope: Scope): { headline: string; detail: string } {
  const { log } = scope;
  if (log.measured) {
    return {
      headline: "Версия агента ещё не проверялась.",
      detail: "Судья оценил только реальные диалоги из логов.",
    };
  }
  return { headline: "Пока нечего оценивать.", detail: "Подключите агента и загрузите логи: судья проверит разговоры по критериям из промптов агента." };
}

export type Trust = {
  level: "pending" | "partial" | "ok";
  /** One word for the level, and one sentence for why. */
  label: string; reason: string;
  facts: { id: string; label: string; value: string; hue: Hue; hint: string }[];
};

/** How far the version's number can be trusted, in words: the level, why, and the facts behind it. */
export function trustStory(run: LabRun | null): Trust | null {
  if (!run?.metric) return null;
  const t = trustOf(run);
  const m = run.metric;
  const facts: Trust["facts"] = [];
  facts.push({
    id: "human", label: "Судья сверен с человеком",
    value: t.reviewed ? `${t.humanShare !== null ? `прав в ${Math.round(100 * t.humanShare)}% · ` : ""}${t.reviewed} из ${m.total}` : "ещё нет",
    hue: t.reviewed < 10 || t.humanShare === null ? "warn" : t.humanShare >= 0.8 ? "ok" : t.humanShare >= 0.6 ? "warn" : "bad",
    hint: t.reviewed < 10 ? "Проверьте хотя бы 10 вердиктов, чтобы знать, насколько судья прав." : "Доля вердиктов судьи, с которыми согласился человек.",
  });
  if (m.secondJudge?.checked) {
    const share = m.secondJudge.agree / m.secondJudge.checked;
    facts.push({ id: "second", label: "Второй судья согласен", value: `в ${Math.round(100 * share)}% · ${m.secondJudge.agree} из ${m.secondJudge.checked}`, hue: share >= 0.8 ? "ok" : "warn", hint: "Модель другого вендора независимо оценила те же диалоги." });
  }
  if (m.repeats?.scenarios) {
    facts.push({ id: "repeats", label: "Устойчивость на повторах", value: `${m.repeats.stable} из ${count(m.repeats.scenarios, "сценария", "сценариев", "сценариев")}`, hue: m.repeats.stable === m.repeats.scenarios ? "ok" : "warn", hint: "Сценарии, где все повторы дали один результат." });
  }
  const label = t.level === "ok" ? "Оценке можно верить" : t.level === "partial" ? "Оценка условно надёжна" : "Оценка предварительная";
  const reason = t.level === "ok"
    ? `Судья сверен с человеком на ${t.reviewed} вердиктах и прав в ${Math.round(100 * (t.humanShare ?? 0))}%.`
    : t.level === "partial"
      ? `Судья сверен с человеком на ${t.reviewed} вердиктах из 30 нужных${t.humanShare !== null && t.humanShare < 0.8 ? `, прав в ${Math.round(100 * t.humanShare)}%` : ""}.`
      : `Судья сверен с человеком на ${t.reviewed} вердиктах из 10 нужных, чтобы знать, насколько он прав.`;
  return { level: t.level, label, reason, facts };
}

/** Share of a criterion as a whole number of percent, or null. */
export const sharePct = (t: { passed: number; failed: number }) => { const r = rate(t); return r === null ? null : Math.round(100 * r); };

/** «лог» / «симулятор» */
export const sourceName = (d: Dialog) => (d.origin === "log" ? "реальный" : "симулятор");
