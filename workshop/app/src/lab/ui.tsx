/**
 * Building blocks of Agent Lab: one visual language for every screen (docs/DESIGN.md).
 * Colours come from the `lab-*` tokens (index.css, tailwind.config.js), sizes from the named type scale
 * (text-caption 12, text-body 13, text-reading 14, text-lead 16, text-title 20, text-display 28, text-metric 40, text-hero 72).
 * No inline hex, no arbitrary text sizes, no mono outside identifiers and code.
 */
import { createContext, forwardRef, useContext, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { ArrowDown, ArrowUp, Check, CircleHelp, Equal, Loader2, Minus, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { HUE, STATUS_TEXT, personaLook, personaName, statusHue, type Hue } from "./look";
import type { Direction } from "./stats";
import type { Persona, Status } from "./types";

/** @deprecated The UI font is also the title font now; kept so older call sites compile. */
export const titleFont = {};

/* ---------- surfaces ---------- */

/** A raised region: a card, a list, a form. One step lighter than the canvas and a hairline. */
export function Panel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-xl border border-lab-line bg-lab-panel", className)} {...rest} />;
}
export const Card = Panel;

/** A row inside a panel, separated from the previous one by a hairline. */
export function Row({ className, first, ...rest }: HTMLAttributes<HTMLDivElement> & { first?: boolean }) {
  return <div className={cn(!first && "border-t border-lab-line", className)} {...rest} />;
}

/** A small label above a value or a group: sentence case, never uppercase mono (Cyrillic caps read badly). */
export function Eyebrow({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("text-caption font-medium text-lab-mute", className)} {...rest} />;
}
export const Label = Eyebrow;

/** A titled block of a page. `hint` is one line of state or instruction, not a description of the block. */
export function Section({ title, hint, right, children, className, id }: { title: ReactNode; hint?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section className={cn("mt-10", className)} id={id} aria-label={typeof title === "string" ? title : undefined}>
      <div className="mb-3 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lead font-semibold text-lab-ink">{title}</h2>
          {hint && <p className="mt-0.5 text-body text-lab-mute">{hint}</p>}
        </div>
        {right && <div className="flex flex-shrink-0 items-center gap-2">{right}</div>}
      </div>
      {children}
    </section>
  );
}

/* ---------- page ---------- */

/**
 * What every page header carries on the right besides its own actions: the version being looked at and the one primary action
 * of the product («Проверить версию»). Provided by LabPage, so a view only says what is its own.
 */
export const ChromeContext = createContext<{ context?: ReactNode; primary?: ReactNode }>({});

/**
 * A page: a sticky header (title, the global context, actions), then the content in a readable column.
 * `crumb` is the way back for detail pages («Критерии»), `lede` one line of the page's state — a conclusion, never a description of the page.
 * `bare` hides the global context and primary action (setup pages carry their own).
 */
export function Page({ title, count, crumb, lede, actions, wide, narrow, nav, bare, children }: {
  title: ReactNode; count?: ReactNode; crumb?: { label: string; onClick: () => void }; lede?: ReactNode; actions?: ReactNode;
  wide?: boolean; narrow?: boolean; nav?: ReactNode; bare?: boolean; children?: ReactNode;
}) {
  const chrome = useContext(ChromeContext);
  const width = narrow ? "max-w-[800px]" : wide ? "max-w-[1200px]" : "max-w-[1080px]";
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-lab-line bg-lab-canvas/85 backdrop-blur-md">
        <div className="flex h-14 items-center gap-3 px-6">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {crumb && (
              <>
                <button onClick={crumb.onClick} className="lab-focus -ml-1.5 rounded-md px-1.5 py-1 text-body text-lab-mute transition-colors duration-100 hover:text-lab-ink">{crumb.label}</button>
                <span className="text-body text-lab-faint" aria-hidden>/</span>
              </>
            )}
            <h1 className="min-w-0 truncate text-body font-semibold text-lab-ink">{title}</h1>
            {count !== undefined && count !== null && <span className="text-body tabular-nums text-lab-mute">{count}</span>}
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            {actions}
            {!bare && chrome.context}
            {!bare && chrome.primary}
          </div>
        </div>
        {nav && <div className="px-6">{nav}</div>}
      </header>
      <div className={cn("mx-auto w-full flex-1 px-6 pb-20", width)}>
        {lede && <p className="mt-6 max-w-[720px] text-pretty text-reading text-lab-text">{lede}</p>}
        {children}
      </div>
    </div>
  );
}

