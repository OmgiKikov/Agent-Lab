/**
 * The Lab tells what it found in sentences: a headline verdict for the version, one line of detail, and a short list of observations.
 * The interface narrates the data, never itself. Every sentence here is computed from the same numbers the tables show,
 * and every observation points to where its evidence is.
 */
import { rate, type Compared, type Dialog } from "./criteria";
import { trustOf } from "./findings";
import { count, points } from "./format";
import { disputed } from "./logic";
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
  better: (v, p) => `Версия ${v} лучше, чем ${p}`,
  "likely-better": (v, p) => `Версия ${v}, похоже, лучше ${p}`,
  same: (v, p) => `Версия ${v} на уровне ${p}`,
  "likely-worse": (v, p) => `Версия ${v}, похоже, хуже ${p}`,
  worse: (v, p) => `Версия ${v} хуже, чем ${p}`,
};

const title = (c?: { title: string }) => (c ? `«${c.title}»` : "");

export function verdictOf(scope: Scope): Verdict {
  const { finished, previous, sim, log, change, compared } = scope;
  const broken = compared.filter(c => c.criterion.by.sim.failed > 0).sort((a, b) => b.criterion.by.sim.failed - a.criterion.by.sim.failed);
  const top = broken[0]?.criterion;
  const topLine = top ? ` Чаще всего нарушается ${title(top)}: ${top.by.sim.failed} из ${top.by.sim.failed + top.by.sim.passed}.` : " Нарушений не найдено.";

  if (finished && sim.measured) {
    const share = sim.share ?? 0;
    const cleanLine = `Без нарушений ${share}% диалогов симулятора: ${sim.clean} из ${sim.measured}.`;
    if (previous && change) {
      const fresh = compared.filter(c => c.change === "new").length;
      const fixed = compared.filter(c => c.change === "fixed").length;
      const moved = change.delta === 0 ? "столько же, сколько в " + previous.version : `${points(change.delta)} к ${previous.version}`;
      const noise = change.direction === "likely-better" || change.direction === "likely-worse"
        ? ` На ${count(sim.measured, "диалоге", "диалогах", "диалогах")} такая разница может быть случайной: повторите проверку, чтобы убедиться.`
        : "";
      const criteriaLine = fresh || fixed
        ? ` ${fixed ? `Исправлено ${count(fixed, "критерий", "критерия", "критериев")}` : "Исправленных нет"}, ${fresh ? `${count(fresh, "новое нарушение", "новых нарушения", "новых нарушений")}` : "новых нарушений нет"}.`
        : "";
      return {
        kind: change.direction,
        headline: HEADLINE[change.direction](finished.version, previous.version),
        detail: `Без нарушений ${share}% диалогов, ${moved}.${criteriaLine}${noise}${noise ? "" : topLine}`,
      };
    }
    return { kind: "first", headline: `Версия ${finished.version}: агент справляется в ${sim.clean} из ${sim.measured} диалогов`, detail: `${cleanLine}${topLine} Проверьте следующую версию, и здесь появится сравнение.` };
  }
  if (log.measured) {
    const failed = log.measured - log.clean;
    const topLog = compared.filter(c => c.criterion.by.log.failed > 0).sort((a, b) => b.criterion.by.log.failed - a.criterion.by.log.failed)[0]?.criterion;
    return {
      kind: "logs",
      headline: `В реальных диалогах агент нарушает критерии в ${failed} из ${log.measured}`,
      detail: `Это оценка записанных разговоров, без запуска агента.${topLog ? ` Чаще всего нарушается ${title(topLog)}.` : ""} Прогоните симулятор, чтобы проверять версии агента до выкладки.`,
    };
  }
  return { kind: "none", headline: "Пока нечего оценивать", detail: "Подключите агента и загрузите логи: судья проверит разговоры по критериям из промптов агента." };
}

export type Observation = { id: string; hue: Hue; text: string; to?: string; cta?: string };

