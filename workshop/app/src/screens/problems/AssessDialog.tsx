import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lab/api";
import { day, plural } from "../../lab/format";
import { useLabState } from "../../shell/LabProvider";
import { LINKS } from "../../shell/links";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { Segmented } from "../../ui/Segmented";
import { useToast } from "../../ui/toast";

const SIZES = [25, 50, 100, 200, 300];
const link = "text-lab-ink underline decoration-white/30 underline-offset-4";

/** «Оценить логи»: how many conversations the judge reads. The same sample every time, so assessments compare. */
export function AssessDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, refresh } = useLabState();
  const toast = useToast();
  const total = state?.logs.total ?? 0;
  const sizes = [...new Set([...SIZES.filter(n => n < total), Math.min(total, 300)])].filter(n => n >= 5);
  const [size, setSize] = useState(0);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (!open) return;
    const previous = state?.discover?.sampled;
    setSize(previous && sizes.includes(previous) ? previous : sizes.includes(100) ? 100 : sizes[sizes.length - 1] ?? 0);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const blocked = !state?.sources.length ? "code" : !total ? "logs" : state.job.running ? "busy" : null;
  const start = async () => {
    setStarting(true);
    try {
      await api("/api/discover", { count: size });
      onClose();
      await refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setStarting(false);
    }
  };
  const since = state?.discover?.rulesSince;
  return (
    <Modal
      open={open} onClose={onClose} title="Оценить логи"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" onClick={start} loading={starting} disabled={!!blocked || !size}>
          Оценить {size} {plural(size, "диалог", "диалога", "диалогов")}
        </Button>
      </>}
    >
      {blocked === "code" && <p className="text-small text-lab-mute">Сначала прочитайте код агента: из него берутся правила. <Link className={link} to={LINKS.agent} onClick={onClose}>Открыть «Агент»</Link></p>}
      {blocked === "logs" && <p className="text-small text-lab-mute">Сначала загрузите логи. <Link className={link} to={LINKS.logs} onClick={onClose}>Загрузить выгрузку</Link></p>}
      {blocked === "busy" && <p className="text-small text-lab-mute">Сейчас идёт другая задача. Дождитесь её или остановите: кольцо на рейке слева.</p>}
      {!blocked && (
        <>
          <p className="text-small text-lab-mute">
            Судья проверит диалоги логов по правилам агента{since ? `, зафиксированным ${day(since)}` : " — сначала он извлечёт их из кода"}.
            Выборка каждый раз одна и та же, поэтому оценки сравнимы.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="text-small text-lab-text">Сколько диалогов</span>
            <Segmented value={String(size)} onChange={v => setSize(Number(v))} options={sizes.map(n => ({ value: String(n), label: String(n) }))} />
          </div>
          <p className="mt-2 text-meta text-lab-dim">В логах {total} {plural(total, "диалог", "диалога", "диалогов")}.</p>
        </>
      )}
    </Modal>
  );
}
