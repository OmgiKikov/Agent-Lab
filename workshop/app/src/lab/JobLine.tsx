import { Square } from "lucide-react";
import { api } from "./api";
import type { LabState } from "./types";
import { Progress } from "./ui";
import { useToast } from "./toast";

/** What the running job is doing, with a stop button; or how the last one of this kind ended. */
export function JobLine({ state, kind, bare }: { state: LabState; kind: string; bare?: boolean }) {
  const { error } = useToast();
  const j = state.job;
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
          className="inline-flex h-6 items-center gap-1 rounded-md bg-white/[0.07] px-2 text-[11.5px] text-lab-soft transition-colors hover:bg-white/[0.13]"
        ><Square className="size-2.5 fill-current" />Остановить</button>
      </span>
    );
  }
  if (!j.running && j.kind === kind && j.error) {
    return j.error === "Остановлено"
      ? <span className="text-[12px] text-lab-dim">Остановлено</span>
      : <span className="text-[12px] text-lab-bad">Ошибка: {j.error}</span>;
  }
  return null;
}
