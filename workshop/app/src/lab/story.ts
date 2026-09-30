/**
 * The Lab tells what it found in sentences: a headline verdict for the version, one line of detail, and at most two things worth a look.
 * The interface narrates the data, never itself. Every sentence here is computed from the same numbers the page shows,
 * and every observation points to where its evidence is.
 */
import { rate, type Dialog } from "./criteria";
import { trustOf } from "./findings";
import { count } from "./format";
import type { Hue } from "./look";
import type { Direction } from "./stats";
import type { LabRun, LabState } from "./types";
import type { Scope } from "./useScope";

export type Verdict = {
  /** better … worse when there is a version to compare with; `first` for a single version; `logs` when only real logs exist. */
  kind: Direction | "first" | "logs" | "none";
  headline: string;
  /** One sentence under the headline: the number in words, what changed, what breaks most. */
  detail: string;
};

const HEADLINE: Record<Direction, (v: string, p: string) => string> = {
  better: (v, p) => `Версия ${v} лучше, чем ${p}.`,
  "likely-better": (v, p) => `Версия ${v}, похоже, лучше ${p}.`,
  same: (v, p) => `Версия ${v} на уровне ${p}.`,
  "likely-worse": (v, p) => `Версия ${v}, похоже, хуже ${p}.`,
  worse: (v, p) => `Версия ${v} хуже, чем ${p}.`,
};

/** The verdict's chip: one or two words in capitals, coloured only when the change is real. */
export const VERDICT_CHIP: Record<Verdict["kind"], { text: string; hue: Hue }> = {
  better: { text: "лучше", hue: "ok" }, "likely-better": { text: "в пределах шума", hue: "mute" }, same: { text: "на уровне", hue: "mute" },
  "likely-worse": { text: "в пределах шума", hue: "mute" }, worse: { text: "хуже", hue: "bad" },
  first: { text: "первая проверка", hue: "mute" }, logs: { text: "реальные диалоги", hue: "mute" }, none: { text: "нет данных", hue: "mute" },
};

/** One sentence and one number: the headline says better or worse, the detail says by how much. Everything else is on the page below it. */
export function verdictOf(scope: Scope): Verdict {
  const { finished, previous, prevSim, sim, log, change } = scope;
  if (finished && sim.measured) {
    const share = sim.share ?? 0;
    if (previous && change) {
      const before = prevSim?.share;
      const noise = change.direction === "likely-better" || change.direction === "likely-worse";
      return {
        kind: change.direction,
        headline: HEADLINE[change.direction](finished.version, previous.version),
        detail: `Без нарушений ${share}% диалогов${before !== null && before !== undefined ? ` против ${before}% в ${previous.version}` : ""}.${noise ? ` На ${count(sim.measured, "диалоге", "диалогах", "диалогах")} такая разница может быть случайной: повторите проверку.` : ""}`,
      };
    }
    return {
      kind: "first",
      headline: `Версия ${finished.version}: без нарушений ${share}% диалогов.`,
      detail: `Агент справился в ${sim.clean} из ${count(sim.measured, "диалога", "диалогов", "диалогов")}. Проверьте следующую версию, и здесь появится сравнение.`,
    };
  }
  if (log.measured) {
    const failed = log.measured - log.clean;
    return {
      kind: "logs",
      headline: `В реальных диалогах агент нарушает критерии в ${failed} из ${log.measured}.`,
      detail: "Это оценка записанных разговоров. Проверьте версию на симуляторе, чтобы сравнивать версии до выкладки.",
    };
  }
  return { kind: "none", headline: "Пока нечего оценивать.", detail: "Подключите агента и загрузите логи: судья проверит разговоры по критериям из промптов агента." };
}

/** At most two things worth a look that the numbers above do not already say: a customer type the agent fails, unstable repeats. */
export function attentionOf(scope: Scope, state: LabState): Observation[] {
  const out: Observation[] = [];
  const decidedSims = scope.sims.filter(d => d.status === "PASS" || d.status === "FAIL");
  const types = state.personas.map(p => {
    const own = decidedSims.filter(d => d.persona === p.id);
    return { p, n: own.length, share: own.length ? own.filter(d => d.status === "PASS").length / own.length : null };
  }).filter(t => t.n >= 3 && t.share !== null);
  if (types.length > 1) {
    const worst = [...types].sort((a, b) => a.share! - b.share!)[0];
    const best = [...types].sort((a, b) => b.share! - a.share!)[0];
    if (best.share! - worst.share! >= 0.15) {
      out.push({ id: "persona", hue: "warn", text: `С типом «${worst.p.name}» агент справляется хуже: ${Math.round(100 * worst.share!)}% без нарушений против ${Math.round(100 * best.share!)}% у типа «${best.p.name}».`, to: "/lab/dialogs?view=map", cta: "Карта" });
    }
  }
  const repeats = scope.finished?.metric?.repeats;
  if (repeats && repeats.scenarios > 0 && repeats.stable < repeats.scenarios) {
    out.push({ id: "repeats", hue: "warn", text: `На повторах результат меняется в ${repeats.scenarios - repeats.stable} из ${count(repeats.scenarios, "сценария", "сценариев", "сценариев")}: агент отвечает по-разному на один вопрос.`, to: "/lab/dialogs?view=map", cta: "Карта" });
  }
  return out.slice(0, 2);
}

export type Observation = { id: string; hue: Hue; text: string; to?: string; cta?: string };

export type Trust = {
  level: "pending" | "partial" | "ok";
  /** One word for the level, and one sentence for why. */
  label: string; reason: string;
  facts: { id: string; label: string; value: string; hue: Hue; hint: string }[];
};

/** How far the version's number can be trusted, in words: the level, why, and the facts behind it. */
export function trustStory(run: LabRun | null, interval: [number, number] | null): Trust | null {
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
  if (interval) {
    const half = Math.round((100 * (interval[1] - interval[0])) / 2);
    facts.push({ id: "n", label: "Погрешность числа", value: `±${half} п.п. на ${m.measured} диалогах`, hue: half > 12 ? "warn" : "mute", hint: `С вероятностью 95% настоящая доля лежит между ${Math.round(100 * interval[0])}% и ${Math.round(100 * interval[1])}%. Больше диалогов — уже интервал.` });
  }
  const label = t.level === "ok" ? "Оценке можно верить" : t.level === "partial" ? "Оценка условно надёжна" : "Оценка предварительная";
  const reason = t.level === "ok"
    ? `Судья сверен с человеком на ${t.reviewed} вердиктах и прав в ${Math.round(100 * (t.humanShare ?? 0))}%.`
    : t.level === "partial"
      ? `Годится для сравнения версий. Для точной оценки сверьте судью хотя бы на 30 вердиктах${t.humanShare !== null && t.humanShare < 0.8 ? " и разберитесь, где он ошибается" : ""}.`
      : `Годится, чтобы сравнивать версии между собой. Чтобы верить самому числу, сверьте судью с человеком хотя бы на 10 вердиктах.`;
  return { level: t.level, label, reason, facts };
}

/** Share of a criterion as a whole number of percent, or null. */
export const sharePct = (t: { passed: number; failed: number }) => { const r = rate(t); return r === null ? null : Math.round(100 * r); };

/** «лог» / «симулятор» */
export const sourceName = (d: Dialog) => (d.origin === "log" ? "реальный" : "симулятор");
