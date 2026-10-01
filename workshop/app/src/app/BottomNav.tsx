import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Step } from "../product/Step";
import { Menu } from "../ui/Menu";
import { isActive, SETUP, useNav, type NavCounts } from "./Sidebar";

/** On a phone and a narrow window the sections move to the bottom: four places with their words, and «Ещё» for the rest. */
export function BottomNav({ counts }: { counts: NavCounts }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const all = useNav(counts);
  const items = all.slice(0, 4);
  const rest = [...all.slice(4), ...SETUP];
  const more = rest.some(i => isActive(i, pathname));
  return (
    <nav aria-label="Разделы" className="fixed inset-x-0 bottom-0 z-30 grid h-14 grid-cols-5 border-t border-line bg-list pb-[env(safe-area-inset-bottom)] lg:hidden">
      {items.map(item => {
        const on = isActive(item, pathname);
        return (
          <NavLink key={item.label} to={item.to} aria-current={on ? "page" : undefined}
            className={cn("relative flex flex-col items-center justify-center gap-0.5 text-label font-medium transition-colors", on ? "text-fg" : "text-fg-3")}>
            <span className="flex h-5 items-center">
              {item.step ? <Step n={item.step} on={on} size="sm" /> : <item.icon aria-hidden className="size-5" strokeWidth={1.75} />}
            </span>
            {item.label}
          </NavLink>
        );
      })}
      <Menu up align="right" className={cn("h-full", more ? "text-fg" : "text-fg-3")}
        trigger={<span className="flex flex-col items-center justify-center gap-0.5 text-label font-medium"><MoreHorizontal aria-hidden className="size-5" strokeWidth={1.75} />Ещё</span>}
        items={rest.map(i => ({ key: i.label, label: i.label, on: isActive(i, pathname), run: () => navigate(i.to) }))} />
    </nav>
  );
}
