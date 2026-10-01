import type { ReactNode } from "react";

/** A field that sits in a row with buttons: the same height as they are. */
export const INPUT =
  "h-8 w-full min-w-0 rounded-control border border-line-strong bg-transparent px-3 font-mono text-small text-fg outline-none transition-colors placeholder:text-fg-4 focus:border-fg-3";

/** One group of settings: what it is on the left, its values and controls on the right; one column on a phone. */
export function Group({ title, about, children }: { title: string; about?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="grid gap-x-12 gap-y-4 py-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,5fr)]">
      <div className="lg:pt-3">
        <h2 className="text-lead font-semibold text-fg">{title}</h2>
        {about && <p className="mt-1 text-small text-fg-3">{about}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

/** A row of a group: a name and what it is for, then its state and its action; `below` opens under it, as a key's field does. */
export function Row({
  name,
  use,
  children,
  below,
}: {
  name: ReactNode;
  use?: ReactNode;
  children?: ReactNode;
  below?: ReactNode;
}) {
  return (
    <div className="border-b border-line py-3">
      <div className="flex items-center gap-x-4">
        <div className="min-w-0 flex-1">
          <div className="text-body font-medium text-fg">{name}</div>
          {use && <div className="text-small text-fg-3">{use}</div>}
        </div>
        {children && <div className="flex flex-shrink-0 items-center gap-3">{children}</div>}
      </div>
      {below}
    </div>
  );
}
