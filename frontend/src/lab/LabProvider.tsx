import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./api";
import type { LabState } from "./types";

type Lab = { state: LabState | null; offline: boolean; refresh: () => Promise<void> };

const LabContext = createContext<Lab>({ state: null, offline: false, refresh: async () => {} });
export const useLabState = () => useContext(LabContext);

/**
 * The service's state for the whole app: polled every 1.5 s while a task runs, every 10 s otherwise, and on focus.
 * Several requests can be under way at once (the poll, the focus, a refresh after an action), and they may come back in
 * any order: an answer is taken only when it was asked after the one on screen, so an older state never replaces a
 * newer one.
 */
export function LabProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LabState | null>(null);
  const [offline, setOffline] = useState(false);
  const asked = useRef(0);
  const shown = useRef(0);
  const refresh = useCallback(async () => {
    const order = ++asked.current;
    try {
      const next = await api<LabState>("/api/state");
      if (order < shown.current) return;
      shown.current = order;
      setState(next);
      setOffline(false);
    } catch {
      if (order < shown.current) return;
      shown.current = order;
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
