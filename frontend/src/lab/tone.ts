import type { LabState } from "./types";

export const TONE_ID = "tone-of-voice";
export type CheckStep = "materials" | "criteria" | "checking" | "result";
export const CHECK_STEPS: { id: CheckStep; label: string }[] = [
  { id: "materials", label: "Материалы" },
  { id: "criteria", label: "Критерии" },
  { id: "checking", label: "Проверка" },
  { id: "result", label: "Результат" },
];

export function toneResult(state: LabState | null) {
  const assessment = state?.discover;
  return assessment?.purpose === TONE_ID ? assessment : null;
}

export function nextStep(state: LabState | null): CheckStep {
  if (state?.job.running && state.job.kind === "tone-check") return "checking";
  if (state?.toneOfVoice && state.job.kind === "tone-check" && state.job.error) return "checking";
  const result = toneResult(state);
  if (result && result.criteriaRevision === state?.toneOfVoice?.revision) return "result";
  if (state?.toneOfVoice || (state?.job.running && state.job.kind === "tone-criteria")) return "criteria";
  return "materials";
}

const TEXT_KEY = "tone-of-voice:policy-draft";
const NAME_KEY = "tone-of-voice:policy-name";
export function savedName(): string {
  try {
    return sessionStorage.getItem(NAME_KEY) ?? "Правила tone of voice";
  } catch {
    return "Правила tone of voice";
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
