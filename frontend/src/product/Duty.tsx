import { useState } from "react";
import { duty } from "../lab/criteria";

const LEAD = 180;

/** A criterion's text as its items: rules often come as «* …» points, sometimes run together on one line. */
function items(text: string): string[] {
  const parts = text
    .split(/(?:^|\s)[*•]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts : [];
}

/** The first sentence, cut at a word if it is long. */
function lead(text: string): string {
  const first = text.split(/(?<=[.!?])\s/)[0] ?? text;
  if (first.length <= LEAD) return first;
  const cut = first.slice(0, LEAD);
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:—–-]\s*$/, "") + "…";
}

/**
 * «Агент должен: …» — what the agent must do, as the criterion says it. A long criterion reads as its first sentence;
 * «Полностью» opens the whole text, with its points as a list. Plain language first, the rest on demand (NN/g,
 * progressive disclosure).
 */
export function Duty({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const full = duty(text);
  const points = items(full);
  const short = lead(points[0] ?? full);
  const long = short !== full;
  return (
    <div className={className}>
      <p>
        <span className="text-fg-3">Агент должен: </span>
        {open ? (points.length ? null : full) : short}
        {long && !open && (
          <>
            {" "}
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="whitespace-nowrap text-read font-medium text-run hover:underline"
            >
              Полностью
            </button>
          </>
        )}
      </p>
      {open && points.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-read">
          {points.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      {open && (
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="mt-2 text-read font-medium text-run hover:underline"
        >
          Свернуть
        </button>
      )}
    </div>
  );
}
