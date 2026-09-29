import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The named font sizes of tailwind.config.js (`text-body`, `text-caption`, …) must be known to tailwind-merge:
 * otherwise it takes them for text colours and drops them when a colour class follows.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["micro", "caption", "body", "reading", "lead", "title", "display", "metric", "hero", "label", "default", "message", "header"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
