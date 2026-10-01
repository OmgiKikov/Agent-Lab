import { forwardRef, type ButtonHTMLAttributes } from "react";
import { Loader2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Kbd } from "./Kbd";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "ghost";
  size?: "sm" | "md" | "lg";
  icon?: LucideIcon;
  loading?: boolean;
  /** The key that does the same; shown in the tooltip, and on the button with `showKbd`. */
  kbd?: string;
  showKbd?: boolean;
};

const VARIANT = {
  primary: "bg-primary text-white hover:bg-primary/85",
  outline: "bg-hover text-fg hover:bg-selected",
  ghost: "bg-transparent text-fg-2 hover:bg-hover hover:text-fg",
};

const SIZE = {
  sm: "h-8 gap-1.5 px-3 text-small",
  md: "h-9 gap-1.5 px-4 text-body",
  lg: "h-11 gap-2 px-5 text-read",
};

const PILL = [
  "inline-flex flex-shrink-0 select-none items-center justify-center whitespace-nowrap rounded-full font-medium transition-[background-color,color,transform] duration-150 ease-out active:scale-[0.97]",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40",
];

/** The same pill for a link that leads somewhere, so a button is never put inside a link. */
export const buttonClass = ({ variant = "outline", size = "md" }: Pick<Props, "variant" | "size"> = {}) =>
  cn(...PILL, SIZE[size], VARIANT[variant]);

/** A pill: the black one is the screen's main action, one per screen; the grey ones are the rest; bare for quiet actions. */
export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  {
    variant = "outline",
    size = "md",
    icon: Icon,
    loading,
    kbd,
    showKbd,
    className,
    children,
    disabled,
    type = "button",
    title,
    ...rest
  },
  ref,
) {
  const label = typeof children === "string" ? children : (rest["aria-label"] ?? "");
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      title={kbd ? `${title ?? label} (${kbd})`.trim() : title}
      className={cn(
        ...PILL,
        SIZE[size],
        !children && (size === "sm" ? "w-8 px-0" : size === "lg" ? "w-11 px-0" : "w-9 px-0"),
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 aria-hidden className={size === "lg" ? "size-4 animate-spin" : "size-3.5 animate-spin"} />
      ) : (
        Icon && <Icon aria-hidden className={size === "lg" ? "size-4" : "size-3.5"} />
      )}
      {children}
      {kbd && showKbd && <Kbd className="ml-0.5">{kbd}</Kbd>}
    </button>
  );
});
