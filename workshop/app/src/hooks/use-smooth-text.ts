import { useEffect, useRef, useState } from "react";

/**
 * Smoothly reveals text at a constant character rate, preventing bursty
 * rendering from streaming deltas. Similar to the triage agent's client.
 */
export function useSmoothText(
  text: string,
  enabled: boolean,
  charsPerFrame: number = 3,
): string {
  const [displayed, setDisplayed] = useState(text);
  const targetRef = useRef(text);
  const posRef = useRef(text.length);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    targetRef.current = text;
    if (!enabled) {
      setDisplayed(text);
      posRef.current = text.length;
      return;
    }
  }, [text, enabled]);

  useEffect(() => {
    if (!enabled) return;

    const tick = () => {
      const target = targetRef.current;
      if (posRef.current < target.length) {
        // Speed up if falling behind
        const behind = target.length - posRef.current;
        const speed = behind > 100 ? Math.ceil(behind / 10) : charsPerFrame;
        posRef.current = Math.min(posRef.current + speed, target.length);
        setDisplayed(target.slice(0, posRef.current));
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [enabled, charsPerFrame]);

  return enabled ? displayed : text;
}
