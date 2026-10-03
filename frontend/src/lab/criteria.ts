import { useMemo } from "react";
import { useLabState } from "./LabProvider";
import { useProblems, type Problems, type RuleEntry } from "./problems";
import type { Check } from "./types";

/** Muted hues for the topics of conversations, as Linear's labels: a dot and a faint tint carry the colour. */
const HUES = ["#6DB3F2", "#A57CF5", "#5FC98A", "#F0AD4E", "#4FCAE3", "#E28A80", "#C9B458"];

export type Topic = { topic: string; short: string; hue: string };
/** A criterion as the whole product shows it: one number everywhere, a short name, where it applies. */
export type Criterion = { r: RuleEntry; n: number; name: string; every: boolean; topics: Topic[] };

/** A quote as criteria are matched by it: the same words, whatever the spaces and the case. */
export const quoteKey = (q: string) => q.replace(/\s+/g, " ").trim().toLowerCase();

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
  t = t
    .split(/\s[—–]\s|:\s/)[0]
    .replace(/[.;]$/, "")
    .trim();
  if (t.length > 64) t = `${t.slice(0, 63).replace(/\s+\S*$/, "")}…`;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * What a criterion requires, in the words a person reads. Criteria of a supplied rubric were once saved with its
 * «### pronouns» headings; the quote keeps them as the rules were written, the wording goes without.
 */
export function duty(text: string) {
  return text.replace(/^#{1,6}[ \t].*(?:\n|$)/gm, "").trim() || text;
}

/** Numbers every criterion once, for all screens: the ones for every conversation first, then by topic. */
export function numberCriteria(rules: RuleEntry[], reference?: string[]): { list: Criterion[]; topics: Topic[] } {
  const titles = [...new Set(rules.flatMap((r) => r.topics))];
  const topics = titles.map((t, i) => ({ topic: t, short: shortTopic(t), hue: HUES[i % HUES.length] }));
  const byTitle = new Map(topics.map((t) => [t.topic, t]));
  const list = rules.map((r) => ({
    r,
    n: 0,
    name: r.rule.name?.trim() || nameFromText(r.rule.text),
    every: titles.length > 1 && r.topics.length === titles.length,
    topics: r.topics.map((t) => byTitle.get(t)!),
  }));
  list.sort(
    (x, y) =>
      Number(y.every) - Number(x.every) ||
      titles.indexOf(x.r.topics[0] ?? "") - titles.indexOf(y.r.topics[0] ?? "") ||
      x.r.rule.text.localeCompare(y.r.rule.text),
  );
  const positions = new Map(reference?.map((quote, i) => [quote, i + 1]));
  let next = (reference?.length ?? 0) + 1;
  list.forEach((c, i) => {
    c.n = reference ? (positions.get(c.r.rule.quote) ?? next++) : i + 1;
  });
  if (reference) list.sort((a, b) => a.n - b.n);
  return { list, topics };
}

/**
 * The numbered criteria of a check. Numbers come from the check's own record (its result and its last run), so a
 * criterion keeps its number in a run's results; a rule only that run has gets the next free number. Tone of voice
 * numbers its criteria in the order of the person's draft, as the step-by-step check shows them.
 */
export function useCriteria(
  check: Check | null,
  runId: string | null = null,
): {
  data: Problems | undefined;
  list: Criterion[];
  topics: Topic[];
  unnamed: number;
} {
  const { data: base } = useProblems(check);
  const { data: withRun } = useProblems(check, runId, !!runId);
  const { state } = useLabState();
  const draft = check === "tone" ? state?.toneOfVoice : null;
  return useMemo(() => {
    const reference = draft?.criteria.map((c) => c.quote);
    const numbered = numberCriteria(base?.rules ?? [], reference);
    const data = runId ? withRun : base;
    const unnamed = (base?.rules ?? []).filter((r) => !r.rule.name).length;
    if (!runId) return { data, ...numbered, unnamed };
    const byId = new Map(numbered.list.map((c) => [c.r.id, c]));
    const extra = numberCriteria(
      (data?.rules ?? []).filter((r) => !byId.has(r.id)),
      reference,
    ).list;
    let next = Math.max(reference?.length ?? 0, ...numbered.list.map((c) => c.n), 0) + 1;
    extra.forEach((c) => {
      if (!reference?.includes(c.r.rule.quote)) c.n = next++;
    });
    const list = (data?.rules ?? [])
      .map((r) => {
        const known = byId.get(r.id);
        return known ? { ...known, r } : extra.find((c) => c.r.id === r.id)!;
      })
      .sort((a, b) => a.n - b.n);
    return { data, list, topics: numbered.topics, unnamed };
  }, [base, withRun, runId, draft]);
}
