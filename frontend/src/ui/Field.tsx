import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/** Native form controls with the product's shared focus, invalid and disabled states. Labels stay with the form. */
const FIELD =
  "min-w-0 w-full rounded-control border border-line-strong bg-canvas px-3 py-2 text-body font-normal text-fg transition-colors placeholder:text-fg-4 hover:border-fg-4 focus-visible:border-run focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/30 disabled:cursor-not-allowed disabled:bg-inset disabled:text-fg-3 disabled:opacity-60 aria-[invalid=true]:border-bad aria-[invalid=true]:focus-visible:ring-bad/30";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cn(FIELD, className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, ...props },
  ref,
) {
  return <select ref={ref} className={cn(FIELD, className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={cn(FIELD, "resize-y", className)} {...props} />;
});
