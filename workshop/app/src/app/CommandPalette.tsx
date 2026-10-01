import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, ClipboardCheck, CornerDownLeft, FileText, FlaskConical, Hammer, ListChecks, MessageSquare, MessagesSquare, Play, Route, Search, Settings, TriangleAlert, Upload, Waypoints, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { day } from "../lab/format";
import { useLabState } from "../lab/LabProvider";
import { useProblems } from "../lab/problems";
import { runTitle } from "../lab/runs";
import { Caps } from "../ui/Caps";
import { criterionLink, runLink, scenariosLink, SECTIONS, violationLink } from "./links";
import { useShell } from "./ShellContext";

type Entry = { id: string; group: string; label: string; sub?: string; icon: LucideIcon; run: () => void };

/** ⌘K: any section, violation, criterion, run or scenario and the main actions, without the mouse. Actions only open their place. */
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
      { id: "s-violations", group: "Разделы", label: "Нарушения", sub: "Что агент делает не так, с доказательствами", icon: TriangleAlert, run: go(SECTIONS.violations) },
      { id: "s-dialogs", group: "Разделы", label: "Диалоги", sub: "Логи, симуляции и трейсы, каждый целиком", icon: MessagesSquare, run: go(SECTIONS.dialogs) },
      { id: "s-criteria", group: "Разделы", label: "Критерии", sub: "Что агент обязан делать, прямо в его коде", icon: ListChecks, run: go(SECTIONS.criteria) },
      { id: "s-simulations", group: "Разделы", label: "Симуляции", sub: "Синтетические клиенты играют сценарии с агентом", icon: FlaskConical, run: go(SECTIONS.simulations) },
      { id: "s-scenarios", group: "Разделы", label: "Сценарии", sub: "Карточки бизнес-сценариев для симуляций", icon: Route, run: go(scenariosLink()) },
      { id: "s-traces", group: "Разделы", label: "Трейсы", sub: "Всё, что записал Workshop", icon: Waypoints, run: go(`${SECTIONS.dialogs}?src=traces`) },
      { id: "s-agent", group: "Разделы", label: "Агент", sub: "Подключение и прочитанный код", icon: Bot, run: go(SECTIONS.agent) },
      { id: "s-settings", group: "Разделы", label: "Настройки", sub: "Модели, ключи, ассистент, повтор трейсов", icon: Settings, run: go(SECTIONS.settings) },
      { id: "a-assess", group: "Действия", label: "Оценить логи", sub: "Судья проверит диалоги логов по критериям агента", icon: Play, run: go(`${SECTIONS.violations}?assess=1`) },
      { id: "a-review", group: "Действия", label: "Проверить вердикты", sub: "Верно или неверно судья: по одному, клавишами V и N", icon: ClipboardCheck, run: go(SECTIONS.review) },
      { id: "a-report", group: "Действия", label: "Отчёт для письма", sub: "Нарушения листом: скопировать или скачать", icon: FileText, run: go(`${SECTIONS.violations}?report=1`) },
      { id: "a-upload", group: "Действия", label: "Загрузить логи", sub: "Выгрузка чата — кнопкой в «Диалогах»", icon: Upload, run: go(SECTIONS.dialogs) },
      { id: "a-cards", group: "Действия", label: "Собрать сценарии", sub: "Из оценённых логов", icon: Hammer, run: go(scenariosLink()) },
      { id: "a-play", group: "Действия", label: "Запустить симуляцию", sub: "Синтетический клиент сыграет сценарии с агентом", icon: Play, run: go(`${SECTIONS.simulations}?play=1`) },
      { id: "a-code", group: "Действия", label: "Прочитать код агента", sub: "Промпты и инструменты — в «Агенте»", icon: FileText, run: go(SECTIONS.agent) },
      { id: "a-ask", group: "Действия", label: "Спросить", sub: "Ассистент по текущему экрану, ⌘J", icon: MessageSquare, run: () => shell.openAsk() },
    ];
    const byId = new Map((data?.rules ?? []).map(r => [r.id, r]));
    for (const id of data?.problems ?? []) {
      const p = byId.get(id);
      if (p?.log.failed) out.push({ id: `v-${id}`, group: "Нарушения в логах", label: p.title, sub: `${p.log.failed} из ${p.log.failed + p.log.passed} диалогов`, icon: TriangleAlert, run: go(violationLink(id)) });
    }
    for (const r of data?.rules ?? []) {
      out.push({ id: `c-${r.id}`, group: "Критерии", label: r.title, sub: r.rule.origin || r.rule.text, icon: ListChecks, run: go(criterionLink(r.id)) });
    }
    const runs = [...(state?.runs ?? [])].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    for (const r of runs) {
      const m = r.metric;
      out.push({ id: `r-${r.id}`, group: "Симуляции", label: r.label || runTitle(r), sub: [day(r.startedAt), m?.measured ? `нарушения в ${m.failed} из ${m.measured}` : ""].filter(Boolean).join(" · "), icon: FlaskConical, run: go(runLink(r.id)) });
    }
    for (const c of state?.cards?.cards ?? []) {
      out.push({ id: `sc-${c.id}`, group: "Сценарии", label: c.name, sub: c.topic, icon: Route, run: go(scenariosLink(c.id)) });
    }
    return out;
  }, [data, state?.runs, state?.cards, navigate, shell]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(() => entries.filter(e => !q || `${e.label} ${e.sub ?? ""}`.toLowerCase().includes(q)).slice(0, 40), [entries, q]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.scrollIntoView({ block: "nearest" }); }, [at]);
  const choose = (e?: Entry) => { if (!e) return; onClose(); e.run(); };

  return (
    <Dialog.Root open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          onKeyDown={e => {
            if (e.key === "ArrowDown") { e.preventDefault(); setAt(a => Math.min(a + 1, shown.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setAt(a => Math.max(a - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); choose(shown[at]); }
          }}
          className="fixed left-1/2 top-[14%] z-50 w-[calc(100vw-32px)] max-w-[600px] -translate-x-1/2 overflow-hidden rounded-sheet bg-raised shadow-pop outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <Dialog.Title className="sr-only">Найти</Dialog.Title>
          <div className="flex items-center gap-2.5 border-b border-line px-4">
            <Search aria-hidden className="size-4 flex-shrink-0 text-fg-3" />
            <input
              autoFocus name="palette" autoComplete="off" spellCheck={false} aria-label="Поиск по разделам и действиям" value={query} onChange={e => { setQuery(e.target.value); setAt(0); }}
              placeholder="Раздел, нарушение, критерий, симуляция или действие"
              className="h-12 w-full bg-transparent text-body text-fg outline-none placeholder:text-fg-4"
            />
          </div>
          <div ref={list} className="max-h-[min(420px,60dvh)] overflow-auto p-1.5">
            {shown.map((e, i) => (
              <div key={e.id}>
                {(i === 0 || shown[i - 1].group !== e.group) && <Caps className="block px-2.5 pb-1 pt-2.5">{e.group}</Caps>}
                <button
                  type="button" data-index={i} onClick={() => choose(e)} onMouseMove={() => setAt(i)}
                  className={cn("flex w-full items-center gap-3 rounded-control px-2.5 py-2 text-left transition-colors", i === at ? "bg-selected" : "hover:bg-hover")}
                >
                  <e.icon aria-hidden className="size-4 flex-shrink-0 text-fg-3" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-small text-fg">{e.label}</span>
                    {e.sub && <span className="block truncate text-meta text-fg-3">{e.sub}</span>}
                  </span>
                  {i === at && <CornerDownLeft aria-hidden className="size-3.5 flex-shrink-0 text-fg-3" />}
                </button>
              </div>
            ))}
            {!shown.length && <div className="px-3 py-8 text-center text-small text-fg-3">Ничего не нашлось</div>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
