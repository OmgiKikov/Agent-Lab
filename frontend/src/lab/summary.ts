import { agentKey } from "../app/agent";
import { answersText, type Answers } from "./answers";
import { CHECK_NAME, CHECKS } from "./checks";
import { count, pct, plural } from "./format";
import { cleanPct } from "./history";
import { importanceTag, masked, masksLine } from "./problemReport";
import { inQuotes, oneLine, ruleLines, splitQuote } from "./quote";
import type { Severity } from "./problems";
import { lineText, type Serious, type SeverityLine } from "./severity";
import type { Check } from "./types";

/**
 * «Сводка для руководителя»: one page of the agent for a person who
 * does not use the product. The page and the letter are told from this one model, so they never differ: numbers with
 * their denominators, people's answers and examples, and no verdict on the agent — the reader draws the conclusion.
 * No «промпт», conversation ids, file paths or the rubric's codes: the model found the errors, people answered.
 */
export type Summary = {
  agent: string;
  /** The dataset the checks read, by its name, and the days they were made, as a person says them. */
  dataset: string | null;
  days: string[];
  checks: SummaryCheck[];
  /** When the summary was put together: people's answers may be added after it. */
  madeAt: string;
};

export type SummaryCheck = {
  check: Check;
  day: string;
  /** The check's own count: of the conversations it could check, how many have an error of the agent. */
  measured: number;
  failed: number;
  unmeasured: number;
  answers: Answers;
  /**
   * The checked conversations with an error by an important criterion, once a criterion is important (lab/severity),
   * and their «было → стало» under the comparison of the whole check; none before.
   */
  serious: Serious | null;
  /**
   * What it says about important criteria, line by line, for people (lab/severity, severityLines): «С нарушением
   * важных критериев — 6 из 53 (11%).», «Важных критериев 2 из 8, их отметили люди.», where they apply when not in
   * every checked conversation; or «Важных критериев нет, так решили люди.» None while nothing is marked.
   */
  severity: SeverityLine[];
  /** «Прошлая проверка, 3 октября: 22 из 53 (42%) → сейчас 4 из 12 (33%). …» — the line of «Итог», or none. */
  compare: string | null;
  /** «С нарушением важных критериев: 3 из 53 (6%) → сейчас 6 из 53 (11%). …», or none. */
  seriousCompare: string | null;
  /**
   * Every problem of the check in the order of «Итог»: the important ones a person marked first, then the most frequent;
   * the ticked ones go into the PDF and the letter.
   */
  problems: SummaryProblem[];
};

export type SummaryProblem = {
  id: string;
  chosen: boolean;
  /** Its criterion is important: «важный» beside its name, with whose decision it is (`severity`). */
  serious: boolean;
  severity: Severity;
  /** Its criterion's name, as on every screen (lab/criteria, criterionName). */
  name: string;
  /** «Чаще всего: «…» — 12 из 57 ошибок.», when the most frequent kind of its errors is worth a line. */
  common: string | null;
  /** What the agent must do, in the criterion's words: a list on the page and points in the letter (lab/quote). */
  duty: string;
  failed: number;
  checked: number;
  /** People's answers on its errors: «да, ошибка» and «нет». */
  yes: number;
  no: number;
  example: SummaryExample | null;
};

/**
 * One reply of the agent with the words the model pointed at: the customer's message it answered, the whole reply when
 * the conversation is at hand (else only the words), and whether people answered that this was no error.
 */
export type SummaryExample = { customer: string | null; reply: string | null; quote: string; refuted: boolean };

/** What each check looks at, in words for someone outside the product. */
export const SUMMARY_WHAT: Record<Check, string> = {
  tone: "Соблюдает ли агент правила общения с клиентами: обращение, тон, ясность.",
  code: "Делает ли агент то, что требуют его инструкции: отвечает по базе знаний и ничего не выдумывает.",
};

/**
 * «Без найденных ошибок — 58% проверенных разговоров · с ошибкой агента 22 из 53»: the measurement first, as «Итог»
 * says it. With none checked there is no count to give, as on «Итог»
 * (product/StageResult): «Ни один из 60 разговоров не удалось проверить», never «0 из 0».
 */
