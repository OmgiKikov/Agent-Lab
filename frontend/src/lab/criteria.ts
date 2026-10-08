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

/** The criteria in force, in the order of the person's draft: their ids and the words of the rules they quote. */
export type Reference = { id: string; quote: string }[];

/**
 * Numbers every criterion once, for all screens: the ones for every conversation first, then by topic. With the
 * criteria in force (reference), a criterion takes its place among them: by the words it quotes when only one of them
 * quotes those, else by its id (the one its verdicts carry); a criterion added or edited by hand quotes nothing. Two
 * never share a number: one without a place, or whose place is taken, gets the next free one.
 */
export function numberCriteria(rules: RuleEntry[], reference?: Reference): { list: Criterion[]; topics: Topic[] } {
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
  const byId = new Map(reference?.map((c, i) => [c.id, i + 1]));
  // A quote two criteria share places neither of them.
  const byQuote = new Map<string, number | null>();
  reference?.forEach((c, i) => c.quote && byQuote.set(c.quote, byQuote.has(c.quote) ? null : i + 1));
  const taken = new Set<number>();
  let next = (reference?.length ?? 0) + 1;
  list.forEach((c, i) => {
    // The words it quotes first (criteria collected again keep them, not their places); else the criterion's own id,
    // which its verdicts carry (log.ruleIds): a criterion added or edited by hand quotes nothing.
    const place =
      (c.r.rule.quote ? byQuote.get(c.r.rule.quote) : null) ??
      [c.r.id, ...c.r.log.ruleIds].map((id) => byId.get(id)).find(Boolean);
    c.n = !reference ? i + 1 : place && !taken.has(place) ? place : next++;
    taken.add(c.n);
  });
  if (reference) list.sort((a, b) => a.n - b.n);
  return { list, topics };
}

/** How the records a screen rests on stand: still coming, failed with the way to ask again, or here (both false). */
export type Loading = {
  /** A record is asked for and not here yet; also while the service's state has not come. */
  loading: boolean;
  /** Why a record could not be loaded, once every try failed; `retry` asks for it again. */
  error: Error | null;
  retry: () => void;
};

/**
 * The numbered criteria of a check. Numbers come from the check's own record (its result and its last run), so a
 * criterion keeps its number in a run's results; a rule only that run has gets the next free number. Tone of voice
 * numbers its criteria in the order of the person's draft, as the step-by-step check shows them. Until the records
 * they rest on are here, `list` is empty and `loading` or `error` says why: a screen says «no errors» or «nothing
 * checked» only of a record that came.
 */
export function useCriteria(
  check: Check | null,
  runId: string | null = null,
): Loading & {
  data: Problems | undefined;
  list: Criterion[];
  topics: Topic[];
  unnamed: number;
} {
  const baseQuery = useProblems(check);
  const runQuery = useProblems(check, runId, !!runId);
  const base = baseQuery.data;
  const withRun = runQuery.data;
  const { state } = useLabState();
  const draft = check === "tone" ? state?.toneOfVoice : null;
  // The check's own record numbers the criteria; a run's, when one is asked for, holds what is shown.
  const missing = [...(check ? [baseQuery] : []), ...(runId ? [runQuery] : [])].filter((q) => q.data === undefined);
  const failed = missing.find((q) => q.error && !q.isFetching);
  const criteria = useMemo(() => {
    const reference = draft?.criteria.map((c) => ({ id: c.id, quote: c.quote }));
    const numbered = numberCriteria(base?.rules ?? [], reference);
    const data = runId ? withRun : base;
    const unnamed = (base?.rules ?? []).filter((r) => !r.rule.name).length;
    if (!runId) return { data, ...numbered, unnamed };
    const byId = new Map(numbered.list.map((c) => [c.r.id, c]));
    const extra = numberCriteria(
      (data?.rules ?? []).filter((r) => !byId.has(r.id)),
      reference,
    ).list;
    // A criterion only the run has keeps its place among the criteria in force while no other holds it.
    const taken = new Set(numbered.list.map((c) => c.n));
    let next = Math.max(reference?.length ?? 0, ...taken, 0) + 1;
    extra.forEach((c) => {
      if (taken.has(c.n) || c.n > (reference?.length ?? 0)) c.n = next++;
      taken.add(c.n);
    });
    const list = (data?.rules ?? [])
      .map((r) => {
        const known = byId.get(r.id);
        return known ? { ...known, r } : extra.find((c) => c.r.id === r.id)!;
      })
      .sort((a, b) => a.n - b.n);
    return { data, list, topics: numbered.topics, unnamed };
  }, [base, withRun, runId, draft]);
  return {
    ...criteria,
    loading: missing.length > 0 && !failed,
    error: failed?.error ?? null,
    retry: () => missing.forEach((q) => void q.refetch()),
  };
}
