import { cn } from "@/lib/utils";
import { reliabilityWord } from "../lab/problemReport";
import type { Example } from "../lab/problems";

/** How well an example is backed, as a word with a sign: people and both judges first, a dispute in amber. */
export function Reliability({ example, className }: { example: Example; className?: string }) {
  const word = reliabilityWord(example);
  const tone =
    example.review === "disagree"
      ? "bg-bad"
      : example.second === "disagree"
        ? "bg-warn"
        : example.review === "agree" || example.second === "agree"
          ? "bg-ok"
          : "bg-fg-4";
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-fg-2", className)}>
      <span aria-hidden className={cn("size-1.5 flex-shrink-0 rounded-full", tone)} />
      {word}
    </span>
  );
}
