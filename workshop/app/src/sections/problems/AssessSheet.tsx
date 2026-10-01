import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lab/api";
import { day, plural } from "../../lab/format";
import { SECTIONS } from "../../app/links";
import { useLabState } from "../../lab/LabProvider";
import { Button } from "../../ui/Button";
import { Label } from "../../ui/Label";
import { Segmented } from "../../ui/Segmented";
import { Sheet } from "../../ui/Sheet";
import { useToast } from "../../ui/toast";
import { UploadButton } from "../../product/UploadLogs";

const SIZES = [100, 200, 300];

/**
 * «Оценить логи» without leaving the violations: how many real conversations, by how many criteria from the code,
 * how many to take, and one button. The agent itself is not run; the judge reads the logs.
 */
export function AssessSheet({ open, onClose, criteria }: { open: boolean; onClose: () => void; criteria: number }) {
  const { state, refresh } = useLabState();
  const toast = useToast();
  const total = state?.logs.total ?? 0;
  const sizes = [...new Set([...SIZES.filter(n => n < total), Math.min(total, 300)])].filter(n => n > 0);
  const previous = state?.discover?.sampled;
  const [picked, setPicked] = useState<number | null>(null);
  const size = picked && sizes.includes(picked) ? picked : previous && sizes.includes(previous) ? previous : sizes.includes(100) ? 100 : sizes[sizes.length - 1] ?? 0;
  const [starting, setStarting] = useState(false);
  const busy = !!state?.job.running;
  const sources = state?.sources.length ?? 0;
  const start = () => {
    setStarting(true);
    api("/api/discover", { count: size }).then(() => { refresh(); onClose(); toast.notify("Оценка началась: ход виден внизу навигации"); }).catch(toast.error).finally(() => setStarting(false));
  };
  const why = busy ? "Сейчас идёт другая задача" : !sources ? "Сначала прочитайте код агента" : !total ? "Сначала загрузите логи" : undefined;
  return (
    <Sheet open={open} onClose={onClose} title="Оценить логи" sub="Модель читает настоящие разговоры и по каждому критерию отмечает: ошибка, без ошибки или не ясно. Сам агент не запускается.">
      <div className="space-y-6 px-5 py-5">
        <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-4">
          <div className="rounded-block border border-line p-4">
            <Label>Логи</Label>
            {total ? (
              <>
                <div className="mt-2 font-mono text-count text-fg">{total}</div>
                <div className="text-small text-fg-3">{plural(total, "разговор", "разговора", "разговоров")}{state?.logs.updatedAt ? `, выгрузка от ${day(state.logs.updatedAt)}` : ""}</div>
                <div className="mt-3"><UploadButton variant="outline" label="Другая выгрузка" /></div>
              </>
            ) : <div className="mt-3"><UploadButton label="Загрузить логи" /></div>}
          </div>
          <span aria-hidden className="self-center text-title text-fg-4">×</span>
          <div className="rounded-block border border-line p-4">
            <Label>Критерии</Label>
            {criteria ? (
              <>
                <div className="mt-2 font-mono text-count text-fg">{criteria}</div>
                <div className="text-small text-fg-3">из кода агента</div>
              </>
            ) : <p className="mt-2 text-small text-fg-2">Они извлекаются дословно из промптов при первой оценке.</p>}
            {!sources && <Link to={SECTIONS.agent} onClick={onClose} className="mt-3 inline-block text-small text-fg underline decoration-line-strong underline-offset-4">Прочитать код агента</Link>}
          </div>
        </div>
        {sizes.length > 1 && (
          <div>
            <Label>Сколько разговоров взять</Label>
            <div className="mt-2"><Segmented<string> label="Сколько разговоров" value={String(size)} onChange={v => setPicked(Number(v))} options={sizes.map(n => ({ value: String(n), label: String(n) }))} /></div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
          <Button variant="primary" loading={starting} disabled={!!why || !size} title={why} onClick={start}>
            Оценить {size} {plural(size, "разговор", "разговора", "разговоров")}{criteria ? ` по ${criteria} ${plural(criteria, "критерию", "критериям", "критериям")}` : ""}
          </Button>
          {why && <span className="text-small text-fg-3">{why}</span>}
        </div>
      </div>
    </Sheet>
  );
}
