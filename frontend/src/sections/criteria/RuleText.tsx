import { cn } from "@/lib/utils";

/** The bullets the rules were written with («* …») in one line of a card: as dots, not stars. */
export const plainRule = (text: string) => text.replace(/(^|\s+)\*\s+/g, "$1• ");

/**
 * A criterion's words as a person reads them: the bullets the bank's rules were written with («* Стиль — …
 * * Одна реплика — …») as a list, what comes before them as its lead; a text without them as it is.
 */
export function RuleText({ text, className }: { text: string; className?: string }) {
  const bulleted = /^\s*\*\s+/.test(text);
  const parts = text
    .split(/(?:^|\s+)\*\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2 && !bulleted) return <p className={cn("whitespace-pre-wrap", className)}>{text}</p>;
  const [lead, ...items] = bulleted ? ["", ...parts] : parts;
  return (
    <div className={className}>
      {lead && <p className="whitespace-pre-wrap">{lead}</p>}
      <ul className={cn("list-disc space-y-1 pl-5 marker:text-fg-4", lead && "mt-1.5")}>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
