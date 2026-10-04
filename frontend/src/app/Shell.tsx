import { useEffect, useMemo, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { useAgents } from "../lab/agents";
import { LabProvider } from "../lab/LabProvider";
import { AGENT } from "./agent";
import { ToastProvider } from "../ui/toast";
import { BottomNav } from "./BottomNav";
import { CommandPalette } from "./CommandPalette";
import { ShellContext, type Shell as ShellApi } from "./ShellContext";
import { Sidebar } from "./Sidebar";
import { JobNotices, TaskCard } from "./TaskCard";

function Frame() {
  const location = useLocation();
  const [palette, setPalette] = useState(false);
  const shell = useMemo<ShellApi>(() => ({ openPalette: () => setPalette(true) }), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyK") {
        e.preventDefault();
        setPalette((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // A new place starts at its top, and the keyboard and the screen reader land in it.
  useEffect(() => {
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [location.pathname]);

  return (
    <ShellContext.Provider value={shell}>
      {/* On paper the page flows from sheet to sheet: no navigation, no fixed height, nothing scrolls. */}
      <div className="flex h-[100dvh] overflow-hidden bg-canvas text-fg-2 print:block print:h-auto print:overflow-visible">
        <Sidebar />
        <a
          href="#main"
          className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:left-2 focus-visible:top-2 focus-visible:z-[80] focus-visible:rounded-control focus-visible:bg-raised focus-visible:px-3 focus-visible:py-1.5 focus-visible:text-small focus-visible:text-fg"
        >
          К содержимому
        </a>
        <main
          id="main"
          tabIndex={-1}
          className="relative flex min-w-0 flex-1 flex-col overflow-hidden pb-[calc(56px+env(safe-area-inset-bottom))] focus:outline-none lg:pb-0 print:block print:overflow-visible print:!pb-0"
        >
          <div className="min-h-0 flex-1 overflow-auto print:overflow-visible">
            <Outlet />
          </div>
          {/* A narrow window has no side navigation: the running task sits above the bottom navigation. */}
          <div className="lg:hidden print:hidden">
            <TaskCard bar />
          </div>
        </main>
      </div>
      <BottomNav />
      <JobNotices />
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </ShellContext.Provider>
  );
}

/** The agent of the address names the tab; an agent that does not exist leads to the list of agents. */
function AgentTitle() {
  const { data } = useAgents();
  useEffect(() => {
    if (!data) return;
    const agent = data.find((a) => a.id === AGENT);
    if (!agent) window.location.replace("/agents");
    else document.title = `${agent.name} · Agent Lab`;
  }, [data]);
  return null;
}

/** The frame of every screen: the navigation, the screen, the search; the service's state and the notices for all of them. */
export function Shell() {
  return (
    <LabProvider>
      <ToastProvider>
        <AgentTitle />
        <Frame />
      </ToastProvider>
    </LabProvider>
  );
}
