import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ChevronDown, CircleCheck, Download, FileText, Pencil, Plus, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { launchLink, SECTIONS } from "../../app/links";
import { SIMULATIONS } from "../../app/product";
import { api, textFile } from "../../lab/api";
import { nameFromText, type Criterion } from "../../lab/criteria";
import { count, longDay, pct } from "../../lab/format";
import { useJudges, type JudgeVersion } from "../../lab/judges";
import { useLabState } from "../../lab/LabProvider";
import { download } from "../../lab/problemReport";
import { useSource, type Problems } from "../../lab/problems";
import { useFirstRun } from "../../lab/compare";
import { TONE_ID, toneJudgedByOther, toneResult } from "../../lab/tone";
import { MarkNo } from "../../product/MarkNo";
import { Step, Steps, STEP_NEXT } from "../../product/Checklist";
import { IMPORTANT, SeriousTag, SeverityHint, SeverityNote, SeveritySwitch } from "../../product/Severity";
import { Button } from "../../ui/Button";
import { EmptyState, Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { Menu, type MenuItem } from "../../ui/Menu";
import { Modal } from "../../ui/Modal";
import { Sheet } from "../../ui/Sheet";
import { RuleEditor } from "../judges/RuleEditor";
import { AddRules } from "./AddRules";
import { CriterionPanel, type Shown } from "./CriterionPanel";
import { plainRule, RuleText } from "./RuleText";

/** A criterion as its card shows it: from the rules in use, with what the last check found by it when it judged it. */
type Card = {
  id: string;
  n: number;
  name: string;
  text: string;
  quote: string;
  condition: string;
  acceptable: string;
  /** What people clarified about it after a check, «Уточнить критерий» on a problem's page: the judge reads them too. */
  clarifications: string[];
  result?: Criterion;
};

/**
 * One criterion as a card, as the criteria were shown before the first check: its number, name and words; after a
 * check, what it found — «45 из 100 с ошибкой» with a thin bar, «важный» when it is. Pressed, it opens. Under it,
 * after a check, whether its errors are serious: switched on the card itself, with whose decision it is and the model's
 * reason, so the proposals of the automatic check are read and decided on one screen.
 */
function CriterionCard({ card, judged, onOpen }: { card: Card; judged: boolean; onOpen: () => void }) {
  const s = card.result?.r.log;
  const checked = s ? s.failed + s.passed : 0;
  const sim = card.result?.r.sim;
  const played = sim ? sim.failed + sim.passed : 0;
  return (
    <div className="flex h-full flex-col rounded-[18px] bg-inset">
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "group flex w-full flex-1 flex-col p-4 text-left transition-colors hover:bg-fg/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60",
          judged && card.result ? "rounded-t-[18px]" : "rounded-[18px]",
        )}
      >
        <span className="flex items-center gap-2 text-small text-fg-3">
          <span className="tabular-nums">Критерий {card.n}</span>
          {card.clarifications.length > 0 && (
            <span>· {count(card.clarifications.length, "уточнение", "уточнения", "уточнений")}</span>
          )}
          {card.result?.r.serious && <SeriousTag rule={card.result.r} />}
        </span>
        <span className="mt-1 text-read font-semibold text-fg">{card.name}</span>
        <span className="mt-1 line-clamp-3 text-body text-fg-2">{plainRule(card.text)}</span>
        {judged && (
          <span className="mt-auto block pt-4">
            {s && checked ? (
              <>
                <span className="flex items-baseline justify-between gap-3 text-small text-fg-3">
                  <span>
                    <span className={cn("font-semibold tabular-nums", s.failed ? "text-bad" : "text-fg")}>
                      {s.failed}
                    </span>{" "}
                    из {checked} с ошибкой
                  </span>
                  <span className="tabular-nums">{pct(s.failed, checked)}%</span>
                </span>
                <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-fg/10">
                  <span
                    className="block h-full rounded-full bg-bad/70"
                    style={{ width: `${s.failed ? Math.max(3, pct(s.failed, checked)) : 0}%` }}
                  />
                </span>
              </>
            ) : (
              <span className="text-small text-fg-3">
                {card.result ? "Не встретился в разговорах последней проверки" : "В последней проверке его не было"}
              </span>
            )}
            {SIMULATIONS && played > 0 && (
              <span className="mt-2 block text-small text-fg-3">
                В симуляциях: <span className="tabular-nums">{sim!.failed}</span> из {played} с ошибкой
              </span>
            )}
          </span>
        )}
      </button>
      {judged && card.result && (
        <div className="border-t border-fg/[0.07] px-4 pb-4 pt-3">
          <SeveritySwitch check="tone" rule={card.result.r} />
          <SeverityNote check="tone" rule={card.result.r} className="mt-1.5" />
        </div>
      )}
    </div>
  );
}

