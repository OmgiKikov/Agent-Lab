import { createBrowserRouter, Navigate, useLocation, useParams, type RouteObject } from "react-router-dom";
import { ACCURACY, SIMULATIONS } from "./app/product";
import {
  criterionLink,
  historyLink,
  launchLink,
  problemLink,
  SECTIONS,
  stageLink,
  stageRoot,
  type Check,
} from "./app/links";
import { checkOfOld } from "./lab/checks";
import { dialogLink } from "./lab/dialogs";
import { useLabState } from "./lab/LabProvider";
import { Shell } from "./app/Shell";
import { ScreenError } from "./app/ScreenError";
import { LaunchPage } from "./sections/launches/LaunchPage";
import { LaunchReport } from "./sections/launches/LaunchReport";
import { DataPage } from "./sections/data/DataPage";
import { OverviewPage } from "./sections/overview/OverviewPage";
import { SummaryPage } from "./sections/summary/SummaryPage";
import { ResultPage } from "./sections/checks/ResultPage";
import { ProblemPage } from "./sections/problems/ProblemPage";
import { CriteriaPage } from "./sections/criteria/CriteriaPage";
import { DialogsPage } from "./sections/dialogs/DialogsPage";
import { ReviewPage } from "./sections/review/ReviewPage";
import { AgentPage } from "./sections/agent/AgentPage";
import { SettingsPage } from "./sections/settings/SettingsPage";
import { RunListPage } from "./sections/simulations/RunList";
import { ScenariosPage } from "./sections/simulations/ScenariosPage";
import { SimResultPage } from "./sections/simulations/SimResultPage";
import { HistoryPage } from "./sections/checks/History";
import { RunPage } from "./sections/checks/RunPage";
import { ServiceDown } from "./ui/EmptyState";

type From = (p: Record<string, string | undefined>) => Record<string, string>;

/** An earlier address leads to its block; the query of the old address is kept, what the block needs is added. */
function To({ to, from }: { to: string; from?: From }) {
  const { search } = useLocation();
  const params = useParams();
  const [path, own = ""] = to.split("?");
  const next = new URLSearchParams(own);
  for (const [k, v] of new URLSearchParams(search)) if (!next.has(k)) next.set(k, v);
  for (const [k, v] of Object.entries(from?.(params) ?? {})) next.set(k, v);
  const q = next.toString();
  return <Navigate to={`${path}${q ? `?${q}` : ""}`} replace />;
}

/**
 * The check an address from before the checks had their own sections means: the one with a result, tone of voice
 * when both or neither have one (lab/checks.ts, checkOfOld). It needs the service's state, so it waits for it.
 */
function useOldCheck(): { check: Check | null; wait: JSX.Element | null } {
  const { state, offline } = useLabState();
  if (!state) return { check: null, wait: offline ? <ServiceDown /> : null };
  return { check: checkOfOld(state), wait: null };
}

/** An address of the one place a result lived in («Диалоги», «Критерии»): the same page of the check it means. */
function IntoCheck({ path = "", from }: { path?: string; from?: From }) {
  const { check, wait } = useOldCheck();
  const params = useParams();
  if (!check) return wait;
  const to = `${stageRoot(check)}${path.replace(":id", encodeURIComponent(params.id ?? ""))}`;
  return <To to={to} from={from} />;
}

/**
 * «Диалоги» itself: its older tabs and problem (?tab=, ?p=) open their pages; «Проверить снова» (?assess=) the check's
 * own way of checking again — «assess=code» asked for the accuracy by the agent's code, whatever held the place.
 */
function OldLogs() {
  const { check: old, wait } = useOldCheck();
  const { search } = useLocation();
  const p = new URLSearchParams(search);
  const assess = p.get("assess");
  const check: Check | null = assess === "code" ? "code" : old;
  if (!check) return wait;
  const root = stageRoot(check);
  const tab = p.get("tab");
  const problem = p.get("p");
  for (const key of ["tab", "p", "assess"]) p.delete(key);
  const q = p.toString();
  const rest = q ? `?${q}` : "";
  if (problem) return <Navigate to={problemLink(problem, check)} replace />;
  if (tab === "dialogs") return <Navigate to={`${root}/conversations${rest}`} replace />;
  if (tab === "review") return <Navigate to={`${root}/review${rest}`} replace />;
  if (assess) return <Navigate to={launchLink(check)} replace />;
  return <Navigate to={`${root}${rest}`} replace />;
}

/** An address of the time when both stages lived together: by its source (?src=, ?s=) the simulation or a check. */
function ByStage({ path, traces }: { path: string; traces?: string }) {
  const { check, wait } = useOldCheck();
  const { search } = useLocation();
  const params = useParams();
  const p = new URLSearchParams(search);
  const src = p.get("src") ?? p.get("s");
  p.delete("src");
  p.delete("s");
  if (src === "traces" && traces) return <Navigate to={traces} replace />;
  if (src !== "sim") p.delete("run");
  if (src !== "sim" && !check) return wait;
  const root = stageRoot(src === "sim" ? "sim" : check!);
  const q = p.toString();
  return (
    <Navigate to={`${root}${path.replace(":id", encodeURIComponent(params.id ?? ""))}${q ? `?${q}` : ""}`} replace />
  );
}

