import { useState } from "react";
import { Square, X } from "lucide-react";
import { api } from "./api";
import type { LabState } from "./types";
import { Progress } from "./ui";
import { useToast } from "./toast";

/** What the running job is doing, with a stop button; or how the last one of this kind ended. */
export function JobLine({ state, kind, bare }: { state: LabState; kind: string; bare?: boolean }) {
  const { error } = useToast();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const j = state.job;
  const endKey = `${j.kind}:${j.error}`;
  if (j.running && j.kind === kind) {
    const { done = 0, total = 0, message } = j.progress;
    return (
      <span className="inline-flex items-center gap-3 rounded-lg border border-white/[0.08] bg-white/[0.03] py-1 pl-3 pr-1.5 text-[12px] text-lab-mute">
        <span className="size-2 rounded-full bg-lab-accent pulse-dot" />
        <span className={bare ? "max-w-[210px] truncate" : "max-w-[320px] truncate"}>{message}</span>
        {total > 0 && (
          <span className="flex items-center gap-2">
            {!bare && <Progress value={(100 * done) / total} className="w-16 rounded-full" />}
            <span className="font-mono text-[11px] text-lab-dim">{done}/{total}</span>
          </span>
        )}
        <button
          onClick={() => api("/api/job/stop", {}).catch(error)}
          className="inline-flex h-6 items-center gap-1 rounded-md bg-white/[0.07] px-2 text-[11px] text-lab-soft transition-colors hover:bg-white/[0.13]"
        ><Square className="size-2.5 fill-current" />Остановить</button>
      </span>
    );
  }
  if (!j.running && j.kind === kind && j.error && dismissed !== endKey) {
    const stopped = j.error === "Остановлено";
    return (
      <span className={`inline-flex items-center gap-2 text-[11px] ${stopped ? "text-lab-dim" : "text-lab-bad"}`}>
        {stopped ? "Остановлено" : `Ошибка: ${j.error}`}
        <button onClick={() => setDismissed(endKey)} aria-label="Скрыть" className="rounded p-0.5 text-lab-dim transition-colors hover:bg-white/10 hover:text-lab-text"><X className="size-3" /></button>
      </span>
    );
  }
  return null;
}
