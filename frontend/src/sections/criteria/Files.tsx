import { Database, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Criterion } from "../../lab/criteria";
import type { Source } from "../../lab/types";
import { Label } from "../../ui/Label";
import { nameOf, toneOf, type SideKey } from "./model";

/** A source of the agent's code with how many of its criteria there are and how many are broken on the side shown. */
type FileRow = { s: Source; n: number; broken: number };

/**
 * One file of the list. A component of its own, not one made in the list's render: a new one each render would mount
 * its button anew, and the keyboard's focus would be lost after Enter.
 */
function Row({ r, on, onOpen }: { r: FileRow; on: boolean; onOpen: (id: string) => void }) {
  const { file, dir } = nameOf(r.s);
  const Icon = r.s.kind === "tools" ? Database : FileText;
  return (
    <button
      type="button"
      onClick={() => onOpen(r.s.id)}
      aria-current={on ? "true" : undefined}
      title={r.s.origin}
      className={cn(
        "grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60",
        on ? "bg-raised" : "hover:bg-hover",
        !r.n && "opacity-60",
      )}
    >
      <Icon aria-hidden className="size-3.5 text-fg-3" />
      <span className="min-w-0">
        <span className={cn("block truncate font-mono text-small", on ? "text-fg" : "text-fg-2")}>{file}</span>
        {dir && <span className="block truncate font-mono text-label text-fg-4">{dir}</span>}
      </span>
      <span className="text-small tabular-nums text-fg-3">
        {r.n ? (
          <>
            <b className={cn("font-medium", r.broken ? "text-bad" : "text-ok")}>{r.broken}</b>
            {"\u00a0"}из{"\u00a0"}
            {r.n}
          </>
        ) : (
          "—"
        )}
      </span>
    </button>
  );
}

/** The agent's code as it was read: prompts and tools, each with how many of its criteria are broken on this side. */
export function Files({
  sources,
  list,
  side,
  current,
  onOpen,
}: {
  sources: Source[];
  list: Criterion[];
  side: SideKey;
  current: string | null;
  onOpen: (id: string) => void;
}) {
  const rows: FileRow[] = sources.map((s) => {
    const mine = list.filter((c) => c.r.rule.sourceId === s.id);
    return { s, n: mine.length, broken: mine.filter((c) => toneOf(c.r, side) === "bad").length };
  });
  const prompts = rows
    .filter((r) => r.s.kind !== "tools")
    .sort((a, b) => b.broken - a.broken || b.n - a.n || nameOf(a.s).file.localeCompare(nameOf(b.s).file));
  const tools = rows.filter((r) => r.s.kind === "tools");
  return (
    <nav aria-label="Источники критериев" className="min-h-0 overflow-auto border-r border-line bg-list px-2 py-3">
      <Label className="block px-2 pb-2">Инструкции</Label>
      {prompts.map((r) => (
        <Row key={r.s.id} r={r} on={r.s.id === current} onOpen={onOpen} />
      ))}
      {tools.length > 0 && <Label className="block px-2 pb-2 pt-4">Инструменты</Label>}
      {tools.map((r) => (
        <Row key={r.s.id} r={r} on={r.s.id === current} onOpen={onOpen} />
      ))}
      <div className="mx-2 mt-5 space-y-1.5 border-t border-line pt-3 text-small text-fg-3">
        <p className="flex items-center gap-2">
          <span aria-hidden className="h-3.5 w-1 rounded-sm bg-bad" />
          ошибка хотя бы в одном разговоре
        </p>
        <p className="flex items-center gap-2">
          <span aria-hidden className="h-3.5 w-1 rounded-sm bg-ok/80" />
          без найденных ошибок
        </p>
        <p className="flex items-center gap-2">
          <span aria-hidden className="stripe-unknown h-3.5 w-1 rounded-sm" />
          не удалось проверить
        </p>
      </div>
    </nav>
  );
}
