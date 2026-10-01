import { useEffect, useRef, useState } from "react";

const reduced = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * A number that counts up to its value when it first shows, and glides to a new one: the result arrives instead of
 * sitting there. Eases out over `ms`; with reduced motion it is the value at once.
 */
export function useCountUp(value: number, ms = 900) {
  const [shown, setShown] = useState(() => (reduced() ? value : 0));
  const from = useRef(reduced() ? value : 0);
  useEffect(() => {
    if (reduced()) {
      setShown(value);
      from.current = value;
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      setShown(Math.round(a + (value - a) * eased));
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      from.current = value;
    };
  }, [value, ms]);
  return shown;
}

/** False on the first frame, true from the next: lets a bar grow from nothing with a CSS transition. */
export function useArrived() {
  const [on, setOn] = useState(reduced);
  useEffect(() => {
    if (on) return;
    const raf = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(raf);
  }, [on]);
  return on;
}

/** Rows of a list come in one after another, a beat apart, never longer than the whole beat. */
export const stagger = (i: number, step = 40, cap = 480) => ({ animationDelay: `${Math.min(i * step, cap)}ms` });
export const ENTER =
  "animate-in fade-in-0 slide-in-from-bottom-1 fill-mode-both duration-500 ease-out motion-reduce:animate-none";
