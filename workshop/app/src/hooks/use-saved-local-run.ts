import { useQuery } from "@tanstack/react-query";
import { getRunDetailOrNull } from "../api/runs";
import { setLocalRunCache } from "../api/saved-runs";

async function hasLocalSavedRun(runId: string): Promise<boolean> {
  const data = await getRunDetailOrNull(runId);
  if (!data?.run || data.spans.length === 0) return false;
  void setLocalRunCache(runId, data);
  return true;
}

export function useSavedLocalRun(runId: string) {
  return useQuery({
    queryKey: ["saved-local-run", runId],
    queryFn: () => hasLocalSavedRun(runId),
  });
}
