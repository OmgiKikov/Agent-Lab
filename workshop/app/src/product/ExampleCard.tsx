import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { ArrowUpRight } from "lucide-react";
import { dialogOf } from "../lab/dialogs";
import { day } from "../lab/format";
import { useLabState } from "../lab/LabProvider";
import { personaName } from "../lab/look";
import { reliabilityWord } from "../lab/problemReport";
import { useTurns, type Decision, type Example } from "../lab/problems";
import { splitQuote } from "../lab/quote";
import { Skeleton } from "../ui/EmptyState";
import { Conversation } from "./Conversation";
import { MarkNo } from "./MarkNo";
import { ReviewButtons } from "./ReviewButtons";
import { visible } from "./text";

const WORD: Record<Example["status"], string> = { FAIL: "Почему это ошибка", PASS: "Почему здесь нет ошибки", UNKNOWN: "Почему не проверено" };

/** Where an example was said: the log's topic, or the simulation's scenario and type of customer. */
function Where({ example }: { example: Example }) {
  const { state } = useLabState();
  if (example.source === "log") return <span>{example.topic || "логи"}</span>;
  const run = state?.runs.find(r => r.id === example.runId);
  const repeat = example.attempt && example.attempt > 1 ? ` · повтор ${example.attempt}` : "";
  return <span>{example.name} · клиент: {personaName(state?.personas ?? [], example.persona).toLowerCase()}{run ? ` · ${day(run.startedAt)}` : ""}{repeat}</span>;
}

/**
 * One case, the heart of the product: why the checks call it an error (with the number of the agent's words they cite),
 * the conversation as the customer saw it, and the person's answer. The only box on its page; the trace and the raw quote
 * stay folded under «Детали проверки».
 */
export function ExampleCard({ example, lit, onLit, onDecide, onSkip, emphasis }: {
  example: Example; lit: boolean; onLit: (on: boolean) => void; onDecide?: (d: Decision) => void; onSkip?: () => void; emphasis?: boolean;
}) {
  const { state } = useLabState();
  const { turns, loading, error } = useTurns(example);
  const marked = !!example.agentQuote && !!turns?.some(t => t.role === "agent" && splitQuote(visible(t.text).text, example.agentQuote));
  const judged = example.status !== "UNKNOWN";
  return (
    <article className="rounded-sheet bg-list shadow-card ring-1 ring-line">
      <header className="px-5 pb-5 pt-5 sm:px-7 sm:pt-6" onMouseEnter={() => onLit(true)} onMouseLeave={() => onLit(false)}>
        <h3 className="text-small font-medium text-fg-3">{WORD[example.status]}</h3>
        <p className="mt-2 text-lead text-fg">{marked && <MarkNo n={1} on={lit} className="mr-2 -translate-y-px align-middle" />}{example.reason}</p>
        {!marked && example.agentQuote && <p className="mt-2 text-read text-fg-2">Агент сказал: «{example.agentQuote}»</p>}
        <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-fg-3">
          <span>{reliabilityWord(example)}</span>
          <span aria-hidden>·</span>
          <Where example={example} />
          <span aria-hidden>·</span>
          <Link to={dialogOf(example)} title="Открыть разговор целиком (O)" className="inline-flex items-center gap-0.5 rounded-sm font-medium text-run hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60">
            Весь разговор<ArrowUpRight aria-hidden className="size-3.5" />
          </Link>
        </p>
      </header>
      <div className={cn("bg-inset px-4 py-6 sm:px-7", !judged && "rounded-b-sheet")}>
        {loading ? <Skeleton className="h-40" />
          : error ? <p className="text-read text-bad">Не удалось загрузить разговор: {error instanceof Error ? error.message : String(error)}</p>
          : turns ? <Conversation turns={turns} marks={marked ? [{ quote: example.agentQuote, n: 1 }] : []} lit={lit} onLit={onLit} />
          : <p className="text-read text-fg">{example.opening}</p>}
      </div>
      {judged && onDecide && (
        // In the check queue the question stays in sight while the conversation scrolls under it.
        <div className={cn("px-5 pt-5 sm:px-7", emphasis && "sticky bottom-0 z-10 border-t border-line bg-list/90 pb-4 pt-4 backdrop-blur-md")}>
          <ReviewButtons example={example} onDecide={onDecide} onSkip={onSkip} emphasis={emphasis} />
        </div>
      )}
      {judged && (
        <footer className="px-5 pb-5 pt-4 sm:px-7">
          <details className="group text-small">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-fg-3 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60 [&::-webkit-details-marker]:hidden">
              Детали проверки<span aria-hidden className="transition-transform group-open:rotate-90">›</span>
            </summary>
            <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-fg-2">
              <dt className="text-fg-3">Слова агента</dt><dd className="break-words">«{example.agentQuote || "—"}»</dd>
              <dt className="text-fg-3">Проверяли</dt><dd className="break-words font-mono text-small">{[state?.models.main, state?.models.second].filter(Boolean).join(" и ") || "—"}</dd>
              {example.traceId && <><dt className="text-fg-3">Трейс</dt><dd><Link to={`/runs/${encodeURIComponent(example.traceId)}`} className="font-mono text-small text-run hover:underline">{example.traceId}</Link></dd></>}
            </dl>
          </details>
        </footer>
      )}
    </article>
  );
}
