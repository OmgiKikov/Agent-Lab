import { CircleCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLabState } from "../lab/LabProvider";

type At = "done" | "now" | "later";

/**
 * The way to the first check of tone of voice as one line: the conversations, the rules with their criteria, then the
 * check, each done ticked and the one the person is on in black. It shows wherever a newcomer may stand before the
 * first check («Обзор», «Критерии», «Новая проверка»), so every page says the same three steps in the same words.
 * criteria: how many criteria are ready; collecting: they are being collected now.
 */
export function FirstStepsLine({
  criteria,
  collecting,
  className,
}: {
  criteria: number;
  collecting?: boolean;
  className?: string;
}) {
  const { state } = useLabState();
  const total = state?.logs.total ?? 0;
  const ready = criteria > 0;
  const steps: [string, At][] = [
    ["Разговоры", total ? "done" : "now"],
    ["Правила и критерии", ready ? "done" : total ? "now" : "later"],
    ["Первая проверка", ready && total ? "now" : "later"],
  ];
  return (
    <ol
      aria-label="Путь к первой проверке"
      className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1 text-small", className)}
    >
      {steps.map(([label, at], i) => (
        <li key={label} className="flex items-center gap-2.5">
          {i > 0 && <span aria-hidden className="h-px w-5 bg-line-strong" />}
          <span
            aria-current={at === "now" ? "step" : undefined}
            className={cn("flex items-center gap-1.5", at === "now" ? "font-medium text-fg" : "text-fg-3")}
          >
            {at === "done" ? (
              <CircleCheck aria-hidden className="size-4 text-ok" />
            ) : (
              <span
                aria-hidden
                className={cn("size-3 rounded-full border-2", at === "now" ? "border-fg" : "border-line-strong")}
              />
            )}
            {label}
            {at === "now" && collecting && <span className="font-normal text-fg-3">· собираются</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}
