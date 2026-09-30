import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, CornerDownLeft, FileText, FlaskConical, Hammer, ListChecks, MessageSquare, MessagesSquare, Play, Search, Settings, TriangleAlert, Upload, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { day } from "../lab/format";
import { useProblems } from "../lab/problems";
import { runTitle } from "../lab/runs";
import { useLabState } from "./LabProvider";
import { LINKS } from "./links";
import { useShell } from "./ShellContext";

type Entry = { id: string; group: string; label: string; sub?: string; icon: LucideIcon; run: () => void };

/** ⌘K: any section, problem, rule, run or scenario and the main actions, without the mouse. Actions only open their place. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const shell = useShell();
  const { data } = useProblems(null);
  const { state } = useLabState();
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) { setQuery(""); setAt(0); } }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const go = (to: string) => () => navigate(to);
    const out: Entry[] = [
      { id: "s-problems", group: "Разделы", label: "Проблемы", icon: TriangleAlert, run: go(LINKS.problems) },
      { id: "s-dialogs", group: "Разделы", label: "Диалоги", icon: MessagesSquare, run: go(LINKS.dialogs) },
      { id: "s-rules", group: "Разделы", label: "Правила", icon: ListChecks, run: go(LINKS.rules) },
      { id: "s-sims", group: "Разделы", label: "Симуляции", icon: FlaskConical, run: go(LINKS.simulations) },
      { id: "s-agent", group: "Разделы", label: "Агент", icon: Bot, run: go(LINKS.agent) },
      { id: "s-settings", group: "Разделы", label: "Настройки", icon: Settings, run: go(LINKS.settings) },
      { id: "a-assess", group: "Действия", label: "Оценить логи", sub: "Судья проверит диалоги логов по правилам агента", icon: Play, run: go("/problems?assess=1") },
      { id: "a-play", group: "Действия", label: "Сыграть сценарии", sub: "Синтетический клиент сыграет сценарии с агентом", icon: Play, run: go(`${LINKS.simulations}?play=1`) },
      { id: "a-cards", group: "Действия", label: "Собрать сценарии", sub: "Из последней оценки логов — в «Симуляциях»", icon: Hammer, run: go(LINKS.scenarios) },
      { id: "a-logs", group: "Действия", label: "Загрузить логи", sub: "Выгрузка чата — в «Диалогах»", icon: Upload, run: go(LINKS.dialogs) },
      { id: "a-code", group: "Действия", label: "Прочитать код агента", sub: "Промпты и инструменты — в «Агенте»", icon: FileText, run: go(`${LINKS.agent}?tab=code`) },
      { id: "a-review", group: "Действия", label: "Проверить вердикты", sub: "Верно или неверно судья: по одному, клавишами V / N", icon: ListChecks, run: go(LINKS.review) },
      { id: "a-ask", group: "Действия", label: "Спросить", sub: "Ассистент по текущему экрану", icon: MessageSquare, run: () => shell.openAsk() },
    ];
    const byId = new Map((data?.rules ?? []).map(r => [r.id, r]));
    for (const id of data?.problems ?? []) {
      const p = byId.get(id);
      if (p) out.push({ id: `p-${id}`, group: "Проблемы", label: p.title, sub: `в логах ${p.log.failed} · в симуляции ${p.sim.failed}`, icon: TriangleAlert, run: go(`/problems/${id}`) });
    }
    for (const r of data?.rules ?? []) {
      out.push({ id: `r-${r.id}`, group: "Правила", label: r.rule.text, sub: r.rule.origin, icon: ListChecks, run: go(`/rules/${r.id}`) });
    }
    const runs = [...(state?.runs ?? [])].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    for (const r of runs) {
      const m = r.metric;
      out.push({ id: `run-${r.id}`, group: "Прогоны", label: r.label || runTitle(r), sub: [day(r.startedAt), m?.measured ? `нарушения в ${m.failed} из ${m.measured}` : ""].filter(Boolean).join(" · "), icon: FlaskConical, run: go(`/simulations/runs/${encodeURIComponent(r.id)}`) });
    }
    for (const c of state?.cards?.cards ?? []) {
      out.push({ id: `sc-${c.id}`, group: "Сценарии", label: c.name, sub: c.topic, icon: FlaskConical, run: go(`/simulations/scenarios/${encodeURIComponent(c.id)}`) });
    }
    return out;
  }, [data, state?.runs, state?.cards, navigate, shell]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => entries.filter(e => !q || `${e.label} ${e.sub ?? ""}`.toLowerCase().includes(q)).slice(0, 40), [entries, q]);
  useEffect(() => { setAt(0); }, [q]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.scrollIntoView({ block: "nearest" }); }, [at]);
  const choose = (e?: Entry) => { if (!e) return; onClose(); e.run(); };

  return (
    <Dialog.Root open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/70 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          onKeyDown={e => {
            if (e.key === "ArrowDown") { e.preventDefault(); setAt(a => Math.min(a + 1, shown.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setAt(a => Math.max(a - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); choose(shown[at]); }
          }}
          className="fixed left-1/2 top-[16%] z-50 w-[calc(100vw-32px)] max-w-[600px] -translate-x-1/2 overflow-hidden rounded-xl border border-white/10 bg-lab-surface shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <Dialog.Title className="sr-only">Найти</Dialog.Title>
          <div className="flex items-center gap-2.5 border-b border-white/[0.07] px-4">
            <Search className="size-4 flex-shrink-0 text-lab-dim" />
            <input
              autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Раздел, проблема, прогон или действие"
              className="h-12 w-full bg-transparent text-body text-lab-ink outline-none placeholder:text-lab-faint"
            />
          </div>
          <div ref={list} className="max-h-[380px] overflow-auto p-1.5">
            {shown.map((e, i) => (
              <div key={e.id}>
                {(i === 0 || shown[i - 1].group !== e.group) && <div className="px-2.5 pb-1 pt-2.5 font-mono text-label uppercase tracking-[0.08em] text-lab-dim">{e.group}</div>}
                <button
                  type="button" data-index={i} onClick={() => choose(e)} onMouseMove={() => setAt(i)}
                  className={cn("flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors", i === at ? "bg-lab-active" : "hover:bg-lab-hover")}
                >
                  <e.icon className="size-4 flex-shrink-0 text-lab-mute" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-small text-lab-text">{e.label}</span>
                    {e.sub && <span className="block truncate text-meta text-lab-dim">{e.sub}</span>}
                  </span>
                  {i === at && <CornerDownLeft className="size-3.5 flex-shrink-0 text-lab-dim" />}
                </button>
              </div>
            ))}
            {!shown.length && <div className="px-3 py-8 text-center text-small text-lab-dim">Ничего не нашлось</div>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