/** «Результаты» of a run became the result of the simulation; its tabs became the stage's pages. */
function OldResults() {
  const { search } = useLocation();
  const p = new URLSearchParams(search);
  const tab = p.get("tab");
  p.delete("tab");
  const v = p.get("p");
  p.delete("p");
  const run = p.get("run");
  if (v) return <Navigate to={problemLink(v, "sim", run)} replace />;
  const to =
    tab === "dialogs" ? "/simulations/conversations" : tab === "review" ? "/simulations/review" : "/simulations";
  const q = p.toString();
  return <Navigate to={`${to}${q ? `?${q}` : ""}`} replace />;
}

/** «Нарушения» became the problems: a chosen one opens as its page, the sheets open in the check they belong to. */
function OldViolations() {
  const { check, wait } = useOldCheck();
  const { search } = useLocation();
  const p = new URLSearchParams(search);
  const run = p.get("run");
  const v = p.get("v");
  if (p.get("s") === "sim") return <Navigate to={v ? problemLink(v, "sim", run) : stageLink("sim", run)} replace />;
  if (!check) return wait;
  if (v) return <Navigate to={problemLink(v, check)} replace />;
  if (p.get("assess")) return <Navigate to={launchLink(check)} replace />;
  if (p.get("report")) return <Navigate to={`${stageRoot(check)}?report=1`} replace />;
  return <Navigate to={stageRoot(check)} replace />;
}

/** /dialogs/<key>: the conversation in its place — a real one in the check it means, a simulated one in its run. */
function DialogRedirect() {
  const { dialogKey } = useParams();
  const { check, wait } = useOldCheck();
  if (!check) return wait;
  return <Navigate to={dialogLink(decodeURIComponent(dialogKey ?? ""), check)} replace />;
}

/** The step-by-step check of tone of voice (/tone/check?step=): each of its steps, where it lives now. */
function OldToneCheck() {
  const step = new URLSearchParams(useLocation().search).get("step");
  const to = step === "materials" ? criterionLink("tone") : step === "criteria" ? launchLink("tone") : SECTIONS.tone;
  return <Navigate to={to} replace />;
}

/** «Начать проверку» became «Обзор»; a saved check it opened (?history=) lives in the history of tone of voice. */
function OldStart() {
  const { search } = useLocation();
  const history = new URLSearchParams(search).get("history");
  return <Navigate to={history ? historyLink("tone", history) : SECTIONS.overview} replace />;
}

/** Точность and the simulations are hidden in the first release (app/product): their addresses lead to «Обзор». */
const shown = (route: RouteObject): RouteObject =>
  (!ACCURACY && route.path?.startsWith("accuracy")) || (!SIMULATIONS && route.path?.startsWith("simulations"))
    ? { path: route.path, element: <Navigate to="/overview" replace /> }
    : route;

/** The product inside one agent; «basename» (/a/<id>) keeps every link of it inside that agent. */
export const productRouter = (basename: string) => createBrowserRouter(productRoutes, { basename });

