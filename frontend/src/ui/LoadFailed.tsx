import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";

/** The service's own words on why, when it gave them: after what happened, small. */
const reasonOf = (error: unknown) => (error instanceof Error && error.message ? error.message : null);

/**
 * A place whose data did not come: what is missing, the service's reason under it, and «Повторить». It never stands in
 * for an empty result, nor an empty result for it: an empty place says what will appear there (EmptyState). `page` —
 * the whole screen waited for the data, so the message stands in the middle, as an empty screen's does.
 */
export function LoadFailed({
  title,
  error,
  onRetry,
  page,
  className,
}: {
  /** «Не удалось загрузить проблемы»: what did not come, without a full stop. */
  title: string;
  error?: unknown;
  onRetry: () => void;
  page?: boolean;
  className?: string;
}) {
  const reason = reasonOf(error);
  const retry = (
    <Button icon={RotateCcw} onClick={onRetry}>
      Повторить
    </Button>
  );
  if (page)
    return (
      <div role="alert" className={cn("flex h-full flex-col justify-center", className)}>
        <EmptyState drop title={title} action={retry}>
          {reason}
        </EmptyState>
      </div>
    );
  return (
    <div role="alert" className={cn("py-3", className)}>
      <p className="text-read text-fg-2">{title}.</p>
      {reason && <p className="mt-1 break-words text-small text-fg-3">{reason}</p>}
      <div className="mt-3">{retry}</div>
    </div>
  );
}
