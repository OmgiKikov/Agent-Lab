import { useState } from "react";
import { cn } from "@/lib/utils";
import { ruleParts, type RulePart } from "../lab/quote";

const LEAD = 180;

/** The parts in runs: a paragraph alone, the points next to each other as one list. */
function runs(parts: RulePart[]): RulePart[][] {
  const out: RulePart[][] = [];
  for (const part of parts) {
    const last = out[out.length - 1];
    if (part.point && last?.[0].point) last.push(part);
    else out.push([part]);
  }
  return out;
}

/**
 * A criterion's words as a list (lab/quote, ruleParts), the same on every screen, on paper and in the texts that leave
 * the product: the points the rules were written with, the paragraphs between them.
 */
export function RuleList({ parts, className }: { parts: RulePart[]; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      {runs(parts).map((run, i) =>
        run[0].point ? (
          <ul key={i} className="list-disc space-y-1 pl-5 marker:text-fg-4">
            {run.map((part, j) => (
              // On paper a point stays on one sheet.
              <li key={j} className="print:break-inside-avoid">
                {part.text}
              </li>
            ))}
          </ul>
        ) : (
          <p key={i}>{run[0].text}</p>
        ),
      )}
    </div>
  );
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
 * (a paragraph ending in a colon takes its first point along); «Полностью» opens the whole text as its list (RuleList).
 * Plain language first, the rest on demand (NN/g, progressive disclosure).
 */
export function Duty({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const parts = ruleParts(text);
  const intro = parts.length > 1 && !parts[0].point && parts[0].text.endsWith(":");
  const opening = parts
    .slice(0, intro ? 2 : 1)
    .map((part) => part.text)
    .join(" ");
  const short = lead(opening);
  const long = parts.length > (intro ? 2 : 1) || short !== opening;
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
        {!open && short}
        {long && !open && <> {toggle}</>}
      </p>
      {open && <RuleList parts={parts} className="mt-2 text-read" />}
      {open && <div className="mt-2">{toggle}</div>}
    </div>
  );
}
