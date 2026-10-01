import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The customer's words as Raindrop shows them: a teal bubble on the right. `who` names the customer above it. */
export function Bubble({ children, who, className, clamp }: { children: ReactNode; who?: ReactNode; className?: string; clamp?: boolean }) {
  return (
    <div className={cn("flex flex-col items-end", className)}>
      {who && <span className="mb-1 text-[10.5px] text-lab-dim">{who}</span>}
      <div className="max-w-[88%] rounded-[10px] border border-[rgba(75,180,200,0.11)] bg-[rgba(75,180,200,0.14)] px-[11px] py-2 text-[12.5px] leading-[18px] text-[rgb(212,224,230)]">
        <span className={cn("block", clamp && "line-clamp-3")}>{children}</span>
      </div>
    </div>
  );
}
