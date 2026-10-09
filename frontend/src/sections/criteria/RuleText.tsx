import { ruleLines, ruleParts } from "../../lab/quote";
import { RuleList } from "../../product/Duty";

/** A criterion's words on one line of a card (lab/quote, ruleLines): its points after «•», its headings gone. */
export const plainRule = (text: string) => ruleLines(text).join(" ");

/**
 * A criterion's words as a person reads them (lab/quote, ruleParts): the points the bank's rules were written with
 * («* Стиль — … * Одна реплика — …») as a list, the words around them as paragraphs, the rules' headings and codes
 * gone — the same text as the summary, its PDF and the reports.
 */
export function RuleText({ text, className }: { text: string; className?: string }) {
  return <RuleList parts={ruleParts(text)} className={className} />;
}
