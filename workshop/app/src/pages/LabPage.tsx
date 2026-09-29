/**
 * Agent Lab inside Raindrop Workshop.
 *
 * The Lab is about three things: the criteria the agent must meet, the dialogues (real logs and the simulator) that show how it does,
 * and how far the judge's verdicts can be trusted. The agent, its logs and the simulator's scenarios are where the dialogues come from.
 * Data and jobs live in the Agent Lab service (lab/api.py, :5901); this page only routes between the screens in ../lab.
 */
import { useEffect, useMemo, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import { RunDetail } from "../components/RunDetail";
import { AddDialogs } from "../lab/AddDialogs";
import { CommandPalette } from "../lab/CommandPalette";
import { trustOf } from "../lab/findings";
import { Modal } from "../lab/modal";
import { buildNav, LEGACY, STEPS, type NavExtra } from "../lab/nav";
import { Rail } from "../lab/Rail";
import { ScopeBar } from "../lab/ScopeBar";
import { ToastProvider } from "../lab/toast";
import type { Step } from "../lab/types";
import { useLab } from "../lab/useLab";
import { useScope } from "../lab/useScope";
import { AgentView } from "../lab/views/AgentView";
import { CardView } from "../lab/views/CardView";
import { CardsView } from "../lab/views/CardsView";
import { CriteriaView } from "../lab/views/CriteriaView";
import { CriterionView } from "../lab/views/CriterionView";
import { DialogsView } from "../lab/views/DialogsView";
import { JudgeCheckPage } from "../lab/views/JudgeCheckPage";
import { LogsView } from "../lab/views/LogsView";
import { NewRun, RunView } from "../lab/views/RunView";
import { TrustView } from "../lab/views/TrustView";

const readTarget = () => { try { return localStorage.getItem("lab.target") || "local-http"; } catch { return "local-http"; } };

/** Where an address of an earlier layout (/lab/health, /lab/findings/…, /lab/connect?tab=logs) lives now. */
function legacyTarget(step: string, item: string | null, search: string): string | null {
  const id = item ? `/${encodeURIComponent(item)}` : "";
  if (step === "connect") return new URLSearchParams(search).get("tab") === "logs" ? (id ? `/lab/dialogs${id}` : "/lab/logs") : "/lab/agent";
  if (step === "logs" && item) return `/lab/dialogs${id}`;
  const base = LEGACY[step];
  if (!base) return null;
  return step === "findings" || step === "runs" || step === "run" || step === "cards" ? `${base}${id}` : base;
}

export function LabPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ step?: string; itemId?: string }>();
  const step: Step = STEPS.includes(params.step as Step) ? params.step as Step : "criteria";
  const itemId = params.itemId ? decodeURIComponent(params.itemId) : null;
  const { state, offline, run, pickRun } = useLab();
  const [target, setTargetState] = useState(readTarget);
  const setTarget = (t: string) => { setTargetState(t); try { localStorage.setItem("lab.target", t); } catch { /* ignore */ } };
  const [newRun, setNewRun] = useState(false);
  const [adding, setAdding] = useState(false);
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.code === "KeyK") { e.preventDefault(); setPalette(o => !o); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const scope = useScope(state, run);
  const { finished } = scope;
  const trustLevel = finished ? trustOf(finished).level : null;
  const broken = scope.criteria.filter(c => c.failed > 0).length;
  const extra = useMemo<NavExtra>(() => ({ broken: broken || undefined, dialogs: scope.dialogs.length || undefined, trustPending: !!trustLevel && trustLevel !== "ok" }), [broken, scope.dialogs.length, trustLevel]);
  const nav = useMemo(() => buildNav(state, extra), [state, extra]);
  const paletteCriteria = useMemo(() => scope.criteria.map(c => ({ key: c.key, title: c.title, failed: c.failed })), [scope.criteria]);

  const go = (s: Step, item?: string | null) => navigate(item ? `/lab/${s}/${encodeURIComponent(item)}` : `/lab/${s}`);
  const goJudge = (runId?: string) => { if (runId) pickRun(runId); navigate("/lab/judge/check"); };
  const card = step === "checks" && itemId ? state?.cards?.cards.find(c => c.id === itemId) : undefined;
  const logTrace = step === "dialogs" && itemId && state?.discover?.results.some(r => r.runId === itemId) ? itemId : null;
  const openTrace = (id: string) => navigate(`/lab/dialogs/${encodeURIComponent(id)}`);
  const goBack = (fallback: string) => (location.key !== "default" ? navigate(-1) : navigate(fallback));

  const legacy = params.step ? legacyTarget(params.step, itemId, location.search) : null;
  if (legacy) return <Navigate to={legacy} replace />;

  const scopeBar = <ScopeBar scope={scope} onPick={pickRun} onAdd={() => setAdding(true)} />;

  return (
    <ToastProvider>
      <div className="flex h-full">
        <Rail state={state} offline={offline} step={step} itemId={itemId} run={scope.finished ?? run} go={go} nav={nav} onPalette={() => setPalette(true)} />
        <CommandPalette open={palette} onClose={() => setPalette(false)} state={state} go={go} onPickRun={pickRun} onJudge={() => goJudge(finished?.id)} extra={extra} criteria={paletteCriteria} />

        <main className="sb relative min-w-0 flex-1 overflow-auto">
          {!offline && !state && <div className="flex h-full items-center justify-center text-lab-dim"><Loader2 className="size-5 animate-spin" /></div>}
          {offline && !state && (
            <div className="flex h-full items-center justify-center">
              <div className="text-center">
                <div className="text-[20px] font-medium text-lab-ink" style={{ fontFamily: '"AlphaLyrae", sans-serif' }}>Agent Lab не запущен</div>
                <div className="mt-3 text-[14px] text-lab-dim">Запустите <code className="rounded-md bg-white/10 px-2 py-1 font-mono text-[13px] text-white/90">sh bin/start.sh</code></div>
              </div>
            </div>
          )}
          {state && step === "criteria" && (itemId
            ? <CriterionView state={state} scope={scope} criterionKey={itemId} scopeBar={scopeBar} onBack={() => go("criteria")} onTrace={openTrace} go={navigate} />
            : <CriteriaView state={state} scope={scope} scopeBar={scopeBar} onCriterion={key => go("criteria", key)} onJudge={() => goJudge(finished?.id)} go={navigate} />)}
          {state && step === "dialogs" && !itemId && <DialogsView state={state} scope={scope} scopeBar={scopeBar} onOpen={d => go("dialogs", d.origin === "sim" ? d.key : d.traceId)} />}
          {state && step === "dialogs" && itemId && !logTrace && <RunView state={state} run={scope.finished ?? run} itemId={itemId} target={target} setTarget={setTarget} onOpen={key => go("dialogs", key)} />}
          {state && logTrace && (
            <div className="flex h-full flex-col">
              <div className="flex flex-shrink-0 items-center gap-3 border-b border-white/[0.06] bg-white/[0.02] px-5 py-2.5">
                <button className="inline-flex items-center gap-1.5 text-[12px] text-lab-mute transition-colors hover:text-lab-text" onClick={() => goBack("/lab/dialogs")}>
                  <ArrowLeft className="size-3.5" />Назад
                </button>
                <span className="text-[12px] text-lab-dim">Разговор из лога. Вердикт судьи в заметке сверху.</span>
              </div>
              <div className="sb min-h-0 flex-1 overflow-auto"><RunDetail key={logTrace} runId={logTrace} /></div>
            </div>
          )}
          {state && step === "judge" && (itemId === "check"
            ? <JudgeCheckPage state={state} scope={scope} onBack={() => go("judge")} onOpen={key => go("dialogs", key)} />
            : <TrustView state={state} run={scope.finished ?? run} onJudge={goJudge} />)}
          {state && step === "agent" && <AgentView state={state} />}
          {state && step === "logs" && <LogsView state={state} onGo={() => go("agent")} onCriteria={() => go("criteria")} />}
          {state && step === "checks" && (card ? <CardView card={card} state={state} onBack={() => go("checks")} /> : <CardsView state={state} onPick={id => go("checks", id)} />)}
        </main>
      </div>
      {state && (
        <>
          <Modal open={adding} onClose={() => setAdding(false)} title="Добавить диалоги" description="Откуда взять разговоры, по которым считаются критерии." className="max-w-[560px]">
            <AddDialogs state={state} onLogs={() => { setAdding(false); go("logs"); }} onSimulator={() => { setAdding(false); setNewRun(true); }} />
          </Modal>
          <Modal open={newRun} onClose={() => setNewRun(false)} title="Прогнать симулятор" description="Выберите агента, кто ему пишет и сколько раз повторить.">
            <NewRun state={state} target={target} setTarget={setTarget} onStarted={() => { setNewRun(false); navigate("/lab/dialogs"); }} />
          </Modal>
        </>
      )}
    </ToastProvider>
  );
}
