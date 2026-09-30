import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { FileDown } from "lucide-react";
import { day, plural } from "../../lab/format";
import { download, problemsReport } from "../../lab/problemReport";
import { type Problems, type RuleEntry } from "../../lab/problems";
import { Button } from "../../ui/Button";
import { Table, type Col } from "../../ui/Table";

const dash = <span className="text-lab-faint">—</span>;

/** After an assessment: what was assessed, and every criterion with how many dialogues broke, kept or left it unclear. */
export function AssessResult({ data, onAgain, onOpen }: { data: Problems; onAgain: () => void; onOpen: (id: string) => void }) {
  const log = data.log!;
  const [folded, setFolded] = useState(true);
  const { violated, clean } = useMemo(() => {
    const v = data.rules.filter(r => r.log.failed > 0).sort((a, b) => b.log.failed - a.log.failed);
    return { violated: v, clean: data.rules.filter(r => r.log.failed === 0) };
  }, [data]);
  const rows = folded ? violated : [...violated, ...clean];
  const cols: Col<RuleEntry>[] = [
    { key: "title", label: "Критерий", cell: r => <span className="text-small text-lab-ink">{r.title}</span> },
    { key: "failed", label: "Нарушен", width: "128px", cell: r => r.log.failed ? <span className="text-small text-lab-bad">нарушен в {r.log.failed}</span> : dash },
    { key: "passed", label: "Выполнен", width: "128px", cell: r => r.log.passed ? <span className="text-small text-lab-ok">выполнен в {r.log.passed}</span> : dash },
    { key: "unknown", label: "Не ясно", width: "112px", cell: r => r.log.unknown ? <span className="text-small text-lab-dim">не ясно в {r.log.unknown}</span> : dash },
  ];
  const n = log.withViolations;
  return (
    <div className="mx-auto max-w-[960px] px-6 pb-20 pt-8 lg:px-8">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-heading font-semibold text-lab-ink">Оценка{log.finishedAt ? ` от ${day(log.finishedAt)}` : ""}</h1>
          <p className="mt-1 text-small text-lab-mute">
            {log.assessed} {plural(log.assessed, "разговор", "разговора", "разговоров")} × {data.rules.length} {plural(data.rules.length, "критерий", "критерия", "критериев")}
            {" · "}в {n} {plural(n, "разговоре", "разговорах", "разговорах")} есть нарушения
            {log.unassessed ? ` · ${log.unassessed} оценить не удалось` : ""}
          </p>
        </div>
        <Button onClick={onAgain}>Оценить заново</Button>
      </div>
      <Table className="mt-6" rows={rows} cols={cols} rowKey={r => r.id} onOpen={r => onOpen(r.id)}
        empty={<div className="px-4 py-10 text-center text-small text-lab-dim">Нарушений не найдено</div>} />
      {clean.length > 0 && (
        <button type="button" onClick={() => setFolded(f => !f)} className="mt-3 text-small text-lab-mute hover:text-lab-text">
          {folded ? `ещё ${clean.length} ${plural(clean.length, "критерий", "критерия", "критериев")} без нарушений` : "скрыть критерии без нарушений"}
        </button>
      )}
      <div className="mt-8 flex flex-wrap items-center gap-4 text-small text-lab-dim">
        <Link to="/logs?tab=dialogs" className="hover:text-lab-text">Все разговоры</Link>
        <Link to="/logs?tab=review" className="hover:text-lab-text">Проверить вердикты</Link>
        <button type="button" onClick={() => download("otchet-logi.md", problemsReport(data, window.location.origin, "log"))} className="inline-flex items-center gap-1 hover:text-lab-text"><FileDown className="size-3.5" />Отчёт</button>
      </div>
    </div>
  );
}