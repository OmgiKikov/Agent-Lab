import { agentKey } from "../app/agent";
import { answersText, yesNoText, type Answers } from "./answers";
import { CHECK_NAME, CHECKS } from "./checks";
import { count, pct, plural } from "./format";
import { cleanPct } from "./history";
import { headingOf, inlineText, quoteText } from "./problemReport";
import { splitQuote } from "./quote";
import type { Severity } from "./problems";
import { lineText, type Serious, type SeverityLine } from "./severity";
import type { Check } from "./types";

/**
 * «Сводка для руководителя»: one page of the agent for a person who
 * does not use the product. The page and the letter are told from this one model, so they never differ: numbers with
 * their denominators, people's answers and examples, and no verdict on the agent — the reader draws the conclusion.
 * No «промпт», «модель», conversation ids or file paths: «автоматическая проверка» found the errors.
 */
export type Summary = {
  agent: string;
  /** The export the checks read, and the days they were made, as a person says them. */
  file: string | null;
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
   * The checked conversations with a serious error, once a criterion is serious (lab/severity), and their «было →
   * стало» under the comparison of the whole check; none before.
   */
  serious: Serious | null;
  /**
   * What it says about serious errors, line by line, for people (lab/severity, severityLines): «С нарушением важных критериев
   * — 6 из 53 (11%)», «Важные критерии — 2 из 8. Их отметила автоматическая проверка, люди проверили 0 из 8.», where
   * they could be checked; or «Важных критериев нет. Так решили люди.» None while nothing is marked.
   */
  severity: SeverityLine[];
  /** «Прошлая проверка, 3 октября: 22 из 53 (42%) → сейчас 4 из 12 (33%). …» — the line of «Итог», or none. */
  compare: string | null;
  /** «С нарушением важных критериев: 3 из 53 (6%) → сейчас 6 из 53 (11%). …», or none. */
  seriousCompare: string | null;
  /** Every problem of the check, the serious ones first, then the most frequent; the ticked ones go into the PDF and the letter. */
  problems: SummaryProblem[];
};

export type SummaryProblem = {
  id: string;
  chosen: boolean;
  /** Its criterion is serious: «важный» beside its name, with whose decision it is (`severity`). */
  serious: boolean;
  severity: Severity;
  title: string;
  /** What the agent must do, in the criterion's words. */
  duty: string;
  failed: number;
  checked: number;
  /** People's answers on its errors: «да, ошибка» and «нет». */
  yes: number;
  no: number;
  example: SummaryExample | null;
};

/**
 * One reply of the agent with the words the check pointed at: the customer's message before it, the whole reply when
 * the conversation is at hand (else only the words), and whether people answered that this was no error.
 */
export type SummaryExample = { customer: string | null; reply: string | null; quote: string; refuted: boolean };

/** What each check looks at, in words for someone outside the product. */
export const SUMMARY_WHAT: Record<Check, string> = {
  tone: "Соблюдает ли агент правила общения с клиентами: обращение, тон, ясность.",
  code: "Делает ли агент то, что требуют его инструкции: отвечает по базе знаний и ничего не выдумывает.",
};

const ofConversations = (n: number) => count(n, "разговора", "разговоров", "разговоров");

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

/** «из 29 найденных», «из 21 найденной»: of the errors the check found. */
const ofFound = (n: number) => `${n}\u00a0${plural(n, "найденной", "найденных", "найденных")}`;

/**
 * «Ошибки нашла автоматическая проверка. Люди перепроверили 11 из 29 найденных и согласились с 10.» Nothing when it
 * could check no conversation: it found no errors only because it saw none.
 */
export function rechecked(a: Answers): string | null {
  const answered = a.confirmed + a.removed;
  if (!a.measured) return null;
  if (!a.errors) return "Автоматическая проверка ошибок не нашла.";
  return answered
    ? `Ошибки нашла автоматическая проверка. Люди перепроверили ${answered}\u00a0из\u00a0${ofFound(a.errors)} и согласились с\u00a0${a.confirmed}.`
    : `Ошибки нашла автоматическая проверка. Люди пока не перепроверяли ни одной из\u00a0${ofFound(a.errors)}.`;
}

/** «Ошибка в 6 из 52 разговоров (12%)» — of the conversations where it could be checked. */
export const problemCount = (p: SummaryProblem) =>
  `Ошибка в\u00a0${p.failed}\u00a0из\u00a0${ofConversations(p.checked)} (${pct(p.failed, p.checked)}%)`;

/** «Люди перепроверили 6 из 6 найденных: 5 — ошибка, 1 — нет.» */
export const problemAnswers = (p: SummaryProblem) =>
  p.yes + p.no
    ? `Люди перепроверили ${p.yes + p.no}\u00a0из\u00a0${ofFound(p.failed)}: ${yesNoText(p.yes, p.no)}.`
    : "Люди эти ошибки ещё не перепроверяли.";

/** The quiet footnote: what the numbers count and what they do not say. */
export const HOW = [
  "«N из M» значит, что автоматическая проверка смогла оценить M разговоров и в N из них нашла ошибку агента. Процент рядом — доля проверенных разговоров без найденных ошибок: чем он выше, тем лучше. Разговоры, которые не удалось проверить, названы отдельно и в счёт не входят.",
  "«Без найденных ошибок» не значит, что ошибок нет. Проверка находит не всё.",
  "«С учётом ответов людей» считает те же разговоры. Ошибка, которую человек снял, не считается, а ошибка, которую он нашёл сам, считается. Число автоматической проверки от этого не меняется, и с прошлыми проверками сравнивают только его.",
  "С прошлой проверкой сравнивают, только если критерии и способ проверки те же. Если хотя бы с одной стороны меньше 30 разговоров, этого мало, чтобы судить.",
];

