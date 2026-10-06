import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { SECTIONS } from "../../app/links";
import { CHECK_NAME, CHECKS } from "../../lab/checks";
import { deleteExport, renameExport, type ExportWithChecks } from "../../lab/exports";
import { useLabState } from "../../lab/LabProvider";
import type { ExportLine } from "../../lab/types";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { useToast } from "../../ui/toast";

const FIELD =
  "mt-1.5 w-full rounded-control border border-line-strong bg-canvas px-3 py-2 text-read text-fg outline-none transition-colors placeholder:text-fg-4 focus:border-fg-3 disabled:opacity-60";

/** «Переименовать»: the name the export has in the list and in the results made of it, also the earlier ones. */
export function RenameExport({ line, open, onClose }: { line: ExportLine; open: boolean; onClose: () => void }) {
  const { refresh } = useLabState();
  const [name, setName] = useState(line.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await renameExport(line.id, name.trim());
      await refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="Переименовать выгрузку"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void save()}>
            Сохранить
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="block text-body font-medium text-fg">
          Название
          <input
            autoFocus
            value={name}
            maxLength={120}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            className={FIELD}
          />
        </label>
        {error && (
          <p role="alert" className="mt-3 text-small text-bad">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

/**
 * «Удалить выгрузку?»: its conversations go, and with them the current result of a check made of it — it stays in
 * the history with the conversations it judged — and the scenarios built from that result. Refused while a task runs.
 */
export function DeleteExport({ item, open, onClose }: { item: ExportWithChecks; open: boolean; onClose: () => void }) {
  const { state, refresh } = useLabState();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The current results made of it, as the service decides what goes with it (inputs.remove_export).
  const current = CHECKS.filter((check) => state?.checks[check]?.export?.id === item.id);
  const deck = state?.cards?.cards.length && current.includes(state.cards.check);
  const running = !!state?.job.running;
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteExport(item.id);
      await refresh();
      onClose();
      void navigate(SECTIONS.exports);
      toast.notify(`Выгрузка «${item.name}» удалена`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title={`Удалить выгрузку «${item.name}»?`}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={running}
            title={running ? "Сейчас идёт другая задача" : undefined}
            onClick={() => void remove()}
          >
            Удалить
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-read text-fg-2">
        <p>Разговоры выгрузки удалятся.</p>
        {current.map((check) => (
          <p key={check}>
            Текущий итог {check === "tone" ? "tone of voice" : "точности"} сделан на ней: он уйдёт в «Историю» вместе с
            проверенными разговорами.
          </p>
        ))}
        {!!deck && <p>Сценарии из итога {CHECK_NAME[state!.cards!.check]} сбросятся.</p>}
        <p className="text-fg-3">Сохранённые проверки останутся в «Истории».</p>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-small text-bad">
          {error}
        </p>
      )}
    </Modal>
  );
}