export const headline = (c: SummaryCheck) =>
  c.measured
    ? `Без найденных ошибок — ${cleanPct(c)}% проверенных разговоров · с ошибкой агента ${c.failed}\u00a0из\u00a0${c.measured}`
    : `Ни один ${c.unmeasured ? `из\u00a0${count(c.unmeasured, "разговора", "разговоров", "разговоров")}` : "разговор"} не удалось проверить`;

/**
 * «Ещё 4 разговора не удалось проверить, в счёт они не входят.» — a separate number, never in the count. With none
 * checked the headline says it.
 */
export const unmeasuredText = (c: SummaryCheck) =>
  c.unmeasured && c.measured
    ? `Ещё ${count(c.unmeasured, "разговор", "разговора", "разговоров")} не удалось проверить, в счёт ${c.unmeasured === 1 ? "он не входит" : "они не входят"}.`
    : null;

/** «из 29 найденных», «из 21 найденной»: of the errors the model found. */
const ofFound = (n: number) => `${n}\u00a0${plural(n, "найденной", "найденных", "найденных")}`;

/**
 * People's «да» among their answers on errors, after «и»: «согласились с 3», «согласились с ней», «согласились со
 * всеми», «не согласились ни с одной».
 */
const agreement = (yes: number, answered: number) =>
  yes === answered
    ? answered === 1
      ? "согласились с ней"
      : "согласились со всеми"
    : yes
      ? `согласились с\u00a0${yes}`
      : answered === 1
        ? "не согласились с ней"
        : "не согласились ни с одной";

/**
 * «Ошибки нашла модель. Люди перепроверили 11 из 29 найденных и согласились с 10.» — or «…1 из 29 найденных и не
 * согласились с ней». Nothing when it could check no conversation: it found no errors only because it saw none.
 */
export function rechecked(a: Answers): string | null {
  const answered = a.confirmed + a.removed;
  if (!a.measured) return null;
  if (!a.errors) return "Модель ошибок не нашла.";
  return answered
    ? `Ошибки нашла модель. Люди перепроверили ${answered}\u00a0из\u00a0${ofFound(a.errors)} и ${agreement(a.confirmed, answered)}.`
    : `Ошибки нашла модель. Люди пока не перепроверяли ни одной из\u00a0${ofFound(a.errors)}.`;
}

/** «Ошибка в 57 из 89 проверенных разговоров, где критерий применим (64%).» */
export const problemCount = (p: SummaryProblem) =>
  `Ошибка в\u00a0${p.failed}\u00a0из\u00a0${count(p.checked, "проверенного разговора", "проверенных разговоров", "проверенных разговоров")}, где критерий применим (${pct(p.failed, p.checked)}%).`;

/** «Люди перепроверили 6 из 57 найденных и согласились с 5.», or that nobody did yet. */
export const problemAnswers = (p: SummaryProblem) =>
  p.yes + p.no
    ? `Люди перепроверили ${p.yes + p.no}\u00a0из\u00a0${ofFound(p.failed)} и ${agreement(p.yes, p.yes + p.no)}.`
    : "Люди эти ошибки ещё не перепроверяли.";

/** The quiet footnote: what each number is and what it does not say. */
export const HOW = [
  "«Без найденных ошибок» — доля проверенных разговоров, где модель не нашла ошибок: чем она выше, тем лучше. Это не значит, что ошибок нет: модель находит не всё. Разговоры, которые не удалось проверить, названы отдельно и в счёт не входят.",
  "«N из M» у проблемы: M — проверенные разговоры, где её критерий применим, N — те из них, где модель нашла ошибку. Процент рядом — доля этих разговоров с ошибкой: чем он ниже, тем лучше.",
  "«С учётом ответов людей» считает те же разговоры. Ошибка, которую человек снял, не считается, а ошибка, которую он нашёл сам, считается. Счёт модели от этого не меняется, и с прошлыми проверками сравнивают только его.",
  "С прошлой проверкой сравнивают, только если критерии и способ проверки те же. Если хотя бы с одной стороны меньше 30 разговоров, этого мало, чтобы судить.",
];

