import { createContext, useContext, type ReactNode } from "react";
import { Check, History } from "lucide-react";
import { cn } from "@/lib/utils";
import { buttonClass } from "../ui/Button";

/** The pill of a step's action: the same for a link and a button. */
export const STEP_ACTION = buttonClass({ size: "sm" });
/** The action of the step to take next: the page's one black button among the steps. */
export const STEP_NEXT = buttonClass({ size: "sm", variant: "primary" });

/** A narrow column («Обзор» beside another check): the action goes under the text. */
const Compact = createContext(false);

/**
 * What a person can do after a check, under its number, as steps (product/Trust): each says what to do and why, with
 * the one action that does it; a step done says what came of it. Thin lines between the rows, no boxes. `compact` for
 * a narrow column.
 */
export function Steps({
  children,
  compact,
  className,
}: {
  children: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <Compact.Provider value={!!compact}>
      <div className={cn("max-w-[760px] divide-y divide-line border-y border-line", className)}>{children}</div>
    </Compact.Provider>
  );
}

/**
 * A step: `todo` — something to do, with an empty circle; `done` — done, with a tick, saying what came of it; `info` —
 * nothing to do, a fact to know. The action sits on the right, or under the text on a phone and in a narrow column.
 */
export function Step({
  state,
  title,
  text,
  action,
}: {
  state: "todo" | "done" | "info";
  title: ReactNode;
  text?: ReactNode;
  action?: ReactNode;
}) {
  const compact = useContext(Compact);
  return (
    <div
      className={cn(
        "grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 gap-y-2 py-3.5",
        !compact && "sm:grid-cols-[1.25rem_minmax(0,1fr)_auto] sm:items-center",
      )}
    >
      <span aria-hidden className="mt-0.5 flex size-5 items-center justify-center self-start sm:self-auto">
        {state === "done" ? (
          <span className="flex size-5 items-center justify-center rounded-full bg-ok text-white">
            <Check className="size-3.5" strokeWidth={3} />
          </span>
        ) : state === "todo" ? (
          <span className="size-[18px] rounded-full border-2 border-line-strong" />
        ) : (
          <History className="size-4 text-fg-3" />
        )}
      </span>
      <div className="min-w-0">
        <p className={cn("text-read", state === "info" ? "text-fg-2" : "font-medium text-fg")}>{title}</p>
        {text && <p className="mt-0.5 max-w-[60ch] whitespace-pre-line text-small text-fg-3">{text}</p>}
      </div>
      {action && <div className={cn("col-start-2", !compact && "sm:col-start-3 sm:justify-self-end")}>{action}</div>}
    </div>
  );
}
