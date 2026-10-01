import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import type { LabState } from "./types";

type Lab = { state: LabState | null; offline: boolean; refresh: () => Promise<void> };

const LabContext = createContext<Lab>({ state: null, offline: false, refresh: async () => {} });
export const useLabState = () => useContext(LabContext);

/** The service's state for the whole app: polled every 1.5 s while a task runs, every 10 s otherwise, and on focus. */
export function LabProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LabState | null>(null);
  const [offline, setOffline] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setState(await api<LabState>("/api/state"));
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);
  const running = !!state?.job.running;
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const loop = async () => {
      await refresh();
      if (alive) timer = window.setTimeout(loop, running ? 1500 : 10000);
    };
    loop();
    const onFocus = () => {
      refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, running]);
  const value = useMemo(() => ({ state, offline, refresh }), [state, offline, refresh]);
  return <LabContext.Provider value={value}>{children}</LabContext.Provider>;
}
