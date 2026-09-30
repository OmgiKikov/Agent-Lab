import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { useCriteria } from "../../lab/criteria";
import { JobStrip } from "../../shell/Activity";
import { LINKS } from "../../shell/links";
import { useLabState } from "../../shell/LabProvider";
import { SectionHeader } from "../../shell/SectionHeader";
import { ServiceDown } from "../../ui/EmptyState";
import { Criteria } from "./Criteria";
import { Parts } from "./Parts";

/**
 * Агент: who is checked and by which rules. Two tabs of one page: «Агент» — what it is made of (prompts, bank
 * systems) — and «Критерии» — what it must do. Both are grids of cards; a card opens as a panel over the grid.
 */
export function AgentPage() {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const { state, offline } = useLabState();
  const { list, topics, unnamed } = useCriteria(null);
  // Old links: ?tab=criteria, ?tab=code, ?sources=1.
  if (params.get("tab") === "criteria") return <Navigate to={`${LINKS.criteria}${params.get("c") ? `?c=${encodeURIComponent(params.get("c")!)}` : ""}`} replace />;
  if (params.get("tab") || params.get("sources")) return <Navigate to={LINKS.agent} replace />;
  if (offline && !state) return <ServiceDown />;
  const criteria = pathname.startsWith(LINKS.criteria);
  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        crumbs={[{ label: "Агент эквайринга" }]}
        tabs={[
          { label: "Агент", to: LINKS.agent, on: !criteria },
          { label: <>Критерии{list.length > 0 && <span className="ml-1 text-lab-dim">{list.length}</span>}</>, to: LINKS.criteria, on: criteria },
        ]}
        below={<JobStrip kinds={["sources", "names"]} />}
      />
      {criteria ? <Criteria criteria={list} topics={topics} unnamed={unnamed} /> : <Parts criteria={list} />}
    </div>
  );
}
