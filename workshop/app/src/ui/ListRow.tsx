import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A row of a list column, selected like the Workshop's run list; the selected row scrolls into view. */
export function ListRow({ selected, onClick, children, className }: { selected: boolean; onClick: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (selected) ref.current?.scrollIntoView({ block: "nearest" }); }, [selected]);
  return (
    <button
      ref={ref} type="button" onClick={onClick} aria-current={selected ? "true" : undefined}
      className={cn(
        "block w-full border-b border-white/[0.06] px-4 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-lab-accent",
        selected ? "bg-lab-active" : "hover:bg-lab-hover",
        className,
      )}
    >
      {children}
    </button>
  );
}
