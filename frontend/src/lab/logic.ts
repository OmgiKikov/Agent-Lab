import type { Item, LabRun, Persona } from "./types";
import { DEFAULT_PERSONA } from "./look";

export const personaOf = (i: Item) => i.persona ?? DEFAULT_PERSONA;

/** The customer types that played in a run, in the order the service lists them. */
export const typesOfRun = (run: LabRun | null | undefined, personas: Persona[]) =>
  run?.items ? personas.filter((p) => run.items!.some((i) => personaOf(i) === p.id)) : [];

export const scenariosOfRun = (items: Item[]) =>
  [...new Map(items.map((i) => [i.cardId, i.name])).entries()].map(([id, name]) => ({ id, name }));

const finished = (i: Item) => i.status === "PASS" || i.status === "FAIL";

export type CellState = "PASS" | "FAIL" | "MIXED" | "UNMEASURED" | "RUNNING" | "NONE";
export type Cell = { state: CellState; passed: number; done: number; total: number; first?: Item };

/** One scenario played by one customer type, all repeats together. */
export function cellOf(items: Item[], cardId: string, personaId: string): Cell {
  const own = items.filter((i) => i.cardId === cardId && personaOf(i) === personaId);
  const done = own.filter(finished);
  const passed = done.filter((i) => i.status === "PASS").length;
  const base = { passed, done: done.length, total: own.length, first: own.find((i) => i.status === "FAIL") ?? own[0] };
  if (!own.length) return { ...base, state: "NONE" };
  if (own.some((i) => i.status === "RUNNING")) return { ...base, state: "RUNNING" };
  if (!done.length) return { ...base, state: "UNMEASURED" };
  return { ...base, state: passed === done.length ? "PASS" : passed === 0 ? "FAIL" : "MIXED" };
}
