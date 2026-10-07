import { Link, useLocation, useSearchParams } from "react-router-dom";
import { cn } from "@/lib/utils";
import { historyLink, SECTIONS, stageRoot, type Stage } from "./links";

type Tab = { to: string; label: string; count?: number; end?: boolean };

/**
 * The pages of a section. A check: its result, its conversations, the person's check, its criteria (with its rules)
 * and the history of its checks; a new check is the header's action, not a tab. The simulation: its result, runs,
 * scenarios, conversations and check; the run being looked at travels with the tabs. A tab is never cut: on a narrow
 * screen the ones that do not fit go to a second row (a tab cut at the edge read as «Ис», with nothing to say the bar
 * scrolls). The row says which tab is open (aria-current), not the
 * router: «Итог» at /accuracy would match every page of the section.
 */
export function StageTabs({
  stage,
  counts = {},
}: {
  stage: Stage;
  counts?: { conversations?: number; review?: number; runs?: number; scenarios?: number };
}) {
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  const run = stage === "sim" ? params.get("run") : null;
  const keep = run ? `?run=${encodeURIComponent(run)}` : "";
  const root = stageRoot(stage);
  const tabs: Tab[] =
    stage === "sim"
      ? [
          { to: `${SECTIONS.simulations}${keep}`, label: "Итог", end: true },
          { to: `${SECTIONS.simulations}/runs`, label: "Прогоны", count: counts.runs },
          { to: `${SECTIONS.simulations}/scenarios`, label: "Сценарии", count: counts.scenarios },
          { to: `${SECTIONS.simulations}/conversations${keep}`, label: "Разговоры", count: counts.conversations },
          { to: `${SECTIONS.simulations}/review${keep}`, label: "Ответы людей", count: counts.review },
        ]
      : [
          { to: root, label: "Итог", end: true },
          { to: `${root}/conversations`, label: "Разговоры", count: counts.conversations },
          { to: `${root}/review`, label: "Ответы людей", count: counts.review },
          { to: `${root}/criteria`, label: "Критерии" },
          { to: historyLink(stage), label: "История" },
        ];
  const problemsOpen = pathname.includes("/problems/");
  return (
    <nav aria-label="Страницы раздела" className="-mb-px flex flex-wrap gap-x-6 px-4 lg:px-10">
      {tabs.map((t) => {
        const path = t.to.split("?")[0];
        // A launch's report belongs to the history it is listed in.
        const related = path === `${root}/history` && pathname.startsWith(`${root}/launches/`);
        const on =
          related ||
          (t.end
            ? pathname === path || (problemsOpen && path === `/${pathname.split("/")[1]}`)
            : pathname === path || pathname.startsWith(`${path}/`));
        return (
          <Link
            key={t.label}
            to={t.to}
            aria-current={on ? "page" : undefined}
            className={cn(
              "flex h-10 flex-shrink-0 items-center gap-1.5 border-b-2 text-body font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60",
              on ? "border-fg text-fg" : "border-transparent text-fg-3 hover:text-fg",
            )}
          >
            {t.label}
            {t.count !== undefined && t.count > 0 && (
              <span className="text-small tabular-nums text-fg-3">{t.count}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
