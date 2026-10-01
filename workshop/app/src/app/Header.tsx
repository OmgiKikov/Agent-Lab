import type { ReactNode } from "react";
import { MessageSquare, Search } from "lucide-react";
import { useShell } from "./ShellContext";
import { Button } from "../ui/Button";
import { Kbd } from "../ui/Kbd";

/**
 * The head of a section, the same everywhere: where you are on the left, the section's actions on the right
 * (one light, the main one), the search and the assistant; below it, the section's own task while it runs.
 */
export function Header({ title, sub, actions, below }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; below?: ReactNode }) {
  const shell = useShell();
  return (
    <header className="flex-shrink-0 border-b border-line bg-canvas">
      <div className="flex h-12 items-center gap-2 px-4 lg:px-5">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-body font-semibold text-fg">{title}</h1>
          {sub && <div className="truncate text-meta text-fg-3 lg:hidden">{sub}</div>}
        </div>
        <button type="button" onClick={shell.openPalette} className="hidden h-8 w-56 items-center gap-2 rounded-control border border-line px-2.5 text-small text-fg-3 transition-colors hover:border-line-strong hover:text-fg-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60 xl:flex">
          <Search aria-hidden className="size-3.5" />Найти<Kbd className="ml-auto">⌘K</Kbd>
        </button>
        <Button variant="ghost" icon={Search} aria-label="Найти (⌘K)" onClick={shell.openPalette} className="xl:hidden" />
        <Button variant="ghost" icon={MessageSquare} onClick={() => shell.openAsk()} className="hidden md:inline-flex">Спросить</Button>
        {actions}
      </div>
      {below}
    </header>
  );
}
