import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { stageRoot, type Check } from "../../app/links";
import { useWide } from "../../app/useWide";
import { resultOf } from "../../lab/checks";
import { count, longDay } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { CHANGE_WORD, changeOf, replaysOf, useReplay } from "../../lab/replays";
import type { Change, Replay, ReplayItem } from "../../lab/types";
import { Button, buttonClass } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { Menu } from "../../ui/Menu";
import { Segmented } from "../../ui/Segmented";
import { VerdictWord } from "../dialogs/Rows";
import { CheckHeader } from "../checks/CheckHeader";
import { CHANGE_TONE, Pair, type Numbered } from "./Pair";
import { ChangeLine, ReplayNumbers, replayMeta, useBasisWords, VerdictLine } from "./ReplayNumbers";
import { ReplaySheet } from "./ReplaySheet";

type Filter = Change | "all";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "Все" },
  { value: "fixed", label: "Лучше" },
  { value: "broken", label: "Хуже" },
  { value: "failing", label: "Ошибка осталась" },
  { value: "passing", label: "Без ошибки" },
  { value: "unmeasured", label: "Не сравнить" },
];

/** Each criterion of the check numbered as the check numbers it, by its id in the check's topics. */
function numberedOf(record: Replay | undefined): Numbered {
  const found: Numbered = new Map();
  let n = 0;
  for (const topic of record?.topics ?? [])
    for (const rule of topic.rules) found.set(rule.id, { n: ++n, name: rule.name || rule.text });
  return found;
}

/** One customer in the list: their first message, and the recording's verdict beside the one now. */
function PairRow({ item, on, onOpen }: { item: ReplayItem; on: boolean; onOpen: () => void }) {
  const change = changeOf(item);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={on ? "true" : undefined}
        className={cn(
          "flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-run/60",
          on ? "bg-selected" : "hover:bg-hover",
        )}
      >
        <span className="line-clamp-2 text-body text-fg">{item.opening || "Без слов клиента"}</span>
        <span className="flex flex-wrap items-center gap-x-2 text-small text-fg-3">
          <span>в записи</span>
          <VerdictWord status={item.before.status} />
          <span aria-hidden>→</span>
          <span>сейчас</span>
          <VerdictWord status={item.status} />
        </span>
        <span className={cn("text-small font-medium", CHANGE_TONE[change])}>{CHANGE_WORD[change]}</span>
      </button>
    </li>
  );
}

/**
 * «Живой агент»: the customers of the check's result met again by the agent under test. The pairs in numbers — the
 * conversations with an error in the recordings and now, among the same customers — then each customer: the recording
 * beside the conversation now. Without a check yet: what it does, and its start.
 */
