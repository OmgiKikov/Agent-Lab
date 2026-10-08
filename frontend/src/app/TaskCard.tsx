import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "../lab/api";
import type { Job } from "../lab/types";
import { jobOf } from "./jobs";
import { useLabState } from "../lab/LabProvider";
import { useToast } from "../ui/toast";

const STOPPED = "Остановлено";

const MARK = /^(Готово|Не удалось) · /;

/**
 * A finished task seen from another tab: the tab's title says so until the person comes back (NN/g: visibility of
 * system status for work longer than ten seconds).
 */
function markTab(word: string) {
  if (!document.hidden) return;
  const base = document.title.replace(MARK, "");
  document.title = `${word} · ${base}`;
  const back = () => {
    if (document.hidden) return;
    document.title = document.title.replace(MARK, "");
    document.removeEventListener("visibilitychange", back);
  };
  document.addEventListener("visibilitychange", back);
}

/**
 * Whether the end of `job` is news to the page that saw `before`: the task it saw running has ended, or a task started
 * after the one it saw (`startedAt`) has ended already, between two looks at the service — a quick failure too. A task
 * that had ended when the page opened is not news. A service without `startedAt`: only a task seen running.
 */
function ended(before: Job | null, job: Job): boolean {
  if (!before || job.running || !job.kind) return false;
  if (job.startedAt) return before.running || job.startedAt !== before.startedAt;
  return before.running && before.kind === job.kind;
}

/**
 * Quick saves whose screen says how they went — the upload, the datasets, the rules, the agent's card: neither a toast
 * nor this card repeats their failure beside the screen's own message.
 */
const SAID_ON_SCREEN = new Set(["logs", "datasets", "judge-rules", "agent-context"]);

/**
 * When the service's task ends: one notice with the way to its result, or the reason it failed. Mounted once for the
 * whole product (the task card is drawn twice: the side of a wide window, the bar of a narrow one). A person already
 * looking at the result's section gets no notice: the screen itself changes. Each task is told once, by its start,
 * even when an older answer of the service comes in late.
 */
