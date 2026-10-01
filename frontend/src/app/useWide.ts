import { useEffect, useState } from "react";

const QUERY = "(min-width: 1024px)";

/** A window wide enough for a list and its detail side by side. */
export function useWide() {
  const [wide, setWide] = useState(() => typeof window !== "undefined" && window.matchMedia(QUERY).matches);
  useEffect(() => {
    const m = window.matchMedia(QUERY);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}
