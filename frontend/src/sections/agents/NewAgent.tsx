import { useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { agentHref } from "../../app/agent";
import { createAgent, rulesLine, takeRules, useRulesSources, type Agent } from "../../lab/agents";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";

const FIELD =
  "mt-1.5 w-full rounded-control border border-line-strong bg-canvas px-3 py-2 text-read text-fg outline-none transition-colors placeholder:text-fg-4 focus:border-fg-3 disabled:opacity-60";

/** One way to begin the new agent's rules of communication, with what it brings. */
function RulesChoice({
  checked,
  onChoose,
  disabled,
  label,
  sub,
}: {
  checked: boolean;
  onChoose: () => void;
  disabled: boolean;
  label: ReactNode;
  sub: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 px-3 py-2.5 transition-colors hover:bg-hover has-[:disabled]:cursor-default has-[:disabled]:opacity-60">
      <input
        type="radio"
        name="agent-rules"
        checked={checked}
        disabled={disabled}
        onChange={onChoose}
        className="mt-0.5 size-4 flex-shrink-0 accent-primary"
      />
      <span className="min-w-0">
        <span className="block text-body text-fg">{label}</span>
        <span className="mt-0.5 block break-words text-small text-fg-3">{sub}</span>
      </span>
    </label>
  );
}

/**
 * A new agent: a name and one line about it. Its own dialogues and results start empty; its rules of communication
 * too, or they are taken from another agent that has them — a copy with the criteria and the clarifications people
 * confirmed, taken before the agent opens, so it starts with its criteria ready. The agent opens at «Обзор». Once
 * «Создать» is pressed nothing can call it off — the service creates the agent anyway — so «Отмена», Esc and the
 * backdrop wait, and a line says so.
 */
export function NewAgent({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sources = useRulesSources(null);
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [from, setFrom] = useState<string | null>(null);
  // The agent once created: when taking the rules fails after it, trying again does not create a second one.
  const [created, setCreated] = useState<Agent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = sources.find((a) => a.id === from) ?? null;
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    let agent = created;
    try {
      if (!agent) {
        agent = await createAgent(name, description);
        setCreated(agent);
      }
      if (source) await takeRules(source.id, agent.id);
      window.location.assign(agentHref(agent.id, "/overview"));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      setError(agent ? `Агент «${agent.name}» создан, но правила взять не удалось. ${reason}` : reason);
      setBusy(false);
    }
  };
  const close = () => {
    if (busy) return;
    if (created) void client.invalidateQueries({ queryKey: ["agents"] });
    setName("");
    setDescription("");
    setFrom(null);
    setCreated(null);
    setError(null);
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title="Новый агент"
      footer={
        <>
          <Button onClick={close} disabled={busy}>
            Отмена
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void submit()}>
            {!created ? "Создать" : source ? "Попробовать снова" : "Открыть агента"}
          </Button>
        </>
      }
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <label className="block text-body font-medium text-fg">
          Имя
          <input
            autoFocus
            value={name}
            maxLength={80}
            disabled={!!created || busy}
            onChange={(e) => setName(e.target.value)}
            placeholder="Например: Агент по кредитам"
            className={FIELD}
          />
        </label>
        <label className="block text-body font-medium text-fg">
          Описание <span className="font-normal text-fg-3">— по желанию</span>
          <input
            value={description}
            maxLength={200}
            disabled={!!created || busy}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Например: СберБизнес · чат поддержки"
            className={FIELD}
          />
        </label>
        {!!sources.length && (
          <fieldset>
            <legend className="text-body font-medium text-fg">
              Правила общения <span className="font-normal text-fg-3">— по желанию</span>
            </legend>
            <div className="mt-1.5 max-h-60 divide-y divide-line overflow-auto rounded-control border border-line-strong bg-canvas">
              <RulesChoice
                checked={!source}
                disabled={busy}
                onChoose={() => setFrom(null)}
                label="Не брать"
                sub="Добавите на первом шаге проверки tone of voice"
              />
              {sources.map((a) => (
                <RulesChoice
                  key={a.id}
                  checked={source?.id === a.id}
                  disabled={busy}
                  onChoose={() => setFrom(a.id)}
                  label={`Взять у агента «${a.name}»`}
                  sub={rulesLine(a.rules)}
                />
              ))}
            </div>
            <p className="mt-1.5 text-small text-fg-3">
              Возьмём копию правил и критериев с уточнениями. Дальше у каждого агента свои.
            </p>
          </fieldset>
        )}
        {error && (
          <p role="alert" className="text-small text-bad">
            {error}
          </p>
        )}
        {busy && (
          <p role="status" className="text-small text-fg-3">
            {!created ? "Создаём агента." : source ? "Берём правила." : "Открываем агента."} Отменить уже нельзя.
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
