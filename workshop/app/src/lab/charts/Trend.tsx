import { useState } from "react";
import { cn } from "@/lib/utils";
import { useSize } from "./useSize";

export type TrendPoint = {
  id: string; value: number; label: string; title: string; sub?: string;
  /** The 95% interval of the value, in percent: drawn as a band, so a move inside it reads as noise. */
  low?: number; high?: number;
};

const M = { left: 44, right: 52, top: 16, bottom: 28 };
const TICKS = [0, 50, 100];

/**
 * The share from version to version. One series: past versions grey, the chosen one in the accent with its value;
 * the band around the line is the 95% interval, so the eye does not read a change inside it as a trend.
 * The crosshair snaps to a version, a click picks it. The same numbers are in a hidden table for assistive tech.
 */
export function Trend({ points, selectedId, onPick, height: fixed = 200, fill }: { points: TrendPoint[]; selectedId?: string; onPick?: (id: string) => void; height?: number; fill?: boolean }) {
  const [ref, size] = useSize<HTMLDivElement>();
  const width = size.width;
  const height = fill ? Math.max(size.height, 160) : fixed;
  const [hover, setHover] = useState<number | null>(null);
  const n = points.length;
  const innerW = Math.max(0, width - M.left - M.right);
  const innerH = height - M.top - M.bottom;
  const x = (i: number) => M.left + (n === 1 ? innerW / 2 : (i * innerW) / (n - 1));
  const y = (v: number) => M.top + innerH - (v / 100) * innerH;
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const banded = n > 1 && points.every(p => p.low !== undefined && p.high !== undefined);
  const band = banded
    ? `${points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.high!).toFixed(1)}`).join(" ")} ${[...points].reverse().map((p, k) => `L${x(n - 1 - k).toFixed(1)},${y(p.low!).toFixed(1)}`).join(" ")} Z`
    : "";
  const step = Math.ceil(n / Math.max(2, Math.floor(innerW / 56)));
  const selected = Math.max(0, points.findIndex(p => p.id === selectedId));

  const nearest = (clientX: number, box: DOMRect) => {
    let best = 0, dist = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(x(i) - (clientX - box.left));
      if (d < dist) { dist = d; best = i; }
    }
    return best;
  };

  const tip = hover !== null ? points[hover] : null;
  return (
    <div
      ref={ref} className="relative select-none" style={fill ? { height: "100%" } : { height }}
      onPointerMove={e => setHover(nearest(e.clientX, e.currentTarget.getBoundingClientRect()))}
      onPointerLeave={() => setHover(null)}
      onClick={e => { if (onPick && n) onPick(points[nearest(e.clientX, e.currentTarget.getBoundingClientRect())].id); }}
    >
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Доля диалогов без нарушений по версиям" className={cn(fill && "absolute inset-0", onPick && "cursor-pointer")}>
          {TICKS.map(t => (
            <g key={t}>
              <line x1={M.left} x2={width - M.right + 16} y1={y(t)} y2={y(t)} className="stroke-white/[0.06]" strokeWidth={1} />
              <text x={M.left - 10} y={y(t) + 4} textAnchor="end" className="fill-lab-mute text-micro tabular-nums">{t}%</text>
            </g>
          ))}
          {points.map((p, i) => (i % step === 0 || i === n - 1 || i === selected) && (
            <text key={p.id} x={x(i)} y={height - 8} textAnchor="middle" className={cn("text-micro tabular-nums", i === selected ? "fill-lab-ink font-semibold" : "fill-lab-mute")}>{p.label}</text>
          ))}
          {band && <path d={band} className="fill-white/[0.06]" />}
          {n > 1 && <path d={line} fill="none" className="stroke-lab-mute" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={y(0)} className="stroke-white/20" strokeWidth={1} />}
          {points.map((p, i) => (
            <g key={p.id} tabIndex={0} role="button" aria-label={`${p.title}: ${p.value}%`}
              onFocus={() => setHover(i)} onBlur={() => setHover(null)}
              onKeyDown={e => { if ((e.key === "Enter" || e.key === " ") && onPick) { e.preventDefault(); onPick(p.id); } }}
              className="outline-none">
              <circle cx={x(i)} cy={y(p.value)} r={i === selected ? 5 : i === hover ? 4.5 : 3.5} className={cn("stroke-lab-panel", i === selected ? "fill-lab-accent" : "fill-lab-mute")} strokeWidth={2} />
            </g>
          ))}
          {n > 0 && <text x={x(selected) + 10} y={y(points[selected].value) - 8} className="fill-lab-ink text-body font-semibold tabular-nums">{points[selected].value}%</text>}
        </svg>
      )}
      {tip && hover !== null && (
        <div
          className="pointer-events-none absolute z-20 w-[200px] rounded-lg bg-lab-raised px-3 py-2 shadow-pop"
          style={{ left: Math.min(Math.max(x(hover) - 100, 0), Math.max(0, width - 200)), top: Math.max(0, y(tip.value) - 96) }}
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-body font-semibold text-lab-ink">{tip.title}</span>
            <span className="text-body font-semibold tabular-nums text-lab-ink">{tip.value}%</span>
          </div>
          {tip.sub && <div className="mt-0.5 text-caption text-lab-mute">{tip.sub}</div>}
          {tip.low !== undefined && tip.high !== undefined && <div className="text-caption tabular-nums text-lab-mute">95%: {tip.low}–{tip.high}%</div>}
        </div>
      )}
      <table className="sr-only">
        <caption>Доля диалогов без нарушений по версиям</caption>
        <tbody>{points.map(p => <tr key={p.id}><th>{p.title}</th><td>{p.value}%</td></tr>)}</tbody>
      </table>
    </div>
  );
}
