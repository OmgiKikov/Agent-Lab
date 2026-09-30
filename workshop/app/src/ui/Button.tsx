import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Loader2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Kbd } from "./Kbd";

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

/** The button of Raindrop's trace header: small, outlined, an icon and a word; one light primary per screen. */
export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "outline", size = "md", icon: Icon, loading, kbd, className, children, disabled, type = "button", ...rest }, ref,
) {
  return (
    <button
      ref={ref} type={type} disabled={disabled || loading}
      className={cn(
        "inline-flex flex-shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-lab-accent disabled:pointer-events-none disabled:opacity-40",
        size === "sm" ? "h-7 px-2.5 text-meta" : "h-8 px-3 text-small",
        !children && (size === "sm" ? "w-7 px-0" : "w-8 px-0"),
        VARIANT[variant], className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : Icon && <Icon className="size-3.5" />}
      {children}
      {kbd && <Kbd className={cn("ml-0.5", variant === "primary" && "border-black/20 text-black/60")}>{kbd}</Kbd>}
    </button>
  );
});
