import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BookOpen,
  Bot,
  ClipboardCheck,
  LayoutDashboard,
  CornerDownLeft,
  FileText,
  FlaskConical,
  Hammer,
  History,
  ListChecks,
  MessageSquareQuote,
  MessagesSquare,
  Play,
  Plus,
  Presentation,
  Route,
  Search,
  Settings,
  Target,
  TriangleAlert,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { BY_CRITERIA, CHECK_NAME, CHECKS, resultOf } from "../lab/checks";
import { duty } from "../lab/criteria";
import { count, day } from "../lab/format";
import { useLabState } from "../lab/LabProvider";
import { useProblems, type Problems } from "../lab/problems";
import { runTitle } from "../lab/runs";
import type { Check } from "../lab/types";
import { Label } from "../ui/Label";
import {
  conversationsLink,
  criterionLink,
  historyLink,
  problemLink,
  reviewLink,
  runLink,
  scenariosLink,
  SECTIONS,
  stageRoot,
  launchLink,
} from "./links";

type Entry = { id: string; group: string; label: string; sub?: string; icon: LucideIcon; run: () => void };

const ICON: Record<Check, LucideIcon> = { tone: MessageSquareQuote, code: Target };
const ABOUT: Record<Check, string> = {
  tone: "Проверка разговоров по правилам общения",
  code: "Проверка разговоров по коду агента",
};

