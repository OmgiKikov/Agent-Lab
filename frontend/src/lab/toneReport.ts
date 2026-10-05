import { historyLink, problemLink } from "../app/links";
import { agentLine, headingOf, inlineText, quoteText, reliabilityWord } from "./problemReport";
import type { Problems, RuleEntry } from "./problems";
import { seriousFirst, severityText } from "./severity";
import type { Discover } from "./types";
import { count, pct } from "./format";

const excerpt = (value: string, limit = 300) => value.trim().slice(0, limit).trimEnd();
const cut = (value: string, limit = 300) => excerpt(value, limit) + (value.trim().length > limit ? "…" : "");
/** Someone else's text cut short, on one line, its Markdown marks escaped (inlineText). */
const short = (value: string, limit = 300) => inlineText(cut(value, limit));
const quote = (value: string) => quoteText(excerpt(value));
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
/** A word that begins a sentence. */
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function nextAction(problem: RuleEntry): string {
  const errors = problem.log.examples.filter((e) => e.status === "FAIL");
  if (errors.some((e) => e.review === "disagree" || (!e.review && e.second === "disagree")))
    return "разобрать спорные оценки с автором правил общения и уточнить, когда применяется критерий.";
  if (errors.some((e) => e.review === "agree"))
    return "передать подтверждённые примеры команде агента и после исправления проверить новые ответы.";
  return "проверить примеры, прежде чем передавать задачу команде агента.";
}

/**
 * A short brief for the team, with the same number and words as the screen: «N из M — с ошибкой агента», and the
 * conversations with a serious error with whose decision that is (lab/severity, severityText). It tells the serious
 * problems first, marked «серьёзная», then the most frequent: all the serious ones, and at least three. Complete
 * criteria and evidence remain in the saved check, linked from the brief («История» of tone of voice). Links open Agent
 * Lab on the computer where the check ran; the brief says so, since it travels by e-mail. Its first line names the
 * agent (agentLine): every agent's brief looks alike.
 */
export function toneBrief(
  data: Problems,
  result: Discover,
  base: string,
  { filename, agent }: { filename?: string; agent?: string },
): string {
  const criteria = result.topics.flatMap((topic) => topic.rules);
  const quotes = new Set(criteria.map((criterion) => criterion.quote));
  const rules = data.rules.filter((rule) => quotes.has(rule.rule.quote));
  const found = rules
    .filter((rule) => rule.log.failed > 0)
    .sort((a, b) => seriousFirst(a, b) || b.log.failed - a.log.failed);
  const grave = found.filter((rule) => rule.serious).length;
  const top = found.slice(0, Math.max(3, grave));
  const severity = severityText({ ...data, rules });
  const { measured, failed, passed, unmeasured } = result.summary;
  const reviews = rules.flatMap((rule) => rule.log.examples).filter((example) => example.review);
  const agrees = reviews.filter((example) => example.review === "agree").length;
  const origin = base.replace(/\/$/, "");
  const saved = result.checkId ? `${origin}${historyLink("tone", result.checkId)}` : null;
  const lines = [
    "# Tone of voice: отчёт для команды",
    "",
    ...(agent ? [agentLine(agent)] : []),
    `Проверка закончилась ${date(result.finishedAt)}.`,
    ...(filename ? [`Выгрузка «${short(filename, 160)}».`] : []),
    `В выборке ${count(result.sampled, "разговор", "разговора", "разговоров")}, проверка шла по\u00a0${count(criteria.length, "критерию", "критериям", "критериям")}.`,
    measured
      ? `С ошибкой агента — ${failed}\u00a0из\u00a0${count(measured, "проверенного разговора", "проверенных разговоров", "проверенных разговоров")} (${pct(failed, measured)}%).`
      : `Ни один разговор не удалось проверить.`,
    ...(measured && severity ? [severity] : []),
    `Без найденных ошибок — ${passed}. Не удалось проверить — ${unmeasured}\u00a0из\u00a0${result.sampled}, в счёт они не входят.`,
    reviews.length
      ? `Люди проверили ${count(reviews.length, "оценку", "оценки", "оценок")} и согласились с\u00a0${agrees}. Это число оценок, а не разговоров.`
      : "Люди оценки ещё не проверяли.",
    "",
    "Итог относится только к этим критериям и этой выборке. Процент не говорит, насколько точна сама автоматическая проверка.",
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
  for (const [index, problem] of top.entries()) {
    const criterion = criteria.find((item) => item.quote === problem.rule.quote);
    const errors = problem.log.examples.filter((example) => example.status === "FAIL");
    const example =
      errors.find((e) => e.review === "agree") ?? errors.find((e) => e.review !== "disagree") ?? errors[0];
    lines.push(
      `## ${index + 1}. ${headingOf({ ...problem, title: cut(problem.title, 140) })}`,
      "",
      `Ошибка в\u00a0${problem.log.failed}\u00a0из\u00a0${count(problem.log.failed + problem.log.passed, "разговора", "разговоров", "разговоров")}, где критерий удалось проверить.${problem.log.unknown ? ` Ещё в\u00a0${problem.log.unknown} его не удалось проверить.` : ""}`,
      "",
      "Из правил общения:",
      problem.rule.quote ? quote(problem.rule.quote) : "Цитата не сохранилась.",
      ...(problem.rule.quote.trim().length > 300 ? ["… Полностью — по ссылке в конце."] : []),
      ...(problem.rule.condition ? [`Когда применяется: ${short(problem.rule.condition, 180)}`] : []),
      ...(problem.rule.acceptable ? [`Исключения и допустимое: ${short(problem.rule.acceptable, 180)}`] : []),
      ...(criterion?.clarifications?.length
        ? [`Уточнения команды: ${short(criterion.clarifications.map((c) => c.trim()).join(" "), 200)}`]
        : []),
    );
    if (example)
      lines.push(
        "",
        example.dialogueId ? `Пример из разговора ${short(example.dialogueId, 80)}:` : "Пример:",
        `Клиент: ${short(example.opening, 160)}`,
        `Агент:\n${quote(example.agentQuote || "Цитата не сохранилась.")}`,
        ...(example.agentQuote.length > 300 ? ["… Полностью — в сохранённом разговоре."] : []),
        `Почему это ошибка: ${short(example.reason)}`,
        `${capital(reliabilityWord(example, "people"))}.`,
      );
    lines.push("", `Что сделать: ${nextAction(problem)}`, "");
    if (!saved) lines.push(`Подробнее в Agent Lab: ${origin}${problemLink(problem.id, "tone")}`, "");
  }
  if (found.length > top.length)
    lines.push(
      `В отчёте ${grave >= 3 ? "только серьёзные проблемы" : grave ? "серьёзные проблемы и самые частые из остальных" : "три самые частые проблемы"}. Остальные — в итоге проверки в Agent Lab.`,
      "",
    );
  if (saved)
    lines.push(
      "## Все материалы проверки",
      "",
      `[Сохранённые разговоры, критерии, условия и исключения](${saved}).`,
      "По ссылке всё целиком, как было в конце проверки. Ответы людей учтены на момент, когда составлен отчёт.",
    );
  else
    lines.push(
      "Числа и текст — на момент, когда составлен отчёт. Ссылки открывают Agent Lab на компьютере, где шла проверка, и показывают то, что там сейчас. После новой выгрузки разговоров там будет другое.",
    );
  return lines.join("\n");
}
