import { Link, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";
import { criterionLink, judgesLink, type Check } from "../../app/links";

/** The criteria in saved evidence and the rules for the next check are related, but never the same editable record. */
export function CriteriaNav({ check }: { check: Check }) {
  const { pathname } = useLocation();
  return (
    <nav aria-label="Критерии и правила" className="flex flex-wrap gap-2 border-b border-line px-4 py-3 lg:px-10">
      {[
        { to: criterionLink(check), label: "Разбор критериев" },
        { to: judgesLink(check), label: "Правила для запуска" },
      ].map(({ to, label }) => (
        <Link
          key={to}
          to={to}
          aria-current={pathname === to ? "page" : undefined}
          className={cn(
            "rounded-control px-3 py-2 text-small font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60",
            pathname === to ? "bg-selected text-fg" : "text-fg-3 hover:bg-hover hover:text-fg",
          )}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
