import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { when } from "./format";
import { AGENT_TITLE } from "./look";
import type { Scope } from "./useScope";
import { Button, Chip, inputClass, Segmented } from "./ui";

/**
 * The bar above every screen: which agent, which version, which dialogues (real logs, simulator, both), against which earlier version.
 * Chosen here once; the criteria, the dialogues and the numbers all follow.
 */
export function ScopeBar({ scope, onPick, onAdd }: { scope: Scope; onPick: (runId: string) => void; onAdd: () => void }) {
  const { finished, sameAgent, counts } = scope;
  const versions = [...sameAgent].reverse();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 pb-2.5 pt-0.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.09em] text-lab-dim">оцениваем</span>
      <span className="text-[12px] text-lab-text">{finished?.targetName ?? AGENT_TITLE}</span>
      {versions.length > 0 && (
        <select
          value={finished?.id ?? ""} onChange={e => onPick(e.target.value)} aria-label="Версия агента"
          className={cn(inputClass, "h-6 w-auto cursor-pointer rounded-md py-0 pl-2 pr-6 text-[12px]")}
        >
          {versions.map(r => <option key={r.id} value={r.id}>{r.version} · {when(r.startedAt)}</option>)}
        </select>
      )}
      <Segmented
        value={scope.src} onChange={scope.setSrc}
        options={[
          { value: "all", label: <>Все <span className="font-mono text-[10px] text-lab-dim">{counts.all}</span></>, title: "Настоящие логи и симулятор вместе" },
          { value: "log", label: <>Логи <span className="font-mono text-[10px] text-lab-dim">{counts.log}</span></>, title: "Настоящие разговоры из выгрузки" },
          { value: "sim", label: <>Симулятор <span className="font-mono text-[10px] text-lab-dim">{counts.sim}</span></>, title: "Разговоры, которые сыграл искусственный клиент" },
        ]}
      />
      {scope.canCompare && (
        <Chip on={scope.comparing} onClick={() => scope.setCompare(!scope.compare)}>сравнить с {scope.previous?.version}</Chip>
      )}
      <Button className="ml-auto" size="sm" variant="primary" icon={Plus} onClick={onAdd}>Добавить диалоги</Button>
    </div>
  );
}
