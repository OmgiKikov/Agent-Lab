import { Bot, FileText } from "lucide-react";
import type { LabState } from "../types";
import { Tabs } from "../ui";
import { AgentView } from "./AgentView";
import { LogsView } from "./LogsView";

export type ConnectTab = "agent" | "logs";

/** Everything that connects the agent to the Lab: where it is and what its real conversations look like. */
export function ConnectView({ state, tab, onTab, onOpenTrace, go }: { state: LabState; tab: ConnectTab; onTab: (t: ConnectTab) => void; onOpenTrace: (id: string) => void; go: (to: string) => void }) {
  const nav = (
    <Tabs flush value={tab} onChange={onTab} tabs={[
      { value: "agent", label: <><Bot className="size-3.5" />Агент и модели</> },
      { value: "logs", label: <><FileText className="size-3.5" />Логи</> },
    ]} />
  );
  return tab === "agent" ? <AgentView state={state} nav={nav} /> : <LogsView state={state} nav={nav} onOpen={onOpenTrace} onGo={() => go("/lab/connect")} />;
}
