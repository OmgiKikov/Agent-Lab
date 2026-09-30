/**
 * Building blocks of Agent Lab: one visual language for every screen, Raindrop's (docs/DESIGN.md).
 * A black canvas, hairlines, tiny mono labels over values, colour only for meaning.
 * Colours come from the `lab-*` tokens (index.css, tailwind.config.js), sizes from the named type scale
 * (text-caption 12, text-body 13, text-reading 14, text-lead 16, text-title 20, text-display 30, text-metric 30).
 * No inline hex, no arbitrary text sizes, mono only for labels (`Label`), identifiers and code.
 */
import { createContext, forwardRef, useContext, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { ArrowRight, Check, CircleHelp, Loader2, Minus, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { HUE, STATUS_TEXT, personaLook, personaName, statusHue, type Hue } from "./look";
import type { Persona, Status } from "./types";

/* ---------- type ---------- */

/** Raindrop's instrument label: mono capitals, 10 px, over a value, a column or a group. One to three words, never a sentence. */
export function Label({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("lab-label text-lab-mute", className)} {...rest} />;
}
/** @deprecated The same thing as `Label`. */
export const Eyebrow = Label;

/* ---------- surfaces ---------- */

/** A real boundary: a list, a form, a strip. One step lighter than the canvas and a hairline. Never a panel inside a panel. */
export function Panel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-lab-line bg-lab-panel", className)} {...rest} />;
}
export const Card = Panel;

/** A row inside a panel, separated from the previous one by a hairline. */
export function Row({ className, first, ...rest }: HTMLAttributes<HTMLDivElement> & { first?: boolean }) {
  return <div className={cn(!first && "border-t border-lab-line", className)} {...rest} />;
}

/**
 * A block of a page: a mono label with an optional count, the content right under it.
 * `hint` is one short line of state, not a description of the block; most blocks need none.
 */
export function Section({ title, count, hint, right, children, className, id, tone }: {
  title: ReactNode; count?: ReactNode; hint?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; id?: string;
  /** A dot before the label, when the block is about a state (new violations, fixed). */
  tone?: Hue;
}) {
  return (
    <section className={cn("mt-10", className)} id={id} aria-label={typeof title === "string" ? title : undefined}>
      <div className="mb-2.5 flex min-h-6 items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2">
          {tone && <span className={cn("size-1.5 flex-shrink-0 rounded-full", HUE[tone].solid)} aria-hidden />}
          <h2 className="lab-label text-lab-soft">{title}</h2>
          {count !== undefined && count !== null && <span className="lab-label tabular-nums text-lab-faint">{count}</span>}
          {hint && <span className="hidden min-w-0 truncate text-caption text-lab-mute sm:inline">· {hint}</span>}
        </div>
        {right && <div className="flex flex-shrink-0 items-center gap-2">{right}</div>}
      </div>
      {children}
    </section>
  );
}

/* ---------- page ---------- */

/**
 * What every result page's header carries on the right besides its own actions: the version being looked at
 * and the product's main action («Проверить версию»). Provided by LabContext, so a view only says what is its own.
 */
export const ChromeContext = createContext<{ context?: ReactNode; primary?: ReactNode }>({});

/**
 * Inside a Raindrop-style section (lab/Shell.tsx) the section draws the header: the run's title, buttons and tabs.
 * A page there shows only its own way back and its own actions, in one quiet line above its content.
 */
export const EmbedContext = createContext(false);

/** Buttons in that line take Raindrop's header-button look: small, outlined, never the light primary. */
const RaindropButtons = createContext(false);
const RAINDROP_BUTTON = "h-auto gap-1.5 rounded-md border border-white/10 bg-white/[0.06] px-3 py-1 text-[11px] font-medium text-lab-text hover:bg-white/10";

/**
 * A page: a 52 px header (where you are, the page's actions), then the content in one column.
 * `crumb` is the way back for detail pages. `primary` replaces the global primary action with the page's own
 * (null hides it); `bare` hides the version and the global action (setup pages).
 */
export function Page({ title, icon: Icon, count, crumb, lede, actions, primary, wide, narrow, full, fill, nav, bare, noContext, children }: {
  title: ReactNode; icon?: LucideIcon; count?: ReactNode; crumb?: { label: string; onClick: () => void }; lede?: ReactNode; actions?: ReactNode;
  primary?: ReactNode | null; wide?: boolean; narrow?: boolean; full?: boolean;
  /** A list and its detail side by side, each scrolling on its own (Workshop's layout): the content takes the whole height, no padding. */
  fill?: boolean;
  nav?: ReactNode; bare?: boolean;
  /** The page's title already names the version (the version page). */
  noContext?: boolean; children?: ReactNode;
}) {
  const chrome = useContext(ChromeContext);
  const embedded = useContext(EmbedContext);
  const width = full ? "" : narrow ? "max-w-[800px]" : wide ? "max-w-[1200px]" : "max-w-[1080px]";
  const main = primary === undefined ? (bare ? null : chrome.primary) : primary;
  if (embedded) {
    const own = primary ?? null;
    const bar = (crumb || actions || own) && (
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 px-4 pt-3">
        {crumb && <button onClick={crumb.onClick} className="lab-focus -ml-1 rounded-sm px-1 text-caption text-lab-mute transition-colors duration-100 hover:text-lab-ink">← {crumb.label}</button>}
        <RaindropButtons.Provider value={true}><div className="ml-auto flex items-center gap-1.5">{actions}{own}</div></RaindropButtons.Provider>
      </div>
    );
    return fill ? (
      <div className="flex h-full min-h-0 flex-col">{bar}<div className="flex min-h-0 flex-1">{children}</div></div>
    ) : (
      <div className="min-h-full">
        {bar}
        <div className={cn("mx-auto w-full px-5 pb-20 sm:px-6", width)}>
          {lede && <p className="mt-6 max-w-[720px] text-pretty text-reading text-lab-soft">{lede}</p>}
          {children}
        </div>
      </div>
    );
  }
  return (
    <div className={cn("flex flex-col", fill ? "h-full" : "min-h-full")}>
      <header className={cn("top-0 z-20 flex-shrink-0 border-b border-lab-line bg-lab-canvas/90 backdrop-blur-md", !fill && "sticky")}>
        <div className="flex h-[52px] items-center gap-3 px-5">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {crumb && (
              <>
                <button onClick={crumb.onClick} className="lab-focus -ml-1.5 max-w-[45%] flex-shrink-0 truncate rounded-md px-1.5 py-1 text-body text-lab-mute transition-colors duration-100 hover:text-lab-ink">{crumb.label}</button>
                <span className="text-body text-lab-faint" aria-hidden>/</span>
              </>
            )}
            {Icon && !crumb && <Icon className="size-4 flex-shrink-0 text-lab-mute" aria-hidden />}
            {typeof title === "string" ? <h1 className="min-w-0 truncate text-body font-semibold text-lab-ink">{title}</h1> : <div className="min-w-0">{title}</div>}
            {count !== undefined && count !== null && <span className="text-body tabular-nums text-lab-mute">{count}</span>}
          </div>
          <div className="flex flex-shrink-0 items-center gap-1.5">
            {actions}
            {/* On a phone the header has room for the page's own actions only: the version is switched on the version page. */}
            {!bare && !noContext && chrome.context && <div className="hidden md:block">{chrome.context}</div>}
            {main}
          </div>
        </div>
        {nav && <div className="px-5">{nav}</div>}
      </header>
      {fill ? <div className="flex min-h-0 flex-1">{children}</div> : (
        <div className={cn("mx-auto w-full flex-1 px-5 pb-20 sm:px-8", width)}>
          {lede && <p className="mt-6 max-w-[720px] text-pretty text-reading text-lab-soft">{lede}</p>}
          {children}
        </div>
      )}
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
  /** On a phone only the icon stays: the label goes to screen readers. For header buttons that would not fit. */
  collapse?: boolean;
};

/** Raindrop's buttons: outlined and quiet; the one primary is light, like its «Ask Claude Code» tab. */
const BUTTON_VARIANT = {
  primary: "bg-lab-ink text-black hover:bg-white",
  accent: "bg-lab-accent-solid text-white hover:bg-lab-accent-solid/90",
  secondary: "border border-lab-edge bg-white/[0.04] text-lab-text hover:border-lab-strong hover:bg-white/[0.08] hover:text-lab-ink",
  ghost: "text-lab-mute hover:bg-white/[0.06] hover:text-lab-ink",
  danger: "bg-lab-bad/10 text-lab-bad hover:bg-lab-bad/20",
};

const BUTTON_SIZE = { sm: "h-7 gap-1.5 px-2.5 text-caption", md: "h-8 gap-1.5 px-3 text-body", lg: "h-10 gap-2 px-4 text-reading" };

/** Sans, sentence case, verb first. One primary per region. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon: Icon, loading, kbd, collapse, className, children, disabled, ...rest }, ref,
) {
  const raindrop = useContext(RaindropButtons);
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "lab-focus inline-flex flex-shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md font-medium",
        "transition-[background-color,border-color,color,transform] duration-100 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40",
        raindrop ? RAINDROP_BUTTON : [BUTTON_SIZE[size], BUTTON_VARIANT[variant]], className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : Icon && <Icon className={size === "lg" ? "size-4" : "size-3.5"} />}
      {collapse ? <span className="max-sm:sr-only">{children}</span> : children}
      {kbd && <kbd className={cn("ml-0.5 font-mono text-micro max-sm:hidden", variant === "primary" ? "text-black/45" : "text-lab-faint")}>{kbd}</kbd>}
    </button>
  );
});

/** An icon-only button. `label` is required: it is the tooltip and what a screen reader says. */
export function IconButton({ icon: Icon, label, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return (
    <button aria-label={label} title={label} className={cn("lab-focus inline-flex size-8 flex-shrink-0 items-center justify-center rounded-md text-lab-mute transition-colors duration-100 hover:bg-white/[0.06] hover:text-lab-ink disabled:opacity-40", className)} {...rest}>
      <Icon className="size-4" />
    </button>
  );
}

/** A text action inside a sentence or a block: «Все диалоги →». */
export function LinkButton({ className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={cn("lab-focus inline-flex items-center gap-1 rounded-sm text-body text-lab-soft underline decoration-white/20 underline-offset-4 transition-colors duration-100 hover:text-lab-ink hover:decoration-white/60", className)} {...rest}>{children}</button>;
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-lab-edge bg-white/[0.04] px-1 font-mono text-micro text-lab-mute", className)}>{children}</kbd>;
}

export const inputClass = cn(
  "h-8 w-full rounded-md border border-lab-line bg-white/[0.04] px-2.5 text-body text-lab-ink outline-none transition-colors duration-100",
  "placeholder:text-lab-faint hover:border-lab-edge focus:border-lab-accent/60 focus:ring-2 focus:ring-lab-accent/20",
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
      <span className="mb-1.5 block text-body font-medium text-lab-text">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-caption text-lab-mute">{hint}</span>}
    </label>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, className }: {
  value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; className?: string;
}) {
  return (
    <div role="radiogroup" className={cn("inline-flex gap-0.5 rounded-md border border-lab-line bg-white/[0.02] p-0.5", className)}>
      {options.map(o => (
        <button
          key={String(o.value)} role="radio" aria-checked={o.value === value} title={o.title} onClick={() => onChange(o.value)}
          className={cn(
            "lab-focus inline-flex h-7 items-center gap-1.5 rounded px-2.5 text-body transition-colors duration-100",
            o.value === value ? "bg-white/[0.09] text-lab-ink" : "text-lab-mute hover:text-lab-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Underlined tabs, as in Workshop's trace view (Обзор · Спаны · Диалог). */
export function Tabs<T extends string>({ value, tabs, onChange, flush }: { value: T; tabs: { value: T; label: ReactNode }[]; onChange: (v: T) => void; flush?: boolean }) {
  return (
    <div role="tablist" className={cn("flex flex-shrink-0 gap-4", flush ? "" : "border-b border-lab-line px-5")}>
      {tabs.map(t => (
        <button
          key={t.value} role="tab" aria-selected={t.value === value} onClick={() => onChange(t.value)}
          className={cn(
            "lab-focus-inset -mb-px inline-flex h-10 items-center gap-1.5 border-b-2 text-body transition-colors duration-100",
            t.value === value ? "border-lab-ink font-medium text-lab-ink" : "border-transparent text-lab-mute hover:text-lab-ink",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** A fact in a header, as in Workshop: a mono label chip, then the value. */
export function Meta({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-caption" title={title}>
      <span className="lab-label rounded-sm bg-white/[0.08] px-1 text-lab-mute">{label}</span>
      <span className="min-w-0 truncate tabular-nums text-lab-soft">{children}</span>
    </span>
  );
}

/** A tool the agent called in a conversation: Workshop's tool pill. */
export function ToolPill({ name }: { name: string }) {
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-md border border-lab-edge px-2 font-mono text-micro normal-case tracking-normal text-lab-soft">
      <Check className="size-3 text-lab-ok" strokeWidth={2.5} />{name}
    </span>
  );
}

/** A filter chip with an optional counter. */
export function Chip({ on, onClick, children, count, hue }: { on?: boolean; onClick?: () => void; children: ReactNode; count?: number; hue?: Hue }) {
  return (
    <button
      onClick={onClick} aria-pressed={on}
      className={cn(
        "lab-focus inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-body transition-colors duration-100",
        on ? "border-lab-strong bg-white/[0.08] text-lab-ink" : "border-lab-line text-lab-mute hover:border-lab-edge hover:text-lab-ink",
      )}
    >
      {hue && <span className={cn("size-1.5 rounded-full", HUE[hue].solid)} />}
      {children}
      {count !== undefined && <span className={cn("tabular-nums", on ? "text-lab-soft" : "text-lab-faint")}>{count}</span>}
    </button>
  );
}

/* ---------- status ---------- */

/** `quiet`: a pass is grey, so in a long list only failures and gaps stand out. */
export function Dot({ status, pulse, quiet, className }: { status: Status | string; pulse?: boolean; quiet?: boolean; className?: string }) {
  const solid = quiet && status === "PASS" ? "bg-lab-faint" : HUE[statusHue(status)].solid;
  return <span className={cn("size-1.5 flex-shrink-0 rounded-full", solid, pulse && "pulse-dot", className)} />;
}

/** A tag: muted tint of a hue. Read-only: it never looks like a button. */
export function Badge({ hue = "mute", icon: Icon, children, className, title }: { hue?: Hue; icon?: LucideIcon; children: ReactNode; className?: string; title?: string }) {
  const h = HUE[hue];
  return (
    <span title={title} className={cn("inline-flex h-5 items-center gap-1 whitespace-nowrap rounded px-1.5 text-caption tabular-nums", h.bg, h.text, className)}>
      {Icon && <Icon className="size-3" strokeWidth={2.5} />}
      {children}
    </span>
  );
}
export const Tag = Badge;

/**
 * Raindrop's verdict chip: mono capitals on a tint — ЛУЧШЕ, ХУЖЕ, НОВОЕ, ИСПРАВЛЕНО, В ПРЕДЕЛАХ ШУМА.
 * `solid` is for the one verdict of a page.
 */
export function Verdict({ hue = "mute", solid, children, className, title }: { hue?: Hue; solid?: boolean; children: ReactNode; className?: string; title?: string }) {
  const h = HUE[hue];
  return (
    <span title={title} className={cn("lab-label inline-flex h-5 flex-shrink-0 items-center rounded-sm px-1.5", solid && hue !== "mute" ? cn(h.solid, "text-black") : cn(h.bg, h.text), className)}>
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

/** A status mark: ✓ / ✕ / – / ? inside a tinted square. Shape and colour together, never colour alone. A pass stays quiet. */
export function StatusMark({ status, size = 20, loud }: { status: Status | string; size?: number; loud?: boolean }) {
  const h = HUE[statusHue(status)];
  const quiet = status === "PASS" && !loud;
  return (
    <span className={cn("inline-flex flex-shrink-0 items-center justify-center rounded", quiet ? "bg-white/[0.05] text-lab-mute" : cn(h.bgStrong, h.text))} style={{ width: size, height: size }}>
      <StatusIcon status={status} size={Math.round(size * 0.58)} />
    </span>
  );
}

/** Part-to-whole: a status `hue`, or a plain `tone` class when the parts are not statuses. */
export function StackBar({ parts, className }: { parts: { value: number; hue?: Hue; tone?: string }[]; className?: string }) {
  const shown = parts.filter(p => p.value > 0);
  return (
    <div className={cn("flex h-1.5 gap-[2px] overflow-hidden rounded-sm", className)}>
      {shown.length ? shown.map((p, i) => <div key={i} className={cn("h-full", p.tone ?? HUE[p.hue ?? "mute"].solid)} style={{ flex: p.value }} />) : <div className="h-full flex-1 bg-white/[0.07]" />}
    </div>
  );
}

/** A share as a thin bar. Grey by default: a bar is coloured only when its value is a problem. */
export function Meter({ value, hue, className }: { value: number; hue?: Hue; className?: string }) {
  return (
    <div className={cn("h-1 w-full overflow-hidden rounded-sm bg-white/[0.07]", className)}>
      <div className={cn("h-full rounded-sm", hue ? HUE[hue].solid : "bg-lab-mute")} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn("h-[2px] w-full overflow-hidden bg-white/[0.06]", className)} role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full bg-lab-accent transition-[width] duration-500 ease-out" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

/* ---------- numbers ---------- */

/**
 * The page's one number: the measure the service puts first — for a check, lab/metric.py's accuracy, «the one quality number».
 * Big, with what it is made of under it and at most one quiet reference (the previous check). Nothing else on the page is as big:
 * the eye lands here first. `side` holds a small picture of the same number (a sparkline across checks).
 */
export function Hero({ label, value, sub, note, side, className }: {
  label: ReactNode; value: ReactNode; sub?: ReactNode; note?: ReactNode; side?: ReactNode; className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <Label>{label}</Label>
      <div className="mt-3 flex flex-wrap items-end gap-x-5 gap-y-2">
        <span className="text-hero font-medium tabular-nums text-lab-ink">{value}</span>
        {side}
      </div>
      {sub && <p className="mt-3 text-reading text-lab-soft">{sub}</p>}
      {note && <p className="mt-1 text-body tabular-nums text-lab-mute">{note}</p>}
    </div>
  );
}

export type FactRow = { label: string; value: ReactNode; title?: string; onClick?: () => void };

/** The facts beside the page's number: a mono label and a plain value per row — never as big as the number. A row with `onClick` leads to its evidence. */
export function Facts({ rows, className }: { rows: FactRow[]; className?: string }) {
  return (
    <div className={cn("divide-y divide-lab-line border-y border-lab-line", className)}>
      {rows.map(r => {
        const inner = (
          <>
            <span className="lab-label w-[136px] flex-shrink-0 text-lab-mute">{r.label}</span>
            <span className="min-w-0 flex-1 text-body tabular-nums text-lab-text">{r.value}</span>
          </>
        );
        return r.onClick
          ? <button key={r.label} onClick={r.onClick} title={r.title} className="lab-focus-inset group flex w-full items-center gap-3 py-2.5 text-left transition-colors duration-100 hover:text-lab-ink">{inner}<ArrowRight className="size-3.5 flex-shrink-0 text-lab-faint transition-colors duration-100 group-hover:text-lab-mute" /></button>
          : <div key={r.label} title={r.title} className="flex items-center gap-3 py-2.5">{inner}</div>;
      })}
    </div>
  );
}

/** The top of a result page: the one number on the left, its facts on the right; stacked on a phone. */
export function Numbers({ hero, facts, className }: { hero: ReactNode; facts?: FactRow[]; className?: string }) {
  return (
    <section className={cn("grid gap-x-14 gap-y-8 md:grid-cols-[minmax(0,1fr)_minmax(0,380px)] md:items-end", className)}>
      {hero}
      {facts && facts.length > 0 && <Facts rows={facts} />}
    </section>
  );
}

/* ---------- content ---------- */

/** Placeholder of a block that is still loading: mirrors the final layout. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-white/[0.05]", className)} />;
}

/** A quote with its source: what the agent said, or the line of the prompt a criterion comes from. */
export function Quote({ who, tone, children }: { who: string; tone?: "bad" | "ok"; children: ReactNode }) {
  return (
    <figure className={cn("mt-2.5 border-l-2 pl-3", tone === "bad" ? "border-lab-bad/70" : tone === "ok" ? "border-lab-ok/60" : "border-lab-strong")}>
      <figcaption className="lab-label mb-1 text-lab-mute">{who}</figcaption>
      <blockquote className={cn("text-body", tone === "bad" ? "text-lab-ink" : "text-lab-text")}>{children}</blockquote>
    </figure>
  );
}

/** A customer's message: Raindrop's teal bubble. */
export function Bubble({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("max-w-full rounded-2xl rounded-br-md bg-lab-user px-3.5 py-2 text-reading text-lab-ink", className)}>{children}</div>;
}

/** The pixels of the mark: a speech bubble with a tick, on Raindrop's dot-matrix grid (11 × 11). */
const MARK = [
  ".XXXXXXXXX.",
  "X.........X",
  "X.......X.X",
  "X......X..X",
  "X.X...X...X",
  "X..X.X....X",
  "X...X.....X",
  "X.........X",
  ".XXXXXXXXX.",
  "..XX.......",
  "..X........",
];

/** The mark of Agent Lab: a checked dialogue, drawn in pixels like Raindrop's drop. */
export function LabMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" className={className} aria-hidden>
      {MARK.flatMap((row, y) => [...row].map((c, x) => c === "X"
        ? <rect key={`${x}-${y}`} x={x * 2 + 0.2} y={y * 2 + 0.2} width={1.6} height={1.6} rx={0.3} fill="currentColor" />
        : null))}
    </svg>
  );
}

/**
 * An empty state, Raindrop's way: on the canvas, not in a box. The mark, what is missing in one line, why in one sentence, one action.
 * `drop` is kept for older call sites.
 */
export function EmptyState({ icon: Icon, drop, title, children, action, className }: { icon?: LucideIcon; drop?: boolean; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-14 text-center", className)}>
      <span className="mb-5 inline-flex size-11 items-center justify-center rounded-lg border border-lab-line bg-lab-panel text-lab-mute">
        {Icon && !drop ? <Icon className="size-5" /> : <LabMark size={22} />}
      </span>
      <div className="text-lead font-medium text-lab-ink">{title}</div>
      {children && <div className="mt-1.5 max-w-[440px] text-pretty text-body text-lab-mute">{children}</div>}
      {action && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

/** Hover / focus hint without JS. One sentence: what the element means, not how to click it. */
export function Tip({ text, children, side = "top", className }: { text: ReactNode; children: ReactNode; side?: "top" | "bottom"; className?: string }) {
  return (
    <span className={cn("group/tip relative inline-flex", className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-1/2 z-40 w-max max-w-[280px] -translate-x-1/2 rounded-md border border-lab-edge bg-lab-raised px-2.5 py-1.5 text-caption text-lab-text opacity-0 shadow-pop transition-opacity duration-100",
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
    <span className="inline-flex flex-shrink-0 items-center justify-center rounded bg-white/[0.05] text-lab-mute" style={{ width: size, height: size }}>
      <Icon style={{ width: size * 0.55, height: size * 0.55 }} />
    </span>
  );
}

export function PersonaTag({ personas, id }: { personas: Persona[]; id?: string }) {
  const { icon: Icon } = personaLook(id);
  return (
    <span className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-md border border-lab-line pl-1.5 pr-2 text-caption text-lab-soft">
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
        "lab-focus flex items-start gap-3 rounded-md border p-3 text-left transition-colors duration-100",
        on ? "border-lab-strong bg-white/[0.06]" : "border-lab-line hover:border-lab-edge hover:bg-white/[0.03]",
      )}
    >
      <PersonaIcon id={persona.id} size={26} />
      <span className="min-w-0 flex-1">
        <span className={cn("block text-body font-medium", on ? "text-lab-ink" : "text-lab-text")}>{persona.name}</span>
        <span className="mt-0.5 block text-caption text-lab-mute">{persona.note}</span>
      </span>
      <span className={cn("mt-0.5 flex size-4 flex-shrink-0 items-center justify-center rounded-sm border transition-colors duration-100", on ? "border-transparent bg-lab-ink" : "border-lab-strong")}>
        {on && <Check className="size-2.5 text-black" strokeWidth={3} />}
      </span>
    </button>
  );
}
