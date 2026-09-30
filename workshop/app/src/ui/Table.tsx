import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Search } from "lucide-react";
import { cn } from "@/lib/utils";

export type Col<T> = {
  key: string; label: string; width?: string; align?: "left" | "right";
  /** Sorting by this column: compare two rows, ascending. */
  sort?: (a: T, b: T) => number;
  cell: (row: T) => ReactNode;
  title?: string;
};

/** The bar over a table as Raindrop's Issues has it: a search box that owns the row, a filter and the like on its right. */
export function ListBar({ query, onQuery, placeholder = "Найти…", label, filter, end }: {
  query: string; onQuery: (q: string) => void; placeholder?: string; label: string; filter?: ReactNode; end?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded border border-white/[0.08] bg-lab-surface px-3 text-lab-dim focus-within:border-white/25">
        <Search aria-hidden className="size-3.5 flex-shrink-0" />
        {filter}
        <input value={query} onChange={e => onQuery(e.target.value)} placeholder={placeholder} name="q" autoComplete="off" aria-label={label}
          className="min-w-0 flex-1 bg-transparent font-mono text-meta text-lab-text outline-none placeholder:text-lab-faint" />
      </label>
      {end}
    </div>
  );
}

/**
 * Raindrop's Issues table: one bordered box, a quiet header whose columns sort, a row per object.
 * The first column carries the object (title, a line of description, tags), the others are numbers.
 */
export function Table<T>({ rows, cols, rowKey, onOpen, initial, empty, className }: {
  rows: T[]; cols: Col<T>[]; rowKey: (row: T) => string; onOpen?: (row: T) => void;
  initial?: { key: string; dir: 1 | -1 }; empty?: ReactNode; className?: string;
}) {
  const [sort, setSort] = useState(initial ?? null);
  const sorted = useMemo(() => {
    const col = sort && cols.find(c => c.key === sort.key);
    return col?.sort ? [...rows].sort((a, b) => sort!.dir * col.sort!(a, b)) : rows;
  }, [rows, cols, sort]);
  const grid = { gridTemplateColumns: cols.map(c => c.width ?? "minmax(0,1fr)").join(" ") };
  const toggle = (c: Col<T>) => c.sort && setSort(s => (s?.key === c.key ? { key: c.key, dir: (s.dir * -1) as 1 | -1 } : { key: c.key, dir: -1 }));
  return (
    <div className={cn("overflow-x-auto rounded border border-white/[0.08]", className)}>
      <div className="min-w-[720px]">
        <div role="row" style={grid} className="grid items-center gap-x-4 border-b border-white/[0.08] bg-lab-surface px-4 py-2 text-meta text-lab-mute">
          {cols.map(c => {
            const on = sort?.key === c.key;
            const Arrow = on && sort!.dir === 1 ? ArrowUp : ArrowDown;
            return c.sort ? (
              <button key={c.key} type="button" onClick={() => toggle(c)} title={c.title} aria-sort={on ? (sort!.dir === 1 ? "ascending" : "descending") : "none"}
                className={cn("inline-flex items-center gap-1 transition-colors hover:text-lab-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-lab-accent", c.align === "right" ? "justify-end" : "justify-start", on && "text-lab-ink")}>
                {c.label}{on && <Arrow aria-hidden className="size-3" />}
              </button>
            ) : <div key={c.key} title={c.title} className={cn(c.align === "right" && "text-right")}>{c.label}</div>;
          })}
        </div>
        {sorted.map(row => (
          <button key={rowKey(row)} type="button" role="row" onClick={() => onOpen?.(row)} style={grid}
            className="grid w-full items-center gap-x-4 border-b border-white/[0.08] px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-lab-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-lab-accent">
            {cols.map(c => <div key={c.key} className={cn("min-w-0", c.align === "right" && "text-right")}>{c.cell(row)}</div>)}
          </button>
        ))}
        {!sorted.length && (empty ?? <div className="px-4 py-10 text-center text-small text-lab-dim">Ничего нет</div>)}
      </div>
    </div>
  );
}

/** The first cell of a row: a title, a line of description, then tags. */
export function Lead({ title, sub, tags, lead }: { title: ReactNode; sub?: ReactNode; tags?: ReactNode; lead?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      {lead}
      <div className="min-w-0 flex-1">
        <div className="truncate text-small font-medium text-lab-ink">{title}</div>
        {sub && <div className="mt-0.5 truncate text-meta text-lab-mute">{sub}</div>}
        {tags && <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">{tags}</div>}
      </div>
    </div>
  );
}

/** «7 из 40» with a thin bar of the share under it; the number is the row's own count. */
export function Share({ n, of, tone = "bad", title }: { n: number; of: number; tone?: "bad" | "mute"; title?: string }) {
  const share = of ? Math.max(0, Math.min(1, n / of)) : 0;
  return (
    <div title={title} className="ml-auto w-[104px]">
      <div className="flex items-baseline justify-end gap-1 whitespace-nowrap text-small">
        <span className="font-medium text-lab-ink">{n}</span><span className="text-meta text-lab-dim">из {of}</span>
      </div>
      <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-white/[0.16]" aria-hidden>
        <div className={cn("h-full rounded-full", tone === "bad" ? "bg-lab-bad" : "bg-white/50")} style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}
