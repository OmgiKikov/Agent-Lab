import { useState, type FormEvent } from "react";
import { agentHref } from "../../app/agent";
import { createAgent } from "../../lab/agents";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";

const FIELD =
  "mt-1.5 w-full rounded-control border border-line-strong bg-canvas px-3 py-2 text-read text-fg outline-none transition-colors placeholder:text-fg-4 focus:border-fg-3";

/**
 * A new agent: a name and one line about it. Its own dialogues, rules and results start empty; the agent opens at
 * «Начать проверку».
 */
export function NewAgent({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const agent = await createAgent(name, description);
      window.location.assign(agentHref(agent.id, "/start"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Новый агент"
      footer={
        <>
          <Button onClick={onClose}>Отмена</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void submit()}>
            Создать
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
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Например: СберБизнес · чат поддержки"
            className={FIELD}
          />
        </label>
        {error && (
          <p role="alert" className="text-small text-bad">
            {error}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
