import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { Check, Discover, LabState } from "./types";
import { ACCURACY } from "../app/product";

// The checks the product shows: tone of voice alone in the first release (app/product).
export const CHECKS: Check[] = ACCURACY ? ["tone", "code"] : ["tone"];

/** The names a person reads: in the navigation, the headings, the labels of runs and scenarios. */
export const CHECK_NAME: Record<Check, string> = { tone: "Tone of voice", code: "Точность" };

/** «по критериям Tone of voice»: what a run or a scenario is counted by. */
export const BY_CRITERIA: Record<Check, string> = {
  tone: "по критериям Tone\u00a0of\u00a0voice",
  code: "по критериям точности",
};

/** What a deck's scenarios are counted by: its check's criteria, or none when it was built before any check. */
export const deckCriteria = (check: Check | null): string => (check ? BY_CRITERIA[check] : "без критериев");

/** A deck built without a check: its customers can be read, but no judge can count a run of them. */
export const UNJUDGED =
  "Сценарии собраны без проверки, и судить разговоры не по чему. Проверьте разговоры и соберите сценарии заново.";

/** The task of the service that writes a check's result. */
export const JOB_OF: Record<Check, string> = { tone: "tone-check", code: "discover" };

/** The result of a check in brief (the state's), or null while it has none. */
export const resultOf = (state: LabState | null, check: Check) => state?.checks[check] ?? null;

/**
 * The result of a check itself, with the verdicts on every conversation and the answers people gave on them: fetched
 * when the state says there is one, and again when it is another result or anyone answered anything (reviewsStamp).
 * Until the new one comes the screen keeps the one it had; a result cleared (a new export) is never kept.
 */
export function useResult(check: Check | null, state: LabState | null) {
  const brief = check ? resultOf(state, check) : null;
  return useQuery({
    queryKey: ["result", check, brief?.checkId ?? brief?.finishedAt ?? null, state?.reviewsStamp ?? null],
    queryFn: () => api<Discover>(`/api/checks/${check}`),
    enabled: !!brief,
    staleTime: Infinity,
    placeholderData: (previous, query) => (brief && query?.queryKey[1] === check ? previous : undefined),
  });
}

/**
 * Where an address from before the checks had their own sections leads (spec §3): into the check that has a result,
 * tone of voice when both or neither do.
 */
export const checkOfOld = (state: LabState | null): Check =>
  resultOf(state, "code") && !resultOf(state, "tone") ? "code" : "tone";
