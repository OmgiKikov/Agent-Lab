import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Square, X } from "lucide-react";
import { api } from "../lab/api";
import type { Job } from "../lab/types";
import { jobOf } from "./jobs";
import { useLabState } from "../lab/LabProvider";
import { useToast } from "../ui/toast";

const STOPPED = "Остановлено";

/**
 * The service's task, seen from every screen at the foot of the navigation: what runs, how far it is, «Остановить».
 * When it ends, one notice with the way to its result; when it fails, the reason stays here until closed.
 */
export function TaskCard({ compact }: { compact?: boolean }) {
  const { state } = useLabState();
  const toast = useToast();
  const navigate = useNavigate();
  const [hidden, setHidden] = useState<string | null>(null);
  const job = state?.job;
  const was = useRef<Job | null>(null);
  useEffect(() => {
    if (!job) return;
    const before = was.current;
    was.current = job;
    if (!before?.running || job.running || before.kind !== job.kind) return;
    const info = jobOf(job);
    const label = info?.label ?? "Задача";
    if (job.error === STOPPED) toast.notify(`${label}: остановлено`);
    else if (job.error) toast.error(`${label}: ${job.error}`);
    else
      toast.notify(
        `${label}: готово`,
        info
          ? {
              label: "Открыть",
              run: () => {
                void navigate(info.to);
              },
            }
          : undefined,
      );
  }, [job, toast, navigate]);
  if (!job?.kind) return null;
  const info = jobOf(job);
  const label = info?.label ?? "Задача";
  if (job.running) {
    const { done = 0, total = 0, message } = job.progress;
    const share = total ? Math.min(1, done / total) : null;
    return (
      <div role="status" className="rounded-block border border-line-strong p-3">
        <div className="flex items-center gap-2 text-small font-medium text-fg">
          <span aria-hidden className="relative flex size-2">
            <span className="absolute inset-0 animate-ping rounded-full bg-run/50" />
            <span className="relative size-2 rounded-full bg-run" />
          </span>
          <button
            type="button"
            onClick={() => info && navigate(info.to)}
            className="min-w-0 flex-1 truncate text-left hover:underline"
          >
            {label}
          </button>
        </div>
        {!compact && message && (
          <div className="mt-1 line-clamp-2 text-small text-fg-3" title={message}>
            {message}
          </div>
        )}
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-well">
          <div
            className={
              share === null
                ? "h-full w-1/3 animate-pulse rounded-full bg-run"
                : "h-full rounded-full bg-run transition-[width] duration-500 ease-out"
            }
            style={share === null ? undefined : { width: `${Math.max(4, share * 100)}%` }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 text-small text-fg-3">
          <span className="tabular-nums">{total ? `${done} из ${total}` : "идёт"}</span>
          <button
            type="button"
            onClick={() => api("/api/job/stop", {}).catch(toast.error)}
            className="inline-flex items-center gap-1 rounded px-1 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
          >
            <Square aria-hidden className="size-2.5 fill-current" />
            Остановить
          </button>
        </div>
      </div>
    );
  }
  const key = `${job.kind}:${job.error}`;
  if (!job.error || job.error === STOPPED || hidden === key) return null;
  return (
    <div role="alert" className="rounded-block border border-bad/30 bg-bad/[0.06] p-3">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-small font-medium text-bad">{label}: не удалось</span>
        <button type="button" onClick={() => setHidden(key)} aria-label="Скрыть" className="text-fg-3 hover:text-fg">
          <X className="size-3.5" />
        </button>
      </div>
      <p className="mt-1 line-clamp-3 text-small text-fg-2" title={job.error}>
        {job.error}
      </p>
      {info && (
        <button
          type="button"
          onClick={() => navigate(info.to)}
          className="mt-2 text-small text-fg underline decoration-line-strong underline-offset-2"
        >
          Открыть раздел
        </button>
      )}
    </div>
  );
}