/** A criterion the last check did not judge, opened: what it requires, when, what is allowed, and the rules' words. */
function CriterionDetails({ card, onEdit }: { card: Card; onEdit: () => void }) {
  const part = (label: string, body: ReactNode) => (
    <div>
      <p className="text-small font-medium text-fg-3">{label}</p>
      <div className="mt-1 text-body text-fg-2">{body}</div>
    </div>
  );
  return (
    <div className="space-y-5 p-5 sm:p-7">
      <RuleText text={card.text} className="text-read text-fg" />
      {card.condition && part("Когда применяется", card.condition)}
      {card.acceptable && part("Что допустимо", card.acceptable)}
      {card.clarifications.length > 0 && part("Уточнения команды", <Clarifications notes={card.clarifications} />)}
      {card.quote &&
        part(
          "Как написано в правилах",
          <blockquote className="whitespace-pre-wrap border-l-2 border-line-strong pl-3">{card.quote}</blockquote>,
        )}
      <Button icon={Pencil} onClick={onEdit}>
        Изменить критерии
      </Button>
    </div>
  );
}

/**
 * The way to the first check of tone of voice, while there is none: the conversations, the rules with their criteria,
 * then the check. While the rules are being given (`line`) it is one line saying where the person is, so the step
 * itself stays in view; once the criteria are ready, the steps as under a check's number (product/Checklist), each done
 * ticked and the first check with the page's one black button, so the first run reads as one path to the result.
 */
function FirstSteps({ criteria, collecting, line }: { criteria: number; collecting?: boolean; line?: boolean }) {
  const { state } = useLabState();
  const total = state?.logs.total ?? 0;
  const name = state?.logs.name || state?.logs.file;
  const ready = criteria > 0;
  if (line) {
    const steps: [string, "done" | "now" | "later"][] = [
      ["Разговоры", total ? "done" : "now"],
      ["Правила и критерии", ready ? "done" : total ? "now" : "later"],
      ["Первая проверка", ready && total ? "now" : "later"],
    ];
    return (
      <ol aria-label="Путь к первой проверке" className="mt-5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-small">
        {steps.map(([label, at], i) => (
          <li key={label} className="flex items-center gap-2.5">
            {i > 0 && <span aria-hidden className="h-px w-5 bg-line-strong" />}
            <span
              aria-current={at === "now" ? "step" : undefined}
              className={cn("flex items-center gap-1.5", at === "now" ? "font-medium text-fg" : "text-fg-3")}
            >
              {at === "done" ? (
                <CircleCheck aria-hidden className="size-4 text-ok" />
              ) : (
                <span
                  aria-hidden
                  className={cn("size-3 rounded-full border-2", at === "now" ? "border-fg" : "border-line-strong")}
                />
              )}
              {label}
              {at === "now" && collecting && <span className="font-normal text-fg-3">· собираются</span>}
            </span>
          </li>
        ))}
      </ol>
    );
  }
  return (
    <Steps className="mt-6">
      <Step
        state={total ? "done" : "todo"}
        title={
          total ? `${name ? `«${name}»: ` : ""}${count(total, "разговор", "разговора", "разговоров")}` : "Разговоры"
        }
        text={total ? undefined : "Загрузите датасет разговоров агента: по нему пойдёт проверка."}
        action={
          !total && (
            <Link to={SECTIONS.data} className={STEP_NEXT}>
              Добавить датасет
            </Link>
          )
        }
      />
      <Step
        state={ready ? "done" : "todo"}
        title={ready ? "Критерии собраны" : "Правила и критерии"}
        text={
          ready
            ? "Проверьте их ниже: по ним пойдёт проверка."
            : "Дайте правила общения: модель соберёт из них критерии."
        }
      />
      <Step
        state="todo"
        title="Первая проверка"
        text={
          ready && total
            ? `Модель оценит разговоры по ${count(criteria, "критерию", "критериям", "критериям")} и покажет, где агент нарушает правила и как часто.`
            : "Станет доступна, когда будут разговоры и критерии."
        }
        action={
          ready &&
          !!total && (
            <Link to={launchLink("tone")} className={STEP_NEXT}>
              Запустить проверку
            </Link>
          )
        }
      />
    </Steps>
  );
}

