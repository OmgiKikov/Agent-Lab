import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, FileText, MessagesSquare, ScrollText } from "lucide-react";
import { api } from "../../lab/api";
import type { Criterion } from "../../lab/criteria";
import { day, plural } from "../../lab/format";
import { useLabState } from "../../shell/LabProvider";
import { LINKS } from "../../shell/links";
import { Button } from "../../ui/Button";
import { MarkStack } from "../../ui/Mark";
import { Chips, Pill } from "../../ui/Pill";
import { PageTitle, Stack } from "../../ui/Tile";
import { useToast } from "../../ui/toast";
import { Dropzone, UploadButton } from "../dialogs/UploadLogs";

const SIZES = [100, 200, 300];

/** Before an assessment (and on «Оценить заново»): the conversations × the criteria, and one button. */
export function Assess({ criteria, onCancel }: { criteria: Criterion[]; onCancel?: () => void }) {
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
  const n = criteria.length;
  const start = () => {
    setStarting(true);
    api("/api/discover", { count: size }).then(() => refresh()).catch(toast.error).finally(() => setStarting(false));
  };

  return (
    <div className="mx-auto max-w-[1040px] px-6 pb-20 pt-6">
      <PageTitle title="Оценка логов" sub="настоящие разговоры клиентов × критерии агента · сам агент не запускается"
        actions={onCancel && <button type="button" onClick={onCancel} className="text-[12px] text-lab-mute hover:text-lab-text">К результатам →</button>} />
      <div className="mt-8 grid items-center gap-4 md:grid-cols-[1fr_44px_1fr]">
        <Stack depth={2} className="mb-5 mr-5">
          <div className="flex min-h-[230px] flex-col rounded-[12px] border border-white/[0.09] bg-[rgb(35,35,35)] p-5">
            <div><Pill icon={MessagesSquare}>Разговоры</Pill></div>
            {total ? (
              <>
                <div className="mt-4 text-[34px] font-medium leading-[38px] tracking-[-1px] text-lab-ink">{total}</div>
                <div className="mt-1 text-[13px] text-lab-text">{plural(total, "разговор", "разговора", "разговоров")} клиентов с агентом</div>
                <div className="mt-0.5 text-[12px] text-lab-dim">выгрузка чата{state?.logs.updatedAt ? ` от ${day(state.logs.updatedAt)}` : ""}</div>
                <div className="mt-auto pt-4"><UploadButton variant="outline" label="Загрузить другую выгрузку" /></div>
              </>
            ) : (
              <div className="-mx-5 -mb-5 mt-3 flex flex-1"><Dropzone /></div>
            )}
          </div>
        </Stack>
        <div aria-hidden className="flex items-center justify-center text-[22px] text-lab-faint md:pb-5">×</div>
        <Stack depth={2} className="mb-5 mr-5">
          <div className="flex min-h-[230px] flex-col rounded-[12px] border border-[rgba(232,145,45,0.25)] bg-[rgb(37,33,29)] p-5">
            <div><Pill icon={ScrollText}>Критерии</Pill></div>
            {n ? (
              <>
                <div className="mt-4 text-[34px] font-medium leading-[38px] tracking-[-1px] text-[rgb(255,212,163)]">{n}</div>
                <div className="mt-1 text-[13px] text-lab-text">{plural(n, "правило", "правила", "правил")} из промптов агента</div>
                <div className="mt-3"><MarkStack ns={criteria.map(c => c.n)} max={9} ring="ring-[rgb(37,33,29)]" /></div>
                <Link to={LINKS.criteria} className="mt-auto inline-flex items-center gap-1 pt-4 text-[12px] text-lab-mute hover:text-lab-ink">Открыть критерии<ArrowRight className="size-3" /></Link>
              </>
            ) : (
              <>
                <div className="mt-4 text-[15px] text-lab-ink">Возьмём из промптов агента</div>
                <div className="mt-1 text-[12px] text-lab-dim">Судья достанет критерии дословно при первой оценке.</div>
                {!sources && <Link to={LINKS.agent} className="mt-auto inline-flex items-center gap-1 pt-4 text-[12px] text-lab-ink hover:underline hover:underline-offset-4"><FileText className="size-3.5" />Сначала прочитать код агента</Link>}
              </>
            )}
          </div>
        </Stack>
      </div>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button variant="primary" loading={starting} disabled={busy || !total || !sources || !size} onClick={start}
          title={busy ? "Сейчас идёт другая задача" : !sources ? "Сначала прочитайте код агента" : !total ? "Сначала загрузите логи" : undefined}>
          Оценить {size} {plural(size, "разговор", "разговора", "разговоров")}{n ? ` по ${n} ${plural(n, "критерию", "критериям", "критериям")}` : ""}
        </Button>
        {sizes.length > 1 && <Chips<number> value={size} onChange={v => v && setPicked(v)} options={sizes.map(s => ({ value: s, label: String(s) }))} />}
        <span className="text-[11px] text-lab-faint">Судья прочитает каждый разговор и по каждому критерию отметит: нарушен, выполнен или не ясно.</span>
      </div>
    </div>
  );
}
