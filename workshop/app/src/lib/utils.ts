import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** tailwind-merge learns the named text sizes, so `text-read text-fg` keeps both (a size and a colour). */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["label", "meta", "small", "body", "read", "lead", "count", "title", "message"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
