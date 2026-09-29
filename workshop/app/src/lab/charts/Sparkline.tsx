import { cn } from "@/lib/utils";

/**
 * A word-sized trend (Tufte): grey line on a fixed 0–100 scale, so sparklines side by side compare; the last point is the one that matters.
 * `hue` colours the last point when its state means something (a new violation, a fix).
 */
export function Sparkline({ values, width = 64, height = 24, hue, className }: { values: number[]; width?: number; height?: number; hue?: "ok" | "bad"; className?: string }) {
  if (values.length < 2) return null;
  const pad = 3;
  const x = (i: number) => pad + (i * (width - 2 * pad)) / (values.length - 1);
  const y = (v: number) => height - pad - (v / 100) * (height - 2 * pad);
  const path = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = values.length - 1;
  return (
    <svg width={width} height={height} role="img" aria-label={`По версиям: ${values.map(v => `${v}%`).join(", ")}`} className={className}>
      <path d={path} fill="none" className="stroke-lab-mute/70" strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last)} cy={y(values[last])} r={2.5} className={cn(hue === "bad" ? "fill-lab-bad" : hue === "ok" ? "fill-lab-ok" : "fill-lab-ink")} />
    </svg>
  );
}
