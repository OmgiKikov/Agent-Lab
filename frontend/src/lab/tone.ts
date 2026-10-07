import type { LabState } from "./types";
import { agentKey } from "../app/agent";

export const TONE_ID = "tone-of-voice";
/** The result of the tone-of-voice check, or null. */
export const toneResult = (state: LabState | null) => state?.checks.tone ?? null;

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
