import { useEffect, useRef, useState } from "react";
import { KIND_STYLES, SOURCE_GLYPH, AnnotationChip, ANNOTATION_ARRIVAL_MS, annotationSourceLabel } from "./AnnotationChip";
import type { Annotation, AnnotationKind } from "../hooks/use-annotations";
import { DeepLinkedText } from "../utils/deep-links";

const C = {
  bg: "#F8F9FA", panel: "#FFFFFF", border: "rgba(16,24,32,0.08)",
  fg: "rgba(16,24,32,0.9)", muted: "rgba(16,24,32,0.5)",
};

interface TraceAnnotationsProps {
  annotations: Annotation[];
  freshIds: Set<string>;
  onClearFresh: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
}

/**
 * Trace-level annotation cards rendered below the run header. The create
 * affordance lives in the header so this strip disappears when empty.
 */
export function TraceAnnotations({ annotations, freshIds, onClearFresh, onDelete }: TraceAnnotationsProps) {
  const traceAnnotations = annotations.filter((a) => a.span_id === null);
  if (traceAnnotations.length === 0) return null;

  return (
    <div
      style={{
        padding: "4px 16px",
        borderBottom: `1px solid ${C.border}`,
        background: C.panel,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      {traceAnnotations.map((a) => (
        <TraceAnnotationRow
          key={a.id}
          annotation={a}
          arriving={freshIds.has(a.id)}
          onArrivalEnd={() => onClearFresh(a.id)}
          onDelete={() => onDelete(a.id)}
        />
      ))}
    </div>
  );
}

function TraceAnnotationRow({
  annotation,
  arriving,
  onArrivalEnd,
  onDelete,
}: {
  annotation: Annotation;
  arriving: boolean;
  onArrivalEnd: () => void;
  onDelete: () => void;
}) {
  const style = KIND_STYLES[annotation.kind];
  const author = annotationSourceLabel(annotation.source);
  // Ref keeps the timer stable across parent re-renders that recreate the
  // `onArrivalEnd` arrow — otherwise the class never gets stripped.
  const endRef = useRef(onArrivalEnd);
  endRef.current = onArrivalEnd;

  useEffect(() => {
    if (!arriving) return;
    const handle = window.setTimeout(() => endRef.current(), ANNOTATION_ARRIVAL_MS);
    return () => window.clearTimeout(handle);
  }, [arriving]);

  return (
    <div
      className={arriving ? `annotation-arriving kind-${annotation.kind}` : undefined}
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        padding: "8px 10px",
        border: `1px solid ${style.border}`,
        borderRadius: 8,
        background: `linear-gradient(180deg, rgba(16,24,32,0.035), rgba(16,24,32,0.015)), ${style.bg}`,
        boxShadow: "0 1px 0 rgba(16,24,32,0.03) inset",
      }}
    >
      <span style={{ color: C.muted, width: 14, flex: "0 0 14px", fontSize: 11, textAlign: "center", marginTop: 1 }}>
        {SOURCE_GLYPH[annotation.source]}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
          <AnnotationChip annotation={annotation} showLabel />
          <span style={{ fontSize: 10, color: C.muted }}>{author} · {timeAgo(annotation.created_at)}</span>
        </div>
        {annotation.note && (
          <div style={{ fontSize: 12, color: C.fg, lineHeight: 1.5, whiteSpace: annotation.source === "agent-lab" ? "pre-line" : undefined }}><DeepLinkedText text={annotation.note} /></div>
        )}
      </div>
      <button
        onClick={onDelete}
        title="Удалить"
        style={{
          background: "transparent",
          border: 0,
          color: C.muted,
          fontSize: 14,
          cursor: "pointer",
          padding: "0 4px",
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  );
}

export function InlineCreateForm({
  initialKind = "note",
  onCancel,
  onSubmit,
  compact = false,
  title,
  submitLabel = "Сохранить",
  frameless = false,
}: {
  initialKind?: AnnotationKind;
  onCancel: () => void;
  onSubmit: (input: { kind: AnnotationKind; note: string }) => void | Promise<void>;
  compact?: boolean;
  title?: string;
  submitLabel?: string;
  frameless?: boolean;
}) {
  const [kind, setKind] = useState<AnnotationKind>(initialKind);
  const [note, setNote] = useState("");

  async function save() {
    await onSubmit({ kind, note: note.trim() });
  }

  return (
    <div
      style={{
        padding: compact ? "8px" : frameless ? "8px 10px 12px" : "10px",
        background: frameless ? "transparent" : "rgba(12,12,13,0.96)",
        border: frameless ? "none" : `1px solid ${C.border}`,
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        boxShadow: frameless ? "none" : "0 1px 0 rgba(16,24,32,0.04) inset",
      }}
    >
      {title && (
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.fg }}>{title}</div>
          <span style={{ fontSize: 10, color: C.muted }}>ко всему трейсу</span>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {(["issue", "good", "note"] as AnnotationKind[]).map((k) => {
          const s = KIND_STYLES[k];
          const selected = k === kind;
          return (
            <button
              key={k}
              onClick={() => setKind(k)}
              style={{
                padding: "1px 9px",
                borderRadius: 999,
                fontSize: 10,
                fontWeight: 500,
                lineHeight: "18px",
                cursor: "pointer",
                color: selected ? s.fg : C.muted,
                background: selected ? s.bg : "rgba(16,24,32,0.025)",
                border: `1px solid ${selected ? s.border : C.border}`,
              }}
            >
              <span style={{ fontWeight: 700, marginRight: 3 }}>{s.icon}</span>
              {s.label}
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: C.muted, whiteSpace: "nowrap" }}>
          <kbd style={{ background: "rgba(16,24,32,0.06)", padding: "0 4px", borderRadius: 3 }}>⌘↵</kbd> сохранить ·{" "}
          <kbd style={{ background: "rgba(16,24,32,0.06)", padding: "0 4px", borderRadius: 3 }}>esc</kbd> отмена
        </span>
      </div>
      <textarea
        autoFocus
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Что вы заметили?"
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); onCancel(); }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
        }}
        style={{
          minHeight: 48,
          padding: "7px 8px",
          border: `1px solid ${C.border}`,
          background: "rgba(0,0,0,0.45)",
          borderRadius: 6,
          color: C.fg,
          fontSize: 12,
          fontFamily: "inherit",
          resize: "vertical",
          outline: "none",
        }}
      />
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button
          onClick={onCancel}
          style={{ padding: "4px 10px", fontSize: 11, background: "transparent", border: `1px solid ${C.border}`, borderRadius: 6, color: C.muted, cursor: "pointer" }}
        >
          Отмена
        </button>
        <button
          onClick={save}
          style={{ padding: "4px 10px", fontSize: 11, background: C.fg, border: `1px solid ${C.fg}`, borderRadius: 6, color: "#000", cursor: "pointer", fontWeight: 500 }}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

export function AnnotationCreatePopover({
  anchorRef,
  onClose,
  onSubmit,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onSubmit: (input: { kind: AnnotationKind; note: string }) => void | Promise<unknown>;
}) {
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node) && !anchorRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [anchorRef, onClose]);

  return (
    <div
      ref={(el) => {
        popRef.current = el;
        if (!el || !anchorRef.current) return;
        const btn = anchorRef.current.getBoundingClientRect();
        el.style.top = `${btn.bottom + 4}px`;
        el.style.right = `${window.innerWidth - btn.right}px`;
      }}
      className="fixed z-[9999] rounded-lg p-1.5 shadow-xl"
      style={{
        background: "rgba(20,20,20,0.85)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        border: "1px solid rgba(16,24,32,0.12)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(16,24,32,0.05)",
        width: "min(360px, calc(100vw - 32px))",
      }}
    >
      <InlineCreateForm
        title="Новая заметка"
        submitLabel="Добавить заметку"
        frameless
        onCancel={onClose}
        onSubmit={async (input) => {
          await onSubmit(input);
          onClose();
        }}
      />
    </div>
  );
}

function timeAgo(ts: number): string {
  const delta = (Date.now() - ts) / 1000;
  if (delta < 60) return "только что";
  if (delta < 3600) return `${Math.round(delta / 60)}\u00a0мин назад`;
  if (delta < 86400) return `${Math.round(delta / 3600)}\u00a0ч назад`;
  return `${Math.round(delta / 86400)}\u00a0дн. назад`;
}
