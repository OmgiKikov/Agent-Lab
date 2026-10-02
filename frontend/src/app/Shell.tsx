import { useEffect, useMemo, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { useProblems } from "../lab/problems";
import { LabProvider } from "../lab/LabProvider";
import { ToastProvider } from "../ui/toast";
import { BottomNav } from "./BottomNav";
import { CommandPalette } from "./CommandPalette";
import { ShellContext, type Shell as ShellApi } from "./ShellContext";
import { Sidebar } from "./Sidebar";
import { TONE_ONLY } from "./product";

function Frame() {
  const location = useLocation();
  const [palette, setPalette] = useState(false);
  const { data } = useProblems(null);
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

  const counts = {
    logs: data?.log ? data.rules.filter((r) => r.log.failed > 0).length : undefined,
    sims: data?.sim ? data.rules.filter((r) => r.sim.failed > 0).length : undefined,
    criteria: data?.rules.length || undefined,
  };
  return (
    <ShellContext.Provider value={shell}>
      <div className="flex h-[100dvh] overflow-hidden bg-canvas text-fg-2">
        <Sidebar counts={counts} />
        <a
          href="#main"
          className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:left-2 focus-visible:top-2 focus-visible:z-[80] focus-visible:rounded-control focus-visible:bg-raised focus-visible:px-3 focus-visible:py-1.5 focus-visible:text-small focus-visible:text-fg"
        >
          К содержимому
        </a>
        <main
          id="main"
          tabIndex={-1}
          className="relative flex min-w-0 flex-1 flex-col overflow-hidden pb-[calc(56px+env(safe-area-inset-bottom))] focus:outline-none lg:pb-0"
        >
          <div className="min-h-0 flex-1 overflow-auto">
            <Outlet />
          </div>
        </main>
      </div>
      <BottomNav counts={counts} />
      {!TONE_ONLY && <CommandPalette open={palette} onClose={() => setPalette(false)} />}
    </ShellContext.Provider>
  );
}

/** The frame of every screen: the navigation, the screen, the search; the service's state and the notices for all of them. */
export function Shell() {
  return (
    <LabProvider>
      <ToastProvider>
        <Frame />
      </ToastProvider>
    </LabProvider>
  );
}
