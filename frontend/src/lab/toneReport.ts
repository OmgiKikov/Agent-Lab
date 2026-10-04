import { historyLink, problemLink } from "../app/links";
import { headingOf, reliabilityWord } from "./problemReport";
import type { Problems, RuleEntry } from "./problems";
import { seriousFirst, seriousOf, seriousText } from "./severity";
import type { Discover } from "./types";
import { count, pct } from "./format";

const excerpt = (value: string, limit = 300) => value.trim().slice(0, limit).trimEnd();
const short = (value: string, limit = 300) => excerpt(value, limit) + (value.trim().length > limit ? "…" : "");
const quote = (value: string) =>
  excerpt(value)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
const date = (value: string) => new Date(value).toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" });

function nextAction(problem: RuleEntry): string {
  const errors = problem.log.examples.filter((e) => e.status === "FAIL");
  if (errors.some((e) => e.review === "disagree" || (!e.review && e.second === "disagree")))
    return "Разобрать спорные оценки с владельцем tone of voice и уточнить применение критерия.";
  if (errors.some((e) => e.review === "agree"))
    return "Передать подтверждённые примеры команде агента, согласовать правку и проверить новые ответы после неё.";
  return "Подтвердить оценку на примерах перед передачей задачи команде агента.";
}

/**
 * A short brief for the team, with the same number and words as the screen: «N из M — с ошибкой агента», and the
 * conversations with a serious error once a criterion is marked serious. It tells the serious problems first, marked
 * «серьёзная», then the most frequent: all the serious ones, and at least three. Complete criteria and evidence remain
 * in the saved check, linked from the brief («История» of tone of voice). Links open Agent Lab on the computer where
 * the check ran; the brief says so, since it travels by e-mail.
 */
