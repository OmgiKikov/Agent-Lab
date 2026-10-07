import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { SECTIONS } from "./links";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Menu } from "../ui/Menu";
import { isActive, SETUP, WORK, type NavItem } from "./Sidebar";

function MobileItem({ item }: { item: NavItem }) {
  const { pathname } = useLocation();
  const on = isActive(item, pathname);
  return (
    <NavLink
      to={item.to}
      aria-current={on ? "page" : undefined}
      className={cn(
        "relative flex min-h-11 min-w-0 flex-col items-center justify-center gap-0.5 px-0.5 text-label font-medium transition-colors min-[380px]:text-small",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-run/60",
        on ? "text-fg" : "text-fg-3",
      )}
    >
      <span className="flex h-5 items-center">
        <item.icon aria-hidden className="size-5" strokeWidth={1.75} />
      </span>
      <span className="max-w-full truncate">{item.mobileLabel ?? item.label}</span>
    </NavLink>
  );
}

/** A phone keeps the work in sight: «Обзор · Tone · Точность · Симуляции»; the agent, settings and all agents under «Ещё». */
export function BottomNav() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const more = pathname === SECTIONS.data || SETUP.some((item) => isActive(item, pathname));
  return (
    <nav
      aria-label="Разделы"
      className="fixed inset-x-0 bottom-0 z-30 grid h-[calc(56px+env(safe-area-inset-bottom))] grid-cols-5 border-t border-line bg-list pb-[env(safe-area-inset-bottom)] lg:hidden print:hidden"
    >
      {WORK.map((item) => (
        <MobileItem key={item.to} item={item} />
      ))}
      <Menu
        up
        align="right"
        className={cn(
          "h-full min-h-11",
          "[&_[role^=menuitem]]:min-h-11 [&_[role^=menuitem]]:items-center",
          more ? "text-fg" : "text-fg-3",
        )}
        trigger={
          <span className="flex flex-col items-center justify-center gap-0.5 px-1 text-label font-medium min-[380px]:text-small">
            <MoreHorizontal aria-hidden className="size-5 shrink-0" strokeWidth={1.75} />
            Ещё
          </span>
        }
        items={[
          {
            key: "data",
            label: "Выгрузка диалогов",
            on: pathname === SECTIONS.data,
            run: () => navigate(SECTIONS.data),
          },
          ...SETUP.map((i) => ({
            key: i.to,
            label: i.label,
            on: isActive(i, pathname),
            run: () => navigate(i.to),
          })),
          // Another agent is another address: a full move, outside this agent's router.
          { key: "agents", label: "Все агенты", run: () => window.location.assign("/agents") },
        ]}
      />
    </nav>
  );
}
