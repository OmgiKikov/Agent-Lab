import { useQuery } from "@tanstack/react-query";
import { getReplayContext } from "../api/replay";

export function useReplayContext(input: {
  runId?: string | null;
  eventName?: string | null;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ["replay-context", input.runId, input.eventName],
    queryFn: () => getReplayContext({ runId: input.runId!, eventName: input.eventName }),
    enabled: !!input.runId && input.enabled !== false,
  });
}
