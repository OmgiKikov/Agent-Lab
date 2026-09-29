/**
 * Agent Lab inside Raindrop Workshop.
 *
 * Health of the agent, what is broken in it (findings), how far the number can be trusted, the set of checks,
 * versions side by side, the conversations, and the connection to the agent and its logs.
 * Data and jobs live in the Agent Lab service (lab/api.py, :5901); this page only routes between the screens in ../lab.
 */
import { useEffect, useMemo, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import { RunDetail } from "../components/RunDetail";
import { CommandPalette } from "../lab/CommandPalette";
import { deriveFindings, trustOf } from "../lab/findings";
import { Modal } from "../lab/modal";
import { buildNav, LEGACY, STEPS, type NavExtra } from "../lab/nav";
import { Rail } from "../lab/Rail";
import { ToastProvider } from "../lab/toast";
import type { Step } from "../lab/types";
import { useLab } from "../lab/useLab";
import { useRunContext } from "../lab/useRunContext";
import { CardView } from "../lab/views/CardView";
import { CardsView } from "../lab/views/CardsView";
import { ConnectView, type ConnectTab } from "../lab/views/ConnectView";
import { FindingsView, FindingView } from "../lab/views/FindingsView";
import { HealthView } from "../lab/views/HealthView";
import { NewRun, RunView } from "../lab/views/RunView";
import { TrustView } from "../lab/views/TrustView";
import { VersionsView } from "../lab/views/VersionsView";

const readTarget = () => { try { return localStorage.getItem("lab.target") || "local-http"; } catch { return "local-http"; } };

/** Where an address of the earlier layout (/lab/logs/…, /lab/run/…) lives now. */
function legacyTarget(step: string, item: string | null): string | null {
  const base = LEGACY[step];
  if (!base) return null;
  if (!item) return base;
  const id = encodeURIComponent(item);
  return step === "logs" ? `/lab/connect/${id}?tab=logs` : step === "run" ? `/lab/runs/${id}` : step === "cards" ? `/lab/checks/${id}` : base;
}

export function LabPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ step?: string; itemId?: string }>();
  const step: Step = STEPS.includes(params.step as Step) ? params.step as Step : "health";
  const itemId = params.itemId ? decodeURIComponent(params.itemId) : null;
  const tab: ConnectTab = new URLSearchParams(location.search).get("tab") === "logs" ? "logs" : "agent";
  const { state, offline, run, pickRun } = useLab();
  const [target, setTargetState] = useState(readTarget);
  const setTarget = (t: string) => { setTargetState(t); try { localStorage.setItem("lab.target", t); } catch { /* ignore */ } };
  const [newRun, setNewRun] = useState(false);
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.code === "KeyK") { e.preventDefault(); setPalette(o => !o); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { finished } = useRunContext(state, run);
  const findings = useMemo(() => (finished ? deriveFindings(finished.items ?? []) : []), [finished]);
  const trustLevel = finished ? trustOf(finished).level : null;
  const version = finished?.version;
  const extra = useMemo<NavExtra>(() => ({ findings: findings.length || undefined, trustPending: !!trustLevel && trustLevel !== "ok", version }), [findings.length, trustLevel, version]);
  const nav = useMemo(() => buildNav(state, extra), [state, extra]);
  const paletteFindings = useMemo(() => findings.map(f => ({ key: f.key, title: f.title, count: f.count })), [findings]);

  const go = (s: Step, item?: string | null) => navigate(item ? `/lab/${s}/${encodeURIComponent(item)}` : `/lab/${s}`);
  const goJudge = (runId?: string) => { if (runId) pickRun(runId); navigate("/lab/runs?view=judge"); };
  const card = step === "checks" && itemId ? state?.cards?.cards.find(c => c.id === itemId) : undefined;
  const traceId = step === "connect" && itemId ? itemId : null;
  const openTrace = (id: string) => navigate(`/lab/connect/${encodeURIComponent(id)}?tab=logs`);

  const legacy = params.step ? legacyTarget(params.step, itemId) : null;
  if (legacy) return <Navigate to={legacy} replace />;

  return (
    <ToastProvider>
      <div className="flex h-full">
        <Rail state={state} offline={offline} step={step} itemId={itemId} run={run} go={go} nav={nav} tab={tab} onTrace={openTrace} onPalette={() => setPalette(true)} />
        <CommandPalette open={palette} onClose={() => setPalette(false)} state={state} go={go} onPickRun={pickRun} onJudge={() => goJudge(finished?.id)} extra={extra} findings={paletteFindings} />

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
          {state && traceId && (
            <div className="flex h-full flex-col">
              <div className="flex flex-shrink-0 items-center gap-3 border-b border-white/[0.06] bg-white/[0.02] px-5 py-2.5">
                <button className="inline-flex items-center gap-1.5 text-[12px] text-lab-mute transition-colors hover:text-lab-text" onClick={() => navigate("/lab/connect?tab=logs")}>
                  <ArrowLeft className="size-3.5" />Назад к логам
                </button>
                <span className="text-[12px] text-lab-dim">Разговор из лога. Вердикт судьи в заметке сверху.</span>
              </div>
              <div className="sb min-h-0 flex-1 overflow-auto"><RunDetail key={traceId} runId={traceId} /></div>
            </div>
          )}
          {state && !traceId && step === "health" && <HealthView state={state} run={run} onCheck={() => setNewRun(true)} onJudge={goJudge} onFinding={key => go("findings", key)} go={navigate} />}
          {state && step === "findings" && (itemId ? <FindingView state={state} run={run} findingKey={itemId} onBack={() => go("findings")} go={navigate} /> : <FindingsView state={state} run={run} onFinding={key => go("findings", key)} />)}
          {state && step === "trust" && <TrustView state={state} run={run} onJudge={goJudge} />}
          {state && step === "checks" && (card ? <CardView card={card} state={state} onBack={() => go("checks")} /> : <CardsView state={state} onPick={id => go("checks", id)} />)}
          {state && step === "versions" && <VersionsView state={state} run={run} onFinding={key => go("findings", key)} />}
          {state && step === "runs" && <RunView state={state} run={run} itemId={itemId} target={target} setTarget={setTarget} onOpen={id => go("runs", id)} />}
          {state && !traceId && step === "connect" && <ConnectView state={state} tab={tab} onTab={t => navigate(t === "logs" ? "/lab/connect?tab=logs" : "/lab/connect")} onOpenTrace={openTrace} go={navigate} />}
        </main>
      </div>
      {state && (
        <Modal open={newRun} onClose={() => setNewRun(false)} title="Проверить агента" description="Выберите агента, кто ему пишет и сколько раз повторить.">
          <NewRun state={state} target={target} setTarget={setTarget} onStarted={() => { setNewRun(false); navigate("/lab/runs"); }} />
        </Modal>
      )}
    </ToastProvider>
  );
}
