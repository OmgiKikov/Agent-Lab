import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Menu } from "../ui/Menu";
import { SECTIONS } from "./links";
import { isActive, useNav } from "./Sidebar";

/** On a phone and a narrow window the sections move to the bottom: five places, each with its word. */
export function BottomNav({ counts }: { counts: { violations?: number; dialogs?: number; criteria?: number } }) {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const all = useNav(counts);
  const items = all.slice(0, 4);
  const more = pathname.startsWith("/agent") && !pathname.startsWith("/agent/criteria") || pathname.startsWith("/settings");
  return (
    <nav aria-label="Разделы" className="fixed inset-x-0 bottom-0 z-30 grid h-14 grid-cols-5 border-t border-line bg-side pb-[env(safe-area-inset-bottom)] lg:hidden">
      {items.map(item => {
        const on = isActive(item, pathname, search);
        return (
          <NavLink key={item.label} to={item.to} aria-current={on ? "page" : undefined}
            className={cn("relative flex flex-col items-center justify-center gap-0.5 text-label transition-colors", on ? "text-fg" : "text-fg-3")}>
            <span className="relative">
              <item.icon aria-hidden className="size-5" strokeWidth={1.75} />
              {item.tone === "bad" && !!item.count && <span className="absolute -right-1 -top-0.5 size-2 rounded-full border-2 border-side bg-bad" aria-label={`${item.count} нарушений`} />}
            </span>
            {item.label}
          </NavLink>
        );
      })}
      <Menu up align="right" className={cn("h-full", more ? "text-fg" : "text-fg-3")}
        trigger={<span className="flex flex-col items-center justify-center gap-0.5 text-label"><MoreHorizontal aria-hidden className="size-5" strokeWidth={1.75} />Ещё</span>}
        items={[{ key: "agent", label: "Агент", sub: "подключение и код", on: pathname.startsWith("/agent"), run: () => navigate(SECTIONS.agent) }, { key: "settings", label: "Настройки", sub: "модели, ключи, ассистент", on: pathname.startsWith("/settings"), run: () => navigate(SECTIONS.settings) }]} />
    </nav>
  );
}