/* ---------- controls ---------- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "accent";
  size?: "sm" | "md" | "lg";
  icon?: LucideIcon;
  loading?: boolean;
  /** A keyboard shortcut shown inside the button, e.g. "1". */
  kbd?: string;
};

const BUTTON_VARIANT = {
  primary: "bg-lab-ink text-lab-canvas hover:bg-white",
  accent: "bg-lab-accent-solid text-white hover:bg-lab-accent-solid/90",
  secondary: "border border-lab-edge bg-lab-raised text-lab-ink hover:border-lab-strong hover:bg-lab-active",
  ghost: "text-lab-mute hover:bg-lab-raised hover:text-lab-ink",
  danger: "bg-lab-bad/10 text-lab-bad hover:bg-lab-bad/20",
};

const BUTTON_SIZE = { sm: "h-7 gap-1.5 px-2.5 text-caption", md: "h-8 gap-1.5 px-3 text-body", lg: "h-10 gap-2 px-4 text-reading" };

/** Sans, sentence case, verb first. One primary per region; the primary is light, colour is kept for meaning. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon: Icon, loading, kbd, className, children, disabled, ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "lab-focus inline-flex flex-shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md font-medium",
        "transition-[background-color,border-color,color,transform] duration-100 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40",
        BUTTON_SIZE[size], BUTTON_VARIANT[variant], className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : Icon && <Icon className={size === "lg" ? "size-4" : "size-3.5"} />}
      {children}
      {kbd && <kbd className={cn("ml-0.5 font-sans text-caption", variant === "primary" ? "text-lab-canvas/50" : "text-lab-faint")}>{kbd}</kbd>}
    </button>
  );
});

/** An icon-only button. `label` is required: it is the tooltip and what a screen reader says. */
export function IconButton({ icon: Icon, label, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return (
    <button aria-label={label} title={label} className={cn("lab-focus inline-flex size-8 flex-shrink-0 items-center justify-center rounded-md text-lab-mute transition-colors duration-100 hover:bg-lab-raised hover:text-lab-ink disabled:opacity-40", className)} {...rest}>
      <Icon className="size-4" />
    </button>
  );
}

/** A text action inside a sentence or a card: «Все критерии →». */
export function LinkButton({ className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={cn("lab-focus inline-flex items-center gap-1 rounded-sm text-body font-medium text-lab-accent transition-colors duration-100 hover:text-lab-ink", className)} {...rest}>{children}</button>;
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded border border-lab-edge bg-lab-raised px-1 font-sans text-micro font-medium text-lab-mute", className)}>{children}</kbd>;
}

export const inputClass = cn(
  "h-8 w-full rounded-md border border-lab-edge bg-lab-canvas px-2.5 text-body text-lab-ink outline-none transition-colors duration-100",
  "placeholder:text-lab-faint hover:border-lab-strong focus:border-lab-accent/60 focus:ring-2 focus:ring-lab-accent/20",
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(function Input({ className, mono, ...rest }, ref) {
  return <input ref={ref} className={cn(inputClass, mono && "font-mono text-caption", className)} {...rest} />;
});

export function TextArea({ className, mono, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return <textarea className={cn(inputClass, "h-auto min-h-[72px] resize-y py-2", mono && "font-mono text-caption", className)} {...rest} />;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-body font-medium text-lab-ink">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-caption text-lab-mute">{hint}</span>}
    </label>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, className }: {
  value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; className?: string;
}) {
  return (
    <div role="radiogroup" className={cn("inline-flex gap-0.5 rounded-lg border border-lab-line bg-lab-panel p-0.5", className)}>
      {options.map(o => (
        <button
          key={String(o.value)} role="radio" aria-checked={o.value === value} title={o.title} onClick={() => onChange(o.value)}
          className={cn(
            "lab-focus inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-body transition-colors duration-100",
            o.value === value ? "bg-lab-active text-lab-ink shadow-card" : "text-lab-mute hover:text-lab-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Underlined tabs. */
export function Tabs<T extends string>({ value, tabs, onChange, flush }: { value: T; tabs: { value: T; label: ReactNode }[]; onChange: (v: T) => void; flush?: boolean }) {
  return (
    <div role="tablist" className={cn("flex flex-shrink-0 gap-1", flush ? "-ml-2" : "border-b border-lab-line px-4")}>
      {tabs.map(t => (
        <button
          key={t.value} role="tab" aria-selected={t.value === value} onClick={() => onChange(t.value)}
          className={cn(
            "lab-focus-inset -mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-2 text-body font-medium transition-colors duration-100",
            t.value === value ? "border-lab-ink text-lab-ink" : "border-transparent text-lab-mute hover:text-lab-ink",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** «label value», for facts in a header. */
export function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap text-body">
      <span className="text-lab-mute">{label}</span>
      <span className="tabular-nums text-lab-text">{children}</span>
    </span>
  );
}

/** A tool the agent called in a conversation. */
export function ToolPill({ name }: { name: string }) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-md border border-lab-edge bg-lab-raised px-2 text-caption font-medium text-lab-text">
      <Check className="size-3 text-lab-mute" strokeWidth={2.5} />{name}
    </span>
  );
}

/** A filter chip with an optional counter. */
export function Chip({ on, onClick, children, count, hue }: { on?: boolean; onClick?: () => void; children: ReactNode; count?: number; hue?: Hue }) {
  return (
    <button
      onClick={onClick} aria-pressed={on}
      className={cn(
        "lab-focus inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-body transition-colors duration-100",
        on ? "border-lab-strong bg-lab-active text-lab-ink" : "border-lab-edge text-lab-mute hover:border-lab-strong hover:text-lab-ink",
      )}
    >
      {hue && <span className={cn("size-1.5 rounded-full", HUE[hue].solid)} />}
      {children}
      {count !== undefined && <span className={cn("tabular-nums", on ? "text-lab-text" : "text-lab-faint")}>{count}</span>}
    </button>
  );
}

/* ---------- status ---------- */

/** `quiet`: a pass is grey, so in a long list only failures and gaps stand out. */
export function Dot({ status, pulse, quiet, className }: { status: Status | string; pulse?: boolean; quiet?: boolean; className?: string }) {
  const solid = quiet && status === "PASS" ? "bg-lab-faint" : HUE[statusHue(status)].solid;
  return <span className={cn("size-2 flex-shrink-0 rounded-full", solid, pulse && "pulse-dot", className)} />;
}

/** A tag: muted tint of a hue. Read-only: it never looks like a button. */
export function Badge({ hue = "mute", icon: Icon, children, className, title }: { hue?: Hue; icon?: LucideIcon; children: ReactNode; className?: string; title?: string }) {
  const h = HUE[hue];
  return (
    <span title={title} className={cn("inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-caption font-medium tabular-nums", h.bg, h.text, className)}>
      {Icon && <Icon className="size-3" strokeWidth={2.5} />}
      {children}
    </span>
  );
}
export const Tag = Badge;

const STATUS_ICON: Record<Status, LucideIcon> = { PASS: Check, FAIL: X, RUNNING: Loader2, UNMEASURED: CircleHelp, UNKNOWN: CircleHelp, NOT_APPLICABLE: Minus };

export function StatusIcon({ status, size, className }: { status: Status | string; size?: number; className?: string }) {
  const Icon = STATUS_ICON[status as Status] ?? CircleHelp;
  return <Icon className={cn(status === "RUNNING" && "animate-spin", className)} style={size ? { width: size, height: size } : undefined} strokeWidth={2.5} />;
}

export function StatusBadge({ status, children }: { status: Status | string; children?: ReactNode }) {
  const Icon = STATUS_ICON[status as Status] ?? CircleHelp;
  return <Badge hue={statusHue(status)} icon={Icon}>{children ?? STATUS_TEXT[status as Status] ?? status}</Badge>;
}

/** A round status mark: ✓ / ✕ / – / ? inside a tinted circle. Shape and colour together, never colour alone. */
export function StatusMark({ status, size = 20 }: { status: Status | string; size?: number }) {
  const h = HUE[statusHue(status)];
  return (
    <span className={cn("inline-flex flex-shrink-0 items-center justify-center rounded-full", h.bgStrong, h.text)} style={{ width: size, height: size }}>
      <StatusIcon status={status} size={Math.round(size * 0.55)} />
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

/** A share as a thin bar. Grey by default: a bar is colored only when its value is a problem. */
export function Meter({ value, hue, className }: { value: number; hue?: Hue; className?: string }) {
  return (
    <div className={cn("h-1 w-full overflow-hidden rounded-full bg-white/[0.07]", className)}>
      <div className={cn("h-full rounded-full", hue ? HUE[hue].solid : "bg-lab-mute")} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
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

const DIRECTION_ICON: Record<Direction, LucideIcon> = { better: ArrowUp, "likely-better": ArrowUp, same: Equal, "likely-worse": ArrowDown, worse: ArrowDown };
const DIRECTION_WORD: Record<Direction, string> = {
  better: "лучше", "likely-better": "в пределах шума", same: "без изменений", "likely-worse": "в пределах шума", worse: "хуже",
};

/**
 * A change against the previous version: «▲ +15 п.п.». Coloured only when the change is real (`direction` better / worse);
 * a change within the noise is grey and says so on hover. Without a direction the change is shown grey.
 */
export function Delta({ value, unit = "п.п.", direction, className }: { value: number; unit?: string; direction?: Direction; className?: string }) {
  const d: Direction = direction ?? (value > 0 ? "likely-better" : value < 0 ? "likely-worse" : "same");
  const hue: Hue = d === "better" ? "ok" : d === "worse" ? "bad" : "mute";
  if (!value) return <Badge hue="mute" icon={Equal} className={className}>без изменений</Badge>;
  return (
    <Badge hue={hue} icon={DIRECTION_ICON[d]} className={className} title={DIRECTION_WORD[d]}>
      {value > 0 ? "+" : "−"}{Math.abs(value)} {unit}
    </Badge>
  );
}

/**
 * A share with its 95% interval: the track is 0–100%, the band is where the true share probably lies, the tick is the measured share.
 * Values are fractions (0–1).
 */
export function IntervalBar({ value, low, high, className }: { value: number; low: number; high: number; className?: string }) {
  return (
    <div className={cn("relative h-2 w-full rounded-full bg-white/[0.06]", className)} aria-hidden>
      <div className="absolute inset-y-0 rounded-full bg-white/[0.14]" style={{ left: `${100 * low}%`, width: `${100 * Math.max(0.005, high - low)}%` }} />
      <div className="absolute -top-1 h-4 w-[3px] -translate-x-1/2 rounded-full bg-lab-ink" style={{ left: `${100 * value}%` }} />
    </div>
  );
}

/* ---------- content ---------- */

/** Placeholder of a block that is still loading: mirrors the final layout. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-lg bg-white/[0.05]", className)} />;
}

/** A number with a label. The number is the loudest thing in the block. */
export function Stat({ label, value, sub, hue, className }: { label: string; value: ReactNode; sub?: ReactNode; hue?: Hue; className?: string }) {
  return (
    <Panel className={cn("px-4 py-3.5", className)}>
      <Eyebrow>{label}</Eyebrow>
      <div className={cn("mt-1 text-display font-semibold tabular-nums", hue ? HUE[hue].text : "text-lab-ink")}>{value}</div>
      {sub && <div className="mt-0.5 text-caption text-lab-mute">{sub}</div>}
    </Panel>
  );
}

/** A quote with its source: what the agent said, or the line of the prompt a criterion comes from. */
export function Quote({ who, tone, children }: { who: string; tone?: "bad" | "ok"; children: ReactNode }) {
  return (
    <figure className={cn("mt-2.5 border-l-2 pl-3", tone === "bad" ? "border-lab-bad/70" : tone === "ok" ? "border-lab-ok/60" : "border-lab-strong")}>
      <figcaption className="mb-0.5 text-caption text-lab-mute">{who}</figcaption>
      <blockquote className={cn("text-body", tone === "bad" ? "text-lab-ink" : "text-lab-text")}>{children}</blockquote>
    </figure>
  );
}

/** A customer's message. */
export function Bubble({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("max-w-full rounded-2xl rounded-br-md bg-lab-user px-3.5 py-2 text-reading text-lab-ink", className)}>{children}</div>;
}

/** The mark of Agent Lab: a conversation bubble with a tick — a dialogue that was checked. */
export function LabMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <path d="M4 3.5h12a2.5 2.5 0 0 1 2.5 2.5v6.5A2.5 2.5 0 0 1 16 15h-5.2l-3.6 2.9c-.5.4-1.2 0-1.2-.6V15H4a2.5 2.5 0 0 1-2.5-2.5V6A2.5 2.5 0 0 1 4 3.5Z" fill="currentColor" fillOpacity=".14" stroke="currentColor" strokeWidth="1.3" />
      <path d="m6.6 9.3 2.2 2.2 4.6-4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** An empty state names what is missing, why it matters and the next step. `drop` is kept for older call sites: it shows the Lab's mark. */
export function EmptyState({ icon: Icon, drop, title, children, action, className }: { icon?: LucideIcon; drop?: boolean; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center rounded-xl border border-lab-line bg-lab-panel/60 px-8 py-12 text-center", className)}>
      <span className="mb-4 inline-flex size-10 items-center justify-center rounded-xl bg-lab-raised text-lab-mute">
        {Icon && !drop ? <Icon className="size-5" /> : <LabMark size={22} />}
      </span>
      <div className="text-lead font-semibold text-lab-ink">{title}</div>
      {children && <div className="mt-1.5 max-w-[460px] text-pretty text-body text-lab-mute">{children}</div>}
      {action && <div className="mt-5 flex items-center gap-2">{action}</div>}
    </div>
  );
}

/** Hover / focus hint without JS. Two sentences at most: what the element means, not how to click it. */
export function Tip({ text, children, side = "top", className }: { text: ReactNode; children: ReactNode; side?: "top" | "bottom"; className?: string }) {
  return (
    <span className={cn("group/tip relative inline-flex", className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-1/2 z-40 w-max max-w-[280px] -translate-x-1/2 rounded-lg bg-lab-raised px-2.5 py-1.5 text-caption text-lab-text opacity-0 shadow-pop transition-opacity duration-100",
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
    <span className="inline-flex flex-shrink-0 items-center justify-center rounded-md bg-lab-raised text-lab-mute" style={{ width: size, height: size }}>
      <Icon style={{ width: size * 0.55, height: size * 0.55 }} />
    </span>
  );
}

export function PersonaTag({ personas, id }: { personas: Persona[]; id?: string }) {
  const { icon: Icon } = personaLook(id);
  return (
    <span className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-md bg-lab-raised pl-1.5 pr-2 text-caption font-medium text-lab-text">
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
        "lab-focus flex items-start gap-3 rounded-lg border p-3 text-left transition-colors duration-100",
        on ? "border-lab-strong bg-lab-active" : "border-lab-line bg-lab-panel hover:border-lab-edge hover:bg-lab-raised",
      )}
    >
      <PersonaIcon id={persona.id} size={28} />
      <span className="min-w-0 flex-1">
        <span className={cn("block text-body font-medium", on ? "text-lab-ink" : "text-lab-text")}>{persona.name}</span>
        <span className="mt-0.5 block text-caption text-lab-mute">{persona.note}</span>
      </span>
      <span className={cn("mt-0.5 flex size-4 flex-shrink-0 items-center justify-center rounded-full border transition-colors duration-100", on ? "border-transparent bg-lab-ink" : "border-lab-strong")}>
        {on && <Check className="size-2.5 text-lab-canvas" strokeWidth={3} />}
      </span>
    </button>
  );
}
