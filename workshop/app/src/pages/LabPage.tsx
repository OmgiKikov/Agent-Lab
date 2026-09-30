/**
 * Agent Lab inside Raindrop Workshop, as two more Raindrop sections (docs/DESIGN.md):
 * «agent lab» — the version checks, laid out as the runs page (a list, then a check with a run's header and tabs), and
 * «подготовка» — the service's preparation steps, laid out as the settings page.
 * Data and jobs live in the Agent Lab service (lab/api.py, :5901); every number on these screens is the service's.
 */
import { useCallback, useState, type ReactNode } from "react";
import { Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { Check, Play, RotateCcw, RotateCw } from "lucide-react";
import { api } from "../lab/api";
import { normRule } from "../lab/criteria";
import { whenLong } from "../lab/format";
import { JobLine } from "../lab/JobLine";
import { useLabContext } from "../lab/LabContext";
import { LEGACY, NAV_ICON, STEP_TITLE, STEPS, setupSteps } from "../lab/nav";
import { DetailHeader, HeaderButton, ListColumn, ListItem, MetaItem, TabBar } from "../lab/Shell";
import { useToast } from "../lab/toast";
import type { LabRun, Step } from "../lab/types";
import { EmbedContext, LabMark, Skeleton } from "../lab/ui";
import { ago } from "../utils/helpers";
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

/**
 * The checks section, laid out as Raindrop's runs page: the version checks on the left (the runs list), the picked check
 * on the right with a run's header (title, buttons, badges) and tabs — Обзор, Диалоги, Карта, Судья.
 */
function ChecksSection({ step, itemId, go, openDialog, goJudge }: {
  step: Step; itemId: string | null; go: (s: Step, item?: string | null) => void;
  openDialog: (key: string, replace?: boolean) => void; goJudge: (runId?: string) => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { error } = useToast();
  const { state, offline, run, pickRun, scope, openNewRun } = useLabContext();
  const [query, setQuery] = useState("");
  const [phoneList, setPhoneList] = useState(false);
  const lab = state!;
  const job = lab.job;
  const q = query.trim().toLowerCase();
  const runs = lab.runs.filter(r => !q || `${r.version} ${r.label ?? ""} ${r.targetName}`.toLowerCase().includes(q));
  const current = scope.finished;
  const onMap = new URLSearchParams(location.search).get("view") === "map";
  const tab: "overview" | "dialogs" | "map" | "judge" = step === "dialogs" ? (onMap ? "map" : "dialogs") : step === "judge" ? "judge" : "overview";
  const deck = lab.cards?.cards.length ?? 0;

  const openTab = (t: typeof tab) => (t === "map" ? navigate("/lab/dialogs?view=map") : go(t));
  const pick = (id: string) => {
    pickRun(id);
    setPhoneList(false);
    openTab(tab);
  };
  const sub = (r: LabRun) => {
    if (r.status === "running") {
      const mine = job.running && job.kind === "run" && job.progress.run === r.id;
      return mine && job.progress.total ? `идёт проверка · ${job.progress.done ?? 0} из ${job.progress.total}` : "идёт проверка";
    }
    const acc = r.metric?.accuracy;
    const status = r.status === "failed" ? "прервана · " : r.status === "stopped" ? "остановлена · " : "";
    return `${status}${acc === null || acc === undefined ? "—" : `${acc}%`} без нарушений · ${ago(new Date(r.startedAt).getTime())}`;
  };

  const list = (
    <ListColumn
      hiddenOnPhone={!phoneList}
      status={{ ok: !offline, text: offline ? "нет связи" : "на связи" }}
      action={{ label: "проверить версию", onClick: openNewRun, disabled: !deck || job.running, title: !deck ? "Сначала соберите сценарии: «подготовка» → «Сценарии»" : undefined }}
      search={{ value: query, onChange: setQuery, placeholder: "Поиск по проверкам…" }}
    >
      {runs.length === 0
        ? <div className="text-center text-xs mt-8" style={{ color: "#5a6a72" }}>{q ? "Ничего не нашлось" : "Проверок пока нет"}</div>
        : runs.map(r => (
          <ListItem key={r.id} selected={r.id === current?.id} running={r.status === "running"} onClick={() => pick(r.id)}
            title={<>Версия {r.version}{r.label ? <span style={{ color: "#7d8a90" }}> · {r.label}</span> : null}</>} sub={sub(r)} />
        ))}
    </ListColumn>
  );

  let body: ReactNode;
  if (step === "criteria" && itemId) body = <CriterionView state={lab} scope={scope} criterionKey={itemId} onBack={() => go("overview")} onTrace={key => openDialog(key)} go={navigate} />;
  else if (step === "dialogs") body = <DialogsView state={lab} scope={scope} itemId={itemId} onOpen={openDialog} />;
  else if (step === "judge" && itemId === "check") body = <JudgeCheckPage state={lab} scope={scope} onBack={() => go("judge")} onOpen={key => openDialog(key)} />;
  else if (step === "judge") body = <TrustView state={lab} run={scope.finished ?? run} onJudge={goJudge} />;
  else body = <OverviewView state={lab} scope={scope} go={navigate} onPick={pickRun} />;

  return (
    <div className="h-full flex">
      {list}
      <div className={`flex-1 min-w-0 flex-col overflow-hidden ${phoneList ? "hidden md:flex" : "flex"}`}>
        {current && (
          <>
            <DetailHeader
              back={<button className="md:hidden mb-2 text-[12px]" style={{ color: "#7d8a90" }} onClick={() => setPhoneList(true)}>← Все проверки</button>}
              title={<>Версия {current.version}</>}
              actions={
                <>
                  <HeaderButton icon={RotateCcw} disabled={job.running} title="Судья заново оценит диалоги этой проверки; агент не запускается"
                    onClick={() => api(`/api/runs/${current.id}/rejudge`, {}).catch(error)}>Переоценить</HeaderButton>
                  <HeaderButton icon={Play} disabled={!deck || job.running} title="Симулятор сыграет сценарии с агентом, судья оценит каждый диалог" onClick={openNewRun}>Проверить версию</HeaderButton>
                </>
              }
              meta={
                <>
                  <MetaItem label="агент">{current.targetName}</MetaItem>
                  {current.label && <MetaItem label="что изменили"><span className="inline-block max-w-[320px] truncate align-bottom">{current.label}</span></MetaItem>}
                  {current.metric && <MetaItem label="диалогов">{current.metric.total}</MetaItem>}
                  {current.repeats && current.repeats > 1 ? <MetaItem label="повторы">{current.repeats}</MetaItem> : null}
                  <MetaItem label="дата">{whenLong(current.startedAt)}</MetaItem>
                  {current.status === "failed" || current.status === "stopped" ? <MetaItem label="статус"><span style={{ color: "#F0AD4E" }}>{current.status === "failed" ? `прервана${current.error ? `: ${current.error}` : ""}` : "остановлена"}</span></MetaItem> : null}
                </>
              }
            />
            <TabBar tabs={[{ id: "overview", label: "Обзор" }, { id: "dialogs", label: "Диалоги" }, { id: "map", label: "Карта" }, { id: "judge", label: "Судья" }]} active={tab} onPick={openTab} />
          </>
        )}
        {job.running && job.kind === "run" && <div className="flex-shrink-0 px-4 pt-3"><JobLine state={lab} kind="run" /></div>}
        <div className="min-h-0 flex-1 overflow-auto sb">
          <EmbedContext.Provider value={true}>{body}</EmbedContext.Provider>
        </div>
      </div>
    </div>
  );
}

/** Raindrop's settings layout for the preparation: a lowercase title and the steps on the left, the step on the right. */
function SetupSection({ step, itemId, go }: { step: Step; itemId: string | null; go: (s: Step, item?: string | null) => void }) {
  const { state } = useLabContext();
  const lab = state!;
  const card = step === "checks" && itemId ? lab.cards?.cards.find(c => c.id === itemId) : undefined;
  const steps = setupSteps(lab);
  return (
    <div className="h-full flex flex-col md:flex-row">
      <div className="flex-shrink-0 px-5 pt-5 md:w-48 md:p-6 md:pr-0">
        <h1 className="text-[22px] mb-4 pl-3 md:mb-6" style={{ fontFamily: '"AlphaLyrae", "Commissioner Variable", sans-serif', color: "#e1e8ec" }}>подготовка</h1>
        <nav className="flex gap-0.5 overflow-x-auto md:flex-col">
          {steps.map((s, i) => {
            const on = step === s.id;
            const Icon = NAV_ICON[s.id];
            return (
              <button key={s.id} onClick={() => go(s.id)}
                className="flex flex-shrink-0 items-center gap-2.5 whitespace-nowrap px-3 py-2 rounded-lg text-left transition-all duration-150"
                style={{ color: on ? "#e1e8ec" : "#5a6a72", background: on ? "rgba(255,255,255,0.06)" : "transparent" }}>
                <Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ opacity: on ? 0.9 : 0.4 }} />
                <span className="text-[12px]">{i + 1}. {STEP_TITLE[s.id]}</span>
                {s.done && <Check className="ml-auto w-3 h-3" style={{ color: "#60E36D", opacity: 0.8 }} />}
              </button>
            );
          })}
        </nav>
      </div>
      <div className="min-h-0 flex-1 overflow-auto sb">
        <EmbedContext.Provider value={true}>
          {step === "agent" && <AgentView state={lab} />}
          {step === "logs" && <LogsView state={lab} onGo={() => go("agent")} onCriterion={rule => go("criteria", normRule(rule))} />}
          {step === "checks" && (card ? <CardView card={card} state={lab} onBack={() => go("checks")} /> : <CardsView state={lab} onPick={id => go("checks", id)} />)}
        </EmbedContext.Provider>
      </div>
    </div>
  );
}

export function LabPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ step?: string; itemId?: string }>();
  const step: Step = STEPS.includes(params.step as Step) ? params.step as Step : "overview";
  const itemId = params.itemId ? decodeURIComponent(params.itemId) : null;
  const { state, offline, pickRun } = useLabContext();

  const go = (s: Step, item?: string | null) => navigate(item ? `/lab/${s}/${encodeURIComponent(item)}` : `/lab/${s}`);
  const goJudge = (runId?: string) => { if (runId) pickRun(runId); navigate("/lab/judge/check"); };
  const openDialog = useCallback((key: string, replace?: boolean) => navigate(`/lab/dialogs/${encodeURIComponent(key)}`, { replace }), [navigate]);

  const legacy = params.step ? legacyTarget(params.step, itemId, location.search) : null;
  if (legacy) return <Navigate to={legacy} replace />;
  if (!params.step) return <Navigate to="/lab/overview" replace />;

  if (!state) return offline ? <Offline /> : <Loading />;
  const setup = step === "agent" || step === "logs" || step === "checks";
  return setup
    ? <SetupSection step={step} itemId={itemId} go={go} />
    : <ChecksSection step={step} itemId={itemId} go={go} openDialog={openDialog} goJudge={goJudge} />;
}