/** Said when the summary has both checks: their numbers are not added up. */
export const HOW_BOTH = "Tone of voice и Точность проверяют разное, их числа не складываются.";

/** Said once a criterion is important: that its count is part of the number, and who decides it. */
export const HOW_SERIOUS =
  "«С нарушением важных критериев» — проверенные разговоры, где нарушен хотя бы один важный критерий: одно такое нарушение может навредить клиенту или банку. Они уже входят в число разговоров с ошибкой агента. Какие критерии важные, предлагает модель, а люди подтверждают или меняют.";

/**
 * The footnote of a summary: with the line about two checks when it has both, and the line about important criteria
 * once a check of it has one.
 */
export const howOf = (s: Summary) => [
  ...HOW,
  ...(s.checks.length > 1 ? [HOW_BOTH] : []),
  ...(s.checks.some((c) => c.serious) ? [HOW_SERIOUS] : []),
];

/** A whole date with its year, for a page that leaves the product: «3 октября 2026 г.», never parted at a line's end. */
export const fullDay = (iso: string) =>
  new Date(iso)
    .toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })
    .replace(/\s/g, "\u00a0");

/** «проверено 3 октября 2026 г.», or both days when the checks were made on different ones. */
export const daysText = (days: string[]) => `проверено ${days.join(" и ")}`;

/** «Датасет «Чаты за сентябрь» · проверено 3 октября 2026 г.»: what the summary rests on, under its title. */
export const basisText = (s: Summary) =>
  [s.dataset ? `Датасет ${inQuotes(s.dataset)}` : null, daysText(s.days)].filter(Boolean).join(" · ");

/** A sentence ends with one full stop, also after «2026 г.» */
export const stop = (text: string) => (text.endsWith(".") ? text : `${text}.`);

/** «Сводка составлена 4 октября 2026 г.» */
export const madeText = (s: Summary) => stop(`Сводка составлена ${fullDay(s.madeAt)}`);

/** The words the model pointed at are the whole reply: a letter then has nothing to point at in it. */
const wholeReply = (reply: string, quote: string) => {
  const parts = splitQuote(reply, quote);
  return !!parts && !/[\p{L}\p{N}]/u.test(parts[0] + parts[2]);
};

/**
 * The words the model pointed at, closing a sentence: «…», and a full stop after it unless they end in their own —
 * kept as written, since a full stop may be the very error.
 */
const pointedAt = (quote: string) => `${inQuotes(quote)}${/[.!?…]$/.test(quote.trim()) ? "" : "."}`;

/** The examples of the ticked problems: the page and the letter show them under «Главное». */
const examplesOf = (s: Summary) =>
  s.checks.flatMap((c) => c.problems.flatMap((p) => (p.chosen && p.example ? [p.example] : [])));

/**
 * «В примерах # и * — скрытые данные клиента.» once under «Главное» when the examples of the ticked problems carry the
 * client data an export hides (lab/quote, MASKS); null when they do not.
 */
export function masksText(s: Summary): string | null {
  const examples = examplesOf(s);
  const quoted = examples.map((e) => ({ client: e.customer ?? "", agent: e.reply ?? e.quote }));
  return masked(quoted) ? masksLine(examples.length) : null;
}

/**
 * The summary as a letter (lab/problemReport, copyReport): the same as the page, the ticked problems only, each by its
 * criterion's name with what the agent must do as points (lab/quote, ruleLines). Headings, paragraphs and a quote: the
 * only Markdown the reports write; no line of the customer's, the agent's or the rules' words begins one of them.
 */
