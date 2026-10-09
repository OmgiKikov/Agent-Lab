import { useLabState } from "../lab/LabProvider";

/**
 * Under a section's head while its own task runs: what it does, how far, and a hairline of progress. It only tells:
 * «Остановить» lives in the task's card, on every screen (TaskCard), and in the head of a check's own page, not in
 * this line as well. A narrow window shows the task once, in the bar above the bottom navigation, so this line is for
 * wide ones.
 */
export function SectionJob({ kinds }: { kinds: string[] }) {
  const { state } = useLabState();
  const job = state?.job;
  if (!job?.running || !job.kind || !kinds.includes(job.kind)) return null;
  const { done = 0, total = 0, message } = job.progress;
  return (
    <div className="hidden border-t border-line lg:block" role="status">
      <div className="flex h-8 items-center gap-3 px-4 text-small text-fg-3 lg:px-5">
        <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-run" />
        <span className="min-w-0 flex-1 truncate text-fg-2">{message}</span>
        {total > 0 && (
          <span className="tabular-nums">
            {done} из {total}
          </span>
        )}
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
