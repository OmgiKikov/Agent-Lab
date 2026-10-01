import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { dialogOf } from "../lab/dialogs";
import { day } from "../lab/format";
import { personaName } from "../lab/look";
import { useTurns, type Decision, type Example } from "../lab/problems";
import { useLabState } from "../lab/LabProvider";
import { Skeleton } from "../ui/EmptyState";
import { splitQuote } from "../lab/quote";
import { Conversation } from "./Conversation";
import { JudgeNote } from "./JudgeNote";
import { Reliability } from "./Reliability";
import { visible } from "./text";

/** Where an example was said: the log's topic, or the simulation's scenario and type of customer. */
function Where({ example }: { example: Example }) {
  const { state } = useLabState();
  if (example.source === "log") return <span>лог{example.topic ? ` · ${example.topic}` : ""}</span>;
  const run = state?.runs.find(r => r.id === example.runId);
  const repeat = example.attempt && example.attempt > 1 ? ` · повтор ${example.attempt}` : "";
  return <span>симуляция{run ? ` ${day(run.startedAt)}` : ""} · {example.name} · клиент: {personaName(state?.personas ?? [], example.persona)}{repeat}</span>;
}

/**
 * One verdict with its proof: how well it is backed and where it was said, the conversation with the agent's words
 * the judge cited, the judge's reason, the second judge and a person's word. «Нарушения» and «Проверка вердиктов» show the same.
 */
export function ExampleCard({ example, lit, onLit, onDecide, onSkip }: {
  example: Example; lit: boolean; onLit: (on: boolean) => void; onDecide?: (d: Decision) => void; onSkip?: () => void;
}) {
  const { turns, loading, error } = useTurns(example);
  const marked = !!example.agentQuote && !!turns?.some(t => t.role === "agent" && splitQuote(visible(t.text).text, example.agentQuote));
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-fg-3">
        <Reliability example={example} />
        <span aria-hidden>·</span>
        <Where example={example} />
        <span aria-hidden>·</span>
        <Link to={dialogOf(example)} title="Открыть диалог целиком (O)" className="inline-flex items-center gap-1 rounded-sm text-fg-2 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60">
          Открыть диалог<ArrowUpRight aria-hidden className="size-3.5" />
        </Link>
      </div>
      <div className="mt-3 rounded-block border border-line bg-inset px-4 pb-4 pt-3.5">
        {loading ? <Skeleton className="h-28" />
          : error ? <p className="text-small text-bad">Не удалось загрузить разговор: {error instanceof Error ? error.message : String(error)}</p>
          : turns ? <Conversation turns={turns} marks={marked ? [{ quote: example.agentQuote, n: 1 }] : []} lit={lit} onLit={onLit} />
          : <p className="text-read text-fg">{example.opening}</p>}
        <JudgeNote example={example} marked={marked} lit={lit} onLit={onLit} onDecide={onDecide} onSkip={onSkip} />
      </div>
    </>
  );
}