export function toneBrief(data: Problems, result: Discover, base: string, { filename }: { filename?: string }): string {
  const criteria = result.topics.flatMap((topic) => topic.rules);
  const quotes = new Set(criteria.map((criterion) => criterion.quote));
  const rules = data.rules.filter((rule) => quotes.has(rule.rule.quote));
  const found = rules
    .filter((rule) => rule.log.failed > 0)
    .sort((a, b) => seriousFirst(a, b) || b.log.failed - a.log.failed);
  const grave = found.filter((rule) => rule.serious).length;
  const top = found.slice(0, Math.max(3, grave));
  const serious = seriousOf({ ...data, rules });
  const { measured, failed, passed, unmeasured } = result.summary;
  const reviews = rules.flatMap((rule) => rule.log.examples).filter((example) => example.review);
  const agrees = reviews.filter((example) => example.review === "agree").length;
  const origin = base.replace(/\/$/, "");
  const saved = result.checkId ? `${origin}${historyLink("tone", result.checkId)}` : null;
  const lines = [
    "# Tone of voice: сводка для команды",
    "",
    `Проверка завершена: ${date(result.finishedAt)}.`,
    ...(filename ? [`Выгрузка: ${short(filename, 160)}.`] : []),
    `Выборка: ${count(result.sampled, "разговор", "разговора", "разговоров")}. Критериев: ${criteria.length}.`,
    measured
      ? `С ошибкой агента: ${failed} из ${count(measured, "проверенного разговора", "проверенных разговоров", "проверенных разговоров")} (${pct(failed, measured)}%).`
      : `Ни один разговор не удалось проверить.`,
    ...(measured && serious ? [seriousText(serious, "people")] : []),
    `Без найденных ошибок: ${passed}. Не удалось проверить: ${unmeasured} из ${result.sampled}; в счёт они не входят.`,
    `Ответы человека по отдельным оценкам критериев: ${reviews.length}; согласие с оценкой — ${agrees}, несогласие — ${reviews.length - agrees}. Это число оценок, а не разговоров.`,
    "",
    "Автоматическая оценка относится к выбранным критериям и этой выборке. Процент не измеряет точность самого оценщика.",
    "",
  ];
  if (!top.length)
    lines.push(
      measured ? "## По выбранным критериям ошибок не найдено" : "## Проверка не дала достаточной оценки",
      "",
      measured
        ? "Следующее действие: вручную просмотреть несколько разговоров без найденных ошибок и проверить, не пропускает ли оценщик важные случаи."
        : "Следующее действие: посмотреть причины неоценённых разговоров, проверить настройки модели и повторить оценку.",
      "",
    );
  for (const [index, problem] of top.entries()) {
    const criterion = criteria.find((item) => item.quote === problem.rule.quote);
    const errors = problem.log.examples.filter((example) => example.status === "FAIL");
    const example =
      errors.find((e) => e.review === "agree") ?? errors.find((e) => e.review !== "disagree") ?? errors[0];
    lines.push(
      `## ${index + 1}. ${headingOf({ ...problem, title: short(problem.title, 140) })}`,
      "",
      `Ошибка найдена в ${problem.log.failed} из ${count(problem.log.failed + problem.log.passed, "разговора", "разговоров", "разговоров")}, в которых удалось проверить этот критерий. Не удалось проверить критерий: ${problem.log.unknown}.`,
      "",
      "Основание — фрагмент документа:",
      problem.rule.quote ? quote(problem.rule.quote) : "Цитата источника не сохранена.",
      ...(problem.rule.quote.trim().length > 300 ? ["… Продолжение — в полном основании ниже."] : []),
      ...(problem.rule.condition
        ? [
            `Условие применения${problem.rule.condition.length > 180 ? " (фрагмент)" : ""}: ${short(problem.rule.condition, 180)}`,
          ]
        : []),
      ...(problem.rule.acceptable
        ? [
            `Исключения и допустимое${problem.rule.acceptable.length > 180 ? " (фрагмент)" : ""}: ${short(problem.rule.acceptable, 180)}`,
          ]
        : []),
      ...(criterion?.clarifications?.length
        ? [`Уточнения команды (фрагмент): ${short(criterion.clarifications.join("; "), 200)}`]
        : []),
    );
    if (example)
      lines.push(
        "",
        `Пример${example.dialogueId ? ` — разговор ${short(example.dialogueId, 80)}` : ""}:`,
        `Клиент${example.opening.length > 160 ? " (фрагмент)" : ""}: ${short(example.opening, 160)}`,
        `Реплика агента${example.agentQuote.length > 300 ? " (фрагмент)" : ""}:\n${quote(example.agentQuote || "Цитата не сохранена.")}`,
        ...(example.agentQuote.length > 300 ? ["… Продолжение — в сохранённом разговоре."] : []),
        `Объяснение оценки${example.reason.length > 300 ? " (фрагмент)" : ""}: ${short(example.reason)}`,
        `Проверка примера: ${reliabilityWord(example)}.`,
      );
    lines.push("", `Следующее действие: ${nextAction(problem)}`, "");
    if (!saved) lines.push(`Полное основание в Agent Lab: ${origin}${problemLink(problem.id, "tone")}`, "");
  }
  if (found.length > top.length)
    lines.push(
      `В сводке — ${grave >= 3 ? "серьёзные проблемы" : grave ? "серьёзные проблемы и самые частые из остальных" : "три наиболее частые проблемы"}. Полный список доступен в результате проверки.`,
      "",
    );
  if (saved)
    lines.push(
      "## Полное основание проверки",
      "",
      `[Сохранённые разговоры, критерии, условия и исключения](${saved}).`,
      "Фрагменты выше сокращены. По ссылке — полные материалы на момент завершения проверки; ответы человека в этой сводке учтены на момент экспорта.",
    );
  else
    lines.push(
      "Числа и текст — на момент выгрузки отчёта. Ссылки открывают Agent Lab на компьютере, где шла проверка, и показывают текущее состояние: после новой выгрузки разговоров оно изменится.",
    );
  return lines.join("\n");
}
