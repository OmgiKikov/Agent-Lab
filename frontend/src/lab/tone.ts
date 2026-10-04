import type { LabState } from "./types";
import { agentKey } from "../app/agent";

export const TONE_ID = "tone-of-voice";
export type CheckStep = "materials" | "criteria" | "checking" | "result";
export const CHECK_STEPS: { id: CheckStep; label: string }[] = [
  { id: "materials", label: "Материалы" },
  { id: "criteria", label: "Критерии" },
  { id: "checking", label: "Проверка" },
  { id: "result", label: "Результат" },
];

/** The result of the tone-of-voice check, or null. */
export const toneResult = (state: LabState | null) => state?.checks.tone ?? null;

/** What was read from the agent's code; the rules of communication beside it are a person's own document. */
export const codeSources = (state: LabState | null) => state?.sources.filter((s) => s.id !== TONE_ID) ?? [];

export function nextStep(state: LabState | null): CheckStep {
  if (state?.job.running && state.job.kind === "tone-check") return "checking";
  if (state?.toneOfVoice && state.job.kind === "tone-check" && state.job.error) return "checking";
  const result = toneResult(state);
  if (result && result.criteriaRevision === state?.toneOfVoice?.revision) return "result";
  if (state?.toneOfVoice || (state?.job.running && state.job.kind === "tone-criteria")) return "criteria";
  return "materials";
}

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