export function summaryMarkdown(s: Summary): string {
  const masks = masksText(s);
  const lines = [`# Сводка для руководителя: ${s.agent}`, "", stop(basisText(s))];
  for (const c of s.checks) {
    lines.push(
      "",
      `## ${CHECK_NAME[c.check]}${s.days.length > 1 ? ` · проверено ${c.day}` : ""}`,
      "",
      SUMMARY_WHAT[c.check],
      "",
      [`${headline(c)}.`, unmeasuredText(c)].filter(Boolean).join(" "),
      ...c.severity.map(lineText),
      // Who found the errors, then the count with people's answers: with none checked there is no «0 из 0» to give.
      ...[
        rechecked(c.answers),
        c.measured ? answersText(c.answers, "people") : null,
        c.compare,
        c.seriousCompare,
      ].filter((x): x is string => !!x),
    );
  }
  const chosen = s.checks.filter((c) => c.problems.some((p) => p.chosen));
  if (chosen.length) {
    lines.push("", "## Главное", ...(masks ? ["", masks] : []));
    for (const c of chosen) {
      lines.push("", `### ${CHECK_NAME[c.check]}`);
      for (const p of c.problems.filter((x) => x.chosen)) {
        lines.push(
          "",
          `#### ${p.name}${importanceTag(p)}`,
          "",
          ...(p.common ? [p.common] : []),
          problemCount(p),
          "",
          "Агент должен:",
          ...ruleLines(p.duty),
          "",
          problemAnswers(p),
        );
        const e = p.example;
        if (e) {
          // The customer's words and the reply as one quote, as the page puts them in one box.
          const said = [
            ...(e.customer ? [`Клиент: ${oneLine(e.customer)}`] : []),
            `Агент: ${e.reply ?? inQuotes(e.quote)}`,
          ];
          lines.push(...said.flatMap((part) => part.split("\n")).map((line) => `> ${line.trim()}`));
          if (e.reply && !wholeReply(e.reply, e.quote)) lines.push(`Модель указала на слова: ${pointedAt(e.quote)}`);
          if (e.refuted) lines.push("Люди ответили, что здесь ошибки нет.");
        }
      }
    }
  }
  lines.push("", "## Как считали", "", ...howOf(s), madeText(s));
  return lines.join("\n");
}

/** The problems a person ticked, by check; remembered in this browser, per agent. */
export type Chosen = Partial<Record<Check, string[]>>;
const CHOSEN = agentKey("lab.summary.chosen");

/** The ticks kept in this browser; none when storage is unavailable or holds something else. */
export function readChosen(): Chosen {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CHOSEN) ?? "null");
    if (!value || typeof value !== "object") return {};
    const chosen: Chosen = {};
    for (const check of CHECKS) {
      const ids = (value as Record<string, unknown>)[check];
      if (Array.isArray(ids)) chosen[check] = ids.filter((id): id is string => typeof id === "string");
    }
    return chosen;
  } catch {
    return {};
  }
}

export function writeChosen(chosen: Chosen) {
  try {
    localStorage.setItem(CHOSEN, JSON.stringify(chosen));
  } catch {
    /* a private window or blocked storage: the ticks last while the page is open */
  }
}

/** How many of a check's problems the summary takes when the person has not ticked any and marked none important. */
export const DEFAULT_CHOSEN = 3;

/**
 * The ticked problems of a check, given its problems with their errors and the ones a person marked important
 * (lab/problems, importantByPerson): the person's ticks that still exist, else the important problems, else the three
 * most frequent — a model's proposal ticks nothing. A person who unticked everything gets nothing; ticks that all
 * belong to criteria gone since (other rules, other code) count as none given.
 */
export function chosenOf(
  stored: string[] | undefined,
  problems: { id: string; failed: number }[],
  important: string[] = [],
): Set<string> {
  const ids = problems.map((p) => p.id);
  if (stored) {
    const known = stored.filter((id) => ids.includes(id));
    if (known.length || !stored.length) return new Set(known);
  }
  const marked = ids.filter((id) => important.includes(id));
  if (marked.length) return new Set(marked);
  const frequent = [...problems].sort((a, b) => b.failed - a.failed).slice(0, DEFAULT_CHOSEN);
  return new Set(frequent.map((p) => p.id));
}