/** What people clarified about a criterion, each note as they confirmed it. */
function Clarifications({ notes, className }: { notes: string[]; className?: string }) {
  return (
    <ul className={cn("list-disc space-y-1 pl-5", className)}>
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}

/**
 * The rules of communication as the bank wrote them, each criterion's words marked with its number and, after a check,
 * with what it found there («45 из 100»); a mark opens the criterion.
 */
function RulesDocument({
  content,
  cards,
  judged,
  onOpen,
}: {
  content: string;
  cards: Card[];
  judged: boolean;
  onOpen: (id: string) => void;
}) {
  const marks = cards
    .flatMap((card) => {
      const quote = card.quote.trim();
      const at = quote ? content.indexOf(quote) : -1;
      return at < 0 ? [] : [{ at, end: at + quote.length, card }];
    })
    .sort((a, b) => a.at - b.at);
  const parts: ReactNode[] = [];
  let pos = 0;
  for (const { at, end, card } of marks) {
    if (at < pos) continue;
    if (at > pos) parts.push(content.slice(pos, at));
    parts.push(
      <button
        key={card.id}
        type="button"
        onClick={() => onOpen(card.id)}
        title={`Критерий ${card.n}: ${card.name}`}
        className="rounded-sm bg-mark/25 text-left transition-colors hover:bg-mark/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
      >
        <MarkNo n={card.n} className="mr-1 align-[1px]" />
        {content.slice(at, end)}
        {judged && card.result && card.result.r.log.failed + card.result.r.log.passed > 0 && (
          <span className="ml-1.5 whitespace-nowrap text-small text-fg-3">
            ·{" "}
            <span className={cn("tabular-nums", card.result.r.log.failed > 0 && "text-bad")}>
              {card.result.r.log.failed}
            </span>
            {"\u00a0"}из{"\u00a0"}
            {card.result.r.log.failed + card.result.r.log.passed}
          </span>
        )}
      </button>,
    );
    pos = end;
  }
  parts.push(content.slice(pos));
  return <div className="whitespace-pre-wrap break-words p-5 text-body leading-relaxed text-fg-2 sm:p-7">{parts}</div>;
}

/**
 * «Критерии» of tone of voice, one page before and after a check. Without rules, the step that gives them (AddRules);
 * while the model collects the criteria, their places wait. With rules: the rules in a block — which document, which
 * version (the others and a new set by hand in its menu), «Заменить правила» with the same cards as the first time,
 * «Изменить критерии», the document with each criterion marked, «Скачать»; before the first check the way to it
 * (FirstSteps), with «Запустить проверку» as the next step. Then every criterion as a card, the same before and after a
 * check, with what the last check found by it and, after a check, its seriousness decided on the card; a card opens the
 * criterion (?c=): what it requires and where it is written, and after a check its counts and conversations
 * (CriterionPanel).
 */
export function ToneCriteria({ data, list }: { data: Problems | undefined; list: Criterion[] }) {
  const { state, refresh } = useLabState();
  const judges = useJudges("tone");
  const [params, setParams] = useSearchParams();
  const [replacing, setReplacing] = useState(params.get("doc") === "1");
  const [editing, setEditing] = useState<JudgeVersion | null | undefined>();
  // An older address of the rules with their criteria marked (?view=code, «В правилах») opens the document.
  const [reading, setReading] = useState(params.get("view") === "code");
  const [asking, setAsking] = useState<JudgeVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const policy = state?.sources.find((s) => s.id === TONE_ID);
  const text = useSource(reading && policy ? TONE_ID : null);
  const rules = judges.selected;
  // The criteria in force: of the selected version, else as the service holds them (a library not here yet, or one
  // asked again after new criteria came), so the page never says there are none while there are.
  const set = rules?.criteria ?? state?.toneOfVoice?.criteria ?? [];
  const hasResult = !!toneResult(state);
  // Never checked yet, on any export: the way to the first check leads the page. One checked before and given a new
  // export has its usual page, «Новая проверка» in the head the next step.
  const first = useFirstRun("tone") === true;
  // The last check went by other criteria (collected again, replaced or edited since): its numbers stand for those,
  // never for these, and stay on «Итог» and in the history.
  const other = hasResult && toneJudgedByOther(state);
  const collecting = !!state?.job.running && state.job.kind === "tone-criteria";
  // The first criteria collected lead on to the first check: «Новая проверка» takes them, and opens them from there.
  // They come a moment after the task ends (the rules' versions are fetched again), so the page waits for them.
  // Collected again later, the criteria come where the rules were given, low on the page: the page goes back to its
  // top, to them. Its own scroll moves, not the frame around it (as checks/RunPage does). A collection is told by its
  // task, finished since the page opened: a quick one may end between two looks at the service.
  const navigate = useNavigate();
  const [collected, setCollected] = useState(false);
  const top = useRef<HTMLDivElement>(null);
  const loaded = !!state;
  const finished =
    state?.job.kind === "tone-criteria" && !state.job.running ? `${state.job.id}|${state.job.startedAt}` : "";
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded) return;
    // What the page found when it opened is no collection of its own.
    if (seen.current !== null && finished && finished !== seen.current) {
      if (first) setCollected(true);
      else {
        let box = top.current?.parentElement ?? null;
        while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
        box?.scrollTo({ top: 0 });
      }
    }
    seen.current = finished;
  }, [loaded, finished, first]);
  const jobError = state?.job.error;
  useEffect(() => {
    if (collected && set.length && !jobError) navigate(launchLink("tone"));
  }, [collected, set.length, jobError, navigate]);
  const failed =
    !state?.job.running && state?.job.kind === "tone-criteria" && state.job.error && state.job.error !== "Остановлено"
      ? state.job.error
      : null;

  const byRule = (id: string) => (other ? undefined : list.find((c) => c.r.id === id || c.r.log.ruleIds.includes(id)));
  const cards: Card[] = set.length
    ? set.map((c, i) => {
        const result = byRule(c.id);
        return {
          id: c.id,
          n: result?.n ?? i + 1,
          name: c.name?.trim() || nameFromText(c.text),
          text: c.text,
          quote: c.quote,
          condition: c.condition,
          acceptable: c.acceptable,
          clarifications: c.clarifications ?? [],
          result,
        };
      })
    : // Without rules in force, the criteria of the last check, never those of a run of the simulations alone.
      (hasResult ? list : []).map((c) => ({
        id: c.r.id,
        n: c.n,
        name: c.name,
        text: c.r.rule.text,
        quote: c.r.rule.quote,
        condition: c.r.rule.condition,
        acceptable: c.r.rule.acceptable,
        clarifications: [],
        result: c,
      }));
  const judged = hasResult && !other;
  const unjudged = judged ? cards.filter((c) => !c.result) : [];

  const setUrl = (edit: (n: URLSearchParams) => void) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        edit(n);
        return n;
      },
      { replace: true },
    );
  const asked = params.get("c");
  const chosen = asked ? cards.find((c) => c.id === asked || c.result?.r.id === asked) : undefined;
  const open = (id: string) => setUrl((n) => n.set("c", id));
  const close = () =>
    setUrl((n) => {
      n.delete("c");
      n.delete("x");
    });
  const shownRaw = params.get("x");
  const shown: Shown =
    shownRaw === "FAIL" || shownRaw === "PASS" || shownRaw === "UNKNOWN"
      ? shownRaw
      : chosen?.result && !chosen.result.r.log.failed
        ? "PASS"
        : "FAIL";
  const twice = list.some((c) => c.r.log.examples.some((e) => !!e.second));

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const blocked = busy || judges.changing || !!state?.job.running;
  // Other rules make the current result the history's, so the person is asked first when there is one.
  const take = (v: JudgeVersion) => (hasResult ? setAsking(v) : void act(() => judges.select(v.id)));
  const versions = [...(judges.data?.versions ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const versionItems: MenuItem[] = [
    ...versions.map((v) => ({
      key: v.id,
      label: `«${v.name}», версия ${v.version}`,
      sub: `${count(v.criteria.length, "критерий", "критерия", "критериев")} · ${longDay(v.createdAt)}`,
      on: v.id === judges.data?.selectedId,
      run: () => v.id !== judges.data?.selectedId && take(v),
    })),
    { key: "new", label: "Новый набор вручную", sub: "Свои критерии, без документа", run: () => setEditing(null) },
  ];
  const stop = () =>
    void act(async () => {
      await api("/api/job/stop", {});
      await refresh();
    });

  const page = (body: ReactNode) => (
    <div ref={top} className="max-w-[920px] px-4 pb-16 pt-8 lg:px-10">
      {body}
      {editing !== undefined && (
        <RuleEditor
          key={editing?.id ?? "new"}
          check="tone"
          version={editing}
          baseId={versions.find((v) => v.setId === editing?.setId)?.id}
          replacesResult={hasResult}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );

  if (collecting)
    return page(
      <>
        <p className="text-small font-medium text-fg-3">Правила общения</p>
        <h2 className="mt-1 text-page font-semibold text-fg">
          Собираем критерии из «{policy?.origin || "правил общения"}»
        </h2>
        <p className="mt-2 max-w-[62ch] text-read text-fg-3">
          Модель читает правила и собирает из них критерии. Это займёт пару минут: они появятся здесь.
        </p>
        <Button className="mt-5" disabled={busy} onClick={stop}>
          Остановить
        </Button>
        {first && <FirstSteps criteria={0} collecting line />}
        <ol aria-hidden className="mt-10 grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="h-[132px] animate-pulse rounded-[18px] bg-inset" />
          ))}
        </ol>
      </>,
    );

  const failedLine = failed && (
    <p role="alert" className="mt-4 max-w-[68ch] text-body text-bad">
      Критерии не собрались: {failed}
    </p>
  );

  if (!cards.length && judges.isError)
    return page(
      <LoadFailed title="Правила не загрузились" error={judges.error} onRetry={() => void judges.refetch()} />,
    );
  if (!cards.length && !judges.data)
    return page(
      <>
        <Skeleton className="h-28 max-w-[620px]" />
        <Skeleton className="mt-8 h-72" />
      </>,
    );
  if (!cards.length)
    return page(
      <>
        <p className="text-small font-medium text-fg-3">Правила общения</p>
        <h2 className="mt-1 text-page font-semibold text-fg">Из правил банка — критерии проверки</h2>
        <p className="mt-2 max-w-[62ch] text-read text-fg-3">
          Дайте Lab правила общения банка: документ, текст или правила другого агента. Модель соберёт из них критерии, и
          по ним пойдёт проверка разговоров.
        </p>
        {first && <FirstSteps criteria={0} line />}
        {failedLine}
        {state && <AddRules />}
      </>,
    );

  const source = rules?.name ?? policy?.origin;
  return page(
    <>
      <section aria-label="Правила общения">
        <p className="text-small font-medium text-fg-3">Правила общения</p>
        <h2 className="mt-1 text-page font-semibold text-fg">
          {count(cards.length, "критерий", "критерия", "критериев")}
          {source ? ` из «${source}»` : ""}
        </h2>
        <p className="mt-2 max-w-[66ch] text-read text-fg-3">
          {first
            ? "Так мы поняли ваши правила общения. Проверьте, всё ли верно: по этим критериям пойдёт проверка."
            : "По этим критериям идут проверки. Нажмите на критерий, чтобы увидеть его целиком и разговоры, где он нарушен."}
        </p>
        {first && <FirstSteps criteria={cards.length} />}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Button icon={RefreshCw} disabled={blocked} onClick={() => setReplacing(true)}>
            Заменить правила
          </Button>
          <Button icon={Pencil} disabled={blocked || !rules} onClick={() => setEditing(rules)}>
            Изменить критерии
          </Button>
          {policy && (
            <Button icon={FileText} onClick={() => setReading(true)}>
              Документ
            </Button>
          )}
          <Button
            variant="ghost"
            icon={Download}
            disabled={busy}
            onClick={() => void act(async () => download("rules-tone.md", await textFile("/api/judges/tone/export")))}
          >
            Скачать
          </Button>
          {rules && (
            <Menu
              items={versionItems}
              trigger={
                <span className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-small text-fg-3 transition-colors hover:bg-hover hover:text-fg">
                  версия {rules.version} · {longDay(rules.createdAt)}
                  <ChevronDown aria-hidden className="size-3.5" />
                </span>
              }
            />
          )}
        </div>
        {error && (
          <p role="alert" className="mt-3 text-body text-bad">
            {error}
          </p>
        )}
        {failedLine}
      </section>

      {replacing && state && (
        <section aria-label="Другие правила" className="mt-8 border-t border-line pt-6">
          <h3 className="text-lead font-semibold text-fg">Другие правила</h3>
          <AddRules replacing onDone={() => setReplacing(false)} />
        </section>
      )}

      {hasResult && data && (
        <div className="mt-8 space-y-1 border-t border-line pt-5 text-small text-fg-3">
          {other ? (
            <p>
              Последняя проверка{data.log?.finishedAt ? ` ${longDay(data.log.finishedAt)}` : ""} шла по прежним
              критериям: её числа — в «Итоге» и «Истории».{" "}
              <Link to={launchLink("tone")} className="font-medium text-run hover:underline">
                Новая проверка
              </Link>{" "}
              пойдёт по этим.
            </p>
          ) : (
            data.log?.finishedAt && (
              <p>
                Последняя проверка {longDay(data.log.finishedAt)}
                {unjudged.length > 0
                  ? `: шла по ${cards.length - unjudged.length}\u00a0из\u00a0${cards.length}, ${unjudged.map((c) => `«${c.name}»`).join(", ")} ${unjudged.length === 1 ? "в неё не входил" : "в неё не входили"}. Новая проверка пойдёт по всем.`
                  : "."}
              </p>
            )
          )}
          {!other && <p>{IMPORTANT}</p>}
          {!other && <SeverityHint check="tone" data={data} />}
        </div>
      )}

      <ol className="mt-6 grid gap-3 sm:grid-cols-2">
        {[...cards]
          .sort((a, b) => a.n - b.n)
          .map((card) => (
            <li key={card.id}>
              <CriterionCard card={card} judged={judged} onOpen={() => open(card.id)} />
            </li>
          ))}
        <li>
          <button
            type="button"
            disabled={blocked || !rules}
            onClick={() => setEditing(rules)}
            className="flex h-full min-h-[132px] w-full flex-col items-center justify-center gap-2 rounded-[18px] border border-dashed border-line-strong text-body text-fg-3 transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60 disabled:opacity-50"
          >
            <Plus aria-hidden className="size-5" />
            Добавить критерий
          </button>
        </li>
      </ol>

      <Sheet
        open={!!asked}
        onClose={close}
        title={chosen?.name ?? "Критерий из ссылки"}
        sub={chosen ? `Критерий ${chosen.n}` : undefined}
      >
        {asked && !chosen ? (
          <EmptyState
            drop
            title="Такого критерия нет"
            className="py-16"
            action={<Button onClick={close}>Все критерии</Button>}
          >
            Критерия из ссылки нет в правилах, по которым идут проверки: возможно, их собрали заново или заменили.
          </EmptyState>
        ) : chosen?.result ? (
          <>
            {chosen.clarifications.length > 0 && (
              <div className="px-5 pt-5 sm:px-7">
                <p className="text-small font-medium text-fg-3">Уточнения команды</p>
                <Clarifications notes={chosen.clarifications} className="mt-1 text-body text-fg-2" />
              </div>
            )}
            <CriterionPanel
              bare
              key={chosen.result.r.id}
              c={chosen.result}
              check="tone"
              side="log"
              twice={twice}
              shown={shown}
              onShown={(v) => setUrl((n) => n.set("x", v))}
              className="border-0 bg-transparent lg:border-l-0"
            />
          </>
        ) : chosen ? (
          <CriterionDetails card={chosen} onEdit={() => setEditing(rules)} />
        ) : null}
      </Sheet>

      <Sheet
        open={reading}
        onClose={() => setReading(false)}
        width="lg"
        title={policy ? `«${policy.origin}»` : "Правила общения"}
        sub="Текст правил общения. Номер у фразы — критерий, собранный из неё; нажмите, чтобы открыть."
      >
        {text.isError ? (
          <LoadFailed title="Текст правил не загрузился" error={text.error} onRetry={() => void text.refetch()} />
        ) : text.data ? (
          <RulesDocument
            content={text.data.content}
            cards={cards}
            judged={judged}
            onOpen={(id) => {
              setReading(false);
              open(id);
            }}
          />
        ) : (
          <Skeleton className="m-5 h-80" />
        )}
      </Sheet>

      <Modal
        open={!!asking}
        onClose={() => !busy && setAsking(null)}
        title="Взять другие правила?"
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setAsking(null)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={blocked}
              onClick={() =>
                asking &&
                void act(async () => {
                  await judges.select(asking.id);
                  setAsking(null);
                })
              }
            >
              Взять
            </Button>
          </>
        }
      >
        <p className="text-read text-fg-2">
          Итог Tone of voice по прежним правилам уйдёт в историю. Следующая проверка пойдёт по «{asking?.name}», версия{" "}
          {asking?.version}.
        </p>
      </Modal>
    </>,
  );
}
