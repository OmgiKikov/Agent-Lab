import { createBrowserRouter, Navigate, useLocation, useParams } from "react-router-dom";
import { problemLink } from "./app/links";
import { dialogLink } from "./lab/dialogs";
import { Shell } from "./app/Shell";
import { OverviewPage } from "./sections/overview/OverviewPage";
import { ProblemPage } from "./sections/problems/ProblemPage";
import { LogsPage } from "./sections/logs/LogsPage";
import { CriteriaPage } from "./sections/criteria/CriteriaPage";
import { DialogsPage } from "./sections/dialogs/DialogsPage";
import { ReviewPage } from "./sections/review/ReviewPage";
import { AgentPage } from "./sections/agent/AgentPage";
import { SettingsPage } from "./sections/settings/SettingsPage";
import { RunListPage } from "./sections/simulations/RunList";
import { ScenariosPage } from "./sections/simulations/ScenariosPage";
import { SimResultPage } from "./sections/simulations/SimResultPage";
import { StartPage } from "./sections/check/StartPage";
import { CheckPage } from "./sections/check/CheckPage";
import type { ReactElement } from "react";
import { useLabState } from "./lab/LabProvider";
import { dialoguesShown, TONE_ONLY } from "./app/product";

/** An earlier address leads to its block; the query of the old address is kept, what the block needs is added. */
function To({ to, from }: { to: string; from?: (p: Record<string, string | undefined>) => Record<string, string> }) {
  const { search } = useLocation();
  const params = useParams();
  const [path, own = ""] = to.split("?");
  const next = new URLSearchParams(own);
  for (const [k, v] of new URLSearchParams(search)) if (!next.has(k)) next.set(k, v);
  for (const [k, v] of Object.entries(from?.(params) ?? {})) next.set(k, v);
  const q = next.toString();
  return <Navigate to={`${path}${q ? `?${q}` : ""}`} replace />;
}

