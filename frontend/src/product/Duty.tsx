import { useState } from "react";
import { duty } from "../lab/criteria";

const LEAD = 180;

/** A criterion as its intro and its points: rules often come as «* …» points, sometimes run together on one line. */
function parts(text: string): { intro: string; points: string[] } {
  const pieces = text.split(/(?:^|\s)[*•]\s+/);
  if (pieces.length < 2) return { intro: text.trim(), points: [] };
  return {
    intro: pieces[0].trim(),
    points: pieces
      .slice(1)
      .map((p) => p.trim())
      .filter(Boolean),
  };
}

/**
 * The first sentence. A dot after a short word is an abbreviation or a list number («т. п.», «1.»), and a dot inside
 * «…» belongs to a quote: neither ends the sentence.
 */
function firstSentence(text: string): string {
  const end = /[.!?](?=\s)/g;
  for (let m = end.exec(text); m; m = end.exec(text)) {
    const before = text.slice(0, m.index);
    const word = before.split(/[\s(«"]/).pop() ?? "";
    const open = (before.match(/«/g)?.length ?? 0) > (before.match(/»/g)?.length ?? 0);
    if (word.length > 3 && !open) return text.slice(0, m.index + 1);
  }
  return text;
}

/** The first sentence, cut at a word if it is long. */
function lead(text: string): string {
  const first = firstSentence(text);
  if (first.length <= LEAD) return first;
  const cut = first.slice(0, LEAD);
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:—–-]\s*$/, "") + "…";
}

/**
 * «Агент должен: …» — what the agent must do, as the criterion says it. A long criterion reads as its first sentence
 * (an intro ending in a colon takes its first point along); «Полностью» opens the whole text with its points as a list.
 * Plain language first, the rest on demand (NN/g, progressive disclosure).
 */
export function Duty({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const full = duty(text);
  const { intro, points } = parts(full);
  const opening = intro && intro.endsWith(":") && points[0] ? `${intro} ${points[0]}` : intro || points[0] || full;
  const short = lead(opening);
  const long = short !== full;
  const toggle = (
    <button
      type="button"
      aria-expanded={open}
      onClick={() => setOpen(!open)}
      className="whitespace-nowrap text-read font-medium text-run hover:underline"
    >
      {open ? "Свернуть" : "Полностью"}
    </button>
  );
  return (
    <div className={className}>
      <p>
        <span className="text-fg-3">Агент должен: </span>
        {open ? intro : short}
        {long && !open && <> {toggle}</>}
      </p>
      {open && points.length > 0 && (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-read">
          {points.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      {open && <div className="mt-2">{toggle}</div>}
    </div>
  );
}
