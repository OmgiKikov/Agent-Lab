import type { ReactNode } from "react";

/**
 * Raindrop's issue page: the object on the left in a fixed column, its evidence on the right.
 * Below 1024 px they stack, the object first.
 */
export function TwoCol({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto lg:flex-row lg:overflow-hidden">
      <aside className="w-full flex-shrink-0 border-b border-white/[0.08] px-[18px] pb-6 pt-4 lg:w-[400px] lg:overflow-auto lg:border-b-0 lg:border-r xl:w-[440px]">{left}</aside>
      <section className="min-w-0 flex-1 lg:overflow-auto">{right}</section>
    </div>
  );
}
