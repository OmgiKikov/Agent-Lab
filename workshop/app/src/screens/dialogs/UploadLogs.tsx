import { useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { upload } from "../../lab/api";
import { count } from "../../lab/format";
import { useLabState } from "../../shell/LabProvider";
import { Button } from "../../ui/Button";
import { useToast } from "../../ui/toast";

const ACCEPT = ".xlsx,.jsonl";

/** Sends the chat's export to the service and says what to do next. */
function useUpload() {
  const { refresh } = useLabState();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const send = async (file: File) => {
    setBusy(true);
    try {
      const { total } = await upload<{ total: number }>("/api/logs", file);
      await refresh();
      toast.notify(`Загружено ${count(total, "диалог", "диалога", "диалогов")}`, { label: "Оценить", run: () => navigate("/logs?assess=1") });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return { busy, send };
}

/** «Загрузить логи»: the chat's Excel export (sheet «Данные») or prepared .jsonl. */
export function UploadButton({ variant = "primary", label = "Загрузить логи" }: { variant?: "primary" | "outline"; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const { state } = useLabState();
  const { busy, send } = useUpload();
  const running = !!state?.job.running;
  return (
    <>
      <input ref={input} type="file" accept={ACCEPT} className="hidden" onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) send(f); }} />
      <Button variant={variant} icon={Upload} loading={busy} disabled={running} title={running ? "Сейчас идёт другая задача" : "Excel-выгрузка чата или .jsonl"} onClick={() => input.current?.click()}>
        {label}
      </Button>
    </>
  );
}

/** No logs yet: drop the export here. */
export function Dropzone({ children }: { children?: ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  const { busy, send } = useUpload();
  const [over, setOver] = useState(false);
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <button
        type="button" onClick={() => input.current?.click()} disabled={busy}
        onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) send(f); }}
        className={cn("flex w-full max-w-[560px] flex-col items-center rounded-xl border border-dashed px-8 py-14 text-center transition-colors", over ? "border-lab-accent bg-lab-accent/5" : "border-white/15 hover:border-white/30")}
      >
        <Upload className="size-6 text-lab-mute" />
        <span className="mt-4 text-body font-medium text-lab-ink">{busy ? "Загружаю…" : "Перетащите выгрузку чата сюда"}</span>
        <span className="mt-1.5 text-small text-lab-dim">Excel с листом «Данные» (Id диалога, Текст с метками CLIENT и AGENT) или .jsonl</span>
        {children}
      </button>
      <input ref={input} type="file" accept={ACCEPT} className="hidden" onChange={e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) send(f); }} />
    </div>
  );
}
