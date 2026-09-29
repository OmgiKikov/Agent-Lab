import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, RotateCcw } from "lucide-react";
import { get } from "../api";
import type { LabState, LogDialogue } from "../types";
import { Button, EmptyState, Page, Skeleton } from "../ui";
import { Conversation } from "./Conversation";

/** A saved log and its current verdict, independent of simulator runs. */
export function LogView({ dialogueId, state, onBack }: { dialogueId: string; state: LabState; onBack: () => void }) {
  const query = useQuery({
    queryKey: ["lab", "log", dialogueId, state.discover?.finishedAt],
    queryFn: ({ signal }) => get<LogDialogue>(`/api/logs/${encodeURIComponent(dialogueId)}`, signal),
  });
  const back = (
    <Button size="sm" icon={ArrowLeft} onClick={onBack}>
      Все диалоги
    </Button>
  );
  if (query.isPending)
    return (
      <Page title="диалог из лога" actions={back}>
        <Skeleton className="mt-5 h-[400px]" />
      </Page>
    );
  if (query.isError)
    return (
      <Page title="диалог из лога" actions={back}>
        <EmptyState className="mt-5" title="Не удалось открыть диалог">
          <p>{query.error.message}</p>
          <Button className="mt-3" icon={RotateCcw} onClick={() => query.refetch()}>
            Повторить
          </Button>
        </EmptyState>
      </Page>
    );
  const { messages, evaluation } = query.data;
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-white/[0.06] bg-white/[0.02] px-6 py-2.5">
        {back}
        <span className="text-[12px] text-lab-dim">Разговор из лога</span>
      </div>
      <div className="sb min-h-0 flex-1 overflow-auto">
        <Conversation
          state={state}
          item={{
            conversation: messages.map((m) => ({
              role: m.role === "user" ? "customer" : "agent",
              text: m.content,
              fromLog: true,
            })),
            status: evaluation?.status ?? "UNMEASURED",
            rules: evaluation?.rules ?? [],
            second: evaluation?.second,
            error: evaluation ? (evaluation.error ?? null) : "Диалог ещё не оценён. Запустите оценку на экране «Логи».",
          }}
        />
      </div>
    </div>
  );
}
