import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, CircleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastItem = { id: number; text: string; kind: "error" | "success" };
type Toasts = { error: (e: unknown) => void; success: (text: string) => void };

const ToastContext = createContext<Toasts>({ error: () => {}, success: () => {} });
export const useToast = () => useContext(ToastContext);

let next = 1;
const LIFE_MS = 6000;

/** Results of background calls, in the corner for a few seconds instead of a blocking alert(). Hovering keeps them. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<number, number>());
  const dismiss = useCallback((id: number) => { setItems(list => list.filter(t => t.id !== id)); window.clearTimeout(timers.current.get(id)); timers.current.delete(id); }, []);
  const arm = useCallback((id: number) => { timers.current.set(id, window.setTimeout(() => dismiss(id), LIFE_MS)); }, [dismiss]);
  const push = useCallback((text: string, kind: ToastItem["kind"]) => {
    const id = next++;
    setItems(list => [...list.slice(-2), { id, text, kind }]);
    arm(id);
  }, [arm]);
  const value = useMemo(() => ({
    error: (e: unknown) => push(e instanceof Error ? e.message : String(e), "error"),
    success: (text: string) => push(text, "success"),
  }), [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-2" aria-live="polite">
        {items.map(t => (
          <div
            key={t.id} role={t.kind === "error" ? "alert" : "status"}
            onMouseEnter={() => window.clearTimeout(timers.current.get(t.id))} onMouseLeave={() => arm(t.id)}
            className="message-arrive pointer-events-auto flex items-start gap-2.5 rounded-lg border border-lab-edge bg-lab-raised px-3.5 py-3 shadow-pop"
          >
            {t.kind === "error" ? <CircleAlert className="mt-0.5 size-4 flex-shrink-0 text-lab-bad" /> : <Check className="mt-0.5 size-4 flex-shrink-0 text-lab-ok" />}
            <div className={cn("min-w-0 flex-1 text-body", t.kind === "error" ? "text-lab-ink" : "text-lab-text")}>{t.text}</div>
            <button onClick={() => dismiss(t.id)} aria-label="Закрыть" className="lab-focus rounded-sm text-lab-mute transition-colors duration-100 hover:text-lab-ink"><X className="size-3.5" /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
