import { api } from "../lab/api";
import { splitQuote } from "../lab/quote";
import type { ToolCall, Turn } from "../lab/types";
import { visible } from "./text";

/**
 * What the agent did before a reply, as the stand's mocks recorded it: searched its knowledge base, or called a bank
 * system. A check of a tool criterion quotes these steps (backend/lab/transcript.py tool_calls), not the reply.
 */
export const isKnowledge = (call: ToolCall) => !!call.article || call.tool === "База знаний";

/** The bank system's name as in the agent's code, the way the check cites it: «getLkkTariff». */
export const systemName = (call: ToolCall) => call.tool.replace("Система банка · ", "");

/** «как_оформить_возврат» → «как оформить возврат»: the article's id reads as its subject. */
export const articleWords = (id: string) => id.replace(/_/g, " ");

const words = (quote: string) => new Set(quote.split(/[\s;,()[\]«»"'.:]+/).filter(Boolean));

/** Whether a quote cites this step: the system's name or the article's id as a whole word of it. */
export function cites(call: ToolCall, quote: string): boolean {
  const said = words(quote);
  return isKnowledge(call) ? !!call.article && said.has(call.article) : said.has(systemName(call));
}

/** Whether the agent's words in this turn hold the quote. */
export const inWords = (turn: Turn, quote: string) =>
  turn.role === "agent" && !!splitQuote(visible(turn.text).text, quote);

/**
 * Where a quote lands in a conversation: in the agent's words when they hold it, otherwise on the steps it names.
 * A quote of the words never marks a step, so a reply that mentions a system's name stays a reply.
 */
export function placeQuotes<M extends { quote: string }>(turns: Turn[], marks: M[]): { words: M[]; steps: M[] } {
  const isWords = (m: M) => turns.some((t) => inWords(t, m.quote));
  return { words: marks.filter(isWords), steps: marks.filter((m) => !isWords(m)) };
}

/** Whether the turn shows the quote: in its words, or on one of its steps. */
export const shows = (turn: Turn, quote: string) =>
  inWords(turn, quote) || (turn.role === "agent" && (turn.events ?? []).some((c) => cites(c, quote)));

export type Article = { article: string; title: string; text: string };

export const fetchArticle = (id: string) => api<Article>(`/api/articles/${encodeURIComponent(id)}`);
