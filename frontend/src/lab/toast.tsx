import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { CircleAlert, X } from "lucide-react";

type ToastItem = { id: number; text: string };
type Toasts = { error: (e: unknown) => void };

const ToastContext = createContext<Toasts>({ error: () => {} });
export const useToast = () => useContext(ToastContext);

let next = 1;

/** Errors of background calls: shown for a few seconds instead of a blocking alert(). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);
  const error = useCallback(
    (e: unknown) => {
      const id = next++;
      setItems((list) => [...list.slice(-2), { id, text: e instanceof Error ? e.message : String(e) }]);
      window.setTimeout(() => dismiss(id), 7000);
    },
    [dismiss],
  );
  const value = useMemo(() => ({ error }), [error]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed right-4 top-4 z-[70] flex w-[360px] flex-col gap-2"
        aria-live="assertive"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role="alert"
            className="message-arrive pointer-events-auto flex items-start gap-2.5 rounded-lg border border-lab-bad/30 bg-[#150c0c] px-3.5 py-3 shadow-2xl"
          >
            <CircleAlert className="mt-px size-4 flex-shrink-0 text-lab-bad" />
            <div className="min-w-0 flex-1 text-[13px] leading-snug text-[#f6d6d6]">{t.text}</div>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Закрыть"
              className="text-lab-dim transition-colors hover:text-lab-text"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
