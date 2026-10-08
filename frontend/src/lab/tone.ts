import type { LabState } from "./types";
import { agentKey } from "../app/agent";

export const TONE_ID = "tone-of-voice";
/** The result of the tone-of-voice check, or null. */
export const toneResult = (state: LabState | null) => state?.checks.tone ?? null;

/** What of a criterion the judge reads: the same wording, conditions and clarifications are the same criterion. */
const judged = (c: { id: string; text: string; condition?: string; acceptable?: string; clarifications?: string[] }) =>
  JSON.stringify([c.id, c.text, c.condition ?? "", c.acceptable ?? "", c.clarifications ?? []]);

/**
 * Whether the result of tone of voice was judged by other criteria than the ones in force now: they were collected
 * again, replaced or edited since. Its numbers stand for the criteria it went by, never for the new ones; a set only
 * renamed, or criteria collected again into the very same ones, changed nothing.
 */
export function toneJudgedByOther(state: LabState | null): boolean {
  const result = toneResult(state);
  const draft = state?.toneOfVoice;
  if (!result || !draft || result.criteriaRevision === draft.revision) return false;
  const used = new Set((result.topics ?? []).flatMap((t) => t.rules).map(judged));
  return used.size !== draft.criteria.length || draft.criteria.some((c) => !used.has(judged(c)));
}

/** What was read from the agent's code; the rules of communication beside it are a person's own document. */
export const accuracySources = (state: LabState | null) => state?.sources.filter((s) => s.id !== TONE_ID) ?? [];
export const codeSources = (state: LabState | null) => accuracySources(state).filter((s) => s.id !== "accuracy-judge");
export const customAccuracy = (state: LabState | null) => state?.sources.find((s) => s.id === "accuracy-judge");

const TEXT_KEY = agentKey("tone-of-voice:policy-draft");
const NAME_KEY = agentKey("tone-of-voice:policy-name");
export function savedName(): string {
  try {
    return sessionStorage.getItem(NAME_KEY) ?? "Правила общения";
  } catch {
    return "Правила общения";
  }
}
export function rememberName(name: string) {
  try {
    sessionStorage.setItem(NAME_KEY, name);
  } catch {
    /* Optional session memory. */
  }
}
export function savedText(): string {
  try {
    return sessionStorage.getItem(TEXT_KEY) ?? "";
  } catch {
    return "";
  }
}
export function rememberText(text: string) {
  try {
    sessionStorage.setItem(TEXT_KEY, text);
  } catch {
    /* The form stays usable when storage is unavailable. */
  }
}
