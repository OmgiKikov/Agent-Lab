import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

/** Проблемы and Правила are two views of one section: the violated rules, and all of them. */
export function ViewTabs({ active, problems, rules }: { active: "problems" | "rules"; problems: number; rules: number }) {
  const tab = (on: boolean) => cn("inline-flex h-6 items-center gap-1.5 rounded px-2 font-mono text-meta transition-colors", on ? "bg-lab-active text-lab-ink" : "text-lab-dim hover:text-lab-text");
  return (
    <nav aria-label="Вид" className="flex flex-shrink-0 gap-0.5">
      <Link to="/problems" className={tab(active === "problems")}>Нарушения<span className="text-lab-dim">{problems}</span></Link>
      <Link to="/rules" className={tab(active === "rules")}>Все правила<span className="text-lab-dim">{rules}</span></Link>
    </nav>
  );
}
