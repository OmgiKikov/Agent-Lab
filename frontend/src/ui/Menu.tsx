import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * One line of a menu. With `on` it is a choice, ticked when true (a screen reader hears «menuitemradio», checked or
 * not); without it, an action, such as «Новый агент».
 */
export type MenuItem = { key: string; label: ReactNode; sub?: ReactNode; on?: boolean; run: () => void };

/** The lines of a menu that take focus, in order. */
const linesOf = (menu: HTMLElement | null) => [...(menu?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];

/** Consecutive lines of one kind: choices are grouped apart from actions (WAI-ARIA, menuitemradio in a group). */
function runsOf(items: MenuItem[]) {
  const runs: { choice: boolean; items: MenuItem[] }[] = [];
  for (const item of items) {
    const choice = item.on !== undefined;
    const last = runs[runs.length - 1];
    if (last?.choice === choice) last.items.push(item);
    else runs.push({ choice, items: [item] });
  }
  return runs;
}

/**
 * A small dropdown: a trigger and a list of choices or actions; closes on a click outside, on Esc and on Tab. From the
 * keyboard as a menu button (WAI-ARIA): Enter, Space or ↓ opens it and puts the focus on the ticked line or the first
 * one (↑ on the last one), ↑ ↓ Home End move it, Esc closes and gives the focus back to the trigger.
 */
export function Menu({
  trigger,
  items,
  align = "left",
  up,
  disabled,
  className,
}: {
  trigger: ReactNode;
  items: MenuItem[];
  align?: "left" | "right";
  up?: boolean;
  /** The trigger does nothing, as a disabled button: while another task runs. */
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // Which line takes the focus when the menu opens: the ticked one (or the first), or the last one after ↑.
  const start = useRef<"ticked" | "first" | "last">("ticked");
  const id = useId();
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    // Opened near the bottom of the screen (a phone, above the bottom navigation), the list scrolls into sight.
    list.current?.scrollIntoView({ block: "nearest" });
    const lines = linesOf(list.current);
    const first =
      start.current === "last"
        ? lines[lines.length - 1]
        : start.current === "first"
          ? lines[0]
          : (lines.find((line) => line.getAttribute("aria-checked") === "true") ?? lines[0]);
    first?.focus();
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const openFrom = (where: "ticked" | "first" | "last") => {
    start.current = where;
    setOpen(true);
  };
  const onTriggerKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const lines = linesOf(list.current);
    if (open) lines[e.key === "ArrowDown" ? 0 : lines.length - 1]?.focus();
    else openFrom(e.key === "ArrowDown" ? "first" : "last");
  };
  const onMenuKey = (e: KeyboardEvent) => {
    const lines = linesOf(list.current);
    const at = lines.indexOf(document.activeElement as HTMLElement);
    const go = (to: number) => {
      e.preventDefault();
      lines[(to + lines.length) % lines.length]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at < 0 ? lines.length - 1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(lines.length - 1);
    else if (e.key === "Escape") {
      // The menu alone closes: the page or the sheet under it stays as it was.
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") setOpen(false);
  };
  const runs = runsOf(items);
  const line = (i: MenuItem) => (
    <button
      key={i.key}
      type="button"
      role={i.on === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={i.on === undefined ? undefined : i.on}
      tabIndex={-1}
      onClick={() => {
        close(true);
        i.run();
      }}
      className="flex w-full items-start gap-2 rounded-control px-2.5 py-1.5 text-left outline-none transition-colors hover:bg-selected focus-visible:bg-selected"
    >
      <Check aria-hidden className={cn("mt-0.5 size-3.5 flex-shrink-0 text-fg", !i.on && "invisible")} />
      <span className="min-w-0">
        <span className="block text-small text-fg">{i.label}</span>
        {i.sub && <span className="block text-meta text-fg-3">{i.sub}</span>}
      </span>
    </button>
  );
  return (
    <div ref={ref} className={cn("relative inline-flex", className)}>
      <button
        ref={button}
        id={`${id}-trigger`}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openFrom("ticked"))}
        onKeyDown={onTriggerKey}
        className="inline-flex h-full w-full items-center justify-center rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60 disabled:pointer-events-none disabled:opacity-40"
      >
        {trigger}
      </button>
      {open && !disabled && (
        <div
          ref={list}
          id={`${id}-menu`}
          role="menu"
          aria-labelledby={`${id}-trigger`}
          onKeyDown={onMenuKey}
          className={cn(
            "absolute z-40 max-h-80 min-w-[280px] overflow-auto rounded-block bg-raised p-1 shadow-pop",
            up ? "bottom-full mb-1" : "top-full mt-1",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {runs.map((run, n) =>
            run.choice && runs.length > 1 ? (
              <div key={n} role="group">
                {run.items.map(line)}
              </div>
            ) : (
              run.items.map(line)
            ),
          )}
        </div>
      )}
    </div>
  );
}
