import { useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useMatch, useNavigate } from "react-router-dom";
import { MessagePane } from "../components/MessagePane";
import { useAgentUiCommands } from "../hooks/use-agent-ui-commands";
import { sendWorkshopMessage, useWorkshopConnected } from "../hooks/use-workshop-ws";
import { useProblems } from "../lab/problems";
import { ToastProvider } from "../ui/toast";
import { runPath } from "../utils/navigation";
import { CommandPalette } from "./CommandPalette";
import { LabProvider } from "./LabProvider";
import { Rail } from "./Rail";
import { ASK_EVENT, ShellContext, type Shell } from "./ShellContext";

const OFFLINE_DELAY_MS = 100;

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

/** Over the trace screens only: they need the Workshop; everything else works without it. */
function WorkshopOffline() {
  const connected = useWorkshopConnected();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (connected) { setShown(false); return; }
    const timeout = window.setTimeout(() => setShown(true), OFFLINE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [connected]);
  if (!shown) return null;
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 px-6 backdrop-blur-sm">
      <div className="max-w-[460px] rounded-xl border border-white/10 bg-lab-surface px-8 py-6 text-center">
        <div className="text-title font-medium text-lab-ink">Трейсы недоступны</div>
        <p className="mt-2 text-small text-lab-mute">
          Workshop не запущен. Запустите <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-meta text-lab-text">sh bin/start.sh</code>.
        </p>
      </div>
    </div>
  );
}

function Frame() {
  const location = useLocation();
  const runMatch = useMatch({ path: "/runs/:runId", end: false });
  const routeRunId = runMatch?.params.runId ? decodeURIComponent(runMatch.params.runId) : null;
  const [askRunId, setAskRunId] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const { data } = useProblems(null);
  useAgentUiCommands();
  useEffect(() => { sendWorkshopMessage({ type: "ui_view", run_id: routeRunId }); }, [routeRunId]);

  const shell = useMemo<Shell>(() => ({
    openPalette: () => setPalette(true),
    openAsk: (runId?: string | null) => { setAskRunId(runId ?? null); window.dispatchEvent(new Event(ASK_EVENT)); },
  }), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.code === "KeyK") { e.preventDefault(); setPalette(o => !o); }
      if (e.code === "KeyJ") { e.preventDefault(); shell.openAsk(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shell]);

  const traceRoute = /^\/(runs|search|saved)(\/|$)/.test(location.pathname);
  return (
    <ShellContext.Provider value={shell}>
      <LegacyHashRedirect />
      <div className="flex h-screen overflow-hidden bg-lab-bg text-lab-text">
        <Rail logs={data?.rules.filter(r => r.log.failed > 0).length ?? 0} results={data?.sim ? data.rules.filter(r => r.sim.failed > 0).length : 0} />
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1 overflow-auto"><Outlet /></div>
          {traceRoute && <WorkshopOffline />}
        </main>
        <MessagePane activeRunId={askRunId ?? routeRunId} />
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </ShellContext.Provider>
  );
}

/** The frame of every page: the rail, the page, the assistant; the service's state and the notices for all of them. */
export function AppShell() {
  return (
    <LabProvider>
      <ToastProvider>
        <Frame />
      </ToastProvider>
    </LabProvider>
  );
}
