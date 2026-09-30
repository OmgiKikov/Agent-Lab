import { useMemo } from "react";
import { splitQuote } from "../ui/highlight";
import { useProblems, useSource, type Problems, type RuleEntry } from "./problems";

/** Muted hues for the topics of conversations, as Linear's labels: a dot and a faint tint carry the colour. */
const HUES = ["#6DB3F2", "#A57CF5", "#5FC98A", "#F0AD4E", "#4FCAE3", "#E28A80", "#C9B458"];

export const EVERY = "Во всех разговорах";

export type Topic = { topic: string; short: string; hue: string };
/** A criterion as the whole product shows it: one number everywhere, a short name, where it applies. */
export type Criterion = { r: RuleEntry; n: number; name: string; every: boolean; topics: Topic[] };

/** «Ставка, тариф и комиссия по эквайрингу» → «Ставка». */
export const shortTopic = (t: string) => t.split(",")[0].trim();

/**
 * A short name for a criterion extracted before names existed: the duty itself, without «Если …, агент» and
 * without the explanation after the dash. «Если данных недостаточно, агент задаёт уточняющий вопрос» →
 * «Задаёт уточняющий вопрос».
 */
export function nameFromText(text: string) {
  let t = text.trim();
  const agent = /(^|[\s,])агент\s+/i.exec(t);
  if (agent) t = t.slice(agent.index + agent[0].length);
  t = t.split(/\s[—–]\s|:\s/)[0].replace(/[.;]$/, "").trim();
  if (t.length > 64) t = `${t.slice(0, 63).replace(/\s+\S*$/, "")}…`;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Numbers every criterion once, for all screens: the ones for every conversation first, then by topic. */
export function numberCriteria(rules: RuleEntry[]): { list: Criterion[]; topics: Topic[] } {
  const titles = [...new Set(rules.flatMap(r => r.topics))];
  const topics = titles.map((t, i) => ({ topic: t, short: shortTopic(t), hue: HUES[i % HUES.length] }));
  const byTitle = new Map(topics.map(t => [t.topic, t]));
  const list = rules.map(r => ({
    r,
    n: 0,
    name: r.rule.name?.trim() || nameFromText(r.rule.text),
    every: titles.length > 1 && r.topics.length === titles.length,
    topics: r.topics.map(t => byTitle.get(t)!),
  }));
  list.sort((x, y) => Number(y.every) - Number(x.every) || titles.indexOf(x.r.topics[0] ?? "") - titles.indexOf(y.r.topics[0] ?? "") || x.r.rule.text.localeCompare(y.r.rule.text));
  list.forEach((c, i) => { c.n = i + 1; });
  return { list, topics };
}

/** The numbered criteria of the current rules (the logs' assessment and the chosen run share them). */
export function useCriteria(runId: string | null = null): { data: Problems | undefined; list: Criterion[]; topics: Topic[]; unnamed: number } {
  const { data } = useProblems(runId);
  return useMemo(() => {
    const { list, topics } = numberCriteria(data?.rules ?? []);
    return { data, list, topics, unnamed: (data?.rules ?? []).filter(r => !r.rule.name).length };
  }, [data]);
}

/** The prompt's words around a criterion's quote: a little before, the quote, a little after; null when absent. */
export function useQuoteContext(r: RuleEntry | undefined, around = 200) {
  const { data, isLoading } = useSource(r?.rule.sourceId);
  if (!r || !data) return { loading: isLoading, parts: null as null | [string, string, string] };
  const parts = splitQuote(data.content, r.rule.quote);
  if (!parts) return { loading: false, parts: null };
  const [before, quote, after] = parts;
  const head = before.length > around ? `…${before.slice(-around).replace(/^\S*\s/, "")}` : before;
  const tail = after.length > around ? `${after.slice(0, around).replace(/\s\S*$/, "")}…` : after;
  const plain = (t: string) => t.replace(/\*\*/g, "").replace(/^#{2,}\s*/gm, "");
  return { loading: false, parts: [plain(head.trimStart()), plain(quote), plain(tail.trimEnd())] as [string, string, string] };
}
