import { Link } from "react-router-dom";
import { ArrowUpRight, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { personaName } from "../../lab/look";
import { reliabilityWord, secondLine } from "../../lab/problemReport";
import { useTurns, type Decision, type Example } from "../../lab/problems";
import type { Persona } from "../../lab/types";
import { useLabState } from "../../shell/LabProvider";
import { dialogOf } from "../../lab/dialogs";
import { Button } from "../../ui/Button";
import { Conversation, MarkNumber, visible } from "../../ui/Conversation";
import { Skeleton } from "../../ui/EmptyState";
import { splitQuote } from "../../ui/highlight";

/** An example's conversation, loaded, and whether the judge's quote is found in the agent's words. */
export function useExample(example?: Example) {
  const { turns, loading, error } = useTurns(example);
  const marked = !!example?.agentQuote && !!turns?.some(t => t.role === "agent" && splitQuote(visible(t.text).text, example.agentQuote));
  return { turns, loading, error, marked };
}
export type ExampleView = ReturnType<typeof useExample>;

export function exampleWhere(e: Example, personas: Persona[]): string {
  if (e.source === "log") return `Лог · тема «${e.topic}»`;
  const repeat = e.attempt && e.attempt > 1 ? ` · повтор ${e.attempt}` : "";
  return `Симуляция · ${e.name} · клиент: ${personaName(personas, e.persona)}${repeat}`;
}

/** Where the example comes from, how well it is backed, and the way to its whole conversation. */
export function ExampleMeta({ example }: { example: Example }) {
  const { state } = useLabState();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-meta text-lab-dim">
      <span>{exampleWhere(example, state?.personas ?? [])}{example.status === "FAIL" && ` · ${reliabilityWord(example)}`}</span>
      <Link to={dialogOf(example)} className="inline-flex items-center gap-1 transition-colors hover:text-lab-text" title="Открыть диалог (O)">
        Открыть диалог<ArrowUpRight className="size-3.5" />
      </Link>
    </div>
  );
}

export function ConversationBox({ view, example, hover, onHover, className }: {
  view: ExampleView; example: Example; hover?: boolean; onHover?: (on: boolean) => void; className?: string;
}) {
  return (
    <div className={cn(className)}>
      {view.loading ? <Skeleton className="h-28" />
        : view.error ? <p className="text-small text-lab-bad">Не удалось загрузить разговор: {view.error instanceof Error ? view.error.message : String(view.error)}</p>
        : view.turns ? <Conversation turns={view.turns} mark={view.marked ? { quote: example.agentQuote, n: 1 } : undefined} hover={hover} onHover={onHover} />
        : <p className="text-read text-lab-text">{example.opening}</p>}
    </div>
  );
}

export function ReviewButtons({ example, onDecide }: { example: Example; onDecide: (d: Decision) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-small text-lab-mute">Вердикт верный?</span>
      <Button size="sm" icon={Check} kbd="V" aria-pressed={example.review === "agree"} onClick={() => onDecide("agree")} className={cn(example.review === "agree" && "border-lab-ok/50 text-lab-ok")}>Верно</Button>
      <Button size="sm" icon={X} kbd="N" aria-pressed={example.review === "disagree"} onClick={() => onDecide("disagree")} className={cn(example.review === "disagree" && "border-lab-bad/50 text-lab-bad")}>Неверно</Button>
      {example.reviewScope === "dialogue" && <span className="text-meta text-lab-dim">отмечено для диалога целиком</span>}
    </div>
  );
}

const WORD: Record<Example["status"], string> = { FAIL: "нарушено", PASS: "выполнено", UNKNOWN: "не проверено" };

/** The judge's explanation under the conversation, the second judge, and a person's decision. */
export function JudgeNote({ example, marked, onDecide, verdict = true, hover, onHover }: { example: Example; marked: boolean; onDecide?: (d: Decision) => void; verdict?: boolean; hover?: boolean; onHover?: (on: boolean) => void }) {
  const { state } = useLabState();
  const judged = example.status !== "UNKNOWN";
  return (
    <div className="flex gap-3">
      <span className={cn("mt-1", !marked && "invisible")}><MarkNumber n={1} active={hover} onActive={onHover && (n => onHover(n !== null))} /></span>
      <div className="min-w-0 flex-1 space-y-1.5">
        {!marked && example.agentQuote && <p className="text-small text-lab-mute">Судья ссылается на: «{example.agentQuote}»</p>}
        <p className="text-small text-lab-text">
          <span className="text-lab-dim">Судья{verdict && example.status !== "FAIL" ? ` · ${WORD[example.status]}` : ""}: </span>{example.reason}
        </p>
        {judged && <p className="text-small text-lab-mute">{secondLine(example, state?.models.second ?? null)}</p>}
        {judged && onDecide && <div className="pt-1.5"><ReviewButtons example={example} onDecide={onDecide} /></div>}
      </div>
    </div>
  );
}
