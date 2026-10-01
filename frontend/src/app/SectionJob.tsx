import { Square } from "lucide-react";
import { api } from "../lab/api";
import { useLabState } from "../lab/LabProvider";
import { useToast } from "../ui/toast";

/** Under a section's head while its own task runs: what it does, how far, «Остановить», and a hairline of progress. */
export function SectionJob({ kinds }: { kinds: string[] }) {
  const { state } = useLabState();
  const toast = useToast();
  const job = state?.job;
  if (!job?.running || !job.kind || !kinds.includes(job.kind)) return null;
  const { done = 0, total = 0, message } = job.progress;
  return (
    <div className="border-t border-line" role="status">
      <div className="flex h-8 items-center gap-3 px-4 text-small text-fg-3 lg:px-5">
        <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-run" />
        <span className="min-w-0 flex-1 truncate text-fg-2">{message}</span>
        {total > 0 && (
          <span className="tabular-nums">
            {done} из {total}
          </span>
        )}
        <button
          type="button"
          onClick={() => api("/api/job/stop", {}).catch(toast.error)}
          className="inline-flex items-center gap-1 rounded-sm transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
        >
          <Square aria-hidden className="size-2.5 fill-current" />
          Остановить
        </button>
      </div>
      <div className="h-px bg-line">
        <div
          className="h-px bg-run transition-[width] duration-500 ease-out"
          style={{ width: `${total ? Math.max(3, (100 * done) / total) : 6}%` }}
        />
      </div>
    </div>
  );
}
