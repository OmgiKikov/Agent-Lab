import { cn } from "@/lib/utils";

/**
 * The dotted paper the small pictures of the ways to check stand on («Новая проверка»), where a picture tells one way
 * from the other; nowhere else, where it would only decorate.
 */
export const PAPER =
  "rounded-control bg-inset [background-image:radial-gradient(rgb(var(--fg-4)/0.35)_1px,transparent_1px)] [background-size:8px_8px]";

const bar = "block h-1.5 rounded-full bg-fg/10";

/** What the simulations give: clients of different kinds playing the scenarios through. */
export function SimulationPicture() {
  return (
    <div className="flex h-full flex-col justify-center gap-2 px-3">
      <div className="flex -space-x-1">
        {["bg-mark", "bg-run/40", "bg-fg/20"].map((tint) => (
          <span key={tint} className={cn("size-4 rounded-full ring-2 ring-inset", tint)} />
        ))}
      </div>
      <div className="space-y-1.5 rounded-lg bg-list p-2 ring-1 ring-line">
        <span className={cn(bar, "w-14")} />
        <span className={cn(bar, "w-9")} />
      </div>
    </div>
  );
}
