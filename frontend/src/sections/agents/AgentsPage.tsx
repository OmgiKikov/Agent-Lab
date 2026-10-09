import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Plus, Trash2 } from "lucide-react";
import { agentHref, forgetAgent } from "../../app/agent";
import { Mark } from "../../app/Mark";
import { deleteAgent, useAgents, type Agent } from "../../lab/agents";
import { CHECK_NAME, CHECKS } from "../../lab/checks";
import { Button } from "../../ui/Button";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Modal } from "../../ui/Modal";
import { CheckResult } from "../../product/CheckResult";
import { NewAgent } from "./NewAgent";

/**
 * One agent: its name, what it is, the result of each of its checks. The whole card opens the agent; the bin in its
 * corner, shown on hover and always on a touch screen, asks to delete it.
 */
function AgentCard({ agent, onDelete }: { agent: Agent; onDelete: () => void }) {
  const lines = CHECKS.flatMap((c) => {
    const line = agent.results?.[c];
    return line ? [{ check: c, line }] : [];
  });
  return (
    <div className="group relative">
      <a
        href={agentHref(agent.id)}
        className="flex min-h-[176px] flex-col rounded-block md:min-h-[220px] border border-line bg-canvas p-5 transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-card"
      >
        <h2 className="pr-8 text-count font-semibold text-fg">{agent.name}</h2>
        {agent.description && <p className="mt-1 line-clamp-2 text-body text-fg-3">{agent.description}</p>}
        <div className="mt-auto pt-6">
          {lines.length ? (
            <div className="space-y-4">
              {lines.map(({ check, line }) => (
                <CheckResult key={check} name={CHECK_NAME[check]} line={line} />
              ))}
            </div>
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
      <button
        type="button"
        onClick={onDelete}
        aria-label={`Удалить агента «${agent.name}»`}
        title="Удалить агента"
        className="absolute right-3 top-3 inline-flex size-8 items-center justify-center rounded-control text-fg-3 opacity-0 transition hover:bg-hover hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <Trash2 aria-hidden className="size-4" />
      </button>
    </div>
  );
}

/**
 * «Удалить агента …?»: what goes with it, and that its files stay on this computer (data/deleted/). Refused while its
 * task runs: the service says so here.
 */
function DeleteAgent({ agent, onClose }: { agent: Agent | null; onClose: () => void }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    if (busy) return;
    setError(null);
    onClose();
  };
  const remove = async () => {
    if (!agent) return;
    setBusy(true);
    setError(null);
    try {
      await deleteAgent(agent.id);
      forgetAgent(agent.id);
      await client.invalidateQueries({ queryKey: ["agents"] });
      setBusy(false);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <Modal
      open={!!agent}
      onClose={close}
      title={`Удалить агента «${agent?.name ?? ""}»?`}
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void remove()}>
            Удалить
          </Button>
        </>
      }
    >
      <p className="text-read text-fg-2">Пропадут его датасеты, правила, проверки, сценарии и ответы людей.</p>
      <p className="mt-2 text-small text-fg-3">
        Файлы не стираются: они переедут в папку <span className="font-mono">data/deleted/</span> на этом компьютере.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-small text-bad">
          {error}
        </p>
      )}
    </Modal>
  );
}

/**
 * «Агенты»: the first screen of the product. Every agent the Lab checks, each on its own dialogues by its own rules;
 * inside an agent, the product as it was. Never ranked or compared: their numbers come from other exports and other
 * rules.
 */
export function AgentsPage() {
  const { data, isLoading, error } = useAgents();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(params.get("new") === "1");
  const [deleting, setDeleting] = useState<Agent | null>(null);
  // An address of an agent the Lab does not have leads here (app/Shell, ?missing=): said, so the list is not taken for it.
  const missing = params.get("missing");
  const unknown = missing && data && !data.some((a) => a.id === missing) ? missing : null;
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
        {unknown && (
          <p role="status" className="mt-6 max-w-[64ch] rounded-block bg-inset px-4 py-3 text-read text-fg-2">
            Агент «{unknown}» не найден.{data?.length ? " Откройте агента из списка." : ""}
          </p>
        )}
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
              Имя и одна строка о том, что это за агент. Дальше — датасет его разговоров и правила общения.
            </p>
            <Button className="mt-6" variant="primary" size="lg" icon={Plus} onClick={() => setCreating(true)}>
              Новый агент
            </Button>
          </div>
        ) : (
          <>
            <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {data.map((agent) => (
                <AgentCard key={agent.id} agent={agent} onDelete={() => setDeleting(agent)} />
              ))}
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex min-h-[96px] flex-col items-center justify-center gap-2 rounded-block border border-dashed md:min-h-[220px] border-line-strong p-5 text-fg-3 transition-colors hover:border-fg-3 hover:text-fg"
              >
                <Plus aria-hidden className="size-5" />
                <span className="text-read font-medium">Новый агент</span>
              </button>
            </div>
            {data.length > 1 && (
              <p className="mt-8 max-w-[64ch] text-small text-fg-3">
                Числа агентов не сравниваются: у каждого свои разговоры и правила.
              </p>
            )}
          </>
        )}
      </main>
      <NewAgent open={creating} onClose={close} />
      <DeleteAgent agent={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}
