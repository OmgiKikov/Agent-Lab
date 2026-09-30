import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppShell } from "./shell/AppShell";
import { AgentPage } from "./screens/agent/AgentPage";
import { RunsPage } from "./pages/RunsPage";
import { LabPage } from "./pages/LabPage";
import { SearchPage } from "./pages/SearchPage";
import { SavedPage } from "./pages/SavedPage";
import { DialogsPage } from "./screens/dialogs/DialogsPage";
import { ProblemsPage } from "./screens/problems/ProblemsPage";
import { ReviewPage } from "./screens/review/ReviewPage";
import { RulesPage } from "./screens/rules/RulesPage";
import { SettingsPage } from "./screens/settings/SettingsPage";
import { SimulationsPage } from "./screens/simulations/SimulationsPage";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/problems" replace /> },
      { path: "problems", element: <ProblemsPage /> },
      { path: "problems/:problemId", element: <ProblemsPage /> },
      { path: "rules", element: <RulesPage /> },
      { path: "rules/:ruleId", element: <RulesPage /> },
      { path: "review", element: <ReviewPage /> },
      { path: "dialogs", element: <DialogsPage /> },
      { path: "dialogs/:dialogKey", element: <DialogsPage /> },
      { path: "simulations", element: <SimulationsPage /> },
      { path: "simulations/runs/:runId", element: <SimulationsPage /> },
      { path: "simulations/scenarios/:scenarioId", element: <SimulationsPage /> },
      { path: "agent", element: <AgentPage /> },
      { path: "lab/dialogs", element: <Navigate to="/dialogs?source=sim" replace /> },
      { path: "lab/dialogs/:itemId", element: <Navigate to="/dialogs?source=sim" replace /> },
      { path: "lab/logs", element: <Navigate to="/dialogs?source=log" replace /> },
      // The earlier Lab screens that «Правила» and «Проверка вердиктов» replace.
      { path: "lab/criteria", element: <Navigate to="/rules" replace /> },
      { path: "lab/criteria/:itemId", element: <Navigate to="/rules" replace /> },
      { path: "lab/judge", element: <Navigate to="/rules" replace /> },
      { path: "lab/judge/check", element: <Navigate to="/review" replace /> },
      { path: "lab", element: <LabPage /> },
      { path: "lab/:step", element: <LabPage /> },
      { path: "lab/:step/:itemId", element: <LabPage /> },
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
      { path: "*", element: <Navigate to="/problems" replace /> },
    ],
  },
]);
