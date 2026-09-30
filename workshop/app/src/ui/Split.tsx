import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * List and detail, as every section of the product. Below 1024 px one of them is shown:
 * the detail when `showDetail` (it brings its own «← назад»), otherwise the list.
 */
export function Split({ list, detail, showDetail }: { list: ReactNode; detail: ReactNode; showDetail: boolean }) {
  return (
    <div className="flex min-h-0 flex-1">
      <section className={cn("min-h-0 w-full flex-shrink-0 overflow-auto border-r border-white/[0.06] bg-lab-surface lg:block lg:w-[320px] xl:w-[400px]", showDetail && "hidden")}>
        {list}
      </section>
      <section className={cn("min-h-0 min-w-0 flex-1 overflow-auto", !showDetail && "hidden lg:block")}>{detail}</section>
    </div>
  );
}
