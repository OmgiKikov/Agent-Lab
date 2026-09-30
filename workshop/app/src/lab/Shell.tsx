/**
 * Raindrop Workshop's own layout pieces, for the Agent Lab section: the list column of the runs page, its list item,
 * the header of a run (title, buttons, badges) and its tabs. The markup and colours are the upstream ones
 * (pages/RunsPage.tsx, components/RunList.tsx, components/RunDetail.tsx), so the Lab reads as one more Raindrop page.
 */
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { C } from "@/utils/colors";

/** The runs page's list column: a status line with one action, a search field, the items; hidden on a phone while a detail is open. */
export function ListColumn({ status, action, search, children, hiddenOnPhone }: {
  status: { ok: boolean; text: string };
  action?: { label: string; onClick: () => void; disabled?: boolean; title?: string };
  search?: { value: string; onChange: (v: string) => void; placeholder: string };
  children: ReactNode;
  hiddenOnPhone?: boolean;
}) {
  return (
    <div className={`w-full md:w-[248px] flex-shrink-0 flex-col ${hiddenOnPhone ? "hidden md:flex" : "flex"}`} style={{ borderRight: "1px solid rgba(255,255,255,0.06)" }}>
      <div className="p-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: status.ok ? C.green : C.red, opacity: status.ok ? 0.6 : 1 }} />
            <span className="text-[10px] font-mono" style={{ color: C.fg0 }}>{status.text}</span>
          </div>
          {action && (
            <button className="text-[10px] transition hover:text-white disabled:opacity-40 disabled:hover:text-inherit" style={{ color: "#5a6a72" }}
              onClick={action.onClick} disabled={action.disabled} title={action.title}>
              {action.label}
            </button>
          )}
        </div>
        {search && (
          <div className="relative mb-2">
            <input
              className="w-full px-2 py-1.5 rounded text-[11px] font-mono outline-none"
              style={{ background: "rgba(255,255,255,0.04)", color: C.fg3, border: `1px solid ${search.value ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.06)"}` }}
              placeholder={search.placeholder}
              value={search.value}
              onChange={e => search.onChange(e.target.value)}
            />
            {search.value && (
              <button className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] font-mono" style={{ color: C.fg0 }} onClick={() => search.onChange("")}>esc</button>
            )}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-auto p-2 space-y-0.5 sb">{children}</div>
    </div>
  );
}

/** RunListItem: a title and one small line under it; a pulsing dot while it is running. */
export function ListItem({ selected, onClick, title, sub, running }: { selected: boolean; onClick: () => void; title: ReactNode; sub: ReactNode; running?: boolean }) {
  return (
    <button className="w-full text-left p-2.5 rounded-lg transition-all duration-150"
      style={{
        background: selected ? "rgba(255,255,255,0.08)" : "transparent",
        border: selected ? "1px solid rgba(255,255,255,0.15)" : "1px solid transparent",
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
      onMouseLeave={e => { e.currentTarget.style.background = selected ? "rgba(255,255,255,0.08)" : "transparent"; }}
      onClick={onClick}>
      <div className="flex items-center gap-2">
        {running ? <div className="size-2 rounded-full flex-shrink-0 pulse-dot" style={{ background: C.green }} /> : <div className="size-2 flex-shrink-0" />}
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="text-sm font-medium truncate" style={{ color: C.fg4 }}>{title}</div>
          <div className="mt-0.5 truncate text-[10px]" style={{ color: C.fg0 }}>{sub}</div>
        </div>
      </div>
    </button>
  );
}

/** A button of a run's header (Заметка, Разобрать, Повторить…): small, outlined, an icon and a word. */
export function HeaderButton({ icon: Icon, children, onClick, disabled, title }: { icon: LucideIcon; children: ReactNode; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button
      className="flex items-center gap-1.5 text-[11px] px-3 py-1 rounded-md font-medium transition-colors hover:bg-white/10 disabled:pointer-events-none disabled:opacity-40"
      style={{ color: C.fg3, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)" }}
      onClick={onClick} disabled={disabled} title={title}
    >
      <Icon className="h-3 w-3" />
      <span className="max-sm:sr-only">{children}</span>
    </button>
  );
}

/** A badge of the run's meta line (МОДЕЛЬ, ДЛИТЕЛЬНОСТЬ…) with its value. */
export function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="text-[9px] font-medium uppercase tracking-wide px-1 rounded" style={{ background: "rgba(255,255,255,0.09)", color: C.fg0, lineHeight: "16px" }}>{label}</span>
      <span>{children}</span>
    </span>
  );
}

/** The run's header: a status dot, the title, the buttons on the right, the meta line under it. */
export function DetailHeader({ title, running, actions, meta, back }: { title: ReactNode; running?: boolean; actions?: ReactNode; meta?: ReactNode; back?: ReactNode }) {
  return (
    <div className="flex-shrink-0" style={{ padding: "10px 16px", borderBottom: `1px solid ${C.border}` }}>
      {back}
      <div className="flex flex-wrap items-center mb-1 justify-between gap-x-3 gap-y-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${running ? "pulse-dot" : ""}`} style={{ background: running ? C.green : "rgba(255,255,255,0.18)" }} />
          <h2 className="truncate" style={{ fontSize: "15px", fontWeight: 600, color: C.fg4 }}>{title}</h2>
        </div>
        {actions && <div className="flex items-center gap-1.5">{actions}</div>}
      </div>
      {meta && <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px]" style={{ color: C.fg1 }}>{meta}</div>}
    </div>
  );
}

/** The run's tabs (Обзор · Спаны · Диалог). */
export function TabBar<T extends string>({ tabs, active, onPick }: { tabs: { id: T; label: string }[]; active: T; onPick: (id: T) => void }) {
  return (
    <div className="flex-shrink-0 flex overflow-x-auto" style={{ borderBottom: `1px solid ${C.border}`, paddingLeft: 16 }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => onPick(t.id)}
          style={{
            padding: "8px 12px", fontSize: "12px", fontWeight: 500, cursor: "pointer", background: "none", border: "none", whiteSpace: "nowrap",
            color: active === t.id ? C.fg5 : C.fg0,
            borderBottom: active === t.id ? `2px solid ${C.fg4}` : "2px solid transparent",
          }}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