/**
 * ⌘K: any section and tab of both checks, the simulations, the problems and criteria of each check, runs, scenarios
 * and the actions of each check, without the mouse. Actions only open their place; nothing is started from here. For a
 * screen reader it is a combobox (WAI-ARIA): the field keeps the focus and names the line Enter runs
 * (aria-activedescendant), the lines are the options of a listbox, in groups named as on the screen.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { state } = useLabState();
  const { data: tone } = useProblems("tone", null, open && !!resultOf(state, "tone"));
  const { data: code } = useProblems("code", null, open && !!resultOf(state, "code"));
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const listId = `${id}-results`;
  const optionId = (i: number) => `${id}-option-${i}`;
  useEffect(() => {
    if (open) {
      setQuery("");
      setAt(0);
    }
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const go = (to: string) => () => {
      void navigate(to);
    };
    const results = CHECKS.filter((c) => resultOf(state, c));
    const out: Entry[] = [
      {
        id: "s-overview",
        group: "Разделы",
        label: "Обзор",
        sub: "Итоги проверок и последнего прогона",
        icon: LayoutDashboard,
        run: go(SECTIONS.overview),
      },
      {
        id: "s-data",
        group: "Разделы",
        label: "Датасеты",
        sub: "Загрузить и просмотреть разговоры для обеих проверок",
        icon: FileText,
        run: go(SECTIONS.data),
      },
      {
        id: "s-summary",
        group: "Разделы",
        label: "Сводка для руководителя",
        sub: "Одна страница об агенте для PDF или письма",
        icon: Presentation,
        run: go(SECTIONS.summary),
      },
      ...CHECKS.flatMap((c): Entry[] => [
        { id: `s-${c}`, group: "Разделы", label: CHECK_NAME[c], sub: ABOUT[c], icon: ICON[c], run: go(stageRoot(c)) },
        {
          id: `s-${c}-talks`,
          group: "Разделы",
          label: `${CHECK_NAME[c]} · Разговоры`,
          sub: "Разговоры выгрузки с оценкой этой проверки",
          icon: MessagesSquare,
          run: go(conversationsLink(c)),
        },
        {
          id: `s-${c}-review`,
          group: "Разделы",
          label: `${CHECK_NAME[c]} · Ответы людей`,
          sub: "Это действительно ошибка? Случаи по одному",
          icon: ClipboardCheck,
          run: go(reviewLink(c)),
        },
        {
          id: `s-${c}-criteria`,
          group: "Разделы",
          label: `${CHECK_NAME[c]} · Критерии`,
          sub: c === "tone" ? "Что агент обязан делать по правилам общения" : "Что агент обязан делать по своему коду",
          icon: ListChecks,
          run: go(criterionLink(c)),
        },
        {
          id: `s-${c}-rules`,
          group: "Разделы",
          label: `${CHECK_NAME[c]} · Правила`,
          sub: "Наборы правил и их версии, новый набор",
          icon: BookOpen,
          run: go(criterionLink(c, null, { rules: "1" })),
        },
        {
          id: `s-${c}-history`,
          group: "Разделы",
          label: `${CHECK_NAME[c]} · История`,
          sub: "Прошлые проверки с разговорами и критериями",
          icon: History,
          run: go(historyLink(c)),
        },
      ]),
      {
        id: "s-simulations",
        group: "Разделы",
        label: "Симуляции",
        sub: "Синтетические клиенты играют сценарии из ошибок проверки",
        icon: FlaskConical,
        run: go(SECTIONS.simulations),
      },
      {
        id: "s-runs",
        group: "Разделы",
        label: "Симуляции · Прогоны",
        sub: "Все прогоны, новые сверху",
        icon: FlaskConical,
        run: go(`${SECTIONS.simulations}/runs`),
      },
      {
        id: "s-scenarios",
        group: "Разделы",
        label: "Симуляции · Сценарии",
        sub: "Бизнес-сценарии из ошибок проверки",
        icon: Route,
        run: go(scenariosLink()),
      },
      {
        id: "s-agent",
        group: "Разделы",
        label: "Агент",
        sub: "Карточка агента: подключение, код, инструменты, база знаний",
        icon: Bot,
        run: go(SECTIONS.agent),
      },
      {
        id: "s-settings",
        group: "Разделы",
        label: "Настройки",
        sub: "Модели и где что работает",
        icon: Settings,
        run: go(SECTIONS.settings),
      },
      {
        id: "a-tone",
        group: "Действия",
        label: "Проверить tone of voice",
        sub: "Датасет, правила и режимы проверки",
        icon: Play,
        run: go(launchLink("tone")),
      },
      {
        id: "a-code",
        group: "Действия",
        label: "Проверить точность",
        sub: "Критерии из кода или выбранного набора правил",
        icon: Play,
        run: go(launchLink("code")),
      },
      ...results.flatMap((c): Entry[] => [
        {
          id: `a-${c}-review`,
          group: "Действия",
          label: `Ответить на спорные случаи · ${CHECK_NAME[c]}`,
          sub: "По одному случаю, клавишами V и N",
          icon: ClipboardCheck,
          run: go(reviewLink(c)),
        },
        {
          id: `a-${c}-report`,
          group: "Действия",
          label: `Отчёт для письма · ${CHECK_NAME[c]}`,
          sub: "Проблемы проверки на одном листе, чтобы скопировать или скачать",
          icon: FileText,
          run: go(`${stageRoot(c)}?report=1`),
        },
      ]),
      {
        id: "a-upload",
        group: "Действия",
        label: "Добавить датасет",
        sub: "Выгрузка чата, общая для обеих проверок",
        icon: Upload,
        run: go(SECTIONS.data),
      },
      {
        id: "a-agent",
        group: "Действия",
        label: "Новый агент",
        sub: "Свои разговоры, правила и итоги — отдельно от этого агента",
        icon: Plus,
        run: () => window.location.assign("/agents?new=1"),
      },
      {
        id: "a-cards",
        group: "Действия",
        label: "Собрать сценарии",
        sub: "Из ошибок одной проверки",
        icon: Hammer,
        run: go(scenariosLink()),
      },
      {
        id: "a-play",
        group: "Действия",
        label: "Сыграть сценарии",
        sub: "Синтетические клиенты сыграют сценарии с агентом",
        icon: Play,
        run: go(`${SECTIONS.simulations}?play=1`),
      },
      {
        id: "a-read",
        group: "Действия",
        label: "Прочитать код агента",
        sub: "Инструкции и инструменты агента, в разделе «Агент»",
        icon: FileText,
        run: go(SECTIONS.agent),
      },
    ];
    const ofCheck = (c: Check, data: Problems | undefined) => {
      if (!data) return;
      const byId = new Map(data.rules.map((r) => [r.id, r]));
      for (const id of data.problems) {
        const p = byId.get(id);
        if (p?.log.failed)
          out.push({
            id: `v-${c}-${id}`,
            group: `Проблемы · ${CHECK_NAME[c]}`,
            label: p.title,
            sub: `${p.serious ? "серьёзная · " : ""}ошибка в ${p.log.failed}\u00a0из ${count(p.log.failed + p.log.passed, "разговора", "разговоров", "разговоров")}`,
            icon: TriangleAlert,
            run: go(problemLink(id, c)),
          });
      }
      for (const r of data.rules)
        out.push({
          id: `c-${c}-${r.id}`,
          group: `Критерии · ${CHECK_NAME[c]}`,
          label: r.title,
          sub: r.rule.origin || duty(r.rule.text),
          icon: ListChecks,
          run: go(criterionLink(c, r.id)),
        });
    };
    ofCheck("tone", tone);
    ofCheck("code", code);
    const runs = [...(state?.runs ?? [])].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    for (const r of runs) {
      const m = r.metric;
      out.push({
        id: `r-${r.id}`,
        group: "Прогоны симуляции",
        label: r.label || runTitle(r),
        sub: [
          day(r.startedAt),
          BY_CRITERIA[r.check],
          m?.measured ? `ошибка в ${m.failed}\u00a0из\u00a0${m.measured}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        icon: FlaskConical,
        run: go(runLink(r.id)),
      });
    }
    for (const c of state?.cards?.cards ?? []) {
      out.push({
        id: `sc-${c.id}`,
        group: "Сценарии",
        label: c.name,
        sub: c.topic,
        icon: Route,
        run: go(scenariosLink(c.id)),
      });
    }
    return out;
  }, [tone, code, state, navigate]);

  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => entries.filter((e) => !q || `${e.label} ${e.sub ?? ""}`.toLowerCase().includes(q)).slice(0, 40),
    [entries, q],
  );
  // The lines in their groups, each with its place among all the lines (the one ↑ ↓ and Enter work by).
  const groups = useMemo(() => {
    const out: { name: string; lines: { e: Entry; i: number }[] }[] = [];
    shown.forEach((e, i) => {
      const last = out[out.length - 1];
      if (last?.name === e.group) last.lines.push({ e, i });
      else out.push({ name: e.group, lines: [{ e, i }] });
    });
    return out;
  }, [shown]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at]);
  const choose = (e?: Entry) => {
    if (!e) return;
    onClose();
    e.run();
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-fg/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setAt((a) => Math.min(a + 1, shown.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setAt((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(shown[at]);
            }
          }}
          className="fixed left-1/2 top-[14%] z-50 w-[calc(100vw-32px)] max-w-[600px] -translate-x-1/2 overflow-hidden rounded-sheet bg-raised shadow-pop outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <Dialog.Title className="sr-only">Поиск</Dialog.Title>
          <div className="flex items-center gap-2.5 border-b border-line px-4">
            <Search aria-hidden className="size-4 flex-shrink-0 text-fg-3" />
            <input
              autoFocus
              name="palette"
              autoComplete="off"
              spellCheck={false}
              role="combobox"
              aria-label="Поиск по разделам и действиям"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={shown[at] ? optionId(at) : undefined}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setAt(0);
              }}
              placeholder="Раздел, проблема, критерий, прогон или действие"
              className="h-12 w-full bg-transparent text-body text-fg outline-none placeholder:text-fg-4"
            />
          </div>
          {/* The listbox is the scrolling list itself: ↑ ↓ scroll it, as the popup of the field. */}
          <div
            ref={list}
            id={listId}
            role="listbox"
            aria-label="Найденные разделы и действия"
            className="max-h-[min(420px,60dvh)] overflow-auto p-1.5"
          >
            {groups.map((g, n) => (
              <div key={`${n}-${g.name}`} role="group" aria-labelledby={`${id}-group-${n}`}>
                <Label id={`${id}-group-${n}`} className="block px-2.5 pb-1 pt-2.5">
                  {g.name}
                </Label>
                {g.lines.map(({ e, i }) => (
                  <div
                    key={e.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={i === at}
                    data-index={i}
                    // The field keeps the focus: it says which line Enter runs.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(e)}
                    onMouseMove={() => setAt(i)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-3 rounded-control px-2.5 py-2 text-left transition-colors",
                      i === at ? "bg-selected" : "hover:bg-hover",
                    )}
                  >
                    <e.icon aria-hidden className="size-4 flex-shrink-0 text-fg-3" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body text-fg">{e.label}</span>
                      {/* On the highlighted line the lighter grey would fall below WCAG AA contrast. */}
                      {e.sub && (
                        <span className={cn("block truncate text-small", i === at ? "text-fg-2" : "text-fg-3")}>
                          {e.sub}
                        </span>
                      )}
                    </span>
                    {i === at && <CornerDownLeft aria-hidden className="size-3.5 flex-shrink-0 text-fg-3" />}
                  </div>
                ))}
              </div>
            ))}
          </div>
          {!shown.length && (
            <div role="status" className="px-3 pb-8 pt-6 text-center text-small text-fg-3">
              Ничего не нашлось
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
