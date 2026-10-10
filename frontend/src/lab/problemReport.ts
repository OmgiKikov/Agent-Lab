import { AGENT, shareBase } from "../app/agent";
import { problemLink } from "../app/links";
import { useAgents } from "./agents";
import { CHECK_NAME } from "./checks";
import { commonText, commonTitle, criterionName, type Criterion } from "./criteria";
import { count, day, pct } from "./format";
import { askedOf, importantByPerson, type Example, type Problems, type RuleEntry, type Side } from "./problems";
import { clip, inQuotes, MASKS, ruleLines, showsMasks } from "./quote";
import { seriousFirst, severityText } from "./severity";

const SOURCE_LABEL: Record<string, string> = {
  prompt: "Инструкции агента",
  tools: "Инструменты агента",
  "tone-of-voice": "Правила общения",
};
export const sourceLabel = (kind: string) => SOURCE_LABEL[kind] ?? "Источник критерия";

/** A word that begins a sentence. */
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** One full stop at the end: a model's reason comes with it or without. */
const sentence = (text: string) => (/[.!?…]$/.test(text) ? text : `${text}.`);

/**
 * Markdown's marks in a text a Markdown file quotes, escaped (CommonMark backslash escapes): «[…](…)», «<…>»,
 * «**…**», «_…_», «~~…~~», «#», «|» and «`» stay the characters they are. The copy and the plain text read them back
 * as written (pieces).
 */
