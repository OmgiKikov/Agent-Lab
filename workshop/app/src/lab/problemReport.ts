import { day, plural } from "./format";
import type { Example, Problems, RuleEntry } from "./problems";

const SOURCE_LABEL: Record<string, string> = { prompt: "Промпт требует", tools: "Инструменты агента" };
export const sourceLabel = (kind: string) => SOURCE_LABEL[kind] ?? "Источник критерия";

/** How well an example is backed, in words: the order of examples follows it. */
export function reliabilityWord(e: Example): string {
  if (e.review === "agree") return "подтверждено человеком";
  if (e.review === "disagree") return "человек не согласен с судьёй";
  if (e.second === "agree") return "оба судьи согласны";
  if (e.second === "disagree") return "судьи расходятся";
  return "второй судья не проверял";
}

export function secondLine(e: Example, model: string | null): string {
  const who = model ? `Второй судья (${model})` : "Второй судья";
  if (!e.second) return `${who} этот вердикт не проверял.`;
  if (e.secondScope === "dialogue") return e.second === "agree"
    ? `${who} оценивал разговор целиком и тоже нашёл в нём нарушение.`
    : `${who} оценивал разговор целиком и вынес другой вердикт.`;
  return e.second === "agree" ? `${who}: согласен.` : `${who}: не согласен.`;
}

type Source = "log" | "sim";

/** «Агент нарушает 6 из 18 критериев» in one source, or the good result said as plainly. */
export function summarySentence(data: Problems, source: Source): string {
  const total = data.rules.length;
  const rules = plural(total, "критерия", "критериев", "критериев");
  const failed = data.rules.filter(r => r[source].failed > 0).length;
  if (failed) return `Агент нарушает ${failed} из ${total} ${rules}`;
  const n = source === "log" ? data.log?.assessed ?? 0 : data.sim?.dialogs ?? 0;
  return `Судья не нашёл нарушений ни одного из ${total} ${rules} в ${n} ${plural(n, "разговоре", "разговорах", "разговорах")}`;
}

const where = (p: RuleEntry, source?: Source) => [
  source !== "sim" && p.log.failed ? `в ${p.log.failed} из ${p.log.failed + p.log.passed} разговоров логов` : null,
  source !== "log" && p.sim.failed ? `в ${p.sim.failed} из ${p.sim.failed + p.sim.passed} разговоров симуляции` : null,
].filter(Boolean).join(", ");

/** One problem for a ticket or a message: what, where it is written, how often, one proof and the link. With a source, only that source is told. */
export function problemMarkdown(p: RuleEntry, link: string, level = 1, source?: Source): string {
  const own = source ? p[source].examples : [...p.log.examples, ...p.sim.examples];
  const e = own.find(x => x.status === "FAIL");
  const lines = [
    `${"#".repeat(level)} ${p.title}`, "",
    `Нарушено ${where(p, source)}.`, "",
    `${sourceLabel(p.rule.kind)}${p.rule.origin ? ` (${p.rule.origin})` : ""}: «${p.rule.quote}»`, "",
    `Критерий: ${p.rule.text}`,
  ];
  if (e) lines.push("", `${"#".repeat(level + 1)} Пример`, "", `Клиент: ${e.opening}`, `Агент: «${e.agentQuote}»`, `Судья: ${e.reason}`, `Надёжность: ${reliabilityWord(e)}`);
  lines.push("", link);
  return lines.join("\n");
}

/** The problems of one source as a file: logs and simulation are never told together. */
export function problemsReport(data: Problems, base: string, source: Source): string {
  const lines = [`# ${summarySentence(data, source)}`, ""];
  if (source === "log" && data.log) lines.push(`Логи: оценено ${data.log.assessed} из ${data.log.sampled} разговоров ${day(data.log.finishedAt)}, нарушения в ${data.log.withViolations}, без оценки ${data.log.unassessed}.`);
  if (source === "sim" && data.sim) lines.push(`Прогон: ${data.sim.target} · ${data.sim.version} от ${day(data.sim.finishedAt)}, ${data.sim.dialogs} разговоров, нарушения в ${data.sim.withViolations}.`);
  lines.push("");
  const list = data.rules.filter(r => r[source].failed > 0).sort((a, b) => b[source].failed - a[source].failed);
  for (const p of list) {
    const link = `${base}/problems/${encodeURIComponent(p.id)}${source === "sim" && data.sim ? `?src=sim&run=${encodeURIComponent(data.sim.runId)}` : ""}`;
    lines.push(problemMarkdown(p, link, 2, source), "");
  }
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
