import { useState } from "react";
import { Square, X } from "lucide-react";
import { api } from "./api";
import type { LabState } from "./types";
import { useToast } from "./toast";

/** What the running job of this kind is doing, with a stop button; or how the last one ended, if it failed. */
export function JobLine({ state, kind, bare }: { state: LabState; kind: string; bare?: boolean }) {
  const { error } = useToast();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const j = state.job;
  const endKey = `${j.kind}:${j.error}`;
  if (j.running && j.kind === kind) {
    const { done = 0, total = 0, message } = j.progress;
    return (
      <span className="inline-flex max-w-full items-center gap-2.5 rounded-lg border border-lab-line bg-lab-panel py-1 pl-3 pr-1 text-body text-lab-text" role="status">
        <span className="pulse-dot size-2 flex-shrink-0 rounded-full bg-lab-accent" />
        <span className={bare ? "max-w-[200px] truncate" : "max-w-[320px] truncate"}>{message || "Идёт работа"}</span>
        {total > 0 && (
          <span className="flex flex-shrink-0 items-center gap-2">
            {!bare && <span className="h-1 w-16 overflow-hidden rounded-full bg-white/[0.07]"><span className="block h-full rounded-full bg-lab-accent transition-[width] duration-500" style={{ width: `${(100 * done) / total}%` }} /></span>}
            <span className="text-caption tabular-nums text-lab-mute">{done}/{total}</span>
          </span>
        )}
        <button
          onClick={() => api("/api/job/stop", {}).catch(error)}
          className="lab-focus inline-flex h-6 flex-shrink-0 items-center gap-1 rounded-md px-2 text-caption text-lab-mute transition-colors duration-100 hover:bg-lab-raised hover:text-lab-ink"
        ><Square className="size-2.5 fill-current" />Остановить</button>
      </span>
    );
  }
  if (!j.running && j.kind === kind && j.error && dismissed !== endKey) {
    const stopped = j.error === "Остановлено";
    return (
      <span className={`inline-flex items-center gap-2 text-body ${stopped ? "text-lab-mute" : "text-lab-bad"}`} role={stopped ? undefined : "alert"}>
        {stopped ? "Остановлено" : `Не получилось: ${j.error}`}
        <button onClick={() => setDismissed(endKey)} aria-label="Скрыть" className="lab-focus rounded-sm p-0.5 text-lab-mute transition-colors duration-100 hover:bg-lab-raised hover:text-lab-ink"><X className="size-3" /></button>
      </span>
    );
  }
  return null;
}
