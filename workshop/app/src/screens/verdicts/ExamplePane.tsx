import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, User } from "lucide-react";
import { RunDetail } from "../../components/RunDetail";
import { dialogOf } from "../../lab/dialogs";
import { reliabilityWord } from "../../lab/problemReport";
import type { Decision, Example } from "../../lab/problems";
import { PillTabs } from "../../ui/PillTabs";
import { EvidenceAll, EvidenceBar, type EvidenceMode } from "./EvidenceBar";
import { ConversationBox, exampleWhere, JudgeNote, useExample } from "./Example";
import { useLabState } from "../../shell/LabProvider";

type View = "talk" | "trace" | "details";

/** The user's line of an example as Raindrop's card over the conversation: who and where, and the first words. */
function ExampleCard({ example }: { example: Example }) {
  const { state } = useLabState();
  return (
    <div className="rounded-lg border border-white/[0.08] bg-lab-raised px-[11px] py-[9px]">
      <div className="flex items-center gap-2 text-meta text-lab-mute">
        <User aria-hidden className="size-3.5 flex-shrink-0" />
        <span className="min-w-0 truncate">{exampleWhere(example, state?.personas ?? [])}</span>
        {example.status === "FAIL" && <span className="flex-shrink-0 text-lab-dim">{reliabilityWord(example)}</span>}
        <Link to={dialogOf(example)} title="Открыть диалог (O)" aria-label="Открыть диалог" className="ml-auto flex-shrink-0 text-lab-dim transition-colors hover:text-lab-text"><ArrowUpRight className="size-3.5" /></Link>
      </div>
      <p className="mt-1.5 text-small text-lab-text">{example.opening}</p>
    </div>
  );
}

/**
 * The right column of an issue page: the evidence bar over one example, its user line, the tabs
 * «Разговор · Трейс · Детали»; the conversation with the judge's quote marked and numbered, and the judge's note.
 */
export function ExamplePane({ list, mode, onMode, at, onAt, hover, onHover, onDecide }: {
  list: Example[]; mode: EvidenceMode; onMode: (m: EvidenceMode) => void; at: number; onAt: (n: number) => void;
  hover: boolean; onHover: (on: boolean) => void; onDecide: (d: Decision) => void;
}) {
  const example = list[at];
  const view = useExample(example);
  const [tab, setTab] = useState<View>("talk");
  return (
    <div className="flex min-h-full flex-col">
      <EvidenceBar mode={mode} onMode={onMode} at={at} total={list.length} onAt={onAt} />
      {mode === "all" ? <EvidenceAll list={list} onPick={i => { onMode("rec"); onAt(i); }} />
        : !example ? <p className="px-4 py-10 text-center text-small text-lab-dim">Примеров нет</p>
        : (
          <div className="px-4 pb-10 pt-3">
            <ExampleCard example={example} />
            <PillTabs<View> small className="mt-3" value={tab} onChange={setTab} tabs={[
              { value: "talk", label: "Разговор" },
              ...(example.traceId ? [{ value: "trace" as const, label: "Трейс" }] : []),
              { value: "details", label: "Детали" },
            ]} />
            <div className="-mx-4 mt-3 border-t border-white/[0.08] px-4 pt-4">
              {tab === "talk" && (
                <>
                  <ConversationBox view={view} example={example} hover={hover} onHover={onHover} />
                  <div className="mt-5"><JudgeNote example={example} marked={view.marked} onDecide={onDecide} hover={hover} onHover={onHover} /></div>
                </>
              )}
              {tab === "trace" && example.traceId && <div className="-mx-4 -mb-10"><RunDetail key={example.traceId} runId={example.traceId} /></div>}
              {tab === "details" && (
                <pre className="overflow-auto rounded-lg border border-white/[0.08] bg-lab-surface p-3 font-mono text-meta text-lab-mute">{JSON.stringify(example, null, 2)}</pre>
              )}
            </div>
          </div>
        )}
    </div>
  );
}
