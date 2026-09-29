import { useEffect, useState } from "react";
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  useLocation,
  useMatch,
  useNavigate,
} from "react-router-dom";
import { Menu } from "lucide-react";
import { LabProvider } from "./lab/LabContext";
import { Sidebar } from "./lab/Sidebar";
import { LabMark } from "./lab/ui";
import { MessagePane } from "./components/MessagePane";
import { RunsPage } from "./pages/RunsPage";
import { LabPage } from "./pages/LabPage";
import { SearchPage } from "./pages/SearchPage";
import { SavedPage } from "./pages/SavedPage";
import { SettingsPage } from "./pages/SettingsPage";
import { sendWorkshopMessage, useWorkshopConnected } from "./hooks/use-workshop-ws";
import { useAgentUiCommands } from "./hooks/use-agent-ui-commands";
import { runPath } from "./utils/navigation";

const DISCONNECTED_NOTICE_DELAY_MS = 100;

/** Redirect legacy `/#<runId>` links to `/runs/<runId>`. */
function LegacyHashRedirect() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const hash = location.hash.replace(/^#/, "");
    if (!hash || hash.startsWith("wd-")) return;
    navigate(runPath(hash), { replace: true });
  }, [location.hash, navigate]);

  return null;
}

function AppLayout() {
  const [showDisconnectedNotice, setShowDisconnectedNotice] = useState(false);
  const [menu, setMenu] = useState(false);
  const location = useLocation();
  const runMatch = useMatch({ path: "/runs/:runId", end: false });
  // The Lab does not need the Workshop to work: only the trace pages wait for it.
  const onLab = !!useMatch({ path: "/lab", end: false });
  const activeRunId = runMatch?.params.runId
    ? decodeURIComponent(runMatch.params.runId)
    : null;
  const workshopConnected = useWorkshopConnected();
  useAgentUiCommands();

  useEffect(() => {
    if (workshopConnected) {
      setShowDisconnectedNotice(false);
      return;
    }
    const timeout = window.setTimeout(() => {
      setShowDisconnectedNotice(true);
    }, DISCONNECTED_NOTICE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [workshopConnected]);

  useEffect(() => {
    sendWorkshopMessage({ type: "ui_view", run_id: activeRunId });
  }, [activeRunId]);
  useEffect(() => { setMenu(false); }, [location.pathname]);

  const blocked = showDisconnectedNotice && !onLab;
  return (
    <LabProvider>
      <LegacyHashRedirect />
      {/* One product: the same navigation column on every page, the assistant opens from it, nothing floats over the content. */}
      <div className="flex h-svh overflow-hidden bg-lab-canvas text-lab-text">
        <Sidebar className="hidden md:flex" />
        {menu && (
          <div className="fixed inset-0 z-50 flex md:hidden">
            <Sidebar className="shadow-pop" onNavigate={() => setMenu(false)} />
            <button className="flex-1 bg-black/60" aria-label="Закрыть меню" onClick={() => setMenu(false)} />
          </div>
        )}
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-lab-line px-3 md:hidden">
            <button onClick={() => setMenu(true)} aria-label="Меню" className="lab-focus inline-flex size-8 items-center justify-center rounded-md text-lab-mute hover:bg-lab-raised hover:text-lab-ink"><Menu className="size-4" /></button>
            <LabMark size={18} className="text-lab-ink" /><span className="text-body font-semibold text-lab-ink">Agent Lab</span>
          </div>
          <div
            className={`flex min-h-0 flex-1 transition-[filter,opacity] duration-200 ${blocked ? "pointer-events-none select-none opacity-40 blur-sm" : ""}`}
            aria-hidden={blocked}
          >
            <div className="min-w-0 flex-1 overflow-auto">
              <Outlet />
            </div>
            <MessagePane activeRunId={activeRunId} hideLauncher />
          </div>
          {blocked && (
            <div className="absolute inset-0 z-40 flex items-center justify-center px-6">
              <div className="w-[460px] max-w-full rounded-xl border border-lab-edge bg-lab-raised px-8 py-7 text-center shadow-pop">
                <div className="text-title font-semibold text-lab-ink">Workshop не запущен</div>
                <p className="mt-2 text-reading text-lab-text">
                  Трейсы хранит Workshop. Запустите его вместе с Agent Lab командой <code className="rounded-md bg-lab-active px-1.5 py-0.5 font-mono text-body text-lab-ink">sh bin/start.sh</code> — страница подключится сама.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </LabProvider>
  );
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: <AppLayout />,
    children: [
      { index: true, element: <Navigate to="/lab/overview" replace /> },
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
      { path: "*", element: <Navigate to="/lab/overview" replace /> },
    ],
  },
]);