/** What is worth knowing about the version beyond the headline, most important first. Each one says where to look. */
export function observationsOf(scope: Scope, state: LabState): Observation[] {
  const out: Observation[] = [];
  const { finished, sims, compared } = scope;
  const link = (key: string) => `/lab/criteria/${encodeURIComponent(key)}`;
  const decidedSims = sims.filter(d => d.status === "PASS" || d.status === "FAIL");

  for (const c of compared.filter(x => x.change === "new").slice(0, 2)) {
    out.push({ id: `new:${c.criterion.key}`, hue: "bad", text: `Новое нарушение в ${finished?.version}: «${c.criterion.title}» — ${c.criterion.by.sim.failed} из ${tally(c)}.`, to: link(c.criterion.key), cta: "Диалоги" });
  }
  for (const c of compared.filter(x => x.change === "fixed").slice(0, 2)) {
    out.push({ id: `fixed:${c.criterion.key}`, hue: "ok", text: `Исправлено: «${c.criterion.title}» больше не нарушается (было в ${count(c.before, "диалоге", "диалогах", "диалогах")}).`, to: link(c.criterion.key), cta: "Критерий" });
  }

  // The customer type the agent handles worst, when the gap is visible.
  const types = state.personas.map(p => {
    const own = decidedSims.filter(d => d.persona === p.id);
    return { p, n: own.length, share: own.length ? own.filter(d => d.status === "PASS").length / own.length : null };
  }).filter(t => t.n >= 3 && t.share !== null);
  if (types.length > 1) {
    const worst = [...types].sort((a, b) => a.share! - b.share!)[0];
    const best = [...types].sort((a, b) => b.share! - a.share!)[0];
    if (best.share! - worst.share! >= 0.15) {
      out.push({ id: "persona", hue: "warn", text: `Хуже всего агент справляется с типом «${worst.p.name}»: ${Math.round(100 * worst.share!)}% без нарушений против ${Math.round(100 * best.share!)}% у типа «${best.p.name}».`, to: "/lab/dialogs?view=map", cta: "Карта" });
    }
  }

  // Handing the conversation to an operator instead of answering.
  const handoff = decidedSims.filter(d => d.item?.conversation.some(m => m.role === "agent" && m.ok === false)).length;
  if (handoff > 0) {
    out.push({ id: "handoff", hue: "warn", text: `Передаёт разговор оператору вместо ответа в ${handoff} из ${count(decidedSims.length, "диалога", "диалогов", "диалогов")}.`, to: "/lab/dialogs", cta: "Диалоги" });
  }

  // Stability on repeats.
  const repeats = finished?.metric?.repeats;
  if (repeats && repeats.scenarios > 0 && repeats.stable < repeats.scenarios) {
    const unstable = repeats.scenarios - repeats.stable;
    out.push({ id: "repeats", hue: "warn", text: `На повторах результат меняется в ${unstable} из ${count(repeats.scenarios, "сценария", "сценариев", "сценариев")}: агент отвечает по-разному на один и тот же вопрос.`, to: "/lab/dialogs?view=map", cta: "Карта" });
  }

  // The most frequent violation, if it is not already told as new.
  const top = compared.filter(c => c.criterion.by.sim.failed > 0 && c.change !== "new").sort((a, b) => b.criterion.by.sim.failed - a.criterion.by.sim.failed)[0];
  if (top) out.push({ id: `top:${top.criterion.key}`, hue: "bad", text: `Чаще всего нарушается «${top.criterion.title}»: ${top.criterion.by.sim.failed} из ${tally(top)}.`, to: link(top.criterion.key), cta: "Диалоги" });

  // Disagreement between the judges: where a person should look.
  const disputes = (finished?.items ?? []).filter(disputed).length;
  if (disputes > 0) {
    out.push({ id: "disputes", hue: "warn", text: `Судьи расходятся в ${count(disputes, "диалоге", "диалогах", "диалогах")}. Проверьте их вручную: так станет ясно, кто из судей прав.`, to: "/lab/judge/check", cta: "Проверить" });
  }
  return out;
}

const tally = (c: Compared) => count(c.criterion.by.sim.failed + c.criterion.by.sim.passed, "диалога", "диалогов", "диалогов");

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