/** Said when the summary has both checks: their numbers are not added up. */
export const HOW_BOTH = "Tone of voice и Точность проверяют разное, их числа не складываются.";

/** Said once a criterion is serious: that its count is part of the number, and who decides it. */
export const HOW_SERIOUS =
  "«С нарушением важных критериев» — проверенные разговоры, где нарушен хотя бы один важный критерий: одно такое нарушение может навредить клиенту или банку. Они уже входят в число разговоров с ошибкой агента. Какие критерии важные, предлагает автоматическая проверка, а люди подтверждают или меняют.";

/**
 * The footnote of a summary: with the line about two checks when it has both, and the line about serious errors once
 * a check of it has a serious criterion.
 */
export const howOf = (s: Summary) => [
  ...HOW,
  ...(s.checks.length > 1 ? [HOW_BOTH] : []),
  ...(s.checks.some((c) => c.serious) ? [HOW_SERIOUS] : []),
];

/** A whole date with its year, for a page that leaves the product: «3 октября 2026 г.» */
export const fullDay = (iso: string) =>
  new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });

/** «проверено 3 октября 2026 г.», or both days when the checks were made on different ones. */
export const daysText = (days: string[]) => `проверено ${days.join(" и ")}`;

/** A sentence ends with one full stop, also after «2026 г.» */
export const stop = (text: string) => (text.endsWith(".") ? text : `${text}.`);

/** «Сводка составлена 4 октября 2026 г.» */
export const madeText = (s: Summary) => stop(`Сводка составлена ${fullDay(s.madeAt)}`);

/** «…» closing a sentence: the quote's own full stop goes after the closing mark; «!», «?» and «…» stay and end it. */
const quoted = (quote: string) => {
  const text = quote.trim();
  return /[!?…]$/.test(text) ? `«${text}»` : `«${text.replace(/\.$/, "")}».`;
};

/** The words the check pointed at are the whole reply: a letter then has nothing to point at in it. */
const wholeReply = (reply: string, quote: string) => {
  const parts = splitQuote(reply, quote);
  return !!parts && !/[\p{L}\p{N}]/u.test(parts[0] + parts[2]);
};

/**
 * The summary as a letter (lab/problemReport, copyReport): the same as the page, the ticked problems only. Headings,
 * paragraphs and a quote: the only Markdown the reports write. The words of the customer, the agent and the criteria
 * stay words (inlineText, quoteText): never a link, a heading or a quote of their own.
 */
export function summaryMarkdown(s: Summary): string {
  const lines = [
    `# Сводка для руководителя: ${inlineText(s.agent)}`,
    "",
    stop([s.file ? `Датасет «${inlineText(s.file)}»` : null, daysText(s.days)].filter(Boolean).join(" · ")),
  ];
  for (const c of s.checks) {
    lines.push(
      "",
      `## ${CHECK_NAME[c.check]}${s.days.length > 1 ? ` · проверено ${c.day}` : ""}`,
      "",
      SUMMARY_WHAT[c.check],
      "",
      [`${headline(c)}.`, unmeasuredText(c)].filter(Boolean).join(" "),
      ...c.severity.map(lineText),
      // People's answers count the checked conversations: with none checked there is no «0 из 0» to give.
      ...[
        c.measured ? answersText(c.answers, "people") : null,
        c.compare,
        c.seriousCompare,
        rechecked(c.answers),
      ].filter((x): x is string => !!x),
    );
  }
  const chosen = s.checks.filter((c) => c.problems.some((p) => p.chosen));
  if (chosen.length) {
    lines.push("", "## Главное");
    for (const c of chosen) {
      lines.push("", `### ${CHECK_NAME[c.check]}`);
      for (const p of c.problems.filter((x) => x.chosen)) {
        lines.push(
          "",
          `#### ${headingOf(p)}`,
          "",
          `Агент должен: ${inlineText(p.duty)}`,
          `${problemCount(p)}.`,
          problemAnswers(p),
        );
        const e = p.example;
        if (e) {
          lines.push("");
          if (e.customer) lines.push(`Клиент: ${inlineText(e.customer)}`);
          lines.push(quoteText(`Агент: ${e.reply ?? `«${e.quote}»`}`));
          if (e.reply && !wholeReply(e.reply, e.quote))
            lines.push(`Проверка указала на слова: ${quoted(inlineText(e.quote))}`);
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

/** How many of a check's problems the summary takes when the person has not ticked any and none is serious. */
export const DEFAULT_CHOSEN = 3;

/**
 * The ticked problems of a check, given its problems (serious first, then the most frequent) and the serious ones among
 * them: the person's ticks that still exist, else the serious problems, else the most frequent three. A person who
 * unticked everything gets nothing; ticks that all belong to criteria gone since (other rules, other code) count as
 * none given.
 */
export function chosenOf(stored: string[] | undefined, problems: string[], serious: string[] = []): Set<string> {
  if (stored) {
    const known = stored.filter((id) => problems.includes(id));
    if (known.length || !stored.length) return new Set(known);
  }
  const grave = problems.filter((id) => serious.includes(id));
  return new Set(grave.length ? grave : problems.slice(0, DEFAULT_CHOSEN));
}
