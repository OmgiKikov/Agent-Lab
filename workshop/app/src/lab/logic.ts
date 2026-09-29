import type { Item, LabRun, Persona, Status } from "./types";
import { DEFAULT_PERSONA } from "./look";

/** How a conversation of a run is addressed in the URL: its Workshop trace, or its place in the run when it has none. */
export const itemKey = (i: Item) => i.runId ?? `${i.cardId}~${i.persona ?? DEFAULT_PERSONA}~${i.attempt ?? 1}`;

export const disputed = (i: Item) => !!i.second && ["PASS", "FAIL", "UNMEASURED"].includes(i.second.status) && i.second.status !== i.status;

export const personaOf = (i: Item) => i.persona ?? DEFAULT_PERSONA;

/** The customer types that played in a run, in the order the service lists them. */
export const typesOfRun = (run: LabRun | null | undefined, personas: Persona[]) =>
  run?.items ? personas.filter(p => run.items!.some(i => personaOf(i) === p.id)) : [];

export const scenariosOfRun = (items: Item[]) => [...new Map(items.map(i => [i.cardId, i.name])).entries()].map(([id, name]) => ({ id, name }));

const finished = (i: Item) => i.status === "PASS" || i.status === "FAIL";

/** Share of finished conversations of a scenario that passed; null when none finished. */
export const passShare = (items: Item[], cardId: string) => {
  const done = items.filter(i => i.cardId === cardId && finished(i));
  return done.length ? done.filter(i => i.status === "PASS").length / done.length : null;
};

export type CellState = "PASS" | "FAIL" | "MIXED" | "UNMEASURED" | "RUNNING" | "NONE";
export type Cell = { state: CellState; passed: number; done: number; total: number; first?: Item };

/** One scenario played by one customer type, all repeats together. */
export function cellOf(items: Item[], cardId: string, personaId: string): Cell {
  const own = items.filter(i => i.cardId === cardId && personaOf(i) === personaId);
  const done = own.filter(finished);
  const passed = done.filter(i => i.status === "PASS").length;
  const base = { passed, done: done.length, total: own.length, first: own.find(i => i.status === "FAIL") ?? own[0] };
  if (!own.length) return { ...base, state: "NONE" };
  if (own.some(i => i.status === "RUNNING")) return { ...base, state: "RUNNING" };
  if (!done.length) return { ...base, state: "UNMEASURED" };
  return { ...base, state: passed === done.length ? "PASS" : passed === 0 ? "FAIL" : "MIXED" };
}

export const cellShare = (c: Cell) => (c.done ? c.passed / c.done : null);

/** Status of a scenario over all its conversations, for a dot. */
export function scenarioStatus(own: Item[]): Status {
  return own.some(i => i.status === "RUNNING") ? "RUNNING"
    : own.some(i => i.status === "FAIL") ? "FAIL"
    : own.every(i => i.status === "PASS") ? "PASS" : "UNMEASURED";
}

/** Previous finished run of the same agent. */
export const previousOf = (runs: LabRun[], run: LabRun) =>
  runs.filter(r => r.id !== run.id && r.target === run.target && r.metric?.total && r.status !== "running" && r.startedAt < run.startedAt)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0] ?? null;

/** «в 22 из 30 разговоров»: what was counted, named right. */
export function unitOf(items: Item[]): "сценариев" | "разговоров" {
  const scenarios = new Set(items.map(i => i.cardId)).size;
  return items.length > scenarios ? "разговоров" : "сценариев";
}

/** Failed criteria of a run, most frequent first. */
export function failureReasons(items: Item[]): [string, number][] {
  const reasons = new Map<string, number>();
  for (const i of items) for (const r of i.rules) if (r.status === "FAIL") reasons.set(r.rule, (reasons.get(r.rule) ?? 0) + 1);
  return [...reasons.entries()].sort((a, b) => b[1] - a[1]);
}