export function LivePage({ check }: { check: Check }) {
  const { state, offline } = useLabState();
  const [params, setParams] = useSearchParams();
  const wide = useWide();
  const list = replaysOf(state, check);
  const asked = params.get("id");
  const chosen = list.find((r) => r.id === asked) ?? list[0] ?? null;
  const { data: record, error, refetch } = useReplay(chosen?.id ?? null, chosen?.revision);
  const [starting, setStarting] = useState(params.get("start") === "1");
  const set = (change: (next: URLSearchParams) => void, replace = true) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        change(next);
        return next;
      },
      { replace },
    );
  // ⌘K «Проверить живого агента» opens the window, also on this very page; the address forgets it.
  useEffect(() => {
    if (!params.get("start")) return;
    setStarting(true);
    set((n) => n.delete("start"));
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps
  const filter = (FILTERS.find((f) => f.value === params.get("v"))?.value ?? "all") as Filter;
  const items = useMemo(() => record?.items ?? [], [record]);
  const shown = filter === "all" ? items : items.filter((item) => changeOf(item) === filter);
  const selectedId = params.get("d");
  const selected = items.find((item) => item.dialogueId === selectedId) ?? (wide ? shown[0] : undefined);
  const numbered = useMemo(() => numberedOf(record), [record]);
  const result = resultOf(state, check);
  const basis = useBasisWords(chosen);
  const running = !!state?.job.running;

  const actions = result && (
    <Button
      variant="primary"
      icon={Play}
      aria-label={list.length ? "Проверить снова" : "Проверить живого агента"}
      disabled={running}
      title={running ? "Сейчас идёт другая задача" : undefined}
      onClick={() => setStarting(true)}
    >
      <span className="hidden sm:inline">{list.length ? "Проверить снова" : "Проверить живого агента"}</span>
    </Button>
  );
  const page = (body: ReactNode) => (
    <div className="flex h-full flex-col">
      <CheckHeader check={check} actions={actions} />
      <div className="min-h-0 flex-1 overflow-auto">{body}</div>
      <ReplaySheet check={check} open={starting} onClose={() => setStarting(false)} />
    </div>
  );
  if (offline && !state) return page(<ServiceDown />);
  if (!state) return page(<Skeleton className="m-6 h-80" />);
  if (!chosen)
    return page(
      <div className="mx-auto w-full max-w-2xl px-5 py-14">
        <h2 className="text-title font-semibold text-fg">Живой агент на тех же клиентах</h2>
        <div className="mt-3 space-y-2 text-read text-fg-2">
          <p>
            Итог проверки показывает, как агент отвечал в записанных разговорах. Здесь видно, как он отвечает сейчас тем
            же клиентам: синтетический клиент начинает каждый разговор настоящей первой репликой и добивается того же.
          </p>
          <p>
            Ответы оценивает тот же судья по тем же критериям, и каждый разговор встаёт рядом со своей записью: стало
            лучше, стало хуже или без изменений.
          </p>
        </div>
        <div className="mt-8">
          {result ? (
            <Button variant="primary" size="lg" icon={Play} disabled={running} onClick={() => setStarting(true)}>
              Проверить живого агента
            </Button>
          ) : (
            <Link to={stageRoot(check)} className={buttonClass({ variant: "primary", size: "lg" })}>
              Сначала проверьте записи
            </Link>
          )}
        </div>
      </div>,
    );

  // On a wide screen a pair replaces the one before it (Back leaves the page, as in «Разговоры»); on a phone opening
  // one is a step, and «Все клиенты» goes back over it.
  const openPair = (id: string | null) =>
    set((n) => {
      if (id) n.set("d", id);
      else n.delete("d");
    }, wide || !id);
  const runMenu =
    list.length > 1 ? (
      <Menu
        align="right"
        trigger={
          <span className="inline-flex items-center gap-1 text-small text-fg-3 hover:text-fg">
            Другие проверки
            <ChevronDown aria-hidden className="size-3.5" />
          </span>
        }
        items={list.map((r) => ({
          key: r.id,
          label: `${longDay(r.startedAt)} · ${r.targetName}`,
          on: r.id === chosen.id,
          run: () =>
            set((n) => {
              n.set("id", r.id);
              n.delete("d");
            }),
        }))}
      />
    ) : null;
  const stale = result?.checkId && chosen.basis.checkId !== result.checkId;

  const head = (
    <div className="border-b border-line px-4 pb-6 pt-6 lg:px-10 lg:pt-8">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <p className="text-read text-fg-3">{replayMeta(chosen)}</p>
        {runMenu}
      </div>
      <p className="mt-1 text-small text-fg-3">
        Клиенты из итога: {basis}
        {stale ? " — это прошлый итог, текущий проверен позже." : "."}
      </p>
      <div className="mt-5">
        <ReplayNumbers r={chosen} />
      </div>
      <ChangeLine
        r={chosen}
        className="mt-3"
        onPick={(change) =>
          set((n) => {
            n.set("v", change);
            n.delete("d");
          })
        }
      />
      <VerdictLine r={chosen} className="mt-2" />
      {chosen.status === "running" && (
        <p className="mt-3 text-body text-run" role="status">
          Идёт проверка: {chosen.done} из {count(chosen.size, "разговора", "разговоров", "разговоров")}. Пары появляются
          по мере готовности.
        </p>
      )}
      {(chosen.status === "failed" || chosen.status === "stopped") && chosen.error && (
        <p className="mt-3 text-body text-bad">{chosen.error}</p>
      )}
    </div>
  );

  if (error && !record)
    return page(
      <>
        {head}
        <LoadFailed title="Не удалось загрузить разговоры" error={error} onRetry={() => void refetch()} />
      </>,
    );
  const showDetail = !!selected && (wide || !!selectedId);
  return page(
    <>
      {/* On a phone an open pair takes the screen: the numbers are a step back, with the list. */}
      {(wide || !showDetail) && head}
      <div className="grid min-h-[480px] lg:grid-cols-[380px_minmax(0,1fr)]">
        <div className={cn("border-r border-line", showDetail && !wide && "hidden")}>
          <div className="border-b border-line px-4 py-3">
            <Segmented<Filter>
              size="sm"
              label="Какие пары"
              value={filter}
              onChange={(v) =>
                set((n) => {
                  if (v === "all") n.delete("v");
                  else n.set("v", v);
                  n.delete("d");
                })
              }
              options={FILTERS.filter((f) => f.value === "all" || items.some((i) => changeOf(i) === f.value)).map(
                (f) => ({
                  value: f.value,
                  label: f.label,
                  count: f.value === "all" ? items.length : items.filter((i) => changeOf(i) === f.value).length,
                }),
              )}
            />
          </div>
          {!record ? (
            <Skeleton className="m-4 h-64" />
          ) : (
            <ul className="divide-y divide-line">
              {shown.map((item) => (
                <PairRow
                  key={item.dialogueId}
                  item={item}
                  on={item.dialogueId === selected?.dialogueId}
                  onOpen={() => openPair(item.dialogueId)}
                />
              ))}
            </ul>
          )}
        </div>
        {showDetail && selected ? (
          <Pair item={selected} numbered={numbered} onBack={wide ? undefined : () => openPair(null)} />
        ) : (
          wide &&
          record && (
            <EmptyState drop title={shown.length ? "Выберите клиента" : "Таких пар нет"} className="justify-center">
              {shown.length ? "Слева клиенты: запись и разговор сейчас." : "Выберите другой фильтр."}
            </EmptyState>
          )
        )}
      </div>
    </>,
  );
}
