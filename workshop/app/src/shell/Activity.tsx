import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Square, X } from "lucide-react";
import { api } from "../lab/api";
import type { Job } from "../lab/types";
import { Button } from "../ui/Button";
import { useToast } from "../ui/toast";
import { jobOf } from "./jobs";
import { useLabState } from "./LabProvider";

const STOPPED = "Остановлено";

function Ring({ share }: { share: number | null }) {
  const r = 8;
  const c = 2 * Math.PI * r;
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" className={share === null ? "animate-spin" : "-rotate-90"} aria-hidden>
      <circle cx="11" cy="11" r={r} fill="none" stroke="rgb(255 255 255 / 0.12)" strokeWidth="2.5" />
      <circle
        cx="11" cy="11" r={r} fill="none" stroke="rgb(var(--lab-accent))" strokeWidth="2.5" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - (share ?? 0.25))} className="transition-[stroke-dashoffset] duration-500"
      />
    </svg>
  );
}

/** The running task on the rail: a ring of its progress; a click shows it and stops it. Its end is announced once. */
export function Activity() {
  const { state } = useLabState();
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
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
    else toast.notify(`${label}: готово`, info ? { label: "Открыть", run: () => navigate(info.to) } : undefined);
  }, [job, toast, navigate]);
  useEffect(() => { if (!job?.running) setOpen(false); }, [job?.running]);
  if (!job?.running) return null;
  const info = jobOf(job);
  const { done = 0, total = 0, message } = job.progress;
  return (
    <div className="relative">
      <button
        type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} title={`${info?.label ?? "Задача"}: ${message ?? ""}`}
        className="flex size-10 items-center justify-center rounded-lg transition-colors hover:bg-lab-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-lab-accent"
      >
        <Ring share={total ? done / total : null} />
      </button>
      {open && (
        <div className="absolute bottom-0 left-full z-40 ml-2 w-[300px] rounded-lg border border-white/10 bg-lab-hover p-3 shadow-2xl">
          <div className="text-small font-medium text-lab-ink">{info?.label ?? "Задача"}</div>
          <div className="mt-1 text-meta text-lab-mute">{message}</div>
          {total > 0 && <div className="mt-2 font-mono text-meta text-lab-dim">{done} из {total}</div>}
          <div className="mt-3 flex gap-2">
            {info && <Button size="sm" onClick={() => { setOpen(false); navigate(info.to); }}>Открыть</Button>}
            <Button size="sm" variant="ghost" icon={Square} onClick={() => api("/api/job/stop", {}).catch(toast.error)}>Остановить</Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Under a section's header: this section's task while it runs, or why it failed. */
export function JobStrip({ kinds }: { kinds: string[] }) {
  const { state } = useLabState();
  const toast = useToast();
  const [hidden, setHidden] = useState<string | null>(null);
  const job = state?.job;
  if (!job?.kind || !kinds.includes(job.kind)) return null;
  if (job.running) {
    const { done = 0, total = 0, message } = job.progress;
    return (
      <div className="border-t border-white/[0.06]">
        <div className="flex h-8 items-center gap-3 px-4 text-meta text-lab-mute">
          <span className="pulse-dot size-1.5 rounded-full bg-lab-accent" />
          <span className="min-w-0 flex-1 truncate">{message}</span>
          {total > 0 && <span className="font-mono text-lab-dim">{done} из {total}</span>}
          <button type="button" onClick={() => api("/api/job/stop", {}).catch(toast.error)} className="inline-flex items-center gap-1 transition-colors hover:text-lab-text">
            <Square className="size-2.5 fill-current" />Остановить
          </button>
        </div>
        <div className="h-px bg-white/[0.06]">
          <div className="h-px bg-lab-accent transition-[width] duration-500" style={{ width: `${total ? (100 * done) / total : 6}%` }} />
        </div>
      </div>
    );
  }
  const key = `${job.kind}:${job.error}`;
  if (!job.error || job.error === STOPPED || hidden === key) return null;
  return (
    <div className="flex items-center gap-3 border-t border-lab-bad/20 bg-lab-bad/[0.06] px-4 py-2 text-meta text-lab-bad">
      <span className="min-w-0 flex-1">{job.error}</span>
      <button type="button" onClick={() => setHidden(key)} aria-label="Скрыть" className="text-lab-dim transition-colors hover:text-lab-text"><X className="size-3.5" /></button>
    </div>
  );
}
