import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** tailwind-merge learns the named text sizes, so `text-read text-lab-ink` keeps both (a size and a colour). */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["micro", "label", "meta", "small", "body", "read", "title", "page", "count", "stat", "heading", "default", "message", "header"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
