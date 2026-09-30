import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Play } from "lucide-react";
import { CommandPalette } from "./CommandPalette";
import { Modal } from "./modal";
import { buildNav, type NavItem } from "./nav";
import { NewRun } from "./NewRun";
import { ToastProvider } from "./toast";
import type { LabRun, LabState, Step } from "./types";
import { Button, ChromeContext } from "./ui";
import { useLab } from "./useLab";
import { useScope, type Scope } from "./useScope";

type Lab = {
  state: LabState | null; offline: boolean; run: LabRun | null; pickRun: (id: string) => void;
  scope: Scope; nav: NavItem[];
  target: string; setTarget: (t: string) => void;
  /** Opens «Проверить версию» — the product's main action — from anywhere. */
  openNewRun: () => void;
  openPalette: () => void;
};

const LabContext = createContext<Lab | null>(null);

export function useLabContext(): Lab {
  const lab = useContext(LabContext);
  if (!lab) throw new Error("useLabContext outside LabProvider");
  return lab;
}

const readTarget = () => { try { return localStorage.getItem("lab.target") || "local-http"; } catch { return "local-http"; } };

/**
 * The Lab's state for the whole app: the rail shows what needs a look and the running job on every page (the trace viewer too),
 * ⌘K and «Проверить версию» work everywhere, and every result page's header carries the version.
 */
export function LabProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { state, offline, run, pickRun } = useLab();
  const scope = useScope(state, run);
  const [target, setTargetState] = useState(readTarget);
  const setTarget = useCallback((t: string) => { setTargetState(t); try { localStorage.setItem("lab.target", t); } catch { /* ignore */ } }, []);
  const [newRun, setNewRun] = useState(false);
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.code === "KeyK") { e.preventDefault(); setPalette(o => !o); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const { finished } = scope;
  const nav = useMemo(() => buildNav(state), [state]);
  const paletteCriteria = useMemo(() => scope.criteria.map(c => ({ key: c.key, title: c.title, failed: c.failed })), [scope.criteria]);
  const go = useCallback((s: Step, item?: string | null) => navigate(item ? `/lab/${s}/${encodeURIComponent(item)}` : `/lab/${s}`), [navigate]);

  const deck = state?.cards?.cards.length ?? 0;
  const openNewRun = useCallback(() => setNewRun(true), []);
  const openPalette = useCallback(() => setPalette(true), []);
  const chrome = useMemo(() => ({
    // Without scenarios there is nothing to play: the button appears with them, the setup pages lead there.
    primary: deck ? (
      <Button variant="primary" icon={Play} disabled={!state || state.job.running} onClick={openNewRun}
        title={state?.job.running ? "Дождитесь конца текущей работы" : "Симулятор сыграет сценарии с агентом, судья оценит каждый диалог"}>
        <span className="hidden sm:inline">Проверить версию</span>
      </Button>
    ) : null,
  }), [state, deck, openNewRun]);

  const value = useMemo<Lab>(() => ({ state, offline, run, pickRun, scope, nav, target, setTarget, openNewRun, openPalette }),
    [state, offline, run, pickRun, scope, nav, target, setTarget, openNewRun, openPalette]);

  return (
    <ToastProvider>
      <LabContext.Provider value={value}>
        <ChromeContext.Provider value={chrome}>
          {children}
          <CommandPalette
            open={palette} onClose={() => setPalette(false)} state={state} go={go} navigate={navigate} onPickRun={pickRun}
            onJudge={() => { if (finished) pickRun(finished.id); navigate("/lab/judge/check"); }} onNewRun={deck ? openNewRun : undefined}
            criteria={paletteCriteria}
          />
          {state && (
            <Modal open={newRun} onClose={() => setNewRun(false)} title="Проверить версию агента" description="Симулятор клиента сыграет сценарии с агентом, судья оценит каждый диалог по критериям.">
              <NewRun state={state} target={target} setTarget={setTarget} onStarted={() => { setNewRun(false); navigate("/lab/overview"); }} />
            </Modal>
          )}
        </ChromeContext.Provider>
      </LabContext.Provider>
    </ToastProvider>
  );
}
