import { useEffect, useRef, useState } from "react";

/** Size of an element, kept up to date, so SVG can be drawn in real pixels. */
export function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setSize({ width: el.clientWidth, height: el.clientHeight });
    const observer = new ResizeObserver((entries) => {
      const box = entries[0].contentRect;
      setSize({ width: Math.round(box.width), height: Math.round(box.height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}
