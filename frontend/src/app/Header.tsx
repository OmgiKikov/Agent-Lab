import { Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Search } from "lucide-react";
import { useShell } from "./ShellContext";
import { Button } from "../ui/Button";

export type Crumb = { label: string; to: string };

/**
 * The head of a page, the same everywhere: where you are on the left (the place, and the page inside it), the page's
 * actions on the right (one black pill, the main one); under it the place's tabs and its running task.
 * Search lives in the navigation; on a phone, here.
 */
export function Header({
  title,
  crumbs,
  sub,
  actions,
  tabs,
  below,
}: {
  title: ReactNode;
  crumbs?: Crumb[];
  sub?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
  below?: ReactNode;
}) {
  const shell = useShell();
  return (
    <header className="flex-shrink-0 border-b border-line bg-canvas/90 backdrop-blur">
      <div className="flex min-h-16 flex-wrap items-center gap-2 px-4 py-3 sm:h-16 sm:flex-nowrap sm:py-0 lg:px-10">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            {crumbs?.map((c) => (
              <Fragment key={c.to}>
                <Link
                  to={c.to}
                  className="flex-shrink-0 rounded-sm text-lead text-fg-3 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
                >
                  {c.label}
                </Link>
                <ChevronRight aria-hidden className="size-4 flex-shrink-0 text-fg-4" />
              </Fragment>
            ))}
            <h1 className="truncate text-lead font-semibold text-fg">{title}</h1>
          </div>
          {sub && <div className="truncate text-small text-fg-3 lg:hidden">{sub}</div>}
        </div>
        <Button
          variant="ghost"
          icon={Search}
          aria-label="Поиск"
          title="Поиск (⌘K)"
          onClick={shell.openPalette}
          className="lg:hidden"
        />
        {actions && <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">{actions}</div>}
      </div>
      {tabs}
      {below}
    </header>
  );
}
