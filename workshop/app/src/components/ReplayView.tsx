import { useCallback, useRef, useState } from "react";
import { X, Loader2, AlertCircle, RotateCcw, ArrowRight } from "lucide-react";
import { RunDetail } from "./RunDetail";
import { C } from "../utils/colors";

interface ReplayViewProps {
  originalRunId: string;
  originalName?: string;
  replayRunId: string | null;
  error?: string | null;
  isRunning?: boolean;
  isCancelled?: boolean;
  initialCompare?: boolean;
  onCancel?: () => void;
  onReplay?: () => void;
}

export function ReplayView({ originalRunId, originalName, replayRunId, error, isRunning, isCancelled, initialCompare, onCancel, onReplay }: ReplayViewProps) {
  const [showOriginal, setShowOriginal] = useState(initialCompare ?? false);
  const [leftPct, setLeftPct] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    setLeftPct(Math.min(Math.max(pct, 25), 75));
  }, []);

  const onPointerUp = useCallback(() => { dragging.current = false; }, []);

  return (
    <div ref={containerRef} className="h-full flex flex-col" onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      {/* Top bar — split into replay (left) + original (right) when comparing */}
      <div className="flex-shrink-0 flex z-10" style={{ borderBottom: `1px solid ${C.border}` }}>
        {/* Replay (left) header */}
        <div
          className="flex items-center justify-between px-3 py-1.5 min-w-0"
          style={{ background: "rgba(255,255,255,0.10)", width: showOriginal ? `${leftPct}%` : "100%" }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <RotateCcw style={{ width: 12, height: 12, color: C.fg1, flexShrink: 0 }} />
            <span className="text-[12px] truncate" style={{ color: C.fg1 }}>
              replay of{" "}
              <button
                className="font-medium hover:underline transition-colors"
                style={{ color: C.fg3 }}
                onClick={() => setShowOriginal(!showOriginal)}
              >
                {originalName ?? "run"}
              </button>
            </span>
            {!showOriginal && (
              <button
                className="flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded transition-colors hover:bg-white/10 flex-shrink-0"
                style={{ color: C.fg2, border: `1px solid rgba(255,255,255,0.15)` }}
                onClick={() => setShowOriginal(true)}
              >
                compare <ArrowRight className="size-3" />
              </button>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {isRunning && onCancel && (
              <button
                className="text-[10px] font-mono px-2 py-0.5 rounded transition-colors hover:bg-white/5"
                style={{ color: C.red }}
                onClick={onCancel}
              >
                cancel
              </button>
            )}
            {!isRunning && onReplay && (
              <button
                className="p-1 rounded transition-colors hover:bg-white/10"
                title="Replay"
                onClick={onReplay}
              >
                <RotateCcw style={{ width: 12, height: 12, color: C.fg2 }} />
              </button>
            )}
          </div>
        </div>

        {/* Original (right) header — same row, mirrors the drag handle gap below */}
        {showOriginal && (
          <>
            <div className="flex-shrink-0" style={{ width: 4 }} />
            <div
              className="flex items-center justify-between px-3 py-1.5 min-w-0"
              style={{ background: "rgba(255,255,255,0.04)", flex: 1 }}
            >
              <span className="text-[12px] truncate" style={{ color: C.fg1 }}>
                original — <span style={{ color: C.fg3 }}>{originalName ?? "run"}</span>
              </span>
              <button
                className="p-0.5 rounded transition-colors hover:bg-white/10 flex-shrink-0"
                onClick={() => setShowOriginal(false)}
              >
                <X className="size-3.5" style={{ color: C.fg1 }} />
              </button>
            </div>
          </>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 flex min-h-0">
        {/* Replay (always shown) */}
        <div className="min-w-0 overflow-auto sb" style={{ width: showOriginal ? `${leftPct}%` : "100%" }}>
          {replayRunId ? (
            <RunDetail runId={replayRunId} isReplay />
          ) : error ? (
            <div className="flex items-center justify-center h-full">
              <div className="flex flex-col items-center gap-3 max-w-xs text-center">
                <AlertCircle className="size-5" style={{ color: C.red }} />
                <span className="text-xs font-mono" style={{ color: C.fg2 }}>{error}</span>
              </div>
            </div>
          ) : isCancelled ? (
            <div className="flex items-center justify-center h-full">
              <span className="text-xs font-mono" style={{ color: C.fg1 }}>Stopped</span>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="size-5 animate-spin" style={{ color: C.fg1 }} />
                <span className="text-xs font-mono" style={{ color: C.fg1 }}>Replaying agent…</span>
              </div>
            </div>
          )}
        </div>

        {/* Drag handle + Original (only when comparing) */}
        {showOriginal && (
          <>
            <div
              className="flex-shrink-0 cursor-col-resize hover:bg-white/10 active:bg-white/10 transition-colors"
              style={{ width: 4 }}
              onPointerDown={onPointerDown}
            />
            <div className="min-w-0 overflow-auto sb" style={{ flex: 1 }}>
              <RunDetail runId={originalRunId} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