const marks = (text: string) => text.replace(/[\\`*_~[\]<>#|]/g, "\\$&");

/**
 * A line of a Markdown file that holds someone else's words: its marks escaped, and what would begin a list, a rule or
 * a heading at its start escaped too, so it stays the line it is.
 */
const markdownLine = (line: string) =>
  marks(line.trim())
    .replace(/^([-+=])/, "\\$1")
    .replace(/^(\d+)([.)])/, "$1\\$2");

/**
 * Someone else's text inside a line of a Markdown file (a conversation saved for a ticket): on one line, since its line
 * breaks would start blocks of their own (a heading, a quote), and with its marks escaped, so a «[link](…)» in it stays
 * words and none of its addresses becomes a link.
 */
export const inlineText = (text: string) => marks(text.replace(/\s+/g, " ").trim());

/** Someone else's text of several lines as a quote of a Markdown file: every line «> …», escaped (markdownLine). */
export const quoteText = (text: string) =>
  text
    .split("\n")
    .map((line) => `> ${markdownLine(line)}`)
    .join("\n");

/** «Агент «Агент эквайринга».»: the first line under a report's heading, so a report never goes out about another agent. */
export const agentLine = (agent: string) => `Агент ${inQuotes(agent)}.`;

/** The name of a report's file: what it is and, since every agent's reports look alike, which agent (its address). */
export const reportFile = (name: string) => `${name}${AGENT ? `-${AGENT}` : ""}.md`;

/**
 * The agent of the page as a report names it (agentLine). Null while the list of agents loads, and a report waits for
 * it: it never goes out under a placeholder. `failed` when the list could not be loaded or has no such agent; `retry`
 * asks again.
 */
export function useReportAgent(): { name: string | null; failed: boolean; retry: () => void } {
  const agents = useAgents();
  const agent = agents.data?.find((a) => a.id === AGENT);
  return {
    name: agent?.name ?? null,
    failed: agents.isError || (!!agents.data && !agent),
    retry: () => void agents.refetch(),
  };
}

/**
 * How well an example is backed, in words: a person's answer first, then whether the two automatic checks (two models
 * of different vendors) agree. The order of examples follows it. With neither, it says so plainly: «проверено один раз»
 * read as if a person had already looked. The person reading («вы»), or, in a report someone else reads, «человек».
 */
export function reliabilityWord(e: Example, who: "you" | "people" = "you"): string {
  const you = who === "you";
  if (e.review === "agree") return you ? "вы подтвердили" : "подтвердил человек";
  if (e.review === "disagree") return you ? "вы не согласились" : "человек не согласился";
  if (e.second === "agree") return "две модели совпали";
  if (e.second === "disagree") return "модели разошлись";
  return you ? "вы ещё не отвечали" : "человек ещё не проверял";
}

/** The second check in a sentence, for a person; the model's name only where an engineer asks for it. */
export function secondLine(e: Example, model: string | null): string {
  // Without a second check (one model by default) there is nothing to say about it.
  if (!e.second) return "";
  const who = model ? `Вторая проверка (${model})` : "Вторая проверка";
  if (e.secondScope === "dialogue")
    return e.secondStatus === "FAIL"
      ? `${who} смотрела разговор целиком и нашла в нём ошибку.`
      : `${who} смотрела разговор целиком и ошибок не нашла.`;
  return e.second === "agree" ? "Две модели совпали." : "Модели разошлись. Нужен ваш ответ.";
}

type Source = "log" | "sim";

/** The criteria one stage checked: with an error or without one in some conversation of that stage. */
export const checkedIn = (data: Problems, source: Source) =>
  data.rules.filter((r) => r[source].failed + r[source].passed > 0);

/** «Агент ошибается по 6 из 18 критериев» in one source, or the good result said as plainly. */
export function summarySentence(data: Problems, source: Source): string {
  const total = checkedIn(data, source).length;
  const failed = data.rules.filter((r) => r[source].failed > 0).length;
  if (failed)
    return `Агент ошибается по\u00a0${failed}\u00a0из\u00a0${count(total, "критерия", "критериев", "критериев")}`;
  const n = source === "log" ? (data.log?.assessed ?? 0) : (data.sim?.assessed ?? 0);
  if (!n) return "Разговоры пока не удалось проверить";
  return `Ошибок не нашли ни по одному из\u00a0${count(total, "критерия", "критериев", "критериев")} в\u00a0${count(n, "разговоре", "разговорах", "разговорах")}`;
}

/** The words of a conversation a text quotes of an error, by whose they are: the client's and the agent's. */
export type Quoted = { client: string; agent: string };

/**
 * Whether the quoted words show the client data an export hides (lab/quote, showsMasks): named once where a text that
 * leaves the product quotes them (masksLine).
 */
export const masked = (quoted: Quoted[]) =>
  quoted.some((q) => showsMasks(q.client, true) || showsMasks(q.agent, false));

/**
 * «В примерах # и * — скрытые данные клиента.», once under the examples of a text that has them, after a word of the
 * sentence: a line of a report never begins with «#» (a heading in Markdown, a list in a tracker).
 */
export const masksLine = (examples: number) => `В ${examples === 1 ? "примере" : "примерах"} ${MASKS}.`;

/** The words a text quotes of an error: the customer's the reply answered (askedOf) and the agent's. */
export const quotedOf = (e: Example): Quoted => ({ client: askedOf(e), agent: e.agentQuote });

/** How many characters of someone's words a text quotes at most: a customer's message, the agent's words, a reason. */
const QUOTED = 300;

/** A criterion of a text that leaves the product, named as on every screen (lab/criteria); a text numbers nothing. */
export const criterionOf = (r: RuleEntry): Criterion => ({ r, n: 0, name: criterionName(r), every: false, topics: [] });

/**
 * The order a text tells the problems of one side in, as «Итог» does (lab/severity, seriousFirst): the criteria a
 * person marked important first, then the most frequent; a model's proposal moves nothing.
 */
export const importantFirst =
  (side: Source) =>
  (a: RuleEntry, b: RuleEntry): number =>
    seriousFirst(a, b) || b[side].failed - a[side].failed;

/**
 * « · важный критерий» after a problem's name when a person marked its criterion important, « · важный по мнению
 * модели» while only the model proposed it, as the screens tag it (lab/severity, importantWord); nothing for the others.
 */
export const importanceTag = (r: Pick<RuleEntry, "serious" | "severity">) =>
  importantByPerson(r) ? " · важный критерий" : r.serious ? " · важный по мнению модели" : "";

/** «Простой и понятный язык · важный критерий»: a problem by its criterion's name, as a report heads it. */
export const headingOf = (c: Criterion) => `${c.name}${importanceTag(c.r)}`;

/** «Чаще всего: «Пишет „нажмите на кнопку“…» — 12 из 57 ошибок.», as under a problem's name on the screens. */
export function commonLine(c: Criterion, side: Source = "log"): string | null {
  const common = commonTitle(c, side);
  return common && `${commonText(common)}.`;
}

/** «Ошибка в 57 из 89 проверенных разговоров, где критерий применим (64%).»: a criterion's count, as on «Итог». */
function errorsLine(s: Pick<Side, "failed" | "passed">): string {
  const applies = s.failed + s.passed;
  return `Ошибка в\u00a0${s.failed}\u00a0из\u00a0${count(applies, "проверенного разговора", "проверенных разговоров", "проверенных разговоров")}, где критерий применим (${pct(s.failed, applies)}%).`;
}

/**
 * «Ещё в 5 разговорах критерий не удалось проверить, в 3 он не применим. В счёт они не входят.»: the checked
 * conversations a criterion's count leaves out, only the parts there are; null without any. Those it does not apply to
 * are the service's count; a service without it leaves the check's checked conversations (`assessed`) beyond the rest.
 */
function restLine(s: Side, assessed?: number): string | null {
  const notApplicable =
    s.notApplicable ?? (assessed === undefined ? 0 : Math.max(0, assessed - s.failed - s.passed - s.unknown));
  const conversations = (n: number) => count(n, "разговоре", "разговорах", "разговорах");
  const parts = [
    s.unknown ? `в\u00a0${conversations(s.unknown)} критерий не удалось проверить` : null,
    notApplicable && s.unknown ? `в\u00a0${notApplicable} он не применим` : null,
    notApplicable && !s.unknown ? `в\u00a0${conversations(notApplicable)} критерий не применим` : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  return `Ещё ${parts.join(", ")}. В счёт ${s.unknown + notApplicable === 1 ? "он не входит" : "они не входят"}.`;
}

/** The same words, whatever the headings, the codes, the marks and the spaces between them. */
const wordsOf = (text: string) =>
  ruleLines(text)
    .join(" ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * What the agent must do as points (lab/quote, ruleLines), the same words «Критерии» shows, and where it is written.
 * The rules' own words follow only where they say more than the criterion: a rubric's criterion is its passage itself.
 */
function dutyLines(r: RuleEntry): string[] {
  const duty = ruleLines(r.rule.text);
  if (!duty.length) return [];
  const where = [SOURCE_LABEL[r.rule.kind]?.toLowerCase(), r.rule.origin && inQuotes(r.rule.origin)].filter(Boolean);
  const source = where.length ? `Источник: ${where.join(" ")}.` : "";
  const quote = r.rule.quote && wordsOf(r.rule.quote) !== wordsOf(r.rule.text) ? ruleLines(r.rule.quote) : [];
  return [
    "Агент должен:",
    ...duty,
    ...(quote.length ? [`${source} Там написано:`.trim(), ...quote] : r.rule.origin ? [source] : []),
  ];
}

/** The error a text tells of a criterion: one a person confirmed, else one nobody refuted, else the first. */
export const proofOf = (errors: Example[]): Example | undefined =>
  errors.find((e) => e.review === "agree") ?? errors.find((e) => e.review !== "disagree") ?? errors[0];

/** The errors of one side of a criterion, in the service's order: the best-backed first. */
export const errorsOf = (s: Side) => s.examples.filter((e) => e.status === "FAIL");

/**
 * One error as a text tells it: the customer's words the reply answered (lab/problems, askedOf), the agent's words
 * the model pointed at, why it is an error and who checked it. Long words are cut at a word (lab/quote, clip).
 */
function exampleLines(e: Example): string[] {
  const asked = askedOf(e).trim();
  return [
    "Пример:",
    ...(asked ? [`Клиент: ${clip(asked, QUOTED)}`] : []),
    ...(e.agentQuote.trim() ? [`Агент: ${inQuotes(clip(e.agentQuote, QUOTED))}`] : []),
    ...(e.reason.trim() ? [`Почему это ошибка: ${sentence(capital(clip(e.reason, QUOTED)))}`] : []),
    `${capital(reliabilityWord(e, "people"))}.`,
  ];
}

/**
 * A problem as every text that leaves the product tells it, in the words of «Итог»: the kind of error named most
 * often, how often among the checked conversations where the criterion applies and what that count leaves out, what
 * the agent must do as points, and one error (`proof`). Blocks are parted by an empty line; no line begins with a mark
 * of Markdown, so the text reads the same as plain text and as Markdown.
 */
export function problemLines(c: Criterion, side: Source, proof: Example | undefined, assessed?: number): string[] {
  const s = c.r[side];
  const duty = dutyLines(c.r);
  return [
    ...[commonLine(c, side), errorsLine(s), restLine(s, assessed)].filter((line): line is string => !!line),
    ...(duty.length ? ["", ...duty] : []),
    ...(proof ? ["", ...exampleLines(proof)] : []),
  ];
}

/**
 * «Задача для разработчика»: one problem as a task for the agent's team, pasted into a tracker — its name, the agent
 * (agentLine), the problem (problemLines), the hidden client data named when the example has it, and the link back.
 * Plain text that reads the same as Markdown: no line begins with «#», «*» or «-», and nothing needs escaping.
 */
export function handoffText(r: RuleEntry, link: string, { side, agent }: { side: Source; agent?: string }): string {
  const c = criterionOf(r);
  const proof = proofOf(errorsOf(r[side]));
  return [
    headingOf(c),
    "",
    ...(agent ? [agentLine(agent)] : []),
    ...problemLines(c, side, proof),
    ...(proof && masked([quotedOf(proof)]) ? [masksLine(1)] : []),
    "",
    `Проблема в Agent Lab: ${link}`,
  ].join("\n");
}

/**
 * The problems of one source of a check as a Markdown file: its conversations and its simulation are never told
 * together. It names its agent first (agentLine), and the conversations name their dataset, as the tone-of-voice brief
 * does; under their numbers the conversations with an error by an important criterion with whose decision that is
 * (lab/severity, severityText). The problems a person marked important first, then the most frequent, each told as
 * every text tells it (problemLines) with the words of others in its lines escaped (markdownLine): a reason's «**…**»
 * or a reply's «[…](…)» stays words in a Markdown viewer, and the copy reads them back (pieces).
 */
export function problemsReport(
  data: Problems,
  base: string,
  source: Source,
  { filename, agent }: { filename?: string; agent?: string } = {},
): string {
  const lines = [
    `# ${summarySentence(data, source)}`,
    "",
    ...(agent ? [markdownLine(agentLine(agent))] : []),
    `Проверка «${CHECK_NAME[data.check]}».`,
  ];
  if (source === "log" && data.log && filename) lines.push(markdownLine(`Датасет ${inQuotes(filename)}.`));
  if (source === "log" && data.log) {
    lines.push(
      `Разговоры ${day(data.log.finishedAt)}: проверено ${data.log.assessed}\u00a0из\u00a0${count(data.log.sampled, "разговора", "разговоров", "разговоров")}.`,
      `С ошибкой агента — ${data.log.withViolations}, не удалось проверить — ${data.log.unassessed}.`,
    );
    const severity = severityText(data);
    if (severity) lines.push(severity);
  }
  if (source === "sim" && data.sim)
    lines.push(
      `Симуляция ${data.sim.target} · ${data.sim.version}, ${day(data.sim.finishedAt)}: проверено ${data.sim.assessed}\u00a0из\u00a0${count(data.sim.dialogs, "разговора", "разговоров", "разговоров")}.`,
      `С ошибкой агента — ${data.sim.withViolations}, не удалось проверить — ${data.sim.unassessed}.`,
    );
  const list = data.rules
    .filter((r) => r[source].failed > 0)
    .sort(importantFirst(source))
    .map(criterionOf);
  const proofs = list.map((c) => proofOf(errorsOf(c.r[source])));
  const shown = proofs.filter((e): e is Example => !!e);
  if (masked(shown.map(quotedOf))) lines.push(masksLine(shown.length));
  const assessed = source === "log" ? data.log?.assessed : data.sim?.assessed;
  list.forEach((c, i) =>
    lines.push(
      "",
      `## ${markdownLine(headingOf(c))}`,
      "",
      ...problemLines(c, source, proofs[i], assessed).map(markdownLine),
      "",
      `${base}${problemLink(c.r.id, source === "sim" ? "sim" : data.check, data.sim?.runId)}`,
    ),
  );
  return lines.join("\n");
}

