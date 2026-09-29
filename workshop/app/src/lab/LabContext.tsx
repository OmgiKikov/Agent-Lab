import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Play } from "lucide-react";
import { CommandPalette } from "./CommandPalette";
import { trustOf } from "./findings";
import { Modal } from "./modal";
import { buildNav, type NavExtra, type NavItem } from "./nav";
import { ToastProvider } from "./toast";
import type { LabRun, LabState, Step } from "./types";
import { Button, ChromeContext } from "./ui";
import { useLab } from "./useLab";
import { useScope, type Scope } from "./useScope";
import { VersionSwitch } from "./VersionSwitch";
import { NewRun } from "./views/RunView";

type Lab = {
  state: LabState | null; offline: boolean; run: LabRun | null; pickRun: (id: string) => void;
  scope: Scope; nav: NavItem[]; extra: NavExtra;
  target: string; setTarget: (t: string) => void;
  /** Opens «Проверить версию» — the product's one primary action — from anywhere. */
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
 * The Lab's state for the whole app: the sidebar shows its sections and the running job on every page (the trace viewer too),
 * ⌘K and «Проверить версию» work everywhere, and every page header can carry the version.
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
  const trustLevel = finished ? trustOf(finished).level : null;
  const broken = scope.criteria.filter(c => c.failed > 0).length;
  const extra = useMemo<NavExtra>(() => ({ broken: broken || undefined, dialogs: scope.dialogs.length || undefined, trustPending: !!trustLevel && trustLevel !== "ok" }), [broken, scope.dialogs.length, trustLevel]);
  const nav = useMemo(() => buildNav(state, extra), [state, extra]);
  const paletteCriteria = useMemo(() => scope.criteria.map(c => ({ key: c.key, title: c.title, failed: c.failed })), [scope.criteria]);
  const go = useCallback((s: Step, item?: string | null) => navigate(item ? `/lab/${s}/${encodeURIComponent(item)}` : `/lab/${s}`), [navigate]);

  const deck = state?.cards?.cards.length ?? 0;
  const openNewRun = useCallback(() => setNewRun(true), []);
  const openPalette = useCallback(() => setPalette(true), []);
  const chrome = useMemo(() => ({
    context: <VersionSwitch versions={scope.sameAgent} current={finished} previous={scope.previous} onPick={pickRun} />,
    primary: (
      <Button variant="primary" icon={Play} disabled={!state || state.job.running || !deck} onClick={openNewRun}
        title={!deck ? "Сначала соберите сценарии: шаг «Сценарии»" : state?.job.running ? "Дождитесь окончания текущей работы" : "Симулятор сыграет сценарии с агентом, судья оценит каждый диалог"}>
        <span className="hidden sm:inline">Проверить версию</span>
      </Button>
    ),
  }), [scope.sameAgent, finished, scope.previous, pickRun, state, deck, openNewRun]);

  const value = useMemo<Lab>(() => ({ state, offline, run, pickRun, scope, nav, extra, target, setTarget, openNewRun, openPalette }),
    [state, offline, run, pickRun, scope, nav, extra, target, setTarget, openNewRun, openPalette]);

  return (
    <ToastProvider>
      <LabContext.Provider value={value}>
        <ChromeContext.Provider value={chrome}>
          {children}
          <CommandPalette
            open={palette} onClose={() => setPalette(false)} state={state} go={go} navigate={navigate} onPickRun={pickRun}
            onJudge={() => { if (finished) pickRun(finished.id); navigate("/lab/judge/check"); }} onNewRun={deck ? openNewRun : undefined}
            extra={extra} criteria={paletteCriteria}
          />
          {state && (
            <Modal open={newRun} onClose={() => setNewRun(false)} title="Проверить версию агента" description="Симулятор клиента сыграет сценарии с агентом, судья оценит каждый диалог. Результат сравнится с предыдущей версией.">
              <NewRun state={state} target={target} setTarget={setTarget} onStarted={() => { setNewRun(false); navigate("/lab/overview"); }} />
            </Modal>
          )}
        </ChromeContext.Provider>
      </LabContext.Provider>
    </ToastProvider>
  );
}
