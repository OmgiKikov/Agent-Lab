import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { CHECK_NAME } from "./checks";
import type { Family, LabState, ReplayResult } from "./types";

export const FAMILIES: Family[] = ["tone", "code", "rag"];
export const FAMILY_NAME: Record<Family, string> = { tone: CHECK_NAME.tone, code: CHECK_NAME.code, rag: "База знаний" };
export const familyOf = (ruleId: string) => ruleId.split(":", 1)[0] as Family;
/** The match of the replayed reply with production's (backend lab/match.py): shown under the replies, in no score. */
export const MATCH_ID = "replay:match";

/** The latest replay; read again when the service reports a new one. */
export function useReplay(state: LabState | null) {
  const id = state?.replay?.id ?? null;
  return useQuery({
    queryKey: ["replay", id],
    queryFn: () => api<ReplayResult>("/api/replay"),
    enabled: !!id,
    staleTime: Infinity,
  });
}
