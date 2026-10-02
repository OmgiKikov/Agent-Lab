import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowRight, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { agentHref } from "../../app/agent";
import { Mark } from "../../app/Mark";
import { useAgents, type Agent } from "../../lab/agents";
import { longDay, plural } from "../../lab/format";
import { Button } from "../../ui/Button";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { NewAgent } from "./NewAgent";

/** The last result in a card: errors of measured, the split as a thin bar, which metric and when. */
function Result({ result }: { result: NonNullable<Agent["result"]> }) {
  const { failed, measured, unmeasured } = result;
  const parts = [
    { key: "bad", n: failed, cls: "bg-bad" },
    { key: "ok", n: Math.max(0, measured - failed), cls: "bg-ok" },
    { key: "none", n: unmeasured, cls: "hatch" },
  ].filter((p) => p.n > 0);
  const total = parts.reduce((s, p) => s + p.n, 0) || 1;
  return (
    <div>
      <p className="whitespace-nowrap text-title font-semibold tabular-nums">
        <span className={failed ? "text-bad" : "text-fg"}>{failed}</span>
        <span className="font-normal text-fg-3">{" из "}</span>
        <span className="text-fg">{measured}</span>
      </p>
      <p className="mt-0.5 text-small text-fg-3">
        {plural(measured, "проверенного разговора", "проверенных разговоров", "проверенных разговоров")} — с ошибкой
        агента
      </p>
      <div className="mt-3 flex h-1.5 w-full gap-[2px] overflow-hidden rounded-full" aria-hidden>
        {parts.map((p) => (
          <div key={p.key} className={cn("h-full rounded-full", p.cls)} style={{ width: `${(100 * p.n) / total}%` }} />
        ))}
      </div>
      <p className="mt-3 text-small text-fg-3">
        {result.metric} · {longDay(result.finishedAt)}
      </p>
    </div>
  );
}

/** One agent: its name, what it is, its last check. The whole card opens the agent. */
function AgentCard({ agent }: { agent: Agent }) {
  return (
    <a
      href={agentHref(agent.id)}
      className="group flex min-h-[220px] flex-col rounded-block border border-line bg-canvas p-5 transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-card"
    >
      <h2 className="text-count font-semibold text-fg">{agent.name}</h2>
      {agent.description && <p className="mt-1 line-clamp-2 text-body text-fg-3">{agent.description}</p>}
      <div className="mt-auto pt-6">
        {agent.result ? (
          <Result result={agent.result} />
        ) : (
          <div>
            <p className="text-read text-fg-2">Ещё не проверялся</p>
            <p className="mt-2 inline-flex items-center gap-1 text-read font-medium text-run group-hover:underline">
              Начать проверку
              <ArrowRight aria-hidden className="size-4" />
            </p>
          </div>
        )}
      </div>
    </a>
  );
}

/**
 * «Агенты»: the first screen of the product. Every agent the Lab checks, each on its own dialogues by its own rules;
 * inside an agent, the product as it was. Never ranked or compared: their numbers come from other exports and other
 * rules (DESIGN.md, честность 2).
 */
export function AgentsPage() {
  const { data, isLoading, error } = useAgents();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(params.get("new") === "1");
  const close = () => {
    setCreating(false);
    if (params.get("new")) setParams({}, { replace: true });
  };
  return (
    <div className="min-h-full bg-canvas">
      <header className="flex h-16 items-center justify-between border-b border-line px-4 lg:px-10">
        <span className="flex items-center gap-3">
          <Mark />
          <span className="text-read font-semibold text-fg">Agent Lab</span>
        </span>
        {!!data?.length && (
          <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
            Новый агент
          </Button>
        )}
      </header>
      <main className="mx-auto max-w-[1080px] px-4 pb-24 pt-10 lg:px-10 lg:pt-14">
        <h1 className="text-page font-semibold text-fg">Агенты</h1>
        <p className="mt-3 max-w-[60ch] text-lead text-fg-2">
          Каждый агент проверяется на своих разговорах по своим правилам. Откройте агента, чтобы увидеть, где он
          ошибается и чем это доказано.
        </p>
        {error ? (
          <div className="mt-10">
            <ServiceDown />
          </div>
        ) : isLoading || !data ? (
          <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <Skeleton className="h-[220px]" />
            <Skeleton className="h-[220px]" />
          </div>
        ) : data.length === 0 ? (
          <div className="mt-12 max-w-xl">
            <Mark quiet className="size-12 rounded-2xl" />
            <h2 className="mt-6 text-title font-semibold text-fg">Добавьте первого агента</h2>
            <p className="mt-2 text-read text-fg-2">
              Имя и одна строка о том, что это за агент. Дальше — выгрузка его разговоров и правила общения.
            </p>
            <Button className="mt-6" variant="primary" size="lg" icon={Plus} onClick={() => setCreating(true)}>
              Новый агент
            </Button>
          </div>
        ) : (
          <>
            <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {data.map((agent) => (
                <AgentCard key={agent.id} agent={agent} />
              ))}
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-block border border-dashed border-line-strong p-5 text-fg-3 transition-colors hover:border-fg-3 hover:text-fg"
              >
                <Plus aria-hidden className="size-5" />
                <span className="text-read font-medium">Новый агент</span>
              </button>
            </div>
            {data.length > 1 && (
              <p className="mt-8 max-w-[64ch] text-small text-fg-3">
                Числа агентов не сравниваются: у каждого свои разговоры и свои правила.
              </p>
            )}
          </>
        )}
      </main>
      <NewAgent open={creating} onClose={close} />
    </div>
  );
}
