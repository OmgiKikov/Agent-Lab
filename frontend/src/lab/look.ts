import type { Persona } from "./types";

export const DEFAULT_PERSONA = "default";
export const personaName = (personas: Persona[], id?: string) =>
  personas.find((p) => p.id === (id ?? DEFAULT_PERSONA))?.name ?? id ?? "";
