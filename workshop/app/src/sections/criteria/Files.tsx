import { Database, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Criterion } from "../../lab/criteria";
import type { Source } from "../../lab/types";
import { Label } from "../../ui/Label";
import { nameOf, toneOf, type SideKey } from "./model";

/** The agent's code as it was read: prompts and tools, each with how many of its criteria are broken on this side. */
export function Files({ sources, list, side, current, onOpen }: { sources: Source[]; list: Criterion[]; side: SideKey; current: string | null; onOpen: (id: string) => void }) {
  const rows = sources.map(s => {
    const mine = list.filter(c => c.r.rule.sourceId === s.id);
    return { s, n: mine.length, broken: mine.filter(c => toneOf(c.r, side) === "bad").length };
  });
  const prompts = rows.filter(r => r.s.kind !== "tools").sort((a, b) => b.broken - a.broken || b.n - a.n || nameOf(a.s).file.localeCompare(nameOf(b.s).file));
  const tools = rows.filter(r => r.s.kind === "tools");
  const Row = ({ r }: { r: (typeof rows)[number] }) => {
    const { file, dir } = nameOf(r.s);
    const on = r.s.id === current;
    const Icon = r.s.kind === "tools" ? Database : FileText;
    return (
      <button type="button" onClick={() => onOpen(r.s.id)} aria-current={on ? "true" : undefined} title={r.s.origin}
        className={cn("grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-2 rounded-control px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60", on ? "bg-raised" : "hover:bg-hover", !r.n && "opacity-60")}>
        <Icon aria-hidden className="size-3.5 text-fg-3" />
        <span className="min-w-0">
          <span className={cn("block truncate font-mono text-small", on ? "text-fg" : "text-fg-2")}>{file}</span>
          {dir && <span className="block truncate font-mono text-label text-fg-4">{dir}</span>}
        </span>
        <span className="font-mono text-meta text-fg-3">{r.n ? <><b className={cn("font-medium", r.broken ? "text-bad" : "text-ok")}>{r.broken}</b> из {r.n}</> : "—"}</span>
      </button>
    );
  };
  return (
    <nav aria-label="Код агента" className="min-h-0 overflow-auto border-r border-line bg-list px-2 py-3">
      <Label className="block px-2 pb-2">Промпты</Label>
      {prompts.map(r => <Row key={r.s.id} r={r} />)}
      {tools.length > 0 && <Label className="block px-2 pb-2 pt-4">Инструменты</Label>}
      {tools.map(r => <Row key={r.s.id} r={r} />)}
      <div className="mx-2 mt-5 space-y-1.5 border-t border-line pt-3 text-meta text-fg-3">
        <p className="flex items-center gap-2"><span aria-hidden className="h-3.5 w-1 rounded-sm bg-bad" />нарушен хотя бы в одном разговоре</p>
        <p className="flex items-center gap-2"><span aria-hidden className="h-3.5 w-1 rounded-sm bg-ok/80" />выполнен, нарушений не найдено</p>
        <p className="flex items-center gap-2"><span aria-hidden className="stripe-unknown h-3.5 w-1 rounded-sm" />не проверен: нет доказательств</p>
      </div>
    </nav>
  );
}
