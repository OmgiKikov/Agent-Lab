import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lab/api";
import { day, plural } from "../../lab/format";
import { useProblems } from "../../lab/problems";
import { useLabState } from "../../shell/LabProvider";
import { LINKS } from "../../shell/links";
import { Button } from "../../ui/Button";
import { Segmented } from "../../ui/Segmented";
import { useToast } from "../../ui/toast";
import { Dropzone, UploadButton } from "../dialogs/UploadLogs";

const SIZES = [100, 200, 300];

function Box({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-white/[0.08] p-5">
      <div className="text-small text-lab-dim">{label}</div>
      {children}
    </div>
  );
}

/** Before an assessment: what is assessed × by what, and one button. Also reachable later through «Оценить заново». */
export function AssessPanel({ onCancel }: { onCancel?: () => void }) {
  const { state, refresh } = useLabState();
  const { data } = useProblems(null);
  const toast = useToast();
  const total = state?.logs.total ?? 0;
  const sizes = [...new Set([...SIZES.filter(n => n < total), Math.min(total, 300)])].filter(n => n > 0);
  const previous = state?.discover?.sampled;
  const [picked, setPicked] = useState<number | null>(null);
  const size = picked && sizes.includes(picked) ? picked : previous && sizes.includes(previous) ? previous : sizes.includes(100) ? 100 : sizes[sizes.length - 1] ?? 0;
  const [starting, setStarting] = useState(false);
  const rules = state?.discover ? data?.rules ?? [] : [];
  const busy = !!state?.job.running;
  const sources = state?.sources.length ?? 0;
  const start = () => {
    setStarting(true);
    api("/api/discover", { count: size }).then(() => refresh()).catch(toast.error).finally(() => setStarting(false));
  };
  const n = rules.length;
  const label = `Оценить ${size} ${plural(size, "разговор", "разговора", "разговоров")}${n ? ` по ${n} ${plural(n, "критерию", "критериям", "критериям")}` : ""}`;
  return (
    <div className="mx-auto max-w-[960px] px-6 pb-20 pt-8 lg:px-8">
      <div className="grid items-stretch gap-3 md:grid-cols-[1fr_28px_1fr]">
        <Box label="Что оцениваем">
          {total ? (
            <>
              <div className="mt-1 text-heading text-lab-ink">{total} {plural(total, "разговор", "разговора", "разговоров")}</div>
              <div className="mt-1 text-small text-lab-mute">выгрузка чата{state?.logs.updatedAt ? ` от ${day(state.logs.updatedAt)}` : ""}</div>
              <div className="mt-4"><UploadButton variant="outline" label="Загрузить другую" /></div>
            </>
          ) : (
            <div className="-mx-5 -mb-5 mt-2 flex"><Dropzone /></div>
          )}
        </Box>
        <div aria-hidden className="flex items-center justify-center text-heading text-lab-dim">×</div>
        <Box label="По чему оцениваем">
          {n ? (
            <>
              <div className="mt-1 text-heading text-lab-ink">{n} {plural(n, "критерий", "критерия", "критериев")}</div>
              <div className="mt-1 text-small text-lab-mute">из промптов агента</div>
              <ul className="mt-3 space-y-1.5">
                {rules.slice(0, 3).map(r => (
                  <li key={r.id} className="flex items-start gap-2 text-small text-lab-text"><span aria-hidden className="mt-[5px] size-2.5 flex-shrink-0 rounded-[3px] border border-white/30" /><span className="min-w-0">{r.title}</span></li>
                ))}
              </ul>
              {n > 3 && <Link to={LINKS.criteria} className="mt-2 text-small text-lab-mute hover:text-lab-text">и ещё {n - 3} →</Link>}
            </>
          ) : (
            <>
              <div className="mt-1 text-body text-lab-ink">Возьмём из промптов агента</div>
              <div className="mt-1 text-small text-lab-mute">Судья достанет критерии из промптов при первой оценке.</div>
              {!sources && <Link to={LINKS.agent} className="mt-3 text-small text-lab-ink hover:underline hover:underline-offset-4">Сначала прочитать код агента →</Link>}
            </>
          )}
        </Box>
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-4">
        <Button variant="primary" loading={starting} disabled={busy || !total || !sources || !size} onClick={start}
          title={busy ? "Сейчас идёт другая задача" : !sources ? "Сначала прочитайте код агента" : !total ? "Сначала загрузите логи" : undefined}>{label}</Button>
        {sizes.length > 1 && <Segmented value={String(size)} onChange={v => setPicked(Number(v))} options={sizes.map(s => ({ value: String(s), label: String(s) }))} />}
        {onCancel && <button type="button" onClick={onCancel} className="text-small text-lab-mute hover:text-lab-text">К результатам</button>}
      </div>
    </div>
  );
}
