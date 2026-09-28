// In-memory replayRunId → OTLP traceId map. The ingest handler records the
// mapping when a span carries a `replayRunId`; the replay system reads it
// instead of guessing by event-name + timestamp.

const replayRunToTraceId = new Map<string, string>();

export function setReplayTrace(replayRunId: string, traceId: string): void {
  replayRunToTraceId.set(replayRunId, traceId);
}

export function getReplayTrace(replayRunId: string): string | undefined {
  return replayRunToTraceId.get(replayRunId);
}
