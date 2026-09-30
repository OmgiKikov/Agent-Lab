/**
 * Agent Lab inside Raindrop Workshop.
 *
 * The Lab answers one question first — is this version of the agent better or worse, and what breaks — then shows the evidence
 * (the criteria with the prompt line they come from, the dialogues with the judge's quote) and how far the judge can be trusted.
 * The agent, its logs and the simulator's scenarios are the preparation that feeds it (docs/DESIGN.md).
 * Data and jobs live in the Agent Lab service (lab/api.py, :5901); this page routes between the screens in ../lab.
 */
import { useCallback } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { RotateCw } from "lucide-react";
import { useLabContext } from "../lab/LabContext";
import { LEGACY, STEPS } from "../lab/nav";
import type { Step } from "../lab/types";
import { LabMark, Skeleton } from "../lab/ui";
import { AgentView } from "../lab/views/AgentView";
import { CardView } from "../lab/views/CardView";
import { CardsView } from "../lab/views/CardsView";
import { CriterionView } from "../lab/views/CriterionView";
import { DialogsView } from "../lab/views/DialogsView";
import { JudgeCheckPage } from "../lab/views/JudgeCheckPage";
import { LogsView } from "../lab/views/LogsView";
import { OverviewView } from "../lab/views/OverviewView";
import { TrustView } from "../lab/views/TrustView";

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
    <div className="lab-dots flex h-full items-center justify-center px-6">
      <div className="max-w-[420px] rounded-lg border border-lab-line bg-lab-canvas px-8 py-8 text-center">
        <LabMark size={32} className="mx-auto text-lab-mute" />
        <div className="mt-5 text-lead font-medium text-lab-ink">Agent Lab не отвечает</div>
        <p className="mt-1.5 text-body text-lab-soft">Запустите сервис командой <code className="rounded bg-white/[0.08] px-1.5 py-0.5 font-mono text-caption text-lab-ink">sh bin/start.sh</code> в папке проекта. Страница подключится сама.</p>
        <div className="mt-5 inline-flex items-center gap-2 font-mono text-micro text-lab-mute"><RotateCw className="size-3 animate-spin [animation-duration:2.4s]" />ПРОБУЕМ ПОДКЛЮЧИТЬСЯ</div>
      </div>
    </div>
  );
}

/** First paint, before the service answers: the shape of the version page, not a spinner. */
function Loading() {
  return (
    <div className="mx-auto w-full max-w-[1080px] px-8 pt-24">
      <Skeleton className="h-5 w-24" /><Skeleton className="mt-4 h-9 w-2/3" /><Skeleton className="mt-3 h-5 w-1/2" />
      <Skeleton className="mt-8 h-[104px]" /><Skeleton className="mt-10 h-[196px]" />
    </div>
  );
}

export function LabPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ step?: string; itemId?: string }>();
  const step: Step = STEPS.includes(params.step as Step) ? params.step as Step : "overview";
  const itemId = params.itemId ? decodeURIComponent(params.itemId) : null;
  const { state, offline, run, pickRun, scope } = useLabContext();

  const go = (s: Step, item?: string | null) => navigate(item ? `/lab/${s}/${encodeURIComponent(item)}` : `/lab/${s}`);
  const goJudge = (runId?: string) => { if (runId) pickRun(runId); navigate("/lab/judge/check"); };
  const openDialog = useCallback((key: string, replace?: boolean) => navigate(`/lab/dialogs/${encodeURIComponent(key)}`, { replace }), [navigate]);
  const card = step === "checks" && itemId ? state?.cards?.cards.find(c => c.id === itemId) : undefined;

  const legacy = params.step ? legacyTarget(params.step, itemId, location.search) : null;
  if (legacy) return <Navigate to={legacy} replace />;
  if (!params.step) return <Navigate to="/lab/overview" replace />;

  if (!state) return offline ? <Offline /> : <Loading />;
  return (
    <>
      {step === "overview" && <OverviewView state={state} scope={scope} go={navigate} onPick={pickRun} />}
      {step === "criteria" && (itemId
        ? <CriterionView state={state} scope={scope} criterionKey={itemId} onBack={() => go("overview")} onTrace={key => openDialog(key)} go={navigate} />
        : <Navigate to="/lab/overview" replace />)}
      {step === "dialogs" && <DialogsView state={state} scope={scope} itemId={itemId} onOpen={openDialog} />}
      {step === "judge" && (itemId === "check"
        ? <JudgeCheckPage state={state} scope={scope} onBack={() => go("judge")} onOpen={key => openDialog(key)} />
        : <TrustView state={state} run={scope.finished ?? run} onJudge={goJudge} />)}
      {step === "agent" && <AgentView state={state} />}
      {step === "logs" && <LogsView state={state} onGo={() => go("agent")} onCriteria={() => go("overview")} />}
      {step === "checks" && (card ? <CardView card={card} state={state} onBack={() => go("checks")} /> : <CardsView state={state} onPick={id => go("checks", id)} />)}
    </>
  );
}
