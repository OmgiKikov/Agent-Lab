import { useState } from "react";
import { cn } from "@/lib/utils";
import { useSize } from "./useSize";

export type TrendPoint = { id: string; value: number; label: string; title: string; sub?: string };

const M = { left: 36, right: 52, top: 16, bottom: 30 };
const TICKS = [0, 25, 50, 75, 100];
const SURFACE = "#0a0a0a";
const ACCENT = "rgb(91,141,239)";

/**
 * Accuracy from run to run: one series, one colour, 2px line, 8px markers with a surface ring.
 * The crosshair snaps to a run, the tooltip reads value first, a click picks the run.
 * The same numbers are in a hidden table for assistive tech.
 */
export function Trend({
  points,
  selectedId,
  onPick,
  height: fixed = 236,
  fill,
}: {
  points: TrendPoint[];
  selectedId?: string;
  onPick?: (id: string) => void;
  height?: number;
  fill?: boolean;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const width = size.width;
  const height = fill ? Math.max(size.height, 200) : fixed;
  const [hover, setHover] = useState<number | null>(null);
  const n = points.length;
  const innerW = Math.max(0, width - M.left - M.right);
  const innerH = height - M.top - M.bottom;
  const x = (i: number) => M.left + (n === 1 ? innerW / 2 : (i * innerW) / (n - 1));
  const y = (v: number) => M.top + innerH - (v / 100) * innerH;
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = n > 1 ? `${line} L${x(n - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z` : "";
  const step = Math.ceil(n / Math.max(2, Math.floor(innerW / 64)));
  const selected = points.findIndex((p) => p.id === selectedId);

  const nearest = (clientX: number, box: DOMRect) => {
    let best = 0,
      dist = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(x(i) - (clientX - box.left));
      if (d < dist) {
        dist = d;
        best = i;
      }
    }
    return best;
  };

  const tip = hover !== null ? points[hover] : null;
  return (
    <div
      ref={ref}
      className="relative select-none"
      style={fill ? { height: "100%" } : { height }}
      onPointerMove={(e) => setHover(nearest(e.clientX, e.currentTarget.getBoundingClientRect()))}
      onPointerLeave={() => setHover(null)}
      onClick={(e) => {
        if (onPick) onPick(points[nearest(e.clientX, e.currentTarget.getBoundingClientRect())].id);
      }}
    >
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label="Точность по прогонам"
          className={cn(fill && "absolute inset-0", onPick && "cursor-pointer")}
        >
          {TICKS.map((t) => (
            <g key={t}>
              <line
                x1={M.left}
                x2={width - M.right + 14}
                y1={y(t)}
                y2={y(t)}
                stroke="rgba(255,255,255,0.06)"
                strokeWidth={1}
              />
              <text
                x={M.left - 10}
                y={y(t) + 3.5}
                textAnchor="end"
                fontSize={10.5}
                fill="rgb(125,138,144)"
                className="font-mono"
              >
                {t}
              </text>
            </g>
          ))}
          {points.map(
            (p, i) =>
              (i % step === 0 || i === n - 1) && (
                <text
                  key={p.id}
                  x={x(i)}
                  y={height - 8}
                  textAnchor="middle"
                  fontSize={10.5}
                  fill="rgb(125,138,144)"
                  className="font-mono"
                >
                  {p.label}
                </text>
              ),
          )}
          {area && <path d={area} fill={ACCENT} fillOpacity={0.1} />}
          {n > 1 && (
            <path d={line} fill="none" stroke={ACCENT} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          )}
          {hover !== null && (
            <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={y(0)} stroke="rgba(255,255,255,0.2)" strokeWidth={1} />
          )}
          {selected >= 0 && (
            <circle
              cx={x(selected)}
              cy={y(points[selected].value)}
              r={10}
              fill="none"
              stroke={ACCENT}
              strokeOpacity={0.35}
              strokeWidth={1.5}
            />
          )}
          {points.map((p, i) => (
            <g
              key={p.id}
              tabIndex={0}
              role="button"
              aria-label={`${p.title}: ${p.value}%`}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && onPick) {
                  e.preventDefault();
                  onPick(p.id);
                }
              }}
              className="outline-none"
            >
              <circle
                cx={x(i)}
                cy={y(p.value)}
                r={i === hover || i === selected ? 5.5 : 4}
                fill={ACCENT}
                stroke={SURFACE}
                strokeWidth={2}
              />
            </g>
          ))}
          {n > 0 && (
            <text
              x={x(n - 1) + 12}
              y={y(points[n - 1].value) + 4}
              fontSize={12.5}
              fontWeight={600}
              fill="rgb(242,245,247)"
            >
              {points[n - 1].value}%
            </text>
          )}
        </svg>
      )}
      {tip && hover !== null && (
        <div
          className="pointer-events-none absolute z-20 min-w-[140px] rounded-lg border border-white/10 bg-[#141618] px-3 py-2 shadow-2xl"
          style={{
            left: Math.min(Math.max(x(hover) - 76, 0), Math.max(0, width - 160)),
            top: Math.max(4, y(tip.value) - 98),
          }}
        >
          <div className="flex items-center gap-2">
            <span className="h-0.5 w-3 rounded-full bg-lab-accent" />
            <span className="text-[15px] font-semibold leading-none text-lab-ink">{tip.value}%</span>
          </div>
          <div className="mt-1.5 text-[11.5px] text-lab-mute">{tip.title}</div>
          {tip.sub && <div className="text-[11.5px] text-lab-dim">{tip.sub}</div>}
        </div>
      )}
      <table className="sr-only">
        <caption>Точность по прогонам</caption>
        <tbody>
          {points.map((p) => (
            <tr key={p.id}>
              <th>{p.title}</th>
              <td>{p.value}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
