import { useId } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { exportLink } from "../app/links";
import { count, longDay } from "../lab/format";
import { useLabState } from "../lab/LabProvider";
import { UploadExport } from "../sections/exports/UploadExport";

/**
 * Which export a check takes its conversations from: the agent's exports to choose one, the newest first, and a new one
 * uploaded right here, then chosen. An export without a conversation cannot be chosen. The choice is the caller's.
 */
export function ExportPicker({
  value,
  onChange,
  disabled,
}: {
  value: string | null;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const { state } = useLabState();
  // Its own group of radios: two pickers on one page (a check's start and its window) never switch each other.
  const group = useId();
  const exports = state?.exports ?? [];
  return (
    <div>
      {exports.length ? (
        <ul
          role="radiogroup"
          aria-label="Выгрузка"
          className="divide-y divide-line overflow-hidden rounded-block border border-line"
        >
          {exports.map((e) => {
            const on = value === e.id;
            const off = disabled || !e.total;
            return (
              <li key={e.id}>
                <label
                  className={cn(
                    "flex items-start gap-3 px-4 py-3 transition-colors",
                    on ? "bg-selected" : "hover:bg-hover",
                    off ? "cursor-default" : "cursor-pointer",
                    !e.total && "opacity-60",
                  )}
                >
                  <input
                    type="radio"
                    name={group}
                    checked={on}
                    disabled={off}
                    onChange={() => onChange(e.id)}
                    className="mt-1 size-4 accent-primary"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-read font-medium text-fg">{e.name}</span>
                    <span className="block text-body text-fg-3">
                      {count(e.total, "разговор", "разговора", "разговоров")} · {longDay(e.uploadedAt)}
                    </span>
                  </span>
                  <Link
                    to={exportLink(e.id)}
                    className="mt-0.5 flex-shrink-0 text-small text-fg-3 underline-offset-2 hover:text-fg hover:underline"
                  >
                    открыть
                  </Link>
                </label>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-read text-fg-2">Выгрузок ещё нет.</p>
      )}
      <div className="mt-3">
        <UploadExport
          variant="outline"
          label={exports.length ? "Загрузить новую" : "Загрузить выгрузку"}
          onUploaded={(line) => line.total && onChange(line.id)}
        />
      </div>
    </div>
  );
}
