import { cn } from "@/lib/utils";
import { twoChecks } from "../../lab/dialogs";
import { familyOf, FAMILY_NAME, MATCH_ID } from "../../lab/replay";
import type { AgentTrace, RagCall, RagPassage, ReplayStep, Rule, Status } from "../../lab/types";
import { RULE_WORD } from "../dialogs/Dialog";
import { Dot, dotOf } from "../simulations/parts";

const score = (passage: RagPassage) => {
  const value = passage.reranker ?? passage.retrieval;
  return value === null ? "—" : value.toFixed(2);
};

function Reply({ title, text, status }: { title: string; text: string | null; status?: string }) {
  return (
    <div className="min-w-0 flex-1 rounded-control border border-line p-3">
      <div className="mb-1 text-small text-fg-3">
        {title}
        {status && status !== "200" ? ` · статус ${status}` : ""}
      </div>
      <p className="whitespace-pre-wrap text-body text-fg">{text ?? "—"}</p>
    </div>
  );
}

const CALL_WORD: Record<string, string> = {
  error: "База знаний ответила ошибкой.",
  timeout: "База знаний не ответила вовремя.",
  cancelled: "Запрос отменён: агент ответил раньше.",
  pending: "Запрос не закончился к ответу агента.",
};

function CallNote({ call }: { call: RagCall }) {
  if (call.source === "cache") return <p className="text-fg-3">Ответ из кэша базы знаний, без запроса.</p>;
  const word = typeof call.status === "string" ? CALL_WORD[call.status] : undefined;
  return word ? <p className="text-bad">{word}</p> : null;
}

function Trace({ trace }: { trace: AgentTrace }) {
  return (
    <details className="rounded-control border border-line p-3 text-small">
      <summary className="cursor-pointer text-fg-2">Что происходило внутри агента</summary>
      {trace.rag.map((call, i) => (
        <div key={i} className="mt-3 space-y-2">
          <CallNote call={call} />
          <div>
            <span className="text-fg-3">Запрос в базу знаний: </span>
            {call.query}
          </div>
          <ol className="space-y-1">
            {call.passages.map((p, j) => (
              <li key={j} className="rounded-sm bg-hover p-2">
                <div className="text-fg-3">
                  Статья {String(p.article ?? "—")}, фрагмент {p.passage ?? "—"} · релевантность {score(p)}
                </div>
                <p className="whitespace-pre-wrap">{p.text}</p>
              </li>
            ))}
          </ol>
          <div>
            <span className="text-fg-3">Ответ базы знаний: </span>
            {call.answer || call.reason || "—"}
          </div>
          {call.request != null && (
            <details>
              <summary className="cursor-pointer text-fg-3">Запрос в базу знаний целиком</summary>
              <pre className="mt-1 whitespace-pre-wrap break-all">{JSON.stringify(call.request, null, 2)}</pre>
            </details>
          )}
        </div>
      ))}
      {trace.rag.length === 0 && <p className="mt-3 text-fg-3">К базе знаний агент не обращался.</p>}
      <ul className="mt-3 space-y-1">
        {trace.chains.map((chain, i) => (
          <li key={i}>
            <span className="text-fg-3">{chain.name}: </span>
            <span className="whitespace-pre-wrap">{chain.error ?? chain.output ?? "—"}</span>
          </li>
        ))}
      </ul>
      {trace.systems.length > 0 && (
        <p className="mt-3">
          <span className="text-fg-3">Системы банка: </span>
          {trace.systems.map((s) => s.tool).join(", ")}
          {trace.systems.some((s) => s.status === "stubbed") && <span className="text-fg-3"> (тестовые данные)</span>}
        </p>
      )}
    </details>
  );
}

/** Whether the replayed reply matches production's: under the two replies, never among the verdicts. */
function Match({ rules }: { rules?: Rule[] }) {
  const row = rules?.find((r) => r.ruleId === MATCH_ID);
  if (!row || row.status === "NOT_APPLICABLE") return null;
  const line =
    row.status === "PASS"
      ? "Совпадает с ответом в проде."
      : row.status === "FAIL"
        ? "Отличается от ответа в проде."
        : "Не удалось сравнить с ответом в проде.";
  return (
    <p className="text-small text-fg-2">
      {line}
      {row.reason && ` ${row.reason}`}
    </p>
  );
}

function Verdicts({ rules }: { rules: Rule[] }) {
  const shown = rules.filter((r) => r.status !== "NOT_APPLICABLE" && r.ruleId !== MATCH_ID);
  return (
    <ul className="space-y-2">
      {shown.map((r) => (
        <li key={r.ruleId} className="text-small">
          <Word status={r.status} />
          <span className="text-fg-3"> · {FAMILY_NAME[familyOf(r.ruleId)]} · </span>
          {r.rule}
          {r.reason && <p className="text-fg-2">{r.reason}</p>}
          {r.agentQuote && <p className="text-fg-3">«{r.agentQuote}»</p>}
        </li>
      ))}
    </ul>
  );
}

function Word({ status }: { status: string }) {
  const [word, tone] = RULE_WORD[status] ?? [status, "text-fg-3"];
  return <span className={cn("font-medium", tone)}>{word}</span>;
}

/**
 * The second model's opinion on the step in the words of «Разговоры»: two models agree or not, and when one of them
 * decided nothing, what the second one found. Nothing with one model: asking it twice is not a second opinion.
 */
function Second({ step }: { step: ReplayStep }) {
  const second = step.second;
  if (!second) return null;
  const agreement = twoChecks(step.status ?? null, second);
  const line =
    agreement === "agree"
      ? "Две модели совпали."
      : agreement === "disagree"
        ? "Модели разошлись."
        : `Вторая проверка: ${dotOf(second.status as Status).word}.`;
  return (
    <p className="text-small text-fg-3" title={[second.model, second.error].filter(Boolean).join(": ")}>
      {line}
    </p>
  );
}

/** One customer message replayed: production's reply beside the new one, what the agent did, the verdicts. */
export function StepView({ step }: { step: ReplayStep }) {
  return (
    <section className="space-y-3 border-t border-line py-4">
      <div className="flex items-center gap-2">
        <Dot status={step.status ?? "UNMEASURED"} />
        <span className="sr-only">{dotOf(step.status ?? "UNMEASURED").word}. </span>
        <span className="text-body font-medium text-fg">Клиент: {step.customer}</span>
      </div>
      <div className="flex flex-col gap-3 lg:flex-row">
        <Reply title="Ответ в проде" text={step.prodReply} />
        <Reply title="Ответ сейчас" text={step.reply?.text ?? step.error ?? null} status={step.reply?.status} />
      </div>
      <Match rules={step.rules} />
      {step.reply && step.error && <p className="text-small text-fg-3">{step.error}</p>}
      {step.trace && <Trace trace={step.trace} />}
      {step.rules && <Verdicts rules={step.rules} />}
      <Second step={step} />
    </section>
  );
}
