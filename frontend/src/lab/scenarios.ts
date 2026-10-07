import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { nameFromText, quoteKey, type Criterion } from "./criteria";
import type { Card, Check, LabState, Persona, Status } from "./types";

/**
 * A scenario as a test (GET /api/scenarios, backend/lab/flows/scenarios.py): the error of the real conversation it
 * reproduces, and its own result in every run of its check. The runs stand side by side; nothing compares them.
 */
export type Reproduced = { ruleId: string; name: string; text: string; agentQuote: string };
/** One finished conversation of a scenario in a run: who played it, the result, the criteria it failed. */
export type Played = {
  run: string;
  label: string;
  startedAt: string;
  persona: string;
  attempt: number;
  status: "PASS" | "FAIL" | "UNMEASURED";
  index: number;
  failed: { ruleId: string; name: string }[];
};
export type ScenarioRecord = {
  id: string;
  /** The real conversation it was built from, in the current result of its check; null when that has it no more. */
  sourceStatus: Status | null;
  reproduces: Reproduced[];
  /** Newest run first, in the order of each run. */
  history: Played[];
};
export type Scenarios = { check: Check | null; cards: ScenarioRecord[] };

/** What makes the record out of date: new scenarios, a new result of their check, any change of a run. */
export function scenariosStamp(state: LabState | null): string {
  if (!state) return "";
  const deck = state.cards;
  const result = deck ? state.checks[deck.check]?.finishedAt : "";
  const runs = state.runs.map((r) => `${r.id}:${r.revision ?? ""}:${r.status}`).join(",");
  return `${deck?.check ?? ""}|${deck?.createdAt ?? ""}|${deck?.cards.length ?? 0}|${result ?? ""}|${runs}`;
}

/**
 * The scenarios of the deck as tests. Fetched again whenever a run changes (a conversation played, judged again) or
 * the deck does; the previous record stays on screen meanwhile.
 */
export function useScenarios(state: LabState | null) {
  const stamp = scenariosStamp(state);
  return useQuery({
    queryKey: ["scenarios", stamp],
    queryFn: () => api<Scenarios>("/api/scenarios"),
    enabled: !!state,
    placeholderData: (previous) => previous,
    staleTime: Infinity,
  });
}

/**
 * «Контроль: …»: what the real conversation of a control shows in the current result of its check, as the check said
 * it — no error found, an error found now (the control was built from it without one), or it could not be checked;
 * never «ошибок не было». Missing only when the result has no such conversation.
 */
export const controlLine = (sourceStatus: Status | null | undefined) =>
  !sourceStatus
    ? "настоящего разговора нет в нынешнем итоге"
    : sourceStatus === "PASS"
      ? "в настоящем разговоре ошибок не нашли"
      : sourceStatus === "FAIL"
        ? "в настоящем разговоре теперь нашли ошибку"
        : "настоящий разговор проверить не удалось";

/** One run that played a scenario: its conversations by type of customer, in the order the service lists types. */
export type RunPlays = { run: string; label: string; startedAt: string; plays: Played[] };

export function runsOf(history: Played[], personas: Persona[]): RunPlays[] {
  const order = new Map(personas.map((p, i) => [p.id, i]));
  const runs: RunPlays[] = [];
  for (const p of history) {
    const last = runs[runs.length - 1];
    if (last?.run === p.run) last.plays.push(p);
    else runs.push({ run: p.run, label: p.label, startedAt: p.startedAt, plays: [p] });
  }
  for (const r of runs)
    r.plays.sort((a, b) => (order.get(a.persona) ?? 99) - (order.get(b.persona) ?? 99) || a.attempt - b.attempt);
  return runs;
}

/**
 * How a scenario came out in the latest run that played it: with an error when any type of customer met one, without
 * errors when none did and at least one conversation was checked; «не удалось проверить» stays apart.
 */
export type Outcome = "fail" | "pass" | "none" | "unplayed";
export function outcomeOf(history: Played[] | undefined): Outcome {
  const latest = history?.[0]?.run;
  if (!latest) return "unplayed";
  const plays = history.filter((p) => p.run === latest);
  if (plays.some((p) => p.status === "FAIL")) return "fail";
  if (plays.some((p) => p.status === "PASS")) return "pass";
  return "none";
}

/** The customer types that met an error in the latest run that played a scenario: replaying them reproduces it. */
export function failedTypes(history: Played[] | undefined): string[] {
  const latest = history?.[0]?.run;
  if (!latest) return [];
  return [...new Set(history.filter((p) => p.run === latest && p.status === "FAIL").map((p) => p.persona))];
}

/**
 * The criteria of a scenario as every screen names and numbers them: the check's numbered criterion with the same
 * quote, else the scenario's own short name.
 */
export type Named = { n?: number; name: string; c?: Criterion };
export function namedCriteria(card: Card, list: Criterion[]): Map<string, Named> {
  const byQuote = new Map(list.map((c) => [quoteKey(c.r.rule.quote), c]));
  return new Map(
    card.criteria.map((x) => {
      const c = byQuote.get(quoteKey(x.quote));
      return [x.id, c ? { n: c.n, name: c.name, c } : { name: x.name?.trim() || nameFromText(x.text) }];
    }),
  );
}

/** «Клиент хочет закрыть карту…»: the first sentence of a situation, which is written for the synthetic customer. */
export function firstSentence(text: string): string {
  const t = text.trim();
  // Not after a one-letter abbreviation («г. Москва»): a sentence ends before a capital that starts the next one.
  const end = /(?<!(?:^|\s)[а-яёa-z])[.!?…](?=\s+[«"(]?[А-ЯЁA-Z0-9])/.exec(t);
  return end ? t.slice(0, end.index + 1) : t;
}
