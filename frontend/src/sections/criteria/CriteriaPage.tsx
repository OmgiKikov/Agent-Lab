import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BookOpen, ChevronDown, RotateCcw } from "lucide-react";
import { launchLink, type Check } from "../../app/links";
import { useWide } from "../../app/useWide";
import { nameFromText, useCriteria, type Criterion } from "../../lab/criteria";
import { count, day, plural } from "../../lab/format";
import { useSource } from "../../lab/problems";
import { secondOf } from "../../lab/problemStats";
import { decisions } from "../../lab/verdicts";
import { useKeys } from "../../app/keys";
import { useLabState } from "../../lab/LabProvider";
import { accuracySources, customAccuracy, TONE_ID } from "../../lab/tone";
import { SeverityHint } from "../../product/Severity";
import { Button, buttonClass } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { Menu } from "../../ui/Menu";
import { Segmented } from "../../ui/Segmented";
import { CheckHeader } from "../checks/CheckHeader";
import { BeforeCheck } from "./BeforeCheck";
import { RulesSheet } from "../judges/RulesSheet";
import { useJudges } from "../../lab/judges";
import { CodeView } from "./CodeView";
import { CriteriaTable } from "./CriteriaTable";
import { CriterionPanel, type Shown } from "./CriterionPanel";
import { Files } from "./Files";
import { nameOf, type SideKey } from "./model";
import { SIMULATIONS } from "../../app/product";

type View = "code" | "list";

/** By frequency on the side, broken first: the order J and K walk, and the first one chosen. */
const byFrequency = (list: Criterion[], side: SideKey) =>
  [...list].sort((a, b) => b.r[side].failed - a.r[side].failed || a.n - b.n);

/**
 * «Критерии» of a check: what the agent must do, where it is written and how it went — in the check's conversations
 * («Диалоги») and in the last run of its scenarios («Симуляции»). Accuracy shows the agent's prompt as code with each
 * criterion lit in place; tone of voice, the person's rules of communication the same way. The chosen criterion opens
 * with its conversations. Here a person decides whether a criterion's errors are serious (in its row and in its panel)
 * or confirms all the automatic check proposed; until a person decided every criterion, one quiet line says where it
 * stands, with its one action.
 */