/** An address of the time when both stages lived together: by its source (?src=, ?s=) it leads into its stage. */
function ByStage({ log, sim, traces }: { log: string; sim: string; traces?: string }) {
  const { search } = useLocation();
  const params = useParams();
  const p = new URLSearchParams(search);
  const src = p.get("src") ?? p.get("s");
  p.delete("src");
  p.delete("s");
  const fill = (to: string) => to.replace(":id", encodeURIComponent(params.id ?? ""));
  const to = src === "traces" && traces ? traces : src === "sim" ? sim : log;
  if (src !== "sim") p.delete("run");
  const q = p.toString();
  return <Navigate to={`${fill(to)}${q ? `?${q}` : ""}`} replace />;
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

/** «Нарушения» became the two stages: a chosen violation opens as its problem, the sheets open on the logs. */
function OldViolations() {
  const { search } = useLocation();
  const p = new URLSearchParams(search);
  const sim = p.get("s") === "sim";
  const run = p.get("run");
  const v = p.get("v");
  if (v) return <Navigate to={problemLink(v, sim ? "sim" : "log", run)} replace />;
  if (p.get("assess") || p.get("report"))
    return <Navigate to={`/logs?${p.get("assess") ? "assess=1" : "report=1"}`} replace />;
  return <Navigate to={sim ? `/simulations${run ? `?run=${encodeURIComponent(run)}` : ""}` : "/logs"} replace />;
}

/** /dialogs/<key>: the dialogue at its block. */
function DialogRedirect() {
  const { dialogKey } = useParams();
  return <Navigate to={dialogLink(decodeURIComponent(dialogKey ?? ""))} replace />;
}

/** A place hidden while the product shows only tone of voice (app/product.ts): its address leads to the start. */
const hidden = (element: ReactElement) => (TONE_ONLY ? <Navigate to="/start" replace /> : element);

/** «Диалоги» in tone-only mode: shown once they hold a tone-of-voice result, never the accuracy one. */
function Dialogues({ children }: { children: ReactElement }) {
  const { state } = useLabState();
  if (!TONE_ONLY) return children;
  if (!state) return null;
  return dialoguesShown(state) ? children : <Navigate to="/start" replace />;
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/start" replace /> },
      { path: "start", element: <StartPage /> },
      { path: "check", element: <CheckPage /> },
      { path: "overview", element: <OverviewPage /> },
      // Stage 1: the customers' real conversations, checked against the agent's criteria.
      {
        path: "logs",
        element: (
          <Dialogues>
            <LogsPage />
          </Dialogues>
        ),
      },
      {
        path: "logs/problems/:id",
        element: (
          <Dialogues>
            <ProblemPage stage="log" />
          </Dialogues>
        ),
      },
      {
        path: "logs/conversations",
        element: (
          <Dialogues>
            <DialogsPage stage="log" />
          </Dialogues>
        ),
      },
      {
        path: "logs/review",
        element: (
          <Dialogues>
            <ReviewPage stage="log" />
          </Dialogues>
        ),
      },
      // Stage 2: synthetic customers play business scenarios, the same criteria check them.
      { path: "simulations", element: hidden(<SimResultPage />) },
      { path: "simulations/runs", element: hidden(<RunListPage />) },
      { path: "simulations/scenarios", element: hidden(<ScenariosPage />) },
      { path: "simulations/problems/:id", element: hidden(<ProblemPage stage="sim" />) },
      { path: "simulations/conversations", element: hidden(<DialogsPage stage="sim" />) },
      { path: "simulations/review", element: hidden(<ReviewPage stage="sim" />) },
      { path: "simulations/runs/:runId", element: <To to="/simulations" from={(p) => ({ run: p.runId ?? "" })} /> },
      {
        path: "simulations/scenarios/:scenarioId",
        element: <To to="/simulations/scenarios" from={(p) => ({ s: p.scenarioId ?? "" })} />,
      },
      { path: "criteria", element: hidden(<CriteriaPage />) },
      { path: "agent", element: hidden(<AgentPage />) },
      { path: "agent/criteria", element: <To to="/criteria" /> },
      // The addresses of the time when both stages lived in one place.
      { path: "problems", element: <ByStage log="/logs" sim="/simulations" /> },
      { path: "problems/:id", element: <ByStage log="/logs/problems/:id" sim="/simulations/problems/:id" /> },
      {
        path: "dialogs",
        element: <ByStage log="/logs/conversations" sim="/simulations/conversations" traces="/overview" />,
      },
      { path: "dialogs/:dialogKey", element: <DialogRedirect /> },
      { path: "review", element: <ByStage log="/logs/review" sim="/simulations/review" /> },
      { path: "violations", element: <OldViolations /> },
      { path: "results", element: <OldResults /> },
      { path: "scenarios", element: <To to="/simulations/scenarios" /> },
      { path: "rules", element: <To to="/criteria" /> },
      { path: "rules/:ruleId", element: <To to="/criteria" from={(p) => ({ c: p.ruleId ?? "" })} /> },
      { path: "lab", element: <Navigate to="/overview" replace /> },
      { path: "lab/dialogs/*", element: <Navigate to="/simulations/conversations" replace /> },
      { path: "lab/logs/*", element: <Navigate to="/logs/conversations" replace /> },
      { path: "lab/criteria/*", element: <Navigate to="/criteria" replace /> },
      { path: "lab/judge/check", element: <Navigate to="/logs/review" replace /> },
      { path: "lab/judge/*", element: <Navigate to="/criteria" replace /> },
      { path: "lab/checks/*", element: <Navigate to="/simulations/scenarios" replace /> },
      { path: "lab/agent/*", element: <Navigate to="/agent" replace /> },
      { path: "lab/*", element: <Navigate to="/overview" replace /> },
      // Workshop's traces are no longer part of the product: their addresses lead to the overview.
      { path: "runs/*", element: <Navigate to="/overview" replace /> },
      { path: "search/*", element: <Navigate to="/overview" replace /> },
      { path: "saved/*", element: <Navigate to="/overview" replace /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "*", element: <Navigate to="/overview" replace /> },
    ],
  },
]);
