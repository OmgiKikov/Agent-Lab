import { useQuery } from "@tanstack/react-query";
import {
  buildCloudRun,
  detectSubAgents,
  getCloudSpans,
  listEvents,
  type QueryEvent,
} from "../api/query-api";

export function useCloudTrace(event: QueryEvent | null | undefined) {
  return useQuery({
    queryKey: ["cloud-trace", event?.id],
    queryFn: async () => {
      const spans = await getCloudSpans(event!.id);
      return {
        run: buildCloudRun(event!, spans),
        spans,
        liveEvents: [],
        subAgents: detectSubAgents(spans),
      };
    },
    enabled: !!event,
  });
}

export function useCloudTraceById(eventId: string | null | undefined, eventName: string | null | undefined) {
  return useQuery({
    queryKey: ["cloud-trace", eventId],
    queryFn: async () => {
      const spans = await getCloudSpans(eventId!);
      const runEvent = {
        id: eventId!,
        event_name: eventName ?? eventId!,
        user_id: null,
        convo_id: null,
        timestamp: spans.length > 0 ? new Date(Math.min(...spans.map(s => s.start_time_ms))).toISOString() : new Date().toISOString(),
        user_input: null,
        assistant_output: null,
      };
      return {
        run: buildCloudRun(runEvent, spans),
        spans,
        liveEvents: [],
        subAgents: detectSubAgents(spans),
      };
    },
    enabled: !!eventId,
  });
}

export function useCloudConversation(convoId: string | null | undefined) {
  return useQuery({
    queryKey: ["cloud-conversation", convoId],
    queryFn: async () => {
      const res = await listEvents({ convoId: convoId!, limit: 100, orderBy: "timestamp" });
      return Promise.all(res.data.map(async (event) => {
        try {
          return { event, spans: await getCloudSpans(event.id) };
        } catch {
          return { event, spans: [] };
        }
      }));
    },
    enabled: !!convoId,
  });
}
