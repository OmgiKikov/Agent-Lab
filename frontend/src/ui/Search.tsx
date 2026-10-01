import { forwardRef } from "react";
import { Search as SearchIcon, X } from "lucide-react";
import { cn } from "@/lib/utils";

/** A search field over a list; Esc in it clears the text. */
export const Search = forwardRef<
  HTMLInputElement,
  { value: string; onChange: (v: string) => void; placeholder: string; className?: string }
>(function Search({ value, onChange, placeholder, className }, ref) {
  return (
    <label
      className={cn(
        "relative flex h-8 min-w-0 items-center rounded-control border border-line transition-colors focus-within:border-line-strong",
        className,
      )}
    >
      <SearchIcon aria-hidden className="pointer-events-none absolute left-2.5 size-3.5 text-fg-3" />
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.stopPropagation();
            onChange("");
          }
        }}
        className="h-full w-full min-w-0 bg-transparent pl-8 pr-7 text-small text-fg placeholder:text-fg-3 focus:outline-none"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Очистить"
          className="absolute right-1.5 rounded p-0.5 text-fg-3 hover:text-fg"
        >
          <X className="size-3.5" />
        </button>
      )}
    </label>
  );
});
