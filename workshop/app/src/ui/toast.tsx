import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { CircleAlert, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

type Action = { label: string; run: () => void };
type Item = { id: number; text: string; tone: "error" | "info"; action?: Action };
type Toasts = { error: (e: unknown) => void; notify: (text: string, action?: Action) => void };

const ToastContext = createContext<Toasts>({ error: () => {}, notify: () => {} });
export const useToast = () => useContext(ToastContext);

let next = 1;

/** Quiet notices at the bottom right — a task finished, a call failed. They go away on their own. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const dismiss = useCallback((id: number) => setItems(list => list.filter(t => t.id !== id)), []);
  const push = useCallback((item: Omit<Item, "id">) => {
    const id = next++;
    setItems(list => [...list.slice(-2), { ...item, id }]);
    window.setTimeout(() => dismiss(id), item.tone === "error" ? 8000 : 5000);
  }, [dismiss]);
  const value = useMemo<Toasts>(() => ({
    error: e => push({ tone: "error", text: e instanceof Error ? e.message : String(e) }),
    notify: (text, action) => push({ tone: "info", text, action }),
  }), [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-2">
        {items.map(t => (
          <div key={t.id} role={t.tone === "error" ? "alert" : "status"} className={cn("message-arrive pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-lab-hover px-3.5 py-3 shadow-2xl", t.tone === "error" ? "border-lab-bad/40" : "border-white/10")}>
            {t.tone === "error" ? <CircleAlert aria-hidden className="mt-0.5 size-4 flex-shrink-0 text-lab-bad" /> : <Info aria-hidden className="mt-0.5 size-4 flex-shrink-0 text-lab-accent" />}
            <div className="min-w-0 flex-1 text-small text-lab-text">{t.text}</div>
            {t.action && (
              <button type="button" onClick={() => { t.action?.run(); dismiss(t.id); }} className="text-small font-medium text-lab-ink underline underline-offset-4">{t.action.label}</button>
            )}
            <button type="button" onClick={() => dismiss(t.id)} aria-label="Закрыть" className="text-lab-dim transition-colors hover:text-lab-text"><X aria-hidden className="size-3.5" /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
