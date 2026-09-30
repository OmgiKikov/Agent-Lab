import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Loader2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "ghost";
  size?: "sm" | "md";
  icon?: LucideIcon;
  loading?: boolean;
  kbd?: string;
};

const VARIANT = {
  primary: "border-transparent bg-lab-ink text-black hover:bg-white",
  outline: "border-white/[0.12] text-lab-soft hover:border-white/25 hover:bg-white/[0.05] hover:text-lab-ink",
  ghost: "border-transparent text-lab-mute hover:bg-white/[0.06] hover:text-lab-text",
};

/** The button of Raindrop's trace header: 11px mono, outlined, an icon and a word; one light primary per screen. The key is in its tooltip. */
export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "outline", size = "md", icon: Icon, loading, kbd, className, children, disabled, type = "button", title, ...rest }, ref,
) {
  return (
    <button
      ref={ref} type={type} disabled={disabled || loading} title={kbd ? `${title ?? (typeof children === "string" ? children : "")} (${kbd})`.trim() : title}
      className={cn(
        "inline-flex flex-shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded border font-mono text-meta transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-lab-accent disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "h-6 px-2" : "h-7 px-2.5",
        !children && (size === "sm" ? "w-6 px-0" : "w-7 px-0"),
        VARIANT[variant], className,
      )}
      {...rest}
    >
      {loading ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : Icon && <Icon aria-hidden className="size-3.5" />}
      {children}
    </button>
  );
});
