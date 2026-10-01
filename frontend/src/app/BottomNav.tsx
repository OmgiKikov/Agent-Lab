import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Step } from "../product/Step";
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
        "relative flex min-h-11 min-w-0 flex-col items-center justify-center gap-0.5 px-1 text-label font-medium transition-colors min-[380px]:text-small",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-run/60",
        on ? "text-fg" : "text-fg-3",
      )}
    >
      <span className="flex h-5 items-center">
        {item.step ? (
          <Step n={item.step} on={on} size="sm" />
        ) : (
          <item.icon aria-hidden className="size-5" strokeWidth={1.75} />
        )}
      </span>
      {item.mobileLabel ?? item.label}
    </NavLink>
  );
}

/** The first four product destinations stay visible; the rest fit under «Ещё». */
export function BottomNav({ counts }: { counts: NavCounts }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const all = useNav(counts);
  const items = all.slice(0, 4);
  const rest = [...all.slice(4), ...SETUP];
  const more = rest.some((item) => isActive(item, pathname));
  return (
    <nav
      aria-label="Разделы"
      className="fixed inset-x-0 bottom-0 z-30 grid h-[calc(56px+env(safe-area-inset-bottom))] grid-cols-5 border-t border-line bg-list pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {items.map((item) => (
        <MobileItem key={item.label} item={item} />
      ))}
      <Menu
        up
        align="right"
        className={cn(
          "h-full min-h-11",
          "[&_[role=menuitemradio]]:min-h-11 [&_[role=menuitemradio]]:items-center",
          more ? "text-fg" : "text-fg-3",
        )}
        trigger={
          <span className="flex flex-col items-center justify-center gap-0.5 px-1 text-label font-medium min-[380px]:text-small">
            <MoreHorizontal aria-hidden className="size-5 shrink-0" strokeWidth={1.75} />
            Ещё
          </span>
        }
        items={rest.map((i) => ({
          key: i.label,
          label: i.label,
          on: isActive(i, pathname),
          run: () => navigate(i.to),
        }))}
      />
    </nav>
  );
}
