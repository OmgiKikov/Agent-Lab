import { Download } from "lucide-react";
import { Button } from "../ui/Button";

const EXAMPLE = {
  id: "dialog-1",
  messages: [
    { role: "user", content: "Как оформить возврат?" },
    { role: "assistant", content: "Откройте операцию в личном кабинете и выберите «Возврат»." },
  ],
};

function downloadExample() {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(EXAMPLE) + "\n"], { type: "application/x-ndjson;charset=utf-8" }),
  );
  const link = Object.assign(document.createElement("a"), { href: url, download: "dialog-example.jsonl" });
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The exact formats the export reader supports, available before a person picks a file. */
export function ExportFormat() {
  return (
    <details className="group rounded-block border border-line px-5 py-4">
      <summary className="cursor-pointer text-body font-medium text-fg">Как подготовить файл</summary>
      <div className="mt-4 space-y-4 text-body text-fg-2">
        <div>
          <h3 className="font-medium text-fg">Excel · .xlsx</h3>
          <p className="mt-1">Лист «Данные» с тремя колонками:</p>
          <ul className="mt-2 list-inside list-disc space-y-1 text-small">
            <li>Id диалога</li>
            <li>Текст — реплики с метками CLIENT и AGENT</li>
            <li>Порядок сообщения в диалоге — например, [1, 2]</li>
          </ul>
        </div>
        <div className="border-t border-line pt-4">
          <h3 className="font-medium text-fg">JSONL · .jsonl</h3>
          <p className="mt-1">
            Один разговор в строке: id и messages с role и content. Роли — user и assistant, кодировка UTF-8.
          </p>
          <Button className="mt-3" size="sm" icon={Download} onClick={downloadExample}>
            Скачать пример JSONL
          </Button>
        </div>
        <p className="text-small text-fg-3">
          До 50 МБ. В разговоре клиент пишет первым, а агент отвечает. Разговоры без ответа или с первой репликой агента
          не попадут в проверку.
        </p>
      </div>
    </details>
  );
}
