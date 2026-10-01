import { createBrowserRouter, Navigate, useLocation, useParams } from "react-router-dom";
import { dialogLink } from "./lab/dialogs";
import { Shell } from "./app/Shell";
import { ViolationsPage } from "./sections/violations/ViolationsPage";
import { CriteriaPage } from "./sections/criteria/CriteriaPage";
import { DialogsPage } from "./sections/dialogs/DialogsPage";
import { ReviewPage } from "./sections/review/ReviewPage";
import { AgentPage } from "./screens/agent/AgentPage";
import { RunsPage } from "./pages/RunsPage";
import { SearchPage } from "./pages/SearchPage";
import { SavedPage } from "./pages/SavedPage";
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

/** The earlier blocks «Логи» and «Результаты»: their tabs now live in «Нарушения», «Диалоги» and «Проверка вердиктов». */
function OldBlock({ sim }: { sim?: boolean }) {
  const { search } = useLocation();
  const p = new URLSearchParams(search);
  const tab = p.get("tab");
  p.delete("tab");
  const run = p.get("run");
  if (tab === "dialogs") { if (sim) p.set("src", "sim"); return <Navigate to={`/dialogs?${p}`} replace />; }
  if (tab === "review") { if (sim) p.set("src", "sim"); return <Navigate to={`/review?${p}`} replace />; }
  const next = new URLSearchParams();
  if (sim) { next.set("s", "sim"); if (run) next.set("run", run); }
  const v = p.get("p");
  if (v) next.set("v", v);
  if (p.get("assess")) next.set("assess", "1");
  const q = next.toString();
  return <Navigate to={`/violations${q ? `?${q}` : ""}`} replace />;
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
      { path: "criteria", element: <CriteriaPage /> },
      { path: "agent", element: <AgentPage /> },
      { path: "agent/criteria", element: <To to="/criteria" /> },
      { path: "logs", element: <OldBlock /> },
      { path: "dialogs", element: <DialogsPage /> },
      { path: "review", element: <ReviewPage /> },
      { path: "scenarios", element: <ScenariosPage /> },
      { path: "simulations", element: <SimulationsPage /> },
      { path: "simulations/runs/:runId", element: <To to="/simulations" from={p => ({ r: p.runId ?? "" })} /> },
      { path: "simulations/scenarios/:scenarioId", element: <To to="/scenarios" from={p => ({ s: p.scenarioId ?? "" })} /> },
      { path: "results", element: <OldBlock sim /> },
      // The earlier sections: their content became tabs of the blocks.
      { path: "problems", element: <To to="/violations" /> },
      { path: "problems/:problemId", element: <To to="/violations" from={p => ({ v: p.problemId ?? "" })} /> },
      { path: "rules", element: <To to="/criteria" /> },
      { path: "rules/:ruleId", element: <To to="/criteria" from={p => ({ c: p.ruleId ?? "" })} /> },
      { path: "dialogs/:dialogKey", element: <DialogRedirect /> },
      { path: "lab", element: <Navigate to="/violations" replace /> },
      { path: "lab/dialogs/*", element: <Navigate to="/dialogs?src=sim" replace /> },
      { path: "lab/logs/*", element: <Navigate to="/dialogs" replace /> },
      { path: "lab/criteria/*", element: <Navigate to="/criteria" replace /> },
      { path: "lab/judge/check", element: <Navigate to="/review" replace /> },
      { path: "lab/judge/*", element: <Navigate to="/criteria" replace /> },
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
