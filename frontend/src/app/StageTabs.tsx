import { useEffect, useRef } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { cn } from "@/lib/utils";
import { historyLink, SECTIONS, stageRoot, type Stage } from "./links";

type Tab = { to: string; label: string; count?: number; end?: boolean };

/**
 * The pages of a section. A check: its result, its conversations, the person's check, its criteria and the history of
 * its checks. The simulation: its result, runs, scenarios, conversations and check; the run being looked at travels
 * with the tabs.
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
  const row = useRef<HTMLElement>(null);
  // On a phone the tabs scroll sideways: the open one is brought into the row, not left cut at its edge — again when
  // the tabs change size (the font arrives, a count appears). The row says which tab is open (aria-current), not the
  // router: «Итог» at /accuracy would match every page of the section.
  useEffect(() => {
    const nav = row.current;
    if (!nav) return;
    const show = () => {
      const tab = nav.querySelector<HTMLElement>('[aria-current="page"]');
      if (!tab) return;
      const box = nav.getBoundingClientRect();
      const at = tab.getBoundingClientRect();
      if (at.right > box.right) nav.scrollLeft += at.right - box.right + 16;
      else if (at.left < box.left) nav.scrollLeft -= box.left - at.left + 16;
    };
    const sizes = new ResizeObserver(show);
    for (const tab of nav.children) sizes.observe(tab);
    return () => sizes.disconnect();
  }, [pathname]);
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
          { to: `${SECTIONS.simulations}/review${keep}`, label: "Проверка", count: counts.review },
        ]
      : [
          { to: root, label: "Итог", end: true },
          { to: `${root}/conversations`, label: "Разговоры", count: counts.conversations },
          { to: `${root}/review`, label: "Проверка", count: counts.review },
          { to: `${root}/criteria`, label: "Критерии" },
          { to: historyLink(stage), label: "История" },
        ];
  const problemsOpen = pathname.includes("/problems/");
  return (
    <nav ref={row} aria-label="Страницы раздела" className="-mb-px flex gap-6 overflow-x-auto px-4 lg:px-10">
      {tabs.map((t) => {
        const path = t.to.split("?")[0];
        const on = t.end
          ? pathname === path || (problemsOpen && path === `/${pathname.split("/")[1]}`)
          : pathname === path || pathname.startsWith(`${path}/`);
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
