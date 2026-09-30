import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, MessageSquare, Search } from "lucide-react";
import { AGENT_TITLE } from "../lab/look";
import { Button } from "../ui/Button";
import { useShell } from "./ShellContext";

export type Crumb = { label: string; to?: string };

/** The header of every section: where you are, the section's actions, ⌘K and «Спросить»; below it, the section's task. */
export function SectionHeader({ crumbs, actions, below }: { crumbs: Crumb[]; actions?: ReactNode; below?: ReactNode }) {
  const shell = useShell();
  return (
    <header className="flex-shrink-0 border-b border-white/[0.06] bg-lab-bg">
      <div className="flex h-10 items-center gap-3 px-4">
        <nav aria-label="Путь" className="flex min-w-0 flex-1 items-center gap-1.5 text-small">
          <Link to="/problems" className="truncate text-lab-mute transition-colors hover:text-lab-text">{AGENT_TITLE}</Link>
          {crumbs.map(c => (
            <span key={c.label} className="flex min-w-0 items-center gap-1.5">
              <ChevronRight className="size-3.5 flex-shrink-0 text-lab-faint" />
              {c.to
                ? <Link to={c.to} className="truncate text-lab-mute transition-colors hover:text-lab-text">{c.label}</Link>
                : <span className="truncate text-lab-ink">{c.label}</span>}
            </span>
          ))}
        </nav>
        {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
        <div className="hidden flex-shrink-0 items-center gap-1 border-l border-white/[0.06] pl-2 md:flex">
          <Button variant="ghost" size="sm" icon={Search} title="Найти (⌘K)" aria-label="Найти" onClick={shell.openPalette} />
          <Button variant="ghost" size="sm" icon={MessageSquare} title="Спросить ассистента (⌘J)" aria-label="Спросить" onClick={() => shell.openAsk()} />
        </div>
      </div>
      {below}
    </header>
  );
}
