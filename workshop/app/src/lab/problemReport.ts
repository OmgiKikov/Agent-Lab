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
    ? `${who} оценивал диалог целиком и тоже нашёл в нём нарушение.`
    : `${who} оценивал диалог целиком и вынес другой вердикт.`;
  return e.second === "agree" ? `${who}: согласен.` : `${who}: не согласен.`;
}

/** «Агент нарушает 6 из 18 критериев», or the good result said as plainly. */
export function summarySentence(data: Problems): string {
  const total = data.rules.length;
  const rules = plural(total, "критерия", "критериев", "критериев");
  if (data.problems.length) return `Агент нарушает ${data.problems.length} из ${total} ${rules}`;
  const n = data.log?.assessed ?? 0;
  return `Судья не нашёл нарушений ни одного из ${total} ${rules} в ${n} ${plural(n, "диалоге", "диалогах", "диалогах")}`;
}

const where = (p: RuleEntry) => [
  p.log.failed ? `в ${p.log.failed} из ${p.log.failed + p.log.passed} диалогов логов` : null,
  p.sim.failed ? `в ${p.sim.failed} из ${p.sim.failed + p.sim.passed} диалогов симуляции` : null,
].filter(Boolean).join(", ");

/** One problem for a ticket or a message: what, where it is written, how often, one proof and the link. */
export function problemMarkdown(p: RuleEntry, link: string, level = 1): string {
  const e = [...p.log.examples, ...p.sim.examples].find(x => x.status === "FAIL");
  const lines = [
    `${"#".repeat(level)} ${p.title}`, "",
    `Нарушено ${where(p)}.`, "",
    `${sourceLabel(p.rule.kind)}${p.rule.origin ? ` (${p.rule.origin})` : ""}: «${p.rule.quote}»`, "",
    `Критерий: ${p.rule.text}`,
  ];
  if (e) lines.push("", `${"#".repeat(level + 1)} Пример`, "", `Клиент: ${e.opening}`, `Агент: «${e.agentQuote}»`, `Судья: ${e.reason}`, `Надёжность: ${reliabilityWord(e)}`);
  lines.push("", link);
  return lines.join("\n");
}

export function problemsReport(data: Problems, base: string): string {
  const byId = new Map(data.rules.map(r => [r.id, r]));
  const lines = [`# ${summarySentence(data)}`, ""];
  if (data.log) lines.push(`Логи: оценено ${data.log.assessed} из ${data.log.sampled} диалогов ${day(data.log.finishedAt)}, нарушения в ${data.log.withViolations}, без оценки ${data.log.unassessed}.`);
  if (data.sim) lines.push(`Симуляция: ${data.sim.target} · ${data.sim.version} от ${day(data.sim.finishedAt)}, ${data.sim.dialogs} диалогов, нарушения в ${data.sim.withViolations}.`);
  lines.push("");
  for (const id of data.problems) {
    const p = byId.get(id);
    if (p) lines.push(problemMarkdown(p, `${base}/problems/${id}`, 2), "");
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