export function CriteriaPage({ check }: { check: Check }) {
  const { state, offline } = useLabState();
  const [params, setParams] = useSearchParams();
  const wide = useWide();
  const { data, list, error, retry } = useCriteria(check);
  const judges = useJudges(check);
  const tone = check === "tone";
  const rulesOpen = params.get("rules") === "1";
  const set = (edit: (n: URLSearchParams) => void, replace = true) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        edit(n);
        return n;
      },
      { replace },
    );

  // The simulations are hidden in the first release (app/product): their side of a criterion is not offered.
  const side: SideKey =
    SIMULATIONS && (params.get("s") === "sim" || (params.get("s") !== "log" && !data?.log && !!data?.sim))
      ? "sim"
      : "log";
  const view: View =
    params.get("view") === "list" || params.get("view") === "code" ? (params.get("view") as View) : "list";
  const ordered = useMemo(() => byFrequency(list, side), [list, side]);
  // Tone of voice is written in one document, the person's rules; accuracy in the prompts and tools of the agent.
  const sources = useMemo(
    () => (tone ? (state?.sources.filter((s) => s.id === TONE_ID) ?? []) : accuracySources(state)),
    [tone, state],
  );
  const asked = params.get("c");
  const chosen = (asked ? list.find((c) => c.r.id === asked) : wide ? ordered[0] : undefined) ?? null;
  // A criterion the address names that this check does not have: said so in the panel's place, never a blank one.
  const lost = !!asked && !!data && !chosen;
  const fileId =
    params.get("f") ??
    chosen?.r.rule.sourceId ??
    sources.find((s) => list.some((c) => c.r.rule.sourceId === s.id))?.id ??
    null;
  const source = sources.find((s) => s.id === fileId) ?? null;
  // Only a source the service lists is asked for: one an address names that is gone is said so, not waited for.
  const text = useSource(view === "code" ? (source?.id ?? null) : null);
  const items = useMemo(() => list.filter((c) => c.r.rule.sourceId === fileId), [list, fileId]);
  const shownRaw = params.get("x") as Shown | null;
  const shown: Shown =
    shownRaw === "FAIL" || shownRaw === "PASS" || shownRaw === "UNKNOWN"
      ? shownRaw
      : chosen && !chosen.r[side].failed
        ? "PASS"
        : "FAIL";

  const select = (id: string) => {
    const c = list.find((x) => x.r.id === id);
    set((n) => {
      n.set("c", id);
      n.delete("x");
      if (c?.r.rule.sourceId) n.set("f", c.r.rule.sourceId);
    }, wide);
  };
  const step = (d: 1 | -1) => {
    if (!ordered.length) return;
    const i = ordered.findIndex((c) => c.r.id === chosen?.r.id);
    select(ordered[Math.max(0, Math.min(ordered.length - 1, (i < 0 ? -1 : i) + d))].r.id);
  };
  useKeys({
    KeyJ: () => step(1),
    KeyK: () => step(-1),
    Escape: () => {
      if (!wide && asked) set((n) => n.delete("c"), false);
    },
  });

  const sideOptions = (
    [
      ["log", "Диалоги"],
      ["sim", "Симуляции"],
    ] as const
  ).filter(([k]) => (k === "log" ? !!data?.log : SIMULATIONS && !!data?.sim));
  const header = (
    <>
      <CheckHeader
        check={check}
        actions={
          // Read anew only once criteria were read: before the first check they come from the code anyway.
          !tone && !customAccuracy(state) && list.length > 0 ? (
            <Link
              to={`${launchLink("code")}?replan=1`}
              title="Новая проверка, в которой модель прочитает код агента заново и извлечёт критерии дословно"
              className={buttonClass()}
            >
              <RotateCcw aria-hidden className="size-3.5" />
              Извлечь заново
            </Link>
          ) : undefined
        }
      />
      <RulesSheet check={check} open={rulesOpen} onClose={() => set((n) => n.delete("rules"), false)} />
    </>
  );
  const rulesButton = (
    <Button size="sm" icon={BookOpen} onClick={() => set((n) => n.set("rules", "1"), false)}>
      Правила
    </Button>
  );
  if (offline && !state)
    return (
      <div className="flex h-full flex-col">
        {header}
        <ServiceDown />
      </div>
    );
  if (!data && error)
    return (
      <div className="flex h-full flex-col">
        {header}
        <LoadFailed page title="Не удалось загрузить критерии" error={error} onRetry={retry} />
      </div>
    );
  if (!state || !data)
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="p-5">
          <Skeleton className="h-6 w-[min(640px,90%)]" />
          <Skeleton className="mt-6 h-[480px]" />
        </div>
      </div>
    );
  // Before the first check the criteria are the step after the rules: the ones collected from them, or where they come
  // from. After it, every criterion with its verdicts.
  if (!list.length)
    return (
      <div className="flex h-full flex-col">
        {header}
        <div className="min-h-0 flex-1 overflow-auto">
          <BeforeCheck check={check} rules={judges.selected} onRules={() => set((n) => n.set("rules", "1"), false)} />
        </div>
      </div>
    );

  const second = list.reduce(
    (acc, c) => {
      const s = secondOf(c.r.log.examples);
      return { checked: acc.checked + s.checked, agree: acc.agree + s.agree };
    },
    { checked: 0, agree: 0 },
  );
  const people = decisions(data);
  // The criteria of the rules in use that the last check did not judge — chosen out of it, or collected after it: the
  // list below is the check's, and the next check goes by all of them, so the page says which are not in it yet.
  const judged = new Set(list.flatMap((c) => [c.r.id, ...c.r.log.ruleIds]));
  const inUse = judges.selected?.criteria ?? [];
  const unjudged = inUse.filter((c) => !judged.has(c.id));
  // A second model's opinion on some verdict of this side (LAB_SECOND_MODEL). Without one, «Модели совпали» and «Две
  // проверки» would only say «—» and «не с чем сравнить» on every criterion: nothing to tell.
  const twice = (s: SideKey) => list.some((c) => c.r[s].examples.some((e) => !!e.second));
  const panelOpen = (!!chosen || lost) && (wide || !!asked);
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="flex flex-col gap-2 border-b border-line px-4 py-3 lg:flex-row lg:items-center lg:gap-4 lg:px-5">
        <div className="min-w-0 lg:flex-1">
          <p className="text-small text-fg-3">
            <span className="text-fg-2">
              {list.length}
              {"\u00a0"}
              {plural(list.length, "критерий", "критерия", "критериев")}{" "}
              {judges.selected
                ? `из «${judges.selected.name}»`
                : tone
                  ? "из правил общения"
                  : customAccuracy(state)
                    ? "из своего набора правил"
                    : "из кода агента"}
            </span>
            {data.log?.rulesSince && (
              <>
                , {tone ? "собраны" : "извлечены"} {day(data.log.rulesSince)}
              </>
            )}
            {second.checked > 0 && (
              <>
                {" "}
                · две модели совпали в {second.agree}
                {"\u00a0"}из{"\u00a0"}
                {second.checked} ошибок в диалогах
              </>
            )}
            {people.agree + people.disagree > 0 && (
              <>
                {" "}
                · вы ответили на {people.agree + people.disagree}{" "}
                {plural(people.agree + people.disagree, "случай", "случая", "случаев")}, подтвердили {people.agree}
              </>
            )}
          </p>
          {unjudged.length > 0 && (
            <p className="mt-0.5 text-small text-fg-3">
              Последняя проверка шла по {inUse.length - unjudged.length}
              {"\u00a0"}из{"\u00a0"}
              {inUse.length}: {unjudged.map((c) => `«${c.name?.trim() || nameFromText(c.text)}»`).join(", ")}{" "}
              {unjudged.length === 1 ? "в неё не входил" : "в неё не входили"}. Новая проверка пойдёт по всем.{" "}
              <Link to={launchLink(check)} className="font-medium text-run hover:underline">
                Новая проверка
              </Link>
            </p>
          )}
          {/* Quietly, until a person decided every criterion: the automatic check's proposals, or why there are none. */}
          <SeverityHint check={check} data={data} className="mt-0.5" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {rulesButton}
          {sideOptions.length > 1 && (
            <Segmented<SideKey>
              size="sm"
              label="Где проверяли"
              value={side}
              onChange={(v) =>
                set((n) => {
                  n.set("s", v);
                  n.delete("x");
                })
              }
              options={sideOptions.map(([k, l]) => ({ value: k, label: l }))}
            />
          )}
          <Segmented<View>
            size="sm"
            label="Вид"
            value={view}
            onChange={(v) => set((n) => n.set("view", v))}
            options={[
              { value: "list", label: "Списком" },
              { value: "code", label: tone || customAccuracy(state) ? "В правилах" : "В коде агента" },
            ]}
          />
        </div>
      </div>
      <div
        className={`grid min-h-0 flex-1 ${view === "code" && !tone ? "lg:grid-cols-[232px_minmax(0,1fr)_400px] xl:grid-cols-[248px_minmax(0,1fr)_440px]" : "lg:grid-cols-[minmax(0,1fr)_400px] xl:grid-cols-[minmax(0,1fr)_440px]"}`}
      >
        {view === "code" ? (
          <>
            {/* The rules of communication are one document: no list of files beside it. */}
            <div className={tone ? "hidden" : "hidden lg:contents"}>
              <Files
                sources={sources}
                list={list}
                side={side}
                current={fileId}
                onOpen={(id) =>
                  set((n) => {
                    n.set("f", id);
                    const first = list.find((c) => c.r.rule.sourceId === id);
                    if (first) n.set("c", first.r.id);
                    else n.delete("c");
                  })
                }
              />
            </div>
            <div className={`min-h-0 flex-col ${panelOpen && !wide ? "hidden" : "flex"}`}>
              {source && (
                <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 lg:px-6">
                  <div className={tone ? "hidden" : "lg:hidden"}>
                    <Menu
                      trigger={
                        <span className="inline-flex h-8 items-center gap-1.5 rounded-control border border-line-strong px-2.5 font-mono text-small text-fg">
                          {nameOf(source).file}
                          <ChevronDown aria-hidden className="size-3.5" />
                        </span>
                      }
                      items={sources.map((s) => ({
                        key: s.id,
                        label: nameOf(s).file,
                        sub: count(
                          list.filter((c) => c.r.rule.sourceId === s.id).length,
                          "критерий",
                          "критерия",
                          "критериев",
                        ),
                        on: s.id === fileId,
                        run: () =>
                          set((n) => {
                            n.set("f", s.id);
                            n.delete("c");
                          }),
                      }))}
                    />
                  </div>
                  <span
                    className={
                      tone ? "truncate text-small text-fg-2" : "hidden truncate font-mono text-meta text-fg-3 lg:inline"
                    }
                    title={source.origin}
                  >
                    {source.origin}
                  </span>
                  <span className="ml-auto whitespace-nowrap text-small text-fg-3">
                    {items.length} {plural(items.length, "критерий", "критерия", "критериев")} ·{" "}
                    <span className="text-bad">{items.filter((c) => c.r[side].failed > 0).length} с ошибкой</span>
                  </span>
                </div>
              )}
              {!source ? (
                <EmptyState
                  drop
                  title="Источника нет"
                  className="flex-1 justify-center"
                  action={
                    <Button
                      onClick={() =>
                        set((n) => {
                          n.set("view", "list");
                          n.delete("f");
                        })
                      }
                    >
                      Критерии списком
                    </Button>
                  }
                >
                  {tone
                    ? "Текста правил общения нет среди сохранённых. Критерии из него есть в списке."
                    : "Этого файла нет в прочитанном коде агента. Критерии есть в списке."}
                </EmptyState>
              ) : text.data ? (
                <CodeView
                  label={tone ? "Текст правил общения с критериями" : "Код агента с критериями"}
                  source={source}
                  content={text.data.content}
                  items={items}
                  side={side}
                  selected={chosen?.r.id ?? null}
                  onSelect={select}
                />
              ) : text.error && !text.isFetching ? (
                <LoadFailed
                  title={tone ? "Не удалось загрузить текст правил общения" : "Не удалось загрузить файл кода"}
                  error={text.error}
                  onRetry={() => void text.refetch()}
                  className="px-6"
                />
              ) : (
                <div className="p-6">
                  <Skeleton className="h-[420px]" />
                </div>
              )}
            </div>
          </>
        ) : (
          <CriteriaTable
            className={panelOpen && !wide ? "hidden" : undefined}
            check={check}
            list={list}
            sources={sources}
            selected={chosen?.r.id ?? null}
            onSelect={select}
            hasSim={SIMULATIONS && !!data.sim}
            hasSecond={twice("log")}
          />
        )}
        {panelOpen && chosen && (
          <CriterionPanel
            key={`${chosen.r.id}-${side}`}
            c={chosen}
            check={check}
            side={side}
            runId={data.sim?.runId}
            twice={twice(side)}
            shown={shown}
            onShown={(v) => set((n) => n.set("x", v))}
            onBack={wide ? undefined : () => set((n) => n.delete("c"), false)}
          />
        )}
        {panelOpen && lost && (
          <aside className="flex min-h-0 flex-col border-line bg-side lg:border-l" aria-label="Критерий из ссылки">
            <EmptyState
              drop
              title="Такого критерия нет"
              className="flex-1 justify-center"
              action={<Button onClick={() => set((n) => n.delete("c"), false)}>Все критерии</Button>}
            >
              Критерия из ссылки нет в этой проверке.
            </EmptyState>
          </aside>
        )}
      </div>
    </div>
  );
}
