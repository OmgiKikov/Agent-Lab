import type { LabState } from "../lab/types";
import { toneResult } from "../lab/tone";

/**
 * For now the product shows only tone of voice: the start, the check, «Обзор» and «Диалоги» with its result. Accuracy by
 * the agent's code, simulations, criteria and the agent are hidden, not removed: their addresses lead to the start. Set
 * to false to bring them back.
 */
export const TONE_ONLY = true;

/** In tone-only mode «Диалоги» are shown once they hold a tone-of-voice result, never the accuracy one. */
export const dialoguesShown = (state: LabState | null) => !TONE_ONLY || !!toneResult(state);