/** A heading, a quote or a paragraph of a report: the only Markdown the reports write (problemsReport, toneBrief). */
type Block = { kind: "h"; level: number; text: string } | { kind: "quote" | "p"; lines: string[] };

function blocksOf(markdown: string): Block[] {
  const blocks: Block[] = [];
  for (const line of markdown.split("\n").map((l) => l.trimEnd())) {
    const heading = /^(#{1,6}) +(.*)$/.exec(line);
    const quoted = /^> ?(.*)$/.exec(line);
    const kind = quoted ? "quote" : "p";
    const last = blocks[blocks.length - 1];
    if (heading) blocks.push({ kind: "h", level: heading[1].length, text: heading[2] });
    else if (!line) blocks.push({ kind: "p", lines: [] });
    else if (last && last.kind === kind && last.lines.length) last.lines.push(quoted ? quoted[1] : line);
    else blocks.push({ kind, lines: [quoted ? quoted[1] : line] });
  }
  return blocks.filter((b) => b.kind === "h" || b.lines.length);
}

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A piece of a line of a report: words, or a link of the report's own to a place of this Lab (`href`). */
type Piece = { text: string; href?: string };

/** An address of this Lab inside the page's agent (shareBase): the only addresses a report links. */
const ownAddress = (href: string, base: string) =>
  href === base || href.startsWith(`${base}/`) || href.startsWith(`${base}?`);

/**
 * A line of a report in pieces. «[text](address)» and a bare address become links only when the address is this
 * Lab's own (`base`): the report's own links. Any other address stays the words it is, never a link a customer or the
 * agent could have written, and a mark a Markdown file escaped is its character again (markdownLine, inlineText,
 * quoteText). The letter and the summary write others' words unescaped: there a backslash before a mark is read the
 * same way.
 */
function pieces(line: string, base: string): Piece[] {
  const out: Piece[] = [];
  let words = "";
  let at = 0;
  for (const m of line.matchAll(
    /\\([!-/:-@[-`{-~])|\[([^\]\\]+)\]\((https?:\/\/[^\s)\\]+)\)|(https?:\/\/[^\s<>«»"\\]+)/g,
  )) {
    words += line.slice(at, m.index);
    at = m.index + m[0].length;
    const href = m[3] ?? m[4];
    if (!href || !ownAddress(href, base)) {
      words += m[1] ?? m[0];
      continue;
    }
    if (words) out.push({ text: words });
    words = "";
    out.push({ text: m[2] ?? href, href });
  }
  words += line.slice(at);
  return words ? [...out, { text: words }] : out;
}

/** A line as HTML: the report's own links to this Lab as links, every other word as text. */
const inline = (line: string, base: string) =>
  pieces(line, base)
    .map((p) => (p.href ? `<a href="${escape(p.href)}">${escape(p.text)}</a>` : escape(p.text)))
    .join("");

/** The report as an e-mail shows it: headings, quotes, paragraphs and its own links to this Lab (`base`). */
export function reportHtml(markdown: string, base = shareBase()): string {
  const line = (text: string) => inline(text, base);
  const html = blocksOf(markdown).map((b) =>
    b.kind === "h"
      ? `<h${Math.min(b.level, 4)}>${line(b.text)}</h${Math.min(b.level, 4)}>`
      : b.kind === "quote"
        ? `<blockquote style="margin:0 0 0 4px;padding-left:12px;border-left:3px solid #d6d6d6">${b.lines.map(line).join("<br>")}</blockquote>`
        : `<p>${b.lines.map(line).join("<br>")}</p>`,
  );
  return `<div>${html.join("\n")}</div>`;
}

/**
 * A line of a report as plain words, without Markdown marks: a link of its own is its words and its address, an
 * escaped mark its character; anything else stays as written.
 */
export const plainLine = (line: string, base = shareBase()) =>
  pieces(line, base)
    .map((p) => (p.href && p.text !== p.href ? `${p.text}: ${p.href}` : p.text))
    .join("");

/** The report as text, without Markdown marks: no «#», «>», «[…](…)» or escapes (plainLine). */
export function reportText(markdown: string, base = shareBase()): string {
  return blocksOf(markdown)
    .map((b) => (b.kind === "h" ? [b.text] : b.lines).map((line) => plainLine(line, base)).join("\n"))
    .join("\n\n");
}

/**
 * «Скопировать» a report for a letter or a messenger: formatted (text/html) and as plain text without Markdown marks
 * (text/plain), so each place takes what it shows; only the text where the browser cannot put both. The downloaded
 * file stays Markdown.
 */
export async function copyReport(markdown: string): Promise<void> {
  const text = reportText(markdown);
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard.write) return navigator.clipboard.writeText(text);
  const item = new ClipboardItem({
    "text/html": new Blob([reportHtml(markdown)], { type: "text/html" }),
    "text/plain": new Blob([text], { type: "text/plain" }),
  });
  try {
    await navigator.clipboard.write([item]);
  } catch {
    await navigator.clipboard.writeText(text);
  }
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
