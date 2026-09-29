/**
 * Building blocks of Agent Lab: one visual language for every step.
 * Colours come from the `lab-*` tokens (index.css), never from inline hex.
 */
import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { ArrowDown, ArrowUp, Check, CircleHelp, Loader2, Minus, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { DropPixelGrid } from "../components/DropPixelGrid";
import { HUE, STATUS_TEXT, personaLook, personaName, statusHue, type Hue } from "./look";
import type { Persona, Status } from "./types";

export const titleFont = { fontFamily: '"AlphaLyrae", sans-serif' };

/* ---------- surfaces ---------- */

export function Panel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-white/[0.07] bg-lab-surface", className)} {...rest} />;
}

/** A row inside a panel, separated from the previous one by a hairline. */
export function Row({ className, first, ...rest }: HTMLAttributes<HTMLDivElement> & { first?: boolean }) {
  return <div className={cn(!first && "border-t border-white/[0.06]", className)} {...rest} />;
}

export function Eyebrow({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("font-mono text-[10px] uppercase tracking-[0.09em] text-lab-dim", className)} {...rest} />;
}

export function Section({ title, hint, right, children, className }: { title: ReactNode; hint?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("mt-7", className)}>
      <div className="mb-2.5 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-[14px] font-medium text-lab-text">{title}</h2>
          {hint && <p className="mt-0.5 text-[11px] leading-snug text-lab-dim">{hint}</p>}
        </div>
        {right && <div className="flex flex-shrink-0 items-center gap-2">{right}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * A step's page: a header bar (title, one line of what it is, actions on the right),
 * then the content. The bar stays on top while a long page scrolls, so its actions are always at hand.
 */
export function Page({ title, lede, actions, wide, nav, children }: { title: string; lede?: ReactNode; actions?: ReactNode; wide?: boolean; nav?: ReactNode; children?: ReactNode }) {
  const width = wide ? "max-w-[1240px]" : "max-w-[1120px]";
  return (
    <div className="message-arrive">
      <header className="sticky top-0 z-20 border-b border-white/[0.06] bg-black/90 backdrop-blur">
        <div className={cn("mx-auto flex items-start justify-between gap-6 px-6 py-3", width)}>
          <div className="min-w-0">
            <h1 className="text-[16px] font-medium leading-tight text-lab-ink" style={titleFont}>{title}</h1>
            {lede && <p className="mt-1 max-w-[760px] text-[11px] leading-snug text-lab-dim">{lede}</p>}
          </div>
          {actions && <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-2 pt-0.5">{actions}</div>}
        </div>
        {nav && <div className={cn("mx-auto px-6", width)}>{nav}</div>}
      </header>
      <div className={cn("mx-auto px-6 pb-16 pt-1", width)}>{children}</div>
    </div>
  );
}

/* ---------- controls ---------- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  icon?: LucideIcon;
  loading?: boolean;
};

const BUTTON_VARIANT = {
  primary: "bg-lab-text text-black hover:bg-white",
  secondary: "bg-white/10 text-lab-soft hover:bg-white/20",
  ghost: "text-lab-mute hover:bg-white/10 hover:text-lab-text",
  danger: "bg-lab-bad/10 text-lab-bad hover:bg-lab-bad/20",
};

/** Compact mono button on a grey fill; the primary action is white. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon: Icon, loading, className, children, disabled, ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex flex-shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded font-mono text-[11px] font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/50 disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "px-2.5 py-1.5" : "px-3 py-2",
        BUTTON_VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-3 animate-spin" /> : Icon && <Icon className="size-3" />}
      {children}
    </button>
  );
});

export const inputClass = cn(
  "h-8 w-full rounded-md border border-white/[0.08] bg-white/[0.04] px-2.5 text-[12px] text-lab-text outline-none transition-colors",
  "placeholder:text-lab-faint hover:border-white/[0.16] focus:border-white/25 focus:ring-1 focus:ring-white/20",
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(function Input({ className, mono, ...rest }, ref) {
  return <input ref={ref} className={cn(inputClass, mono && "font-mono text-[12px]", className)} {...rest} />;
});

export function TextArea({ className, mono, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return <textarea className={cn(inputClass, "h-auto min-h-[72px] resize-y py-2", mono && "font-mono text-[12px]", className)} {...rest} />;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-lab-text">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[11px] leading-snug text-lab-dim">{hint}</span>}
    </label>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, className }: {
  value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; className?: string;
}) {
  return (
    <div role="radiogroup" className={cn("inline-flex gap-0.5 rounded-md border border-white/[0.07] bg-white/[0.04] p-0.5", className)}>
      {options.map(o => (
        <button
          key={String(o.value)} role="radio" aria-checked={o.value === value} title={o.title} onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded px-2.5 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/50",
            o.value === value ? "bg-white/[0.13] text-lab-ink shadow-sm" : "text-lab-mute hover:text-lab-text",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Underlined tabs for views of the same run. */
export function Tabs<T extends string>({ value, tabs, onChange, flush }: { value: T; tabs: { value: T; label: ReactNode }[]; onChange: (v: T) => void; flush?: boolean }) {
  return (
    <div role="tablist" className={cn("flex flex-shrink-0", flush ? "-ml-3" : "border-b border-white/[0.06] pl-4")}>
      {tabs.map(t => (
        <button
          key={t.value} role="tab" aria-selected={t.value === value} onClick={() => onChange(t.value)}
          className={cn(
            "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-white/50",
            t.value === value ? "border-lab-text text-lab-ink" : "border-transparent text-lab-dim hover:text-lab-soft",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** «МЕТКА значение»: the small label chip before each fact in a run's header. */
export function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="rounded bg-white/[0.09] px-1 text-[9px] font-medium uppercase leading-4 tracking-wide text-lab-dim">{label}</span>
      <span className="text-lab-mute">{children}</span>
    </span>
  );
}

/** A tool the agent called, shown beside its reply. */
export function ToolPill({ name }: { name: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-white/15 bg-white/[0.08] px-2.5 py-1 text-xs font-medium text-lab-text">
      <Check className="size-3 text-lab-mute" strokeWidth={2.5} />{name}
    </span>
  );
}

/** A filter chip with an optional counter. */
export function Chip({ on, onClick, children, count }: { on?: boolean; onClick?: () => void; children: ReactNode; count?: number }) {
  return (
    <button
      onClick={onClick} aria-pressed={on}
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/50",
        on ? "border-white/25 bg-white/[0.12] text-lab-ink" : "border-white/[0.08] text-lab-mute hover:border-white/[0.16] hover:text-lab-text",
      )}
    >
      {children}
      {count !== undefined && <span className={cn("font-mono text-[10px]", on ? "text-lab-soft" : "text-lab-dim")}>{count}</span>}
    </button>
  );
}

/* ---------- status ---------- */

/** `quiet`: a pass is grey, so in a long list only failures and gaps stand out. */
export function Dot({ status, pulse, quiet, className }: { status: Status | string; pulse?: boolean; quiet?: boolean; className?: string }) {
  const solid = quiet && status === "PASS" ? "bg-white/25" : HUE[statusHue(status)].solid;
  return <span className={cn("size-2 flex-shrink-0 rounded-full", solid, pulse && "pulse-dot", className)} />;
}

export function Badge({ hue = "mute", icon: Icon, children, className }: { hue?: Hue; icon?: LucideIcon; children: ReactNode; className?: string }) {
  const h = HUE[hue];
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4", h.bg, h.border, h.text, className)}>
      {Icon && <Icon className="size-3" />}
      {children}
    </span>
  );
}

const STATUS_ICON: Record<Status, LucideIcon> = { PASS: Check, FAIL: X, RUNNING: Loader2, UNMEASURED: CircleHelp, UNKNOWN: CircleHelp, NOT_APPLICABLE: Minus };

export function StatusIcon({ status, size, className }: { status: Status | string; size?: number; className?: string }) {
  const Icon = STATUS_ICON[status as Status] ?? CircleHelp;
  return <Icon className={cn(status === "RUNNING" && "animate-spin", className)} style={size ? { width: size, height: size } : undefined} strokeWidth={2.5} />;
}

export function StatusBadge({ status, children }: { status: Status | string; children?: ReactNode }) {
  const Icon = STATUS_ICON[status as Status] ?? CircleHelp;
  return <Badge hue={statusHue(status)} icon={Icon}>{children ?? STATUS_TEXT[status as Status] ?? status}</Badge>;
}

/** A round status mark: ✓ / ✗ / – / ? inside a tinted circle. */
export function StatusMark({ status, size = 20 }: { status: Status | string; size?: number }) {
  const h = HUE[statusHue(status)];
  return (
    <span className={cn("inline-flex flex-shrink-0 items-center justify-center rounded-full", h.bgStrong, h.text)} style={{ width: size, height: size }}>
      <StatusIcon status={status} size={size * 0.55} />
    </span>
  );
}

/** Part-to-whole: a status `hue`, or a plain `tone` class when the parts are not statuses. */
export function StackBar({ parts, className }: { parts: { value: number; hue?: Hue; tone?: string }[]; className?: string }) {
  const shown = parts.filter(p => p.value > 0);
  return (
    <div className={cn("flex h-1.5 gap-[2px] overflow-hidden rounded-full", className)}>
      {shown.length ? shown.map((p, i) => <div key={i} className={cn("h-full", p.tone ?? HUE[p.hue ?? "mute"].solid)} style={{ flex: p.value }} />) : <div className="h-full flex-1 bg-white/[0.07]" />}
    </div>
  );
}

export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn("h-[3px] w-full overflow-hidden bg-white/[0.06]", className)} role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full bg-lab-accent transition-[width] duration-500 ease-out" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

/** Change against something: ▲ +8 п. п. */
export function Delta({ value, unit = "п. п.", className }: { value: number; unit?: string; className?: string }) {
  if (!value) return <Badge hue="mute" className={className}>без изменений</Badge>;
  const up = value > 0;
  return <Badge hue={up ? "ok" : "bad"} icon={up ? ArrowUp : ArrowDown} className={className}>{up ? "+" : "−"}{Math.abs(value)} {unit}</Badge>;
}

/* ---------- content ---------- */

/** Placeholder of a block that is still loading. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-white/[0.05]", className)} />;
}

export function Stat({ label, value, sub, hue, className }: { label: string; value: ReactNode; sub?: ReactNode; hue?: Hue; className?: string }) {
  return (
    <Panel className={cn("px-4 py-3", className)}>
      <Eyebrow>{label}</Eyebrow>
      <div className={cn("mt-1.5 text-[22px] font-medium leading-none", hue ? HUE[hue].text : "text-lab-ink")} style={titleFont}>{value}</div>
      {sub && <div className="mt-1.5 text-[11px] text-lab-dim">{sub}</div>}
    </Panel>
  );
}

export function Quote({ who, tone, children }: { who: string; tone?: "bad" | "ok"; children: ReactNode }) {
  return (
    <div className={cn("mt-2.5 border-l-2 pl-3 text-[12px] leading-relaxed", tone === "bad" ? "border-lab-bad/70 text-[#f3cccc]" : tone === "ok" ? "border-lab-ok/60 text-lab-soft" : "border-white/[0.14] text-lab-mute")}>
      <div className="mb-0.5 font-mono text-[9.5px] uppercase tracking-[0.09em] text-lab-dim">{who}</div>
      {children}
    </div>
  );
}

/** A customer's message. */
export function Bubble({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("max-w-full rounded-2xl rounded-br-md bg-lab-user px-3.5 py-2 text-[13px] leading-snug text-lab-text", className)}>{children}</div>;
}

/** `drop` swaps the icon for Raindrop's pixel raindrop, used in the empty screens. */
export function EmptyState({ icon: Icon, drop, title, children, action, className }: { icon?: LucideIcon; drop?: boolean; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center rounded-lg border border-dashed border-white/[0.12] px-8 py-10 text-center", className)}>
      {drop && <div className="mb-4"><DropPixelGrid px={2} gap={1.5} fillRgb="142,157,166" /></div>}
      {Icon && !drop && <span className="mb-4 inline-flex size-11 items-center justify-center rounded-lg bg-white/[0.05] text-lab-mute"><Icon className="size-5" /></span>}
      <div className="text-[14px] font-medium text-lab-ink">{title}</div>
      {children && <div className="mt-1.5 max-w-[440px] text-[12px] leading-relaxed text-lab-dim">{children}</div>}
      {action && <div className="mt-5 flex items-center gap-2">{action}</div>}
    </div>
  );
}

/** Hover / focus hint without JS. */
export function Tip({ text, children, side = "top", className }: { text: ReactNode; children: ReactNode; side?: "top" | "bottom"; className?: string }) {
  return (
    <span className={cn("group/tip relative inline-flex", className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-1/2 z-40 -translate-x-1/2 whitespace-nowrap rounded-md border border-white/10 bg-[#181b1d] px-2 py-1 text-[11px] text-lab-text opacity-0 shadow-xl transition-opacity duration-100",
          "group-hover/tip:opacity-100 group-focus-within/tip:opacity-100",
          side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5",
        )}
      >
        {text}
      </span>
    </span>
  );
}

/* ---------- customer types ---------- */

export function PersonaIcon({ id, size = 24 }: { id?: string; size?: number }) {
  const { icon: Icon } = personaLook(id);
  return (
    <span className="inline-flex flex-shrink-0 items-center justify-center rounded-md bg-white/[0.07] text-lab-mute" style={{ width: size, height: size }}>
      <Icon style={{ width: size * 0.55, height: size * 0.55 }} />
    </span>
  );
}

export function PersonaTag({ personas, id }: { personas: Persona[]; id?: string }) {
  const { icon: Icon } = personaLook(id);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-white/10 bg-white/[0.06] py-0.5 pl-1.5 pr-2.5 text-[11px] text-lab-text">
      <Icon className="size-3 text-lab-mute" />{personaName(personas, id)}
    </span>
  );
}

/** A selectable customer type: glyph, name and how this customer writes. */
export function PersonaCard({ persona, on, onClick }: { persona: Persona; on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick} aria-pressed={on}
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/50",
        on ? "border-white/25 bg-white/[0.07]" : "border-white/[0.07] bg-white/[0.02] hover:border-white/[0.16] hover:bg-white/[0.04]",
      )}
    >
      <PersonaIcon id={persona.id} size={28} />
      <span className="min-w-0 flex-1">
        <span className={cn("block text-[13px] font-medium", on ? "text-lab-ink" : "text-lab-soft")}>{persona.name}</span>
        <span className="mt-0.5 block text-[11px] leading-snug text-lab-dim">{persona.note}</span>
      </span>
      <span className={cn("mt-0.5 flex size-4 flex-shrink-0 items-center justify-center rounded-full border transition-colors", on ? "border-transparent bg-lab-text" : "border-white/20")}>
        {on && <Check className="size-2.5 text-black" strokeWidth={3} />}
      </span>
    </button>
  );
}
