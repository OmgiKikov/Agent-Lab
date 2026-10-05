import { cn } from "@/lib/utils";
import { familyOf, FAMILY_NAME } from "../../lab/replay";
import type { AgentTrace, RagPassage, ReplayStep, Rule } from "../../lab/types";
import { Dot } from "../simulations/parts";

/** A criterion's verdict in the words of the dictionary (docs/DESIGN.md): an error, not a violation. */
const WORD: Record<string, string> = {
  PASS: "без ошибки",
  FAIL: "ошибка",
  UNKNOWN: "не удалось проверить",
  UNMEASURED: "не удалось проверить",
};

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

function Trace({ trace }: { trace: AgentTrace }) {
  return (
    <details className="rounded-control border border-line p-3 text-small">
      <summary className="cursor-pointer text-fg-2">Что происходило внутри агента</summary>
      {trace.rag.map((call, i) => (
        <div key={i} className="mt-3 space-y-2">
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
        </p>
      )}
    </details>
  );
}

function Verdicts({ rules }: { rules: Rule[] }) {
  const shown = rules.filter((r) => r.status !== "NOT_APPLICABLE");
  return (
    <ul className="space-y-2">
      {shown.map((r) => (
        <li key={r.ruleId} className="text-small">
          <span
            className={cn(
              "font-medium",
              r.status === "FAIL" ? "text-bad" : r.status === "PASS" ? "text-ok" : "text-fg-3",
            )}
          >
            {WORD[r.status] ?? r.status}
          </span>
          <span className="text-fg-3"> · {FAMILY_NAME[familyOf(r.ruleId)]} · </span>
          {r.rule}
          {r.reason && <p className="text-fg-2">{r.reason}</p>}
          {r.agentQuote && <p className="text-fg-3">«{r.agentQuote}»</p>}
        </li>
      ))}
    </ul>
  );
}

/** One customer message replayed: production's reply beside the new one, what the agent did, the verdicts. */
export function StepView({ step }: { step: ReplayStep }) {
  return (
    <section className="space-y-3 border-t border-line py-4">
      <div className="flex items-center gap-2">
        <Dot status={step.status ?? "UNMEASURED"} />
        <span className="text-body font-medium text-fg">Клиент: {step.customer}</span>
      </div>
      <div className="flex flex-col gap-3 lg:flex-row">
        <Reply title="Ответ в проде" text={step.prodReply} />
        <Reply title="Ответ сейчас" text={step.reply?.text ?? step.error ?? null} status={step.reply?.status} />
      </div>
      {step.reply && step.error && <p className="text-small text-fg-3">{step.error}</p>}
      {step.trace && <Trace trace={step.trace} />}
      {step.rules && <Verdicts rules={step.rules} />}
    </section>
  );
}
