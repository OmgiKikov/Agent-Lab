import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { useAgent } from "../../lab/agents";
import { api } from "../../lab/api";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";

export function Identity() {
  const agent = useAgent();
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!agent) return null;
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/agents/update", { id: agent.id, name, description });
      await cache.invalidateQueries({ queryKey: ["agents"] });
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="flex items-start gap-3 border-b border-line px-4 py-6 lg:px-10">
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-title font-semibold text-fg">{agent.name}</h2>
          {agent.description && <p className="mt-1 text-body text-fg-3">{agent.description}</p>}
        </div>
        <Button
          variant="ghost"
          icon={Pencil}
          onClick={() => {
            setName(agent.name);
            setDescription(agent.description);
            setError("");
            setOpen(true);
          }}
        >
          Изменить
        </Button>
      </div>
      <Modal
        open={open}
        onClose={() => !busy && setOpen(false)}
        title="Карточка агента"
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={save}>
              Сохранить
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="block text-body text-fg">
            Имя
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              disabled={busy}
              className="mt-1 w-full rounded-control border border-line-strong bg-canvas px-3 py-2"
            />
          </label>
          <label className="block text-body text-fg">
            Описание
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={200}
              disabled={busy}
              className="mt-1 w-full rounded-control border border-line-strong bg-canvas px-3 py-2"
            />
          </label>
          {error && (
            <p role="alert" className="text-bad">
              {error}
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}
