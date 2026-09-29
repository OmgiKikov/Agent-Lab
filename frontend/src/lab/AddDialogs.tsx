import { FileText, MessagesSquare } from "lucide-react";
import { plural } from "./format";
import type { LabState } from "./types";

/** The two ways to get dialogues into the Lab: judge real ones from the logs, or let the simulator play the scenarios. */
export function AddDialogs({
  state,
  onLogs,
  onSimulator,
}: {
  state: LabState;
  onLogs: () => void;
  onSimulator: () => void;
}) {
  const cards = state.cards?.cards.length ?? 0;
  const option = (icon: React.ReactNode, title: string, text: string, onClick: () => void) => (
    <button
      onClick={onClick}
      className="flex w-full items-start gap-3.5 rounded-xl border border-white/[0.1] bg-white/[0.02] p-4 text-left transition-colors hover:border-white/[0.2] hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/50"
    >
      <span className="mt-0.5 flex size-8 flex-shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-lab-mute">
        {icon}
      </span>
      <span>
        <span className="block text-[14px] font-medium text-lab-ink">{title}</span>
        <span className="mt-1 block text-[12px] leading-snug text-lab-dim">{text}</span>
      </span>
    </button>
  );
  return (
    <div className="space-y-2.5 p-5">
      {option(
        <FileText className="size-4" />,
        "Из логов",
        state.logs.total
          ? `Настоящие разговоры: в выгрузке ${state.logs.total} ${plural(state.logs.total, "разговор", "разговора", "разговоров")}. Судья проверит их по критериям агента, сам агент не запускается.`
          : "Загрузите выгрузку чата. Судья проверит настоящие разговоры по критериям агента, сам агент не запускается.",
        onLogs,
      )}
      {option(
        <MessagesSquare className="size-4" />,
        "Симулятор клиента",
        cards
          ? `Искусственный клиент сыграет ${cards} ${plural(cards, "сценарий", "сценария", "сценариев")} с вашим агентом. Так проверяют то, чего в логах ещё нет, и сравнивают версии.`
          : "Искусственный клиент сыграет сценарии с вашим агентом. Сначала соберите сценарии из логов.",
        onSimulator,
      )}
    </div>
  );
}