export function JobNotices() {
  const { state } = useLabState();
  const toast = useToast();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const job = state?.job;
  const was = useRef<Job | null>(null);
  // The start of the task whose end was told, or had ended when the page opened.
  const told = useRef<string | null | undefined>(undefined);
  const here = useRef(pathname);
  here.current = pathname;
  useEffect(() => {
    if (!job) return;
    const before = was.current;
    was.current = job;
    if (!before && !job.running) told.current = job.startedAt;
    if (!ended(before, job) || (job.startedAt && job.startedAt === told.current)) return;
    told.current = job.startedAt;
    const info = jobOf(job);
    const label = info?.label ?? "Задача";
    if (job.error !== STOPPED) markTab(job.error ? "Не удалось" : "Готово");
    if (SAID_ON_SCREEN.has(job.kind ?? "")) return;
    if (job.error === STOPPED)
      toast.notify(
        job.continuable
          ? `${label}: остановлено. Сделанное сохранено: тот же запуск продолжит с этого места.`
          : `${label}: остановлено`,
      );
    else if (job.error) toast.error(`${label}: не удалось. ${job.error}`);
    else if (!info || here.current !== info.to.split("?")[0])
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
  return null;
}

function stop(toast: ReturnType<typeof useToast>) {
  api("/api/job/stop", {}).catch(toast.error);
}

/**
 * The service's task, seen from every screen: what runs, how far it is, «Остановить»; when it fails, the reason stays
 * until closed. `bar` is the narrow window's version: one line above the bottom navigation.
 */
export function TaskCard({ bar }: { bar?: boolean }) {
  const { state } = useLabState();
  const toast = useToast();
  const navigate = useNavigate();
  const [hidden, setHidden] = useState<string | null>(null);
  const job = state?.job;
  if (!job?.kind) return null;
  const info = jobOf(job);
  const label = info?.label ?? "Задача";
  if (job.running) {
    const { done = 0, total = 0, message } = job.progress;
    const share = total ? Math.min(1, done / total) : null;
    const ping = (
      <span aria-hidden className="relative flex size-2 flex-shrink-0">
        <span className="absolute inset-0 animate-ping rounded-full bg-run/50 motion-reduce:animate-none" />
        <span className="relative size-2 rounded-full bg-run" />
      </span>
    );
    const progress = (
      <div className={cn("overflow-hidden rounded-full bg-well", bar ? "h-0.5" : "mt-2 h-1")}>
        <div
          className={
            share === null
              ? "h-full w-1/3 animate-pulse rounded-full bg-run motion-reduce:animate-none"
              : "h-full rounded-full bg-run transition-[width] duration-500 ease-out"
          }
          style={share === null ? undefined : { width: `${Math.max(4, share * 100)}%` }}
        />
      </div>
    );
    const stopButton = (
      <button
        type="button"
        onClick={() => stop(toast)}
        className="inline-flex min-h-6 items-center gap-1 rounded px-1 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
      >
        <Square aria-hidden className="size-2.5 fill-current" />
        Остановить
      </button>
    );
    if (bar)
      return (
        <div role="status" className="border-t border-line bg-canvas">
          {progress}
          <div className="flex min-h-11 items-center gap-3 px-4 text-small text-fg-3">
            {ping}
            <button
              type="button"
              onClick={() => info && navigate(info.to)}
              className="min-w-0 flex-1 truncate text-left font-medium text-fg"
            >
              {label}
            </button>
            {total > 0 && <span className="tabular-nums">{`${done}\u00a0из\u00a0${total}`}</span>}
            {stopButton}
          </div>
        </div>
      );
    return (
      <div role="status" className="rounded-block border border-line-strong p-3">
        <div className="flex items-center gap-2 text-small font-medium text-fg">
          {ping}
          <button
            type="button"
            onClick={() => info && navigate(info.to)}
            className="min-w-0 flex-1 truncate text-left hover:underline"
          >
            {label}
          </button>
        </div>
        {message && message !== label && (
          <div className="mt-1 line-clamp-2 text-small text-fg-3" title={message}>
            {message}
          </div>
        )}
        <div className="mt-1 text-small text-fg-4">
          {job.resumed
            ? "Продолжена после перезапуска Lab: сделанное раньше сохранено."
            : "Страницу можно закрыть, результат сохранится."}
        </div>
        {progress}
        <div className="mt-2 flex items-center justify-between gap-2 text-small text-fg-3">
          <span className="tabular-nums">{total ? `${done}\u00a0из\u00a0${total}` : "идёт"}</span>
          {stopButton}
        </div>
      </div>
    );
  }
  // Hidden is this failure of this task: the same failure of a task started later shows again.
  const key = `${job.kind}:${job.startedAt ?? ""}:${job.error}`;
  if (!job.error || job.error === STOPPED || hidden === key || SAID_ON_SCREEN.has(job.kind)) return null;
  return (
    <div
      role="alert"
      className={cn("bg-bad/[0.06] p-3", bar ? "border-t border-bad/30 px-4" : "rounded-block border border-bad/30")}
    >
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-small font-medium text-bad">{label}: не удалось</span>
        <button
          type="button"
          onClick={() => setHidden(key)}
          aria-label="Скрыть"
          className="-m-1 grid size-6 place-items-center text-fg-3 hover:text-fg"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {/* Room for a whole sentence: what happened and what to do («…проверьте её в разделе «Настройки»»). */}
      <p className={cn("mt-1 text-small text-fg-2", bar ? "line-clamp-3" : "line-clamp-6")} title={job.error}>
        {job.error}
      </p>
      {info && (
        <button
          type="button"
          onClick={() => navigate(info.to)}
          className="mt-2 min-h-6 text-small text-fg underline decoration-line-strong underline-offset-2"
        >
          Открыть раздел
        </button>
      )}
    </div>
  );
}
