import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { MessageSquare, Search } from "lucide-react";
import { Button } from "../ui/Button";
import { useShell } from "./ShellContext";

export type Crumb = { label: string; to?: string };

/** The header of every section: where you are, the section's actions, ⌘K and «Спросить»; below it, the section's task. */
export function SectionHeader({ crumbs, actions, below, meta }: { crumbs: Crumb[]; actions?: ReactNode; below?: ReactNode; meta?: ReactNode }) {
  const shell = useShell();
  return (
    <header className="flex-shrink-0 border-b border-white/[0.08] bg-lab-bg">
      <div className="flex h-11 items-center gap-2 px-[17px]">
        <nav aria-label="Путь" className="flex min-w-0 flex-1 items-center gap-2 text-heading font-medium">
          {crumbs.map((c, i) => (
            <span key={c.label} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && <span aria-hidden className="flex-shrink-0 text-lab-faint">/</span>}
              {c.to && i < crumbs.length - 1
                ? <Link to={c.to} className="max-w-[240px] flex-shrink-0 truncate text-lab-mute transition-colors hover:text-lab-text">{c.label}</Link>
                : <span className="max-w-[420px] truncate text-lab-ink">{c.label}</span>}
            </span>
          ))}
          {meta && <span className="ml-1 flex min-w-0 items-center gap-2 truncate text-meta font-normal text-lab-dim"><span aria-hidden>·</span>{meta}</span>}
        </nav>
        {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
        <div className="hidden flex-shrink-0 items-center gap-1 border-l border-white/[0.08] pl-2 md:flex">
          <Button variant="ghost" size="sm" icon={Search} title="Найти (⌘K)" aria-label="Найти" onClick={shell.openPalette} />
          <Button variant="ghost" size="sm" icon={MessageSquare} title="Спросить ассистента (⌘J)" aria-label="Спросить" onClick={() => shell.openAsk()} />
        </div>
      </div>
      {below}
    </header>
  );
}
