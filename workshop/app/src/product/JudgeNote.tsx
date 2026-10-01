import { secondLine } from "../lab/problemReport";
import type { Decision, Example } from "../lab/problems";
import { useLabState } from "../lab/LabProvider";
import { MarkNo } from "./MarkNo";
import { ReviewButtons } from "./ReviewButtons";

const WORD: Record<Example["status"], string> = { FAIL: "нарушено", PASS: "выполнено", UNKNOWN: "не проверено" };

/** Under the conversation: the judge's reason with the quote's number, the second judge, and a person's decision. */
export function JudgeNote({ example, marked, lit, onLit, onDecide, onSkip }: { example: Example; marked: boolean; lit?: boolean; onLit?: (on: boolean) => void; onDecide?: (d: Decision) => void; onSkip?: () => void }) {
  const { state } = useLabState();
  const judged = example.status !== "UNKNOWN";
  return (
    <div className="mt-4 grid grid-cols-[20px_minmax(0,1fr)] gap-x-2 gap-y-1 border-t border-line pt-3" onMouseEnter={() => onLit?.(true)} onMouseLeave={() => onLit?.(false)}>
      <span className="pt-0.5">{marked && <MarkNo n={1} on={lit} />}</span>
      <p className="text-body text-fg-2"><span className="text-fg-3">Судья{example.status !== "FAIL" ? ` · ${WORD[example.status]}` : ""}: </span>{example.reason}</p>
      {!marked && example.agentQuote && <p className="col-start-2 text-small text-fg-3">Судья ссылается на слова агента: «{example.agentQuote}»</p>}
      {judged && <p className="col-start-2 text-small text-fg-3">{secondLine(example, state?.models.second ?? null)}</p>}
      {judged && onDecide && <div className="col-start-2 mt-2"><ReviewButtons example={example} onDecide={onDecide} onSkip={onSkip} /></div>}
    </div>
  );
}
