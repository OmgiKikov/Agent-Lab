import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";
import { Menu } from "../ui/Menu";
import { isActive, SETUP, useNav, type NavCounts, type NavItem } from "./Sidebar";

function MobileItem({ item }: { item: NavItem }) {
  const { pathname } = useLocation();
  const on = isActive(item, pathname);
  return (
    <NavLink
      to={item.to}
      aria-current={on ? "page" : undefined}
      className={cn(
        "relative flex min-h-11 flex-col items-center justify-center gap-0.5 px-1 text-small font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-run/60",
        on ? "text-fg" : "text-fg-3",
      )}
    >
      <item.icon aria-hidden className="size-5" strokeWidth={1.75} />
      {item.label}
    </NavLink>
  );
}

/** Three destinations on mobile: the guided check, workspace tools, and settings. */
export function BottomNav({ counts }: { counts: NavCounts }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const all = useNav(counts);
  const workspace = [...all.slice(1), SETUP[0]];
  const inWorkspace = workspace.some((item) => isActive(item, pathname));
  return (
    <nav
      aria-label="Разделы"
      className="fixed inset-x-0 bottom-0 z-30 grid h-[calc(56px+env(safe-area-inset-bottom))] grid-cols-3 border-t border-line bg-list pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      <MobileItem item={all[0]} />
      <Menu
        up
        align="right"
        className={cn(
          "h-full min-h-11",
          "[&_[role=menu]]:left-1/2 [&_[role=menu]]:right-auto [&_[role=menu]]:-translate-x-1/2",
          "[&_[role=menuitemradio]]:min-h-11 [&_[role=menuitemradio]]:items-center",
          inWorkspace ? "text-fg" : "text-fg-3",
        )}
        trigger={
          <span className="flex flex-col items-center justify-center gap-0.5 px-1 text-small font-medium leading-4">
            <LayoutGrid aria-hidden className="size-5 shrink-0" strokeWidth={1.75} />
            <span>Рабочая область</span>
          </span>
        }
        items={workspace.map((i) => ({
          key: i.label,
          label: i.label,
          on: isActive(i, pathname),
          run: () => navigate(i.to),
        }))}
      />
      <MobileItem item={SETUP[1]} />
    </nav>
  );
}
