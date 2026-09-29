import { itemKey, personaOf } from "./logic";
import type { Discover, Item, LabRun, LabState, Rule, Status } from "./types";

/**
 * The model of the whole Lab: a criterion is a thing the agent must do; a dialogue is evidence, from a real log or from the simulator;
 * the judge's verdict joins them (0 or 1 with a reason). Everything on screen is a view of these three.
 * The service keeps no criteria of its own, so they are gathered here from the rules of every verdict, by the text of the rule.
 */

export type Origin = "log" | "sim";

export type Dialog = {
  key: string;
  origin: Origin;
  opening: string;
  label: string;
  status: Status;
  rules: Rule[];
  persona?: string;
  attempt?: number;
  /** The simulator's conversation (with all its messages); a logged dialogue is opened by its stable ID. */
  item?: Item;
  dialogueId?: string;
};

export type Tally = { passed: number; failed: number };

export type Criterion = {
  key: string;
  rule: string;
  title: string;
  passed: number;
  failed: number;
  by: Record<Origin, Tally>;
  failing: Dialog[];
  passing: Dialog[];
  quote?: string;
  kind?: string;
};

export type Change = "new" | "remains" | "fixed";
export type Compared = { criterion: Criterion; change: Change | null; before: number };

export const normRule = (rule: string) => rule.trim().toLowerCase().replace(/\s+/g, " ");
export const rate = (t: Tally) => (t.passed + t.failed ? t.passed / (t.passed + t.failed) : null);
export const measured = (d: Dialog) => d.status === "PASS" || d.status === "FAIL";

export function simDialogs(items: Item[]): Dialog[] {
  return items.map((item) => ({
    key: itemKey(item),
    origin: "sim" as const,
    opening: item.conversation[0]?.text ?? item.name,
    label: item.name,
    status: item.status,
    rules: item.rules,
    persona: personaOf(item),
    attempt: item.attempt,
    item,
  }));
}

export function logDialogs(d: Discover | null): Dialog[] {
  if (!d) return [];
  const topics = new Map(d.topics.map((t) => [t.id, t.title]));
  return d.results.map((r) => ({
    key: `log:${r.dialogueId}`,
    origin: "log" as const,
    opening: r.opening,
    label: topics.get(r.topicId) ?? "",
    status: r.status,
    rules: r.rules,
    dialogueId: r.dialogueId,
  }));
}

/** Where a criterion was taken from: the quote in the agent's source and what kind of source it is. */
export function provenanceOf(state: LabState): Map<string, { quote: string; kind?: string }> {
  const kinds = new Map(state.sources.map((s) => [s.id, s.kind]));
  const out = new Map<string, { quote: string; kind?: string }>();
  for (const t of state.discover?.topics ?? [])
    for (const r of t.rules)
      out.set(normRule(r.text), { quote: r.quote, kind: r.sourceId ? kinds.get(r.sourceId) : undefined });
  for (const c of state.cards?.cards ?? [])
    for (const r of c.criteria) if (!out.has(normRule(r.text))) out.set(normRule(r.text), { quote: r.quote });
  return out;
}

export function deriveCriteria(
  dialogs: Dialog[],
  provenance?: Map<string, { quote: string; kind?: string }>,
): Criterion[] {
  const found = new Map<string, Criterion>();
  for (const dialog of dialogs) {
    const seen = new Set<string>();
    for (const r of dialog.rules) {
      if ((r.status !== "PASS" && r.status !== "FAIL") || !r.rule) continue;
      const key = normRule(r.rule);
      if (seen.has(key)) continue;
      seen.add(key);
      const c = found.get(key) ?? {
        key,
        rule: r.rule,
        title: r.rule,
        passed: 0,
        failed: 0,
        by: { log: { passed: 0, failed: 0 }, sim: { passed: 0, failed: 0 } },
        failing: [],
        passing: [],
        ...provenance?.get(key),
      };
      if (r.status === "FAIL") {
        c.failed++;
        c.by[dialog.origin].failed++;
        c.failing.push(dialog);
      } else {
        c.passed++;
        c.by[dialog.origin].passed++;
        c.passing.push(dialog);
      }
      found.set(key, c);
    }
  }
  return [...found.values()].sort(
    (a, b) => b.failed - a.failed || (rate(a) ?? 1) - (rate(b) ?? 1) || b.passed - a.passed,
  );
}

/** The criteria against those of the previous version: new (broken now, not before), still broken, fixed. Without a previous version there is no verdict. */
export function compareCriteria(current: Criterion[], previous: Criterion[] | null): Compared[] {
  if (!previous) return current.map((criterion) => ({ criterion, change: null, before: 0 }));
  const before = new Map(previous.map((c) => [c.key, c]));
  const out: Compared[] = current.map((criterion) => {
    const was = before.get(criterion.key)?.failed ?? 0;
    return {
      criterion,
      before: was,
      change: criterion.failed > 0 ? (was > 0 ? "remains" : "new") : was > 0 ? "fixed" : null,
    };
  });
  // A missing criterion has no current evidence; absence does not prove a fix.
  return out;
}

export type Summary = { measured: number; clean: number; share: number | null; unmeasured: number };

export function summarize(dialogs: Dialog[]): Summary {
  const done = dialogs.filter(measured);
  const clean = done.filter((d) => d.status === "PASS").length;
  return {
    measured: done.length,
    clean,
    share: done.length ? Math.round((100 * clean) / done.length) : null,
    unmeasured: dialogs.length - done.length,
  };
}

/** A criterion's pass share in each of the given versions (oldest first); null where it was not measured. */
export function historyOf(key: string, runs: LabRun[]): (number | null)[] {
  return runs.map((run) => {
    let passed = 0,
      failed = 0;
    for (const item of run.items ?? [])
      for (const r of item.rules) {
        if (normRule(r.rule) !== key) continue;
        if (r.status === "PASS") passed++;
        else if (r.status === "FAIL") failed++;
      }
    return passed + failed ? Math.round((100 * passed) / (passed + failed)) : null;
  });
}

export const KIND_LABEL: Record<string, string> = { prompt: "промпт", tools: "инструменты", knowledge: "база знаний" };
