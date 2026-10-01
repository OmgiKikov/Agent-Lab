import { day, plural } from "./format";
import type { Example, Problems, RuleEntry } from "./problems";

const SOURCE_LABEL: Record<string, string> = { prompt: "Промпт требует", tools: "Инструменты агента" };
export const sourceLabel = (kind: string) => SOURCE_LABEL[kind] ?? "Источник критерия";

/**
 * How well an example is backed, in words: a person's answer first, then whether the two automatic checks (two models
 * of different vendors) agree. The order of examples follows it.
 */
export function reliabilityWord(e: Example): string {
  if (e.review === "agree") return "подтверждено вами";
  if (e.review === "disagree") return "вы не согласились";
  if (e.second === "agree") return "две проверки совпали";
  if (e.second === "disagree") return "проверки разошлись";
  return "проверено один раз";
}

/** The second check in a sentence, for a person; the model's name only where an engineer asks for it. */
export function secondLine(e: Example, model: string | null): string {
  const who = model ? `Вторая проверка (${model})` : "Вторая проверка";
  if (!e.second) return `${who} этот разговор не смотрела.`;
  if (e.secondScope === "dialogue")
    return e.second === "agree"
      ? `${who} смотрела разговор целиком и тоже нашла ошибку.`
      : `${who} смотрела разговор целиком и ошибки не нашла.`;
  return e.second === "agree" ? "Две проверки совпали." : "Проверки разошлись: нужен ваш ответ.";
}

type Source = "log" | "sim";

/** «Агент ошибается по 6 из 18 критериев» in one source, or the good result said as plainly. */
export function summarySentence(data: Problems, source: Source): string {
  const total = data.rules.length;
  const failed = data.rules.filter((r) => r[source].failed > 0).length;
  if (failed) return `Агент ошибается по ${failed} из ${total} ${plural(total, "критерию", "критериям", "критериям")}`;
  const n = source === "log" ? (data.log?.assessed ?? 0) : (data.sim?.dialogs ?? 0);
  return `Ошибок не найдено ни по одному из ${total} ${plural(total, "критерия", "критериев", "критериев")} в ${n} ${plural(n, "разговоре", "разговорах", "разговорах")}`;
}

const where = (p: RuleEntry, source?: Source) =>
  [
    source !== "sim" && p.log.failed ? `в ${p.log.failed} из ${p.log.failed + p.log.passed} разговоров логов` : null,
    source !== "log" && p.sim.failed
      ? `в ${p.sim.failed} из ${p.sim.failed + p.sim.passed} разговоров симуляции`
      : null,
  ]
    .filter(Boolean)
    .join(", ");

/** The page of a problem in its stage, for links that leave the product (a report, a ticket). */
export const problemPath = (id: string, source: Source, runId?: string | null) =>
  source === "sim"
    ? `/simulations/problems/${encodeURIComponent(id)}${runId ? `?run=${encodeURIComponent(runId)}` : ""}`
    : `/logs/problems/${encodeURIComponent(id)}`;

/** One problem for a ticket or a message: what, how often, where the agent's code says it, one proof and the link. With a source, only that source is told. */
export function problemMarkdown(p: RuleEntry, link: string, level = 1, source?: Source): string {
  const own = source ? p[source].examples : [...p.log.examples, ...p.sim.examples];
  const e = own.find((x) => x.status === "FAIL");
  const lines = [
    `${"#".repeat(level)} ${p.title}`,
    "",
    `Ошибка ${where(p, source)}.`,
    "",
    `Агент должен: ${p.rule.text}`,
    "",
    `${sourceLabel(p.rule.kind)}${p.rule.origin ? ` (${p.rule.origin})` : ""}: «${p.rule.quote}»`,
  ];
  if (e)
    lines.push(
      "",
      `${"#".repeat(level + 1)} Пример`,
      "",
      `Клиент: ${e.opening}`,
      `Агент: «${e.agentQuote}»`,
      `Почему это ошибка: ${e.reason}`,
      `Проверка: ${reliabilityWord(e)}`,
    );
  lines.push("", link);
  return lines.join("\n");
}

/** The problems of one source as a file: logs and simulation are never told together. */
export function problemsReport(data: Problems, base: string, source: Source): string {
  const lines = [`# ${summarySentence(data, source)}`, ""];
  if (source === "log" && data.log)
    lines.push(
      `Логи: проверено ${data.log.assessed} из ${data.log.sampled} разговоров ${day(data.log.finishedAt)}, ошибка в ${data.log.withViolations}, не удалось проверить ${data.log.unassessed}.`,
    );
  if (source === "sim" && data.sim)
    lines.push(
      `Симуляция: ${data.sim.target} · ${data.sim.version} от ${day(data.sim.finishedAt)}, ${data.sim.dialogs} разговоров, ошибка в ${data.sim.withViolations}.`,
    );
  lines.push("");
  const list = data.rules.filter((r) => r[source].failed > 0).sort((a, b) => b[source].failed - a[source].failed);
  for (const p of list)
    lines.push(problemMarkdown(p, `${base}${problemPath(p.id, source, data.sim?.runId)}`, 2, source), "");
  return lines.join("\n");
}

/** Save text as a file through the browser. */
export function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
