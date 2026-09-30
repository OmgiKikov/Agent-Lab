import type { Decision, Example } from "../../lab/problems";
import { Label } from "../../ui/Label";
import { EvidenceAll, EvidenceBar, type EvidenceMode } from "../verdicts/EvidenceBar";
import { ConversationBox, ExampleMeta, JudgeNote, useExample } from "../verdicts/Example";

/** The proof: one violation at a time, in the order the bar asks for; the conversation with the judge's quote marked. */
export function Evidence({ list, mode, onMode, at, onAt, hover, onHover, onDecide }: {
  list: Example[]; mode: EvidenceMode; onMode: (m: EvidenceMode) => void; at: number; onAt: (n: number) => void;
  hover: boolean; onHover: (on: boolean) => void; onDecide: (d: Decision) => void;
}) {
  const example = list[at];
  const view = useExample(example);
  return (
    <section className="mt-8">
      <Label>Доказательство</Label>
      <div className="mt-2"><EvidenceBar mode={mode} onMode={onMode} at={at} total={list.length} onAt={onAt} /></div>
      {mode === "all" ? <EvidenceAll list={list} onPick={i => { onMode("rec"); onAt(i); }} />
        : example && (
          <>
            <div className="mt-3"><ExampleMeta example={example} /></div>
            <ConversationBox className="mt-2" view={view} example={example} hover={hover} onHover={onHover} />
            <div className="mt-3"><JudgeNote example={example} marked={view.marked} onDecide={onDecide} hover={hover} onHover={onHover} /></div>
          </>
        )}
    </section>
  );
}
