import { cn } from "@/lib/utils";

/**
 * An on/off choice that takes effect at once, its words beside it or, in a row of a table, read only by a screen
 * reader. On is dark, as a chosen tick; the meaning stays with the words. The press never reaches the row around it,
 * and the area it answers to is larger than the switch.
 */
export function Switch({
  checked,
  onChange,
  label,
  hideLabel,
  disabled,
  title,
  className,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  label: string;
  hideLabel?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={hideLabel ? label : undefined}
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cn(
        "group -m-1.5 inline-flex flex-shrink-0 select-none items-center gap-2 rounded-full p-1.5 text-left",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60 disabled:cursor-default",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "relative inline-flex h-[18px] w-8 flex-shrink-0 items-center rounded-full transition-colors duration-150 ease-out",
          checked ? "bg-primary" : "bg-fg/15 group-hover:bg-fg/25",
        )}
      >
        <span
          className={cn(
            "absolute left-0.5 size-3.5 rounded-full bg-white shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-transform duration-150 ease-out motion-reduce:transition-none",
            checked && "translate-x-3.5",
          )}
        />
      </span>
      {!hideLabel && <span className="text-body font-medium text-fg">{label}</span>}
    </button>
  );
}
