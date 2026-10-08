import { BookOpen, Check as Tick } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkNo } from "./MarkNo";

/** The dotted paper the small pictures of the checks stand on, as on a grid of the references' cards. */
export const PAPER =
  "rounded-control bg-inset [background-image:radial-gradient(rgb(var(--fg-4)/0.35)_1px,transparent_1px)] [background-size:8px_8px]";

const bar = "block h-1.5 rounded-full bg-fg/10";

/** A small picture of what tone of voice looks at: the agent's reply with a quote marked, as its result shows one. */
export function TonePicture() {
  return (
    <div className="flex h-full flex-col justify-center gap-1.5 px-3">
      <span className="ml-auto block h-2.5 w-12 rounded-full bg-customer" />
      <div className="space-y-1.5 rounded-lg bg-list p-2 ring-1 ring-line">
        <span className={cn(bar, "w-14")} />
        <span className="flex items-center gap-1">
          <span className="block h-1.5 w-9 rounded-full bg-mark" />
          <MarkNo n={1} className="h-3 min-w-3 px-0.5 text-[8px]" />
        </span>
        <span className={cn(bar, "w-11")} />
      </div>
    </div>
  );
}

/** A small picture of what accuracy looks at: the agent's reply set against an article of its knowledge base. */
export function AccuracyPicture() {
  return (
    <div className="flex h-full flex-col justify-center gap-1.5 px-3">
      <span className="ml-auto block h-2.5 w-10 rounded-full bg-customer" />
      <div className="space-y-1.5 rounded-lg bg-list p-2 ring-1 ring-line">
        <span className={cn(bar, "w-14")} />
        <span className={cn(bar, "w-10")} />
      </div>
      <span className="inline-flex items-center gap-1 self-start rounded-full bg-list px-1.5 py-0.5 ring-1 ring-line">
        <BookOpen aria-hidden className="size-2.5 text-fg-3" />
        <span className="block h-1 w-6 rounded-full bg-fg/10" />
        <Tick aria-hidden className="size-2.5 text-ok" />
      </span>
    </div>
  );
}

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
