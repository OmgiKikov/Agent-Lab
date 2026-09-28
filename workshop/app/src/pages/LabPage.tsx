/**
 * Agent Lab inside Raindrop Workshop.
 *
 * agent -> logs audit -> test cards -> synthetic customer runs -> one accuracy number.
 * Data and jobs live in the Agent Lab service (lab/api.py, :5901);
 * every conversation is a native Workshop trace, shown here with RunDetail.
 * The screens live in ../lab: this page only routes between them.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import { RunDetail } from "../components/RunDetail";
import { Rail } from "../lab/Rail";
import { STEPS } from "../lab/steps";
import { ToastProvider } from "../lab/toast";
import type { Step } from "../lab/types";
import { useLab } from "../lab/useLab";
import { AccuracyView } from "../lab/views/AccuracyView";
import { AgentView } from "../lab/views/AgentView";
import { CardView } from "../lab/views/CardView";
import { CardsView } from "../lab/views/CardsView";
import { LogsView } from "../lab/views/LogsView";
import { RunView } from "../lab/views/RunView";

const readTarget = () => { try { return localStorage.getItem("lab.target") || "local-http"; } catch { return "local-http"; } };

export function LabPage() {
  const navigate = useNavigate();
  const params = useParams<{ step?: string; itemId?: string }>();
  const step: Step = STEPS.includes(params.step as Step) ? params.step as Step : "agent";
  const itemId = params.itemId ? decodeURIComponent(params.itemId) : null;
  const { state, offline, run, pickRun } = useLab();
  const [target, setTargetState] = useState(readTarget);
  const setTarget = (t: string) => { setTargetState(t); try { localStorage.setItem("lab.target", t); } catch { /* ignore */ } };

  const go = (s: Step, item?: string | null) => navigate(item ? `/lab/${s}/${encodeURIComponent(item)}` : `/lab/${s}`);
  const card = step === "cards" && itemId ? state?.cards?.cards.find(c => c.id === itemId) : undefined;
  const traceId = step === "logs" && itemId ? itemId : null;

  return (
    <ToastProvider>
      <div className="flex h-full">
        <Rail state={state} offline={offline} step={step} itemId={itemId} run={run} go={go} onPickRun={pickRun} />

        <main className="sb relative min-w-0 flex-1 overflow-auto">
          {!offline && !state && (
            <div className="flex h-full items-center justify-center text-lab-dim"><Loader2 className="size-5 animate-spin" /></div>
          )}
          {offline && !state && (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <div className="text-[20px] font-medium text-lab-ink" style={{ fontFamily: '"AlphaLyrae", sans-serif' }}>Agent Lab не запущен</div>
                <div className="mt-3 text-[14px] text-lab-dim">Запустите <code className="rounded-md bg-white/10 px-2 py-1 font-mono text-[13px] text-white/90">sh bin/start.sh</code></div>
              </div>
            </div>
          )}
          {state && traceId && (
            <div className="flex h-full flex-col">
              <div className="flex flex-shrink-0 items-center gap-3 border-b border-white/[0.06] bg-white/[0.02] px-5 py-2.5">
                <button className="inline-flex items-center gap-1.5 text-[12.5px] text-lab-mute transition-colors hover:text-lab-text" onClick={() => go("logs")}>
                  <ArrowLeft className="size-3.5" />Назад к логам
                </button>
                <span className="text-[12px] text-lab-dim">Разговор из лога. Вердикт судьи в заметке сверху.</span>
              </div>
              <div className="sb min-h-0 flex-1 overflow-auto"><RunDetail key={traceId} runId={traceId} /></div>
            </div>
          )}
          {state && !traceId && step === "agent" && <AgentView state={state} />}
          {state && !traceId && step === "logs" && <LogsView state={state} onOpen={id => id && go("logs", id)} onGo={go} />}
          {state && !traceId && step === "cards" && (card ? <CardView card={card} state={state} onBack={() => go("cards")} /> : <CardsView state={state} onPick={id => go("cards", id)} />)}
          {state && step === "run" && <RunView state={state} run={run} itemId={itemId} target={target} setTarget={setTarget} onOpen={id => go("run", id)} />}
          {state && !traceId && step === "accuracy" && <AccuracyView state={state} run={run} onPickRun={pickRun} onOpen={key => go("run", key)} />}
        </main>
      </div>
    </ToastProvider>
  );
}
