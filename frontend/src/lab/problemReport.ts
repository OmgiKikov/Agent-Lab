import { AGENT, shareBase } from "../app/agent";
import { problemLink } from "../app/links";
import { useAgents } from "./agents";
import { CHECK_NAME } from "./checks";
import { duty } from "./criteria";
import { count, day } from "./format";
import type { Example, Problems, RuleEntry } from "./problems";
import { seriousFirst, severityText } from "./severity";

const SOURCE_LABEL: Record<string, string> = {
  prompt: "Инструкции агента",
  tools: "Инструменты агента",
  "tone-of-voice": "Правила общения",
};
export const sourceLabel = (kind: string) => SOURCE_LABEL[kind] ?? "Источник критерия";

/** A word that begins a sentence. */
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Markdown's marks in a text a report quotes, escaped (CommonMark backslash escapes): «[…](…)», «<…>», «#», «|» and «`»
 * stay the characters they are. The copy and the plain text read them back as written (pieces).
 */
const marks = (text: string) => text.replace(/[\\`[\]<>#|]/g, "\\$&");

/**
 * Someone else's text inside a line of a report — the customer's and the agent's words, a model's reason, a quote from
 * the rules or the code, a name: on one line, since its line breaks would start blocks of their own (a heading, a
 * quote), and with its marks escaped, so a «[link](…)» in it stays words and none of its addresses becomes a link.
 */
export const inlineText = (text: string) => marks(text.replace(/\s+/g, " ").trim());

/**
 * Someone else's text of several lines as a quote: every line «> …», with its marks escaped, and what would begin a
 * list, a rule or a heading at its start escaped too, so each line stays a line of the quote.
 */
export const quoteText = (text: string) =>
  text
    .split("\n")
    .map(
      (line) =>
        `> ${marks(line.trim())
          .replace(/^([-+*=_~])/, "\\$1")
          .replace(/^(\d+)([.)])/, "$1\\$2")}`,
    )
    .join("\n");

/** «Агент «Агент эквайринга».»: the first line under a report's heading, so a report never goes out about another agent. */
export const agentLine = (agent: string) => `Агент «${inlineText(agent)}».`;

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
  return you ? "вы ещё не проверяли" : "человек ещё не проверял";
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

const where = (p: RuleEntry, source?: Source) =>
  [
    source !== "sim" && p.log.failed
      ? `в\u00a0${p.log.failed}\u00a0из\u00a0${count(p.log.failed + p.log.passed, "разговора", "разговоров", "разговоров")}`
      : null,
    source !== "log" && p.sim.failed
      ? `в\u00a0${p.sim.failed}\u00a0из\u00a0${count(p.sim.failed + p.sim.passed, "разговора", "разговоров", "разговоров")} симуляции`
      : null,
  ]
    .filter(Boolean)
    .join(", ");

/**
 * «Перекладывает вину на клиента · серьёзная»: a problem's name as a letter or a ticket heads it, in Markdown (the name
 * comes from a model that read the customers' words: inlineText).
 */
export const headingOf = (p: Pick<RuleEntry, "title" | "serious">) =>
  p.serious ? `${inlineText(p.title)} · серьёзная` : inlineText(p.title);

/**
 * One problem for a ticket or a message: what (with «серьёзная» when its errors are serious), how often, where the
 * agent's code says it, one proof and the link. With a source, only that source is told; with an agent, a ticket of
 * its own names it first (agentLine), a problem inside a report does not repeat the report's.
 */
export function problemMarkdown(
  p: RuleEntry,
  link: string,
  { level = 1, source, agent }: { level?: number; source?: Source; agent?: string } = {},
): string {
  const own = source ? p[source].examples : [...p.log.examples, ...p.sim.examples];
  const e = own.find((x) => x.status === "FAIL");
  const lines = [
    `${"#".repeat(level)} ${headingOf(p)}`,
    "",
    ...(agent ? [agentLine(agent)] : []),
    `Ошибка ${where(p, source)}.`,
    "",
    `Агент должен: ${inlineText(duty(p.rule.text))}`,
    "",
    p.rule.quote
      ? `${sourceLabel(p.rule.kind)}${p.rule.origin ? ` (${inlineText(p.rule.origin)})` : ""}: «${inlineText(duty(p.rule.quote))}»`
      : "Цитата не сохранилась.",
  ];
  if (e)
    lines.push(
      "",
      `${"#".repeat(level + 1)} Пример`,
      "",
      `Клиент: ${inlineText(e.opening)}`,
      `Агент: «${inlineText(e.agentQuote)}»`,
      `Почему это ошибка: ${inlineText(e.reason)}`,
      `${capital(reliabilityWord(e, "people"))}.`,
    );
  lines.push("", link);
  return lines.join("\n");
}

/**
 * The problems of one source of a check as a file: its conversations and its simulation are never told together. It
 * names its agent first (agentLine), and the conversations name their export (filename), as the tone-of-voice brief
 * does; under their numbers the conversations with a serious error with whose decision that is (lab/severity,
 * severityText). Serious problems first, then the most frequent.
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
    ...(agent ? [agentLine(agent)] : []),
    `Проверка «${CHECK_NAME[data.check]}».`,
  ];
  if (source === "log" && data.log && filename) lines.push(`Выгрузка «${inlineText(filename)}».`);
  if (source === "log" && data.log) {
    lines.push(
      `Диалоги ${day(data.log.finishedAt)}: проверено ${data.log.assessed}\u00a0из\u00a0${count(data.log.sampled, "разговора", "разговоров", "разговоров")}.`,
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
  lines.push("");
  const list = data.rules
    .filter((r) => r[source].failed > 0)
    .sort((a, b) => seriousFirst(a, b) || b[source].failed - a[source].failed);
  for (const p of list)
    lines.push(
      problemMarkdown(p, `${base}${problemLink(p.id, source === "sim" ? "sim" : data.check, data.sim?.runId)}`, {
        level: 2,
        source,
      }),
      "",
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
 * agent could have written, and an escaped mark is its character again (inlineText, quoteText).
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
