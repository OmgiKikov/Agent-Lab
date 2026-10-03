import { useEffect, useRef } from "react";

export type KeyMap = Partial<Record<string, (e: KeyboardEvent) => void>>;

/** «Да» and «Нет» (V, N): a held key answers once, not on every case its auto-repeat reaches. */
const ANSWERS = new Set(["KeyV", "KeyN"]);

/**
 * Shortcuts by physical key (KeyboardEvent.code: KeyJ, ArrowLeft…), so they work in the Russian layout too.
 * Ignored while typing in a field, with ⌘/Ctrl/Alt held, and while a dialog is open.
 */
export function useKeys(map: KeyMap, enabled = true) {
  const current = useRef(map);
  current.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.repeat && ANSWERS.has(e.code)) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      const run = current.current[e.code];
      if (run) {
        e.preventDefault();
        run(e);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
