import { useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useMatch, useNavigate } from "react-router-dom";
import { MessagePane } from "../components/MessagePane";
import { useAgentUiCommands } from "../hooks/use-agent-ui-commands";
import { sendWorkshopMessage, useWorkshopConnected } from "../hooks/use-workshop-ws";
import { useProblems } from "../lab/problems";
import { CommandPalette } from "../shell/CommandPalette";
import { LabProvider, useLabState } from "../shell/LabProvider";
import { ASK_EVENT, ShellContext, type Shell as ShellApi } from "../shell/ShellContext";
import { ToastProvider } from "../ui/toast";
import { runPath } from "../utils/navigation";
import { BottomNav } from "./BottomNav";
import { Sidebar } from "./Sidebar";

/** Legacy `/#<runId>` links lead to the trace. */
function LegacyHashRedirect() {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    const hash = location.hash.replace(/^#/, "");
    if (!hash || hash.startsWith("wd-") || hash === "main") return;
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
    const t = window.setTimeout(() => setShown(true), 300);
    return () => window.clearTimeout(t);
  }, [connected]);
  if (!shown) return null;
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-canvas/80 px-6 backdrop-blur-sm">
      <div className="max-w-md rounded-sheet bg-side px-8 py-6 text-center shadow-pop">
        <div className="text-body font-semibold text-fg">Трейсы недоступны</div>
        <p className="mt-2 text-small text-fg-3">Workshop не запущен. Запустите <code className="rounded bg-well px-1.5 py-0.5 font-mono text-meta text-fg-2">sh bin/start.sh</code>.</p>
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
  const { state } = useLabState();
  const { data } = useProblems(null);
  useAgentUiCommands();
  useEffect(() => { sendWorkshopMessage({ type: "ui_view", run_id: routeRunId }); }, [routeRunId]);

  const shell = useMemo<ShellApi>(() => ({
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
  // A new place starts at its top, and the keyboard and the screen reader land in it.
  useEffect(() => { document.getElementById("main")?.focus({ preventScroll: true }); }, [location.pathname]);

  const counts = {
    violations: data?.log ? data.rules.filter(r => r.log.failed > 0).length : undefined,
    dialogs: state?.logs.total || undefined,
    criteria: data?.rules.length || undefined,
  };
  const traceRoute = /^\/(runs|search|saved)(\/|$)/.test(location.pathname);
  return (
    <ShellContext.Provider value={shell}>
      <LegacyHashRedirect />
      <div className="flex h-[100dvh] overflow-hidden bg-canvas text-fg-2">
        <Sidebar counts={counts} />
        <a href="#main" className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:left-2 focus-visible:top-2 focus-visible:z-[80] focus-visible:rounded-control focus-visible:bg-raised focus-visible:px-3 focus-visible:py-1.5 focus-visible:text-small focus-visible:text-fg">К содержимому</a>
        <main id="main" tabIndex={-1} className="relative flex min-w-0 flex-1 flex-col overflow-hidden pb-14 focus:outline-none lg:pb-0">
          <div className="min-h-0 flex-1 overflow-auto"><Outlet /></div>
          {traceRoute && <WorkshopOffline />}
        </main>
        <MessagePane activeRunId={askRunId ?? routeRunId} />
      </div>
      <BottomNav counts={counts} />
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </ShellContext.Provider>
  );
}

/** The frame of every screen: the navigation, the screen, the assistant; the service's state and the notices for all of them. */
export function Shell() {
  return (
    <LabProvider>
      <ToastProvider>
        <Frame />
      </ToastProvider>
    </LabProvider>
  );
}
