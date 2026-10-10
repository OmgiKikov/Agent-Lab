import { historyLink, problemLink } from "../app/links";
import {
  agentLine,
  criterionOf,
  errorsOf,
  headingOf,
  importantFirst,
  masked,
  masksLine,
  problemLines,
  proofOf,
  quotedOf,
} from "./problemReport";
import { importantByPerson, type Example, type Problems, type RuleEntry } from "./problems";
import { inQuotes } from "./quote";
import { severityText } from "./severity";
import { rechecked } from "./summary";
import type { ResultBrief } from "./types";
import { count } from "./format";
import { cleanPct } from "./history";

/** «5 октября 2026 г. в 07:12 GMT+3»: the brief travels by e-mail, so its time says its zone. */
const date = (value: string) =>
  new Date(value).toLocaleString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

function nextAction(problem: RuleEntry): string {
  const errors = errorsOf(problem.log);
  if (errors.some((e) => e.review === "disagree" || (!e.review && e.second === "disagree")))
    return "разобрать спорные примеры с автором правил общения и уточнить, когда применяется критерий.";
  if (errors.some((e) => e.review === "agree"))
    return "передать подтверждённые примеры команде агента и после исправления проверить новые ответы.";
  return "проверить примеры, прежде чем передавать задачу команде агента.";
}

/**
 * A short brief for the team, with the same numbers and words as the screen: «N из M — с ошибкой агента», the
 * conversations with an error by an important criterion with whose decision that is (lab/severity, severityText), and
 * what people's answers say. It tells the problems of the criteria a person marked important first, then the most
 * frequent: all the important ones, and at least three — each as every text that leaves the product tells a problem
 * (lab/problemReport, problemLines): no instructions written for the model, no conversation ids, the rules' words as
 * points. Complete criteria and evidence remain in the saved check, linked from the brief («История» of tone of
 * voice). Links open Agent Lab where the check ran; the brief says so, since it travels by e-mail. Its first line names
 * the agent (agentLine): every agent's brief looks alike.
 */
export function toneBrief(
  data: Problems,
  result: ResultBrief,
  base: string,
  { filename, agent }: { filename?: string; agent?: string },
): string {
  const criteria = result.topics.flatMap((topic) => topic.rules);
  const quotes = new Set(criteria.map((criterion) => criterion.quote));
  const rules = data.rules.filter((rule) => quotes.has(rule.rule.quote));
  const found = rules
    .filter((rule) => rule.log.failed > 0)
    .sort(importantFirst("log"))
    .map(criterionOf);
  const important = found.filter((c) => importantByPerson(c.r)).length;
  const top = found.slice(0, Math.max(3, important));
  const proofs = top.map((c) => proofOf(errorsOf(c.r.log)));
  const shown = proofs.filter((e): e is Example => !!e);
  const severity = severityText({ ...data, rules });
  const { measured, failed, passed, unmeasured } = result.summary;
  const origin = base.replace(/\/$/, "");
  const saved = result.checkId ? `${origin}${historyLink("tone", result.checkId)}` : null;
  const lines = [
    "# Tone of voice: отчёт для команды",
    "",
    ...(agent ? [agentLine(agent)] : []),
    `Проверка закончилась ${date(result.finishedAt)}.`,
    ...(filename ? [`Датасет ${inQuotes(filename)}.`] : []),
    `В выборке ${count(result.sampled, "разговор", "разговора", "разговоров")}, проверка шла по\u00a0${count(criteria.length, "критерию", "критериям", "критериям")}.`,
    measured
      ? `Без найденных ошибок — ${cleanPct({ failed, measured })}% проверенных разговоров: ${passed}\u00a0из\u00a0${measured}. С ошибкой агента — ${failed}.`
      : `Ни один разговор не удалось проверить.`,
    ...(measured && severity ? [severity] : []),
    ...(unmeasured
      ? [`Не удалось проверить — ${unmeasured}\u00a0из\u00a0${result.sampled}, в счёт они не входят.`]
      : []),
    ...[rechecked(result.answers)].filter((line): line is string => !!line),
    "",
    "Итог относится только к этим критериям и этой выборке. Процент не говорит, насколько точна сама модель.",
    ...(masked(shown.map(quotedOf)) ? [masksLine(shown.length)] : []),
    "",
  ];
  if (!top.length)
    lines.push(
      measured ? "## По этим критериям ошибок не нашли" : "## Ни один разговор не удалось проверить",
      "",
      measured
        ? "Что сделать: просмотреть несколько разговоров без найденных ошибок и убедиться, что проверка не пропускает важное."
        : "Что сделать: выяснить, почему разговоры не удалось проверить, посмотреть настройки модели и проверить снова.",
      "",
    );
  top.forEach((c, index) => {
    lines.push(
      `## ${index + 1}. ${headingOf(c)}`,
      "",
      ...problemLines(c, "log", proofs[index], data.log?.assessed),
      "",
      `Что сделать: ${nextAction(c.r)}`,
      "",
    );
    if (!saved) lines.push(`Подробнее в Agent Lab: ${origin}${problemLink(c.r.id, "tone")}`, "");
  });
  if (found.length > top.length)
    lines.push(
      `В отчёте ${important >= 3 ? "только проблемы по важным критериям" : important ? "проблемы по важным критериям и самые частые из остальных" : "три самые частые проблемы"}. Остальные — в итоге проверки в Agent Lab.`,
      "",
    );
  if (saved)
    lines.push(
      "## Все материалы проверки",
      "",
      `[Сохранённые разговоры и критерии](${saved}).`,
      "По ссылке всё целиком, как было в конце проверки. Ответы людей учтены на момент, когда составлен отчёт.",
    );
  else
    lines.push(
      "Числа и текст — на момент, когда составлен отчёт. Ссылки открывают Agent Lab, где шла проверка, и показывают то, что там сейчас. После новой проверки там будет другое.",
    );
  return lines.join("\n");
}
