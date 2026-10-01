import { Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, MessageSquare, Search } from "lucide-react";
import { useShell } from "./ShellContext";
import { Button } from "../ui/Button";

export type Crumb = { label: string; to: string };

/**
 * The head of a section, the same everywhere: where you are on the left (the section, and the page inside it),
 * the section's actions on the right (one in petrol, the main one) and the assistant; below it, the section's own task while it runs.
 * Search lives in the navigation; on a phone, here.
 */
export function Header({ title, crumbs, sub, actions, below }: { title: ReactNode; crumbs?: Crumb[]; sub?: ReactNode; actions?: ReactNode; below?: ReactNode }) {
  const shell = useShell();
  return (
    <header className="flex-shrink-0 border-b border-line bg-canvas">
      <div className="flex h-14 items-center gap-2 px-4 lg:px-8">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 text-body">
            {crumbs?.map(c => (
              <Fragment key={c.to}>
                <Link to={c.to} className="flex-shrink-0 rounded-sm text-fg-3 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60">{c.label}</Link>
                <ChevronRight aria-hidden className="size-3.5 flex-shrink-0 text-fg-4" />
              </Fragment>
            ))}
            <h1 className="truncate font-semibold text-fg">{title}</h1>
          </div>
          {sub && <div className="truncate text-meta text-fg-3 lg:hidden">{sub}</div>}
        </div>
        <Button variant="ghost" icon={Search} aria-label="Поиск" title="Поиск (⌘K)" onClick={shell.openPalette} className="lg:hidden" />
        <Button variant="ghost" icon={MessageSquare} onClick={() => shell.openAsk()} title="Спросить ассистента (⌘J)" className="hidden md:inline-flex">Спросить</Button>
        {actions}
      </div>
      {below}
    </header>
  );
}
