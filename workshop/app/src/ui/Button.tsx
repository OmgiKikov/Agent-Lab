import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Loader2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Kbd } from "./Kbd";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "ghost";
  size?: "sm" | "md";
  icon?: LucideIcon;
  loading?: boolean;
  /** The key that does the same; shown in the tooltip, and on the button with `showKbd`. */
  kbd?: string;
  showKbd?: boolean;
};

const VARIANT = {
  primary: "border-transparent bg-fg text-canvas hover:bg-white",
  outline: "border-line-strong text-fg hover:bg-hover",
  ghost: "border-transparent text-fg-2 hover:bg-hover hover:text-fg",
};

/** A button: the light one is the screen's main action, one per screen; the rest are outlined or bare. */
export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "outline", size = "md", icon: Icon, loading, kbd, showKbd, className, children, disabled, type = "button", title, ...rest }, ref,
) {
  const label = typeof children === "string" ? children : rest["aria-label"] ?? "";
  return (
    <button
      ref={ref} type={type} disabled={disabled || loading} title={kbd ? `${title ?? label} (${kbd})`.trim() : title}
      className={cn(
        "inline-flex flex-shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-control border text-small font-medium transition-colors duration-150 ease-out",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60 disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "h-7 px-2.5" : "h-8 px-3",
        !children && (size === "sm" ? "w-7 px-0" : "w-8 px-0"),
        VARIANT[variant], className,
      )}
      {...rest}
    >
      {loading ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : Icon && <Icon aria-hidden className="size-3.5" />}
      {children}
      {kbd && showKbd && <Kbd className="ml-0.5">{kbd}</Kbd>}
    </button>
  );
});
