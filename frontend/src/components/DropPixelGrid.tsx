import { useEffect, useRef } from "react";

/**
 * Animated raindrop "dot matrix" grid — ported from dawn's triage-chat empty
 * state (apps/client/src/pages/Agent/components/AgentEmptyState.tsx). Renders
 * a pixel-art raindrop silhouette out of a fixed 40×40 grid with a slow
 * shimmer, falling rain streaks, and a gentle breathing pulse.
 *
 * The mask below was sampled from the actual Raindrop SVG path
 * (465×465 viewBox) at 40×40 resolution, so the silhouette stays in sync
 * with `RaindropLogo`. Don't hand-edit; resample if the logo changes.
 */

const DROP_S = 40;
/* prettier-ignore */
const DROP_MASK = new Uint8Array([
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,
  0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,
  0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,
  0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,1,1,1,0,0,0,0,0,0,
  0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,1,1,1,0,0,0,0,0,0,
  0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,1,1,1,0,0,0,0,0,0,
  0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,1,1,1,0,0,0,0,0,0,
  0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,1,1,1,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,1,1,1,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,1,1,1,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,1,1,1,1,1,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,0,0,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
]);

interface DropPixelGridProps {
  /** Cell size in CSS px. */
  px?: number;
  /** Gap between cells in CSS px. */
  gap?: number;
  /** Comma-separated `r,g,b` triple used to fill cells. */
  fillRgb?: string;
  className?: string;
}

export function DropPixelGrid({
  px = 3,
  gap = 2,
  fillRgb = "200,210,220",
  className,
}: DropPixelGridProps = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const cssW = DROP_S * (px + gap) - gap;
    const cssH = cssW;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    ctx.scale(dpr, dpr);

    const seeds = Array.from({ length: DROP_S * DROP_S }, (_, i) => {
      const c = i % DROP_S;
      const r = (i - c) / DROP_S;
      return {
        p1: Math.sin(c * 7.3 + r * 13.7) * 6.28,
        s1: 0.6 + Math.abs(Math.sin(c * 3.1 + r * 5.9)) * 0.8,
        p2: Math.sin(c * 11.3 + r * 4.7) * 6.28,
        s2: 0.4 + Math.abs(Math.sin(c * 9.7 + r * 2.3)) * 0.6,
        drift: Math.sin(c * 5.3 + r * 8.1) * 0.4,
      };
    });

    const NUM_STREAKS = 8;
    const streaks = Array.from({ length: NUM_STREAKS }, (_, i) => ({
      col: Math.floor(3 + ((i * 5.7 + 2.3) % 1) * (DROP_S - 6)) % DROP_S,
      speed: 0.6 + (Math.sin(i * 9.1) * 0.5 + 0.5) * 0.8,
      offset: Math.sin(i * 4.3) * DROP_S,
      len: 3 + Math.floor(Math.abs(Math.sin(i * 7.7)) * 4),
    }));

    const rainMap = new Float32Array(DROP_S * DROP_S);

    const render = () => {
      const t = performance.now() * 0.001;
      ctx.clearRect(0, 0, cssW, cssH);

      rainMap.fill(0);
      for (const s of streaks) {
        const head = ((t * s.speed * DROP_S + s.offset) % (DROP_S + s.len + 4)) - s.len;
        for (let j = 0; j < s.len; j++) {
          const row = Math.floor(head + j);
          if (row < 0 || row >= DROP_S) continue;
          const fade = (j + 1) / s.len;
          const idx = row * DROP_S + s.col;
          if (rainMap[idx] < fade * 0.45) rainMap[idx] = fade * 0.45;
        }
      }

      const breath = Math.sin(t * 0.8) * 0.06 + 0.94;

      for (let i = 0; i < DROP_S * DROP_S; i++) {
        const c = i % DROP_S;
        const r = (i - c) / DROP_S;
        const { p1, s1, p2, s2, drift } = seeds[i];
        const inShape = DROP_MASK[i] === 1;

        const noise =
          Math.sin(t * s1 + p1) * 0.4 +
          Math.sin(t * s2 + p2) * 0.3 +
          0.3;

        const rain = rainMap[i];

        let alpha: number;
        if (inShape) {
          const base = 0.25 + noise * 0.15;
          alpha = (base + rain) * breath;
          const edgeBoost = isEdge(i) ? 0.12 : 0;
          alpha = Math.min(1, alpha + edgeBoost);
        } else {
          alpha = Math.max(0, noise * 0.03 + drift * 0.015 + rain * 0.3);
        }

        if (alpha < 0.005) continue;

        ctx.fillStyle = `rgba(${fillRgb},${alpha})`;
        ctx.fillRect(c * (px + gap), r * (px + gap), px, px);
      }

      rafRef.current = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(rafRef.current);
  }, [px, gap, fillRgb]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-label="Raindrop"
    />
  );
}

function isEdge(idx: number): boolean {
  const c = idx % DROP_S;
  const r = (idx - c) / DROP_S;
  if (DROP_MASK[idx] !== 1) return false;
  for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
    const nc = c + dc;
    const nr = r + dr;
    if (nc < 0 || nc >= DROP_S || nr < 0 || nr >= DROP_S) return true;
    if (DROP_MASK[nr * DROP_S + nc] === 0) return true;
  }
  return false;
}
