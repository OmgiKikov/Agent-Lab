import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { dialogOf } from "../lab/dialogs";
import { day } from "../lab/format";
import { useLabState } from "../lab/LabProvider";
import { personaName } from "../lab/look";
import { secondLine } from "../lab/problemReport";
import { useTurns, type Decision, type Example } from "../lab/problems";
import { splitQuote } from "../lab/quote";
import { Skeleton } from "../ui/EmptyState";
import { Conversation } from "./Conversation";
import { MarkNo } from "./MarkNo";
import { Reliability } from "./Reliability";
import { ReviewButtons } from "./ReviewButtons";
import { visible } from "./text";

const WORD: Record<Example["status"], string> = { FAIL: "Почему это ошибка", PASS: "Почему здесь нет ошибки", UNKNOWN: "Почему не проверено" };

/** Where an example was said: the log's topic, or the simulation's scenario and type of customer. */
function Where({ example }: { example: Example }) {
  const { state } = useLabState();
  if (example.source === "log") return <span>Логи{example.topic ? ` · ${example.topic}` : ""}</span>;
  const run = state?.runs.find(r => r.id === example.runId);
  const repeat = example.attempt && example.attempt > 1 ? ` · повтор ${example.attempt}` : "";
  return <span>Симуляция{run ? ` ${day(run.startedAt)}` : ""} · {example.name} · клиент: {personaName(state?.personas ?? [], example.persona)}{repeat}</span>;
}

/**
 * One verdict with its proof, read top to bottom: why the judge thinks so (with the number of the agent's words it cites),
 * how well it is backed and where it was said, the conversation as the chat looked, and the person's answer.
 * The trace and the raw quote stay folded under «Для разработчика». «Проблемы» and «Проверка вердиктов» show the same card.
 */
export function ExampleCard({ example, lit, onLit, onDecide, onSkip }: {
  example: Example; lit: boolean; onLit: (on: boolean) => void; onDecide?: (d: Decision) => void; onSkip?: () => void;
}) {
  const { state } = useLabState();
  const { turns, loading, error } = useTurns(example);
  const marked = !!example.agentQuote && !!turns?.some(t => t.role === "agent" && splitQuote(visible(t.text).text, example.agentQuote));
  const judged = example.status !== "UNKNOWN";
  return (
    <article className="overflow-hidden rounded-sheet border border-line bg-list shadow-card">
      <header className="px-5 pb-4 pt-4" onMouseEnter={() => onLit(true)} onMouseLeave={() => onLit(false)}>
        <h3 className="text-small font-medium text-fg-3">{WORD[example.status]}</h3>
        <p className="mt-1.5 text-read text-fg">{marked && <MarkNo n={1} on={lit} className="mr-1.5 -translate-y-px align-middle" />}{example.reason}</p>
        {!marked && example.agentQuote && <p className="mt-1.5 text-small text-fg-2">Судья ссылается на слова агента: «{example.agentQuote}»</p>}
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-fg-3">
          <Reliability example={example} />
          <span aria-hidden>·</span>
          <Where example={example} />
          <span aria-hidden>·</span>
          <Link to={dialogOf(example)} title="Открыть разговор целиком (O)" className="inline-flex items-center gap-1 rounded-sm font-medium text-fg-2 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60">
            Весь разговор<ArrowUpRight aria-hidden className="size-3.5" />
          </Link>
        </div>
      </header>
      <div className="border-y border-line bg-inset px-4 py-5 sm:px-5">
        {loading ? <Skeleton className="h-32" />
          : error ? <p className="text-small text-bad">Не удалось загрузить разговор: {error instanceof Error ? error.message : String(error)}</p>
          : turns ? <Conversation turns={turns} marks={marked ? [{ quote: example.agentQuote, n: 1 }] : []} lit={lit} onLit={onLit} />
          : <p className="text-read text-fg">{example.opening}</p>}
      </div>
      {judged && (
        <footer className="space-y-3 px-5 py-4">
          <p className="text-small text-fg-3">{secondLine(example, null)}</p>
          {onDecide && <ReviewButtons example={example} onDecide={onDecide} onSkip={onSkip} />}
          <details className="group text-small">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-fg-3 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60 [&::-webkit-details-marker]:hidden">
              Детали проверки<span aria-hidden className="transition-transform group-open:rotate-90">›</span>
            </summary>
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-fg-2">
              <dt className="text-fg-3">Цитата судьи</dt><dd className="break-words">«{example.agentQuote || "—"}»</dd>
              <dt className="text-fg-3">Судьи</dt><dd className="break-words font-mono text-meta">{[state?.models.main, state?.models.second].filter(Boolean).join(" · ") || "—"}</dd>
              {example.traceId && <><dt className="text-fg-3">Трейс</dt><dd><Link to={`/runs/${encodeURIComponent(example.traceId)}`} className="font-mono text-meta text-run underline-offset-2 hover:underline">{example.traceId}</Link></dd></>}
            </dl>
          </details>
        </footer>
      )}
    </article>
  );
}
