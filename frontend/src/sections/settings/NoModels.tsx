import { Link } from "react-router-dom";
import { ArrowRight, CircleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { SECTIONS } from "../../app/links";
import { useLabState } from "../../lab/LabProvider";

/**
 * While the models are not set up (/api/state, models.problem), the one line every page that leads to a check says
 * instead of letting it start and fail: why it will not start, and the way to «Настройки», which say what to do.
 */
export function NoModels({ className }: { className?: string }) {
  const { state } = useLabState();
  if (!state?.models.problem) return null;
  return (
    <p role="status" className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-body text-fg-2", className)}>
      <CircleAlert aria-hidden className="size-4 shrink-0 text-bad" />
      Модели не настроены — проверка не запустится.
      <Link
        to={SECTIONS.settings}
        className="inline-flex items-center gap-1 rounded-sm font-medium text-run hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
      >
        Настройки
        <ArrowRight aria-hidden className="size-3.5" />
      </Link>
    </p>
  );
}