// A page of one check and the same page of the other are one component: the key starts it afresh when the person
// moves between them, so nothing of one check stays on the other's screen.
const productRoutes = [
  {
    path: "/",
    element: <Shell />,
    errorElement: <ScreenError />,
    children: (
      [
        { index: true, element: <Navigate to="/overview" replace /> },
        { path: "launches", element: <Navigate to="/tone/history" replace /> },
        { path: "launches/:id", element: <LaunchReport /> },
        { path: "tone/launches/:id", element: <LaunchReport /> },
        { path: "accuracy/launches/:id", element: <LaunchReport /> },
        { path: "tone/launch", element: <LaunchPage key="tone" check="tone" /> },
        { path: "accuracy/launch", element: <LaunchPage key="code" check="code" /> },
        { path: "overview", element: <OverviewPage /> },
        { path: "data", element: <DataPage /> },
        { path: "data/:datasetId", element: <DataPage /> },
        // One page of the agent for someone who does not use the product: numbers, answers, the ticked problems.
        { path: "summary", element: <SummaryPage /> },
        // Tone of voice: the customers' real conversations checked against a person's rules of communication.
        { path: "tone", element: <ResultPage key="tone" check="tone" /> },
        // The step-by-step check of tone of voice became the one path: its rules step opens the rules from a document,
        // its criteria step the new check, its result the result.
        { path: "tone/check", element: <OldToneCheck /> },
        { path: "tone/conversations", element: <DialogsPage key="tone" stage="tone" /> },
        { path: "tone/review", element: <ReviewPage key="tone" stage="tone" /> },
        // The rules of the next checks open over the criteria (?rules=1); this address was their own page.
        { path: "tone/judges", element: <To to="/tone/criteria?rules=1" /> },
        { path: "tone/criteria", element: <CriteriaPage key="tone" check="tone" /> },
        { path: "tone/history", element: <HistoryPage key="tone" check="tone" /> },
        // A past check of the history on its own page, read as «Итог»; the latest one leads to «Итог».
        { path: "tone/history/:id", element: <RunPage key="tone" check="tone" /> },
        { path: "tone/problems/:id", element: <ProblemPage key="tone" stage="tone" /> },
        // Accuracy: the same conversations checked against the criteria read from the agent's code.
        { path: "accuracy", element: <ResultPage key="code" check="code" /> },
        { path: "accuracy/conversations", element: <DialogsPage key="code" stage="code" /> },
        { path: "accuracy/review", element: <ReviewPage key="code" stage="code" /> },
        { path: "accuracy/judges", element: <To to="/accuracy/criteria?rules=1" /> },
        { path: "accuracy/criteria", element: <CriteriaPage key="code" check="code" /> },
        { path: "accuracy/history", element: <HistoryPage key="code" check="code" /> },
        { path: "accuracy/history/:id", element: <RunPage key="code" check="code" /> },
        { path: "accuracy/problems/:id", element: <ProblemPage key="code" stage="code" /> },
        // The simulations: synthetic customers play scenarios built from the export; one check's criteria judge them.
        { path: "simulations", element: <SimResultPage /> },
        { path: "simulations/runs", element: <RunListPage /> },
        { path: "simulations/scenarios", element: <ScenariosPage /> },
        { path: "simulations/problems/:id", element: <ProblemPage key="sim" stage="sim" /> },
        { path: "simulations/conversations", element: <DialogsPage key="sim" stage="sim" /> },
        { path: "simulations/review", element: <ReviewPage key="sim" stage="sim" /> },
        { path: "simulations/runs/:runId", element: <To to="/simulations" from={(p) => ({ run: p.runId ?? "" })} /> },
        {
          path: "simulations/scenarios/:scenarioId",
          element: <To to="/simulations/scenarios" from={(p) => ({ s: p.scenarioId ?? "" })} />,
        },
        { path: "agent", element: <AgentPage /> },
        { path: "settings", element: <SettingsPage /> },
        // The addresses of the time when one result lived in «Диалоги» and the start chose what it was.
        { path: "start", element: <OldStart /> },
        { path: "check", element: <OldToneCheck /> },
        { path: "logs", element: <OldLogs /> },
        { path: "logs/conversations", element: <IntoCheck path="/conversations" /> },
        { path: "logs/review", element: <IntoCheck path="/review" /> },
        { path: "logs/problems/:id", element: <IntoCheck path="/problems/:id" /> },
        { path: "logs/*", element: <IntoCheck /> },
        { path: "criteria", element: <IntoCheck path="/criteria" /> },
        { path: "agent/criteria", element: <IntoCheck path="/criteria" /> },
        // The addresses of the time when both stages lived in one place.
        { path: "problems", element: <ByStage path="" /> },
        { path: "problems/:id", element: <ByStage path="/problems/:id" /> },
        { path: "dialogs", element: <ByStage path="/conversations" traces="/overview" /> },
        { path: "dialogs/:dialogKey", element: <DialogRedirect /> },
        { path: "review", element: <ByStage path="/review" /> },
        { path: "violations", element: <OldViolations /> },
        { path: "results", element: <OldResults /> },
        { path: "scenarios", element: <To to="/simulations/scenarios" /> },
        { path: "rules", element: <IntoCheck path="/criteria" /> },
        { path: "rules/:ruleId", element: <IntoCheck path="/criteria" from={(p) => ({ c: p.ruleId ?? "" })} /> },
        { path: "lab", element: <Navigate to="/overview" replace /> },
        { path: "lab/dialogs/*", element: <Navigate to="/simulations/conversations" replace /> },
        { path: "lab/logs/*", element: <IntoCheck path="/conversations" /> },
        { path: "lab/criteria/*", element: <IntoCheck path="/criteria" /> },
        { path: "lab/judge/check", element: <IntoCheck path="/review" /> },
        { path: "lab/judge/*", element: <IntoCheck path="/criteria" /> },
        { path: "lab/checks/*", element: <Navigate to="/simulations/scenarios" replace /> },
        { path: "lab/agent/*", element: <Navigate to="/agent" replace /> },
        { path: "lab/*", element: <Navigate to="/overview" replace /> },
        // Workshop's traces are no longer part of the product: their addresses lead to the overview.
        { path: "runs/*", element: <Navigate to="/overview" replace /> },
        { path: "search/*", element: <Navigate to="/overview" replace /> },
        { path: "saved/*", element: <Navigate to="/overview" replace /> },
        { path: "*", element: <Navigate to="/overview" replace /> },
      ] as RouteObject[]
    ).map(shown),
  },
];
