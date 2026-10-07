import { Copy, Link2, RotateCcw } from "lucide-react";
import { problemMarkdown, useReportAgent } from "../../lab/problemReport";
import type { RuleEntry } from "../../lab/problems";
import { Button } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";
import { useToast } from "../../ui/toast";
import type { SideKey } from "./model";

/**
 * «Задача для разработчика»: the problem as a brief to paste into a ticket or a coding assistant — the agent it is
 * about, what is wrong, how often, where the agent's code says it, one proof and the link back here. Logs and
 * simulation are told apart. The task is copied only with the agent's name in it: every agent's tasks look alike.
 */
export function Handoff({
  open,
  onClose,
  r,
  side,
  link,
}: {
  open: boolean;
  onClose: () => void;
  r: RuleEntry;
  side: SideKey;
  link: string;
}) {
  const toast = useToast();
  const agent = useReportAgent();
  const text = problemMarkdown(r, link, { source: side, agent: agent.name ?? undefined });
  const copy = (value: string, done: string) =>
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(value))
      .then(() => toast.notify(done), toast.error);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Задача для разработчика"
      sub="Вставьте в тикет или в Claude Code в папке агента"
      actions={
        <>
          <Button icon={Link2} onClick={() => copy(link, "Ссылка скопирована")} className="hidden sm:inline-flex">
            Скопировать ссылку
          </Button>
          <Button variant="primary" icon={Copy} disabled={!agent.name} onClick={() => copy(text, "Задача скопирована")}>
            Скопировать
          </Button>
        </>
      }
    >
      <div className="p-5">
        {agent.failed && (
          <div className="mb-4">
            <p role="alert" className="text-read text-fg-2">
              Не удалось загрузить имя агента.
            </p>
            <Button className="mt-3" icon={RotateCcw} onClick={agent.retry}>
              Повторить
            </Button>
          </div>
        )}
        <pre className="whitespace-pre-wrap rounded-block border border-line bg-list p-5 font-sans text-read text-fg shadow-card">
          {text}
        </pre>
      </div>
    </Sheet>
  );
}
