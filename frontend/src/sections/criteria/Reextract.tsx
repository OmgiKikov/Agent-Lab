import { useState } from "react";
import { api } from "../../lab/api";
import { plural } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { useToast } from "../../ui/toast";

/**
 * «Извлечь заново» of accuracy: new criteria from the code; the old ones stop counting, so it asks first. Tone of voice
 * keeps its result: it is checked by other criteria.
 */
export function Reextract({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, refresh } = useLabState();
  const toast = useToast();
  const [starting, setStarting] = useState(false);
  const count = Math.max(5, Math.min(300, state?.checks.code?.sampled ?? 100));
  const deck = state?.cards?.check === "code" && !!state.cards.cards.length;
  const dialogs = `${count} ${plural(count, "разговор", "разговора", "разговоров")}`;
  const start = async () => {
    setStarting(true);
    try {
      await api("/api/discover", { count, replan: true });
      onClose();
      await refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setStarting(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Извлечь критерии заново"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" onClick={start} loading={starting} disabled={!!state?.job.running}>
            Извлечь и оценить {dialogs}
          </Button>
        </>
      }
    >
      <p className="text-small text-fg-2">
        Модель прочитает промпты и инструменты агента заново, извлечёт критерии и проверит по ним {dialogs}. Прежние
        критерии перестанут действовать: счёт, ссылки на проблемы и ваши ответы начнутся заново
        {deck ? ", а сценарии, собранные из точности, сбросятся" : ""}. Итог tone of voice не изменится.
      </p>
      <p className="mt-3 text-small text-fg-3">Нужно, когда агент поменялся: новый промпт, новые инструменты.</p>
    </Modal>
  );
}
