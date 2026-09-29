/**
 * Agent Lab inside Raindrop Workshop.
 *
 * The Lab answers one question first — is this version of the agent better or worse, and what breaks — then shows the evidence
 * (criteria with the prompt line they come from, the dialogues with the judge's quote) and how far the judge can be trusted.
 * The agent, its logs and the simulator's scenarios are the preparation that feeds it (docs/DESIGN.md).
 * Data and jobs live in the Agent Lab service (lab/api.py, :5901); this page lays out the shell and routes between the screens in ../lab.
 */
import { useEffect, useMemo, useState } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Menu, Play, RotateCw } from "lucide-react";
import { RunDetail } from "../components/RunDetail";
import { CommandPalette } from "../lab/CommandPalette";
import { trustOf } from "../lab/findings";
import { Modal } from "../lab/modal";
import { buildNav, LEGACY, STEPS, type NavExtra } from "../lab/nav";
import { Sidebar } from "../lab/Sidebar";
import { ToastProvider } from "../lab/toast";
import type { Step } from "../lab/types";
import { ChromeContext, Button, LabMark, Skeleton } from "../lab/ui";
import { useLab } from "../lab/useLab";
import { useScope } from "../lab/useScope";
import { VersionSwitch } from "../lab/VersionSwitch";
import { AgentView } from "../lab/views/AgentView";
import { CardView } from "../lab/views/CardView";
import { CardsView } from "../lab/views/CardsView";
import { CriteriaView } from "../lab/views/CriteriaView";
import { CriterionView } from "../lab/views/CriterionView";
import { DialogsView } from "../lab/views/DialogsView";
import { JudgeCheckPage } from "../lab/views/JudgeCheckPage";
import { LogsView } from "../lab/views/LogsView";
import { OverviewView } from "../lab/views/OverviewView";
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

/** The service is not answering: say what to do, and keep trying on our own. */
function Offline() {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-[420px] text-center">
        <LabMark size={32} className="mx-auto text-lab-mute" />
        <div className="mt-5 text-title font-semibold text-lab-ink">Agent Lab не отвечает</div>
        <p className="mt-2 text-reading text-lab-text">Запустите сервис командой <code className="rounded-md bg-lab-raised px-1.5 py-0.5 font-mono text-body text-lab-ink">sh bin/start.sh</code> в папке проекта. Страница подключится сама.</p>
        <div className="mt-5 inline-flex items-center gap-2 text-caption text-lab-mute"><RotateCw className="size-3.5 animate-spin [animation-duration:2.4s]" />Пробуем подключиться…</div>
      </div>
    </div>
  );
}

/** First paint, before the service answers: the shape of the overview, not a spinner. */
function Loading() {
  return (
    <div className="mx-auto w-full max-w-[1080px] px-6 pt-24">
      <Skeleton className="h-4 w-60" /><Skeleton className="mt-4 h-9 w-2/3" /><Skeleton className="mt-4 h-5 w-1/2" />
      <div className="mt-8 grid gap-4 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]"><Skeleton className="h-[300px]" /><Skeleton className="h-[300px]" /></div>
    </div>
  );
}

