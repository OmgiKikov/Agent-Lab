import { createBrowserRouter, Navigate, useLocation, useParams } from "react-router-dom";
import { dialogLink } from "./lab/dialogs";
import { Shell } from "./app/Shell";
import { ViolationsPage } from "./sections/violations/ViolationsPage";
import { AgentPage } from "./screens/agent/AgentPage";
import { RunsPage } from "./pages/RunsPage";
import { SearchPage } from "./pages/SearchPage";
import { SavedPage } from "./pages/SavedPage";
import { LogsPage } from "./screens/logs/LogsPage";
import { ResultsPage } from "./screens/results/ResultsPage";
import { ScenariosPage } from "./screens/scenarios/ScenariosPage";
import { SettingsPage } from "./screens/settings/SettingsPage";
import { SimulationsPage } from "./screens/simulations/SimulationsPage";

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

/** /dialogs/<key>: the dialogue at its block. */
function DialogRedirect() {
  const { dialogKey } = useParams();
  return <Navigate to={dialogLink(decodeURIComponent(dialogKey ?? ""))} replace />;
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/violations" replace /> },
      { path: "violations", element: <ViolationsPage /> },
      { path: "agent", element: <AgentPage /> },
      { path: "agent/criteria", element: <AgentPage /> },
      { path: "logs", element: <LogsPage /> },
      { path: "scenarios", element: <ScenariosPage /> },
      { path: "simulations", element: <SimulationsPage /> },
      { path: "simulations/runs/:runId", element: <To to="/simulations" from={p => ({ r: p.runId ?? "" })} /> },
      { path: "simulations/scenarios/:scenarioId", element: <To to="/scenarios" from={p => ({ s: p.scenarioId ?? "" })} /> },
      { path: "results", element: <ResultsPage /> },
      // The earlier sections: their content became tabs of the blocks.
      { path: "problems", element: <To to="/violations" /> },
      { path: "problems/:problemId", element: <To to="/violations" from={p => ({ v: p.problemId ?? "" })} /> },
      { path: "rules", element: <To to="/agent/criteria" /> },
      { path: "rules/:ruleId", element: <To to="/agent/criteria" from={p => ({ c: p.ruleId ?? "" })} /> },
      { path: "review", element: <To to="/logs?tab=review" /> },
      { path: "dialogs", element: <To to="/logs?tab=dialogs" /> },
      { path: "dialogs/:dialogKey", element: <DialogRedirect /> },
      { path: "lab", element: <Navigate to="/violations" replace /> },
      { path: "lab/dialogs/*", element: <Navigate to="/results?tab=dialogs" replace /> },
      { path: "lab/logs/*", element: <Navigate to="/logs?tab=dialogs" replace /> },
      { path: "lab/criteria/*", element: <Navigate to="/agent/criteria" replace /> },
      { path: "lab/judge/check", element: <Navigate to="/logs?tab=review" replace /> },
      { path: "lab/judge/*", element: <Navigate to="/agent/criteria" replace /> },
      { path: "lab/checks/*", element: <Navigate to="/scenarios" replace /> },
      { path: "lab/agent/*", element: <Navigate to="/agent" replace /> },
      { path: "lab/*", element: <Navigate to="/violations" replace /> },
      { path: "runs", element: <RunsPage /> },
      { path: "runs/:runId/span/:spanId", element: <RunsPage /> },
      { path: "runs/:runId/spans", element: <RunsPage /> },
      { path: "runs/:runId/convo", element: <RunsPage /> },
      { path: "runs/:runId", element: <RunsPage /> },
      { path: "search/:runId/span/:spanId", element: <SearchPage /> },
      { path: "search/:runId/spans", element: <SearchPage /> },
      { path: "search/:runId/convo", element: <SearchPage /> },
      { path: "search/:runId", element: <SearchPage /> },
      { path: "search", element: <SearchPage /> },
      { path: "saved/:runId/span/:spanId", element: <SavedPage /> },
      { path: "saved/:runId/spans", element: <SavedPage /> },
      { path: "saved/:runId/convo", element: <SavedPage /> },
      { path: "saved/:runId", element: <SavedPage /> },
      { path: "saved", element: <SavedPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "*", element: <Navigate to="/violations" replace /> },
    ],
  },
]);
