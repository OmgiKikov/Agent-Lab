import { useEffect, useMemo } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { parseMessages } from "./MessageList";
import { Markdown } from "./Markdown";
import { C } from "../utils/colors";
import { ago } from "../utils/helpers";
import { useCloudConversation } from "../hooks/use-cloud-trace";
import type { QueryEvent } from "../api/query-api";
import type { Span } from "../utils/types";

interface ConvoTurn {
  event: QueryEvent;
  spans: Span[];
}

type ConvoEvent =
  | { type: "turn_start"; turnIndex: number; event: QueryEvent; time: number }
  | { type: "user_msg"; content: string; time: number; turnIndex: number }
  | { type: "tool_group"; spans: Span[]; time: number; turnIndex: number }
  | { type: "llm_out"; content: string; time: number; turnIndex: number };

function buildRemoteConvoEvents(turns: ConvoTurn[]): ConvoEvent[] {
  const events: ConvoEvent[] = [];
  for (let i = 0; i < turns.length; i++) {
    const { event, spans } = turns[i];
    const time = new Date(event.timestamp).getTime();
    events.push({ type: "turn_start", turnIndex: i, event, time });

    const llmSpans = spans.filter(s => s.span_type?.includes("LLM")).sort((a, b) => a.start_time_ms - b.start_time_ms);
    let userMsg: string | null = null;
    const lastLLM = llmSpans[llmSpans.length - 1];
    if (lastLLM?.normalized?.kind === "llm" && lastLLM.normalized.userMessage) {
      userMsg = lastLLM.normalized.userMessage;
    } else if (lastLLM?.input_payload) {
      const messages = parseMessages(lastLLM.input_payload);
      if (messages) {
        const lastUser = [...messages].reverse().find(m => m.role === "user");
        if (lastUser) userMsg = lastUser.content;
      } else {
        userMsg = lastLLM.input_payload;
      }
    }
    if (!userMsg && event.user_input) userMsg = event.user_input;
    if (userMsg) events.push({ type: "user_msg", content: userMsg, time: time + 1, turnIndex: i });

    const outputSpan = llmSpans.find(s => s.output_payload);
    const output = outputSpan?.output_payload ?? event.assistant_output;
    if (output) events.push({ type: "llm_out", content: output, time: outputSpan?.end_time_ms ?? time + 2, turnIndex: i });
  }
  return events;
}

export function RemoteConvoLoader({ convoId, highlightEventId }: { convoId: string; highlightEventId: string }) {
  const { data: turns = [], isLoading, error } = useCloudConversation(convoId);
  const events = useMemo(() => buildRemoteConvoEvents(turns), [turns]);

  useEffect(() => {
    if (isLoading || turns.length === 0) return;
    document
      .getElementById(`convo-turn-${highlightEventId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightEventId, isLoading, turns.length]);

  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center space-y-2">
          <AlertCircle className="mx-auto size-5" style={{ color: C.red }} />
          <div className="text-[11px]" style={{ color: C.red }}>{(error as Error).message ?? "Failed to load conversation"}</div>
        </div>
      </div>
    );
  }

  if (isLoading && turns.length === 0) {
    return (
      <div className="h-full flex items-center justify-center gap-2" style={{ color: C.fg1 }}>
        <Loader2 className="size-4 animate-spin" /> Loading conversation…
      </div>
    );
  }

  if (turns.length === 0) {
    return <div className="h-full flex items-center justify-center"><div className="text-[11px]" style={{ color: C.fg0 }}>No conversation data</div></div>;
  }

  return (
    <div className="h-full overflow-auto sb p-4">
      <div className="max-w-3xl mx-auto space-y-3">
        {events.map((ev, idx) => {
          if (ev.type === "turn_start") {
            const isHighlight = ev.event.id === highlightEventId;
            return (
              <div key={idx} id={`convo-turn-${ev.event.id}`} className="flex items-center gap-2 py-2">
                <div className="h-px flex-1" style={{ background: C.border }} />
                <div className="text-[10px] font-mono px-2 py-1 rounded-full" style={{ background: isHighlight ? "rgba(165,124,245,0.18)" : "rgba(255,255,255,0.04)", color: isHighlight ? C.purple : C.fg0 }}>
                  Turn {ev.turnIndex + 1} | {ago(new Date(ev.event.timestamp).getTime())}
                </div>
                <div className="h-px flex-1" style={{ background: C.border }} />
              </div>
            );
          }
          if (ev.type === "user_msg") {
            return (
              <div key={idx} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl px-4 py-2.5" style={{ background: "rgba(255,255,255,0.06)", color: C.fg4 }}>
                  <div className="text-[13px] whitespace-pre-wrap">{ev.content}</div>
                </div>
              </div>
            );
          }
          if (ev.type === "llm_out") {
            return (
              <div key={idx} className="flex justify-start">
                <div className="max-w-[85%] text-[13px]" style={{ color: C.fg3 }}>
                  <Markdown>{ev.content}</Markdown>
                </div>
              </div>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}