export function LabPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ step?: string; itemId?: string }>();
  const step: Step = STEPS.includes(params.step as Step) ? params.step as Step : "overview";
  const itemId = params.itemId ? decodeURIComponent(params.itemId) : null;
  const { state, offline, run, pickRun } = useLab();
  const [target, setTargetState] = useState(readTarget);
  const setTarget = (t: string) => { setTargetState(t); try { localStorage.setItem("lab.target", t); } catch { /* ignore */ } };
  const [newRun, setNewRun] = useState(false);
  const [palette, setPalette] = useState(false);
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.code === "KeyK") { e.preventDefault(); setPalette(o => !o); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => { setMenu(false); }, [location.pathname]);

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

  const deck = state?.cards?.cards.length ?? 0;
  const chrome = useMemo(() => ({
    context: <VersionSwitch versions={scope.sameAgent} current={finished} previous={scope.previous} onPick={pickRun} />,
    primary: (
      <Button variant="primary" icon={Play} disabled={!state || state.job.running || !deck} onClick={() => setNewRun(true)}
        title={!deck ? "Сначала соберите сценарии: шаг «Сценарии»" : state?.job.running ? "Дождитесь окончания текущей работы" : "Симулятор сыграет сценарии с агентом, судья оценит каждый диалог"}>
        <span className="hidden sm:inline">Проверить версию</span>
      </Button>
    ),
  }), [scope.sameAgent, finished, scope.previous, pickRun, state, deck]);

  const legacy = params.step ? legacyTarget(params.step, itemId, location.search) : null;
  if (legacy) return <Navigate to={legacy} replace />;

  return (
    <ToastProvider>
      <ChromeContext.Provider value={chrome}>
        <div className="flex h-full bg-lab-canvas text-lab-text">
          <Sidebar state={state} offline={offline} step={step} go={go} nav={nav} onPalette={() => setPalette(true)} className="hidden md:flex" />
          {menu && (
            <div className="fixed inset-0 z-50 flex md:hidden">
              <Sidebar state={state} offline={offline} step={step} go={go} nav={nav} onPalette={() => { setMenu(false); setPalette(true); }} className="shadow-pop" />
              <button className="flex-1 bg-black/60" aria-label="Закрыть меню" onClick={() => setMenu(false)} />
            </div>
          )}
          <CommandPalette open={palette} onClose={() => setPalette(false)} state={state} go={go} onPickRun={pickRun} onJudge={() => goJudge(finished?.id)} extra={extra} criteria={paletteCriteria} />

          <main className="relative flex min-w-0 flex-1 flex-col">
            <div className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-lab-line px-3 md:hidden">
              <button onClick={() => setMenu(true)} aria-label="Меню" className="lab-focus inline-flex size-8 items-center justify-center rounded-md text-lab-mute hover:bg-lab-raised hover:text-lab-ink"><Menu className="size-4" /></button>
              <LabMark size={18} className="text-lab-ink" /><span className="text-body font-semibold text-lab-ink">Agent Lab</span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]">
              {!offline && !state && <Loading />}
              {offline && !state && <Offline />}
              {state && step === "overview" && <OverviewView state={state} scope={scope} go={navigate} onPick={pickRun} onRun={() => setNewRun(true)} />}
              {state && step === "criteria" && (itemId
                ? <CriterionView state={state} scope={scope} criterionKey={itemId} scopeBar={null} onBack={() => go("criteria")} onTrace={openTrace} go={navigate} />
                : <CriteriaView state={state} scope={scope} scopeBar={null} onCriterion={key => go("criteria", key)} onJudge={() => goJudge(finished?.id)} go={navigate} />)}
              {state && step === "dialogs" && !itemId && <DialogsView state={state} scope={scope} scopeBar={null} onOpen={d => go("dialogs", d.origin === "sim" ? d.key : d.traceId)} />}
              {state && step === "dialogs" && itemId && !logTrace && <RunView state={state} run={scope.finished ?? run} itemId={itemId} target={target} setTarget={setTarget} onOpen={key => go("dialogs", key)} />}
              {state && logTrace && (
                <div className="flex h-full flex-col">
                  <div className="flex h-14 flex-shrink-0 items-center gap-3 border-b border-lab-line px-6">
                    <button className="lab-focus inline-flex items-center gap-1.5 rounded-md text-body text-lab-mute transition-colors duration-100 hover:text-lab-ink" onClick={() => goBack("/lab/dialogs")}>
                      <ArrowLeft className="size-4" />Диалоги
                    </button>
                    <span className="text-body text-lab-faint" aria-hidden>/</span>
                    <span className="text-body font-semibold text-lab-ink">Реальный диалог</span>
                    <span className="ml-auto text-caption text-lab-mute">Вердикт судьи — в заметке над разговором</span>
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto"><RunDetail key={logTrace} runId={logTrace} /></div>
                </div>
              )}
              {state && step === "judge" && (itemId === "check"
                ? <JudgeCheckPage state={state} scope={scope} onBack={() => go("judge")} onOpen={key => go("dialogs", key)} />
                : <TrustView state={state} run={scope.finished ?? run} onJudge={goJudge} />)}
              {state && step === "agent" && <AgentView state={state} />}
              {state && step === "logs" && <LogsView state={state} onGo={() => go("agent")} onCriteria={() => go("criteria")} />}
              {state && step === "checks" && (card ? <CardView card={card} state={state} onBack={() => go("checks")} /> : <CardsView state={state} onPick={id => go("checks", id)} />)}
            </div>
          </main>
        </div>
        {state && (
          <Modal open={newRun} onClose={() => setNewRun(false)} title="Проверить версию агента" description="Симулятор клиента сыграет сценарии с агентом, судья оценит каждый диалог. Результат сравнится с предыдущей версией.">
            <NewRun state={state} target={target} setTarget={setTarget} onStarted={() => { setNewRun(false); navigate("/lab/overview"); }} />
          </Modal>
        )}
      </ChromeContext.Provider>
    </ToastProvider>
  );
}
