import { Input, Select } from "../../ui/Field";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowRight,
  Check as Tick,
  ChevronDown,
  Database,
  FlaskConical,
  MessageSquareQuote,
  MessagesSquare,
  Play,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { agentKey } from "../../app/agent";
import { Header } from "../../app/Header";
import { StageTabs } from "../../app/StageTabs";
import { criterionLink, historyLink, launchLink, SECTIONS } from "../../app/links";
import { api } from "../../lab/api";
import { CHECK_NAME, resultOf } from "../../lab/checks";
import { useFirstRun } from "../../lab/compare";
import { datasetFacts, useDatasets } from "../../lab/datasets";
import { count, longDay, plural } from "../../lab/format";
import { useJudges, type JudgeVersion } from "../../lab/judges";
import { useLabState } from "../../lab/LabProvider";
import { MODE_NAME, type Mode } from "../../lab/launches";
import { inQuotes } from "../../lab/quote";
import { codeSources } from "../../lab/tone";
import type { Check } from "../../lab/types";
import { Button, buttonClass } from "../../ui/Button";
import { FirstStepsLine } from "../../product/FirstSteps";
import { MarkNo } from "../../product/MarkNo";
import { PAPER, SimulationPicture } from "../../product/Pictures";
import { SIMULATIONS } from "../../app/product";
import { UploadButton } from "../../product/UploadLogs";
import { shownName } from "../data/DatasetInfo";
import { useConnectionMemory, waysOf } from "../agent/Connection";
import { NoModels } from "../settings/NoModels";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { Menu } from "../../ui/Menu";
import { Sheet } from "../../ui/Sheet";

const MAX = 300; // conversations one launch takes at most (api/launches.py, LaunchCommand)
type Option = { id: Mode; icon: typeof Database; description: string; live: boolean };
const WAYS: Option[] = [
  {
    id: "dataset",
    icon: MessageSquareQuote,
    description: "Оценить ответы, которые уже записаны в датасете. Подключение к агенту не нужно.",
    live: false,
  },
  {
    id: "questions",
    icon: MessagesSquare,
    description: "Задать агенту на стенде те же вопросы клиентов и оценить новые ответы рядом со старыми.",
    live: true,
  },
  {
    id: "simulations",
    icon: FlaskConical,
    description: "Синтетические клиенты разыграют с агентом сценарии из найденных ошибок.",
    live: true,
  },
];
// The simulations are hidden in the first release (app/product).
const OPTIONS = WAYS.filter((option) => option.id !== "simulations" || SIMULATIONS);

const bar = "block h-1.5 rounded-full bg-fg/10";

/** What checking the recorded answers gives: the agent's reply with the quote the check found marked. */
function RecordedPicture() {
  return (
    <div className="flex h-full flex-col justify-center gap-1.5 px-3">
      <span className="ml-auto block h-2.5 w-12 rounded-full bg-customer" />
      <div className="space-y-1.5 rounded-lg bg-list p-2 ring-1 ring-line">
        <span className={cn(bar, "w-14")} />
        <span className="flex items-center gap-1">
          <span className="block h-1.5 w-9 rounded-full bg-mark" />
          <MarkNo n={1} className="h-3 min-w-3 px-0.5 text-[8px]" />
        </span>
      </div>
    </div>
  );
}

/** What asking the live agent gives: the same question, the recorded reply beside the new one. */
function LivePicture() {
  return (
    <div className="flex h-full flex-col justify-center gap-1.5 px-3">
      <span className="ml-auto block h-2.5 w-12 rounded-full bg-customer" />
      <div className="flex gap-1">
        <div className="flex-1 space-y-1.5 rounded-lg bg-list p-1.5 opacity-50 ring-1 ring-line">
          <span className={cn(bar, "w-4/5")} />
          <span className={cn(bar, "w-1/2")} />
        </div>
        <div className="flex-1 space-y-1.5 rounded-lg bg-list p-1.5 ring-1 ring-line-strong">
          <span className={cn(bar, "w-3/4")} />
          <span className={cn(bar, "w-3/5")} />
        </div>
      </div>
    </div>
  );
}

const WAY_PICTURE: Record<Mode, () => ReactNode> = {
  dataset: RecordedPicture,
  questions: LivePicture,
  simulations: SimulationPicture,
};

/**
 * What the form remembers between visits, per agent and check: how to check, not what. The dataset and the rules are
 * always the ones in force (or the dataset its page opened the form with), and all the criteria: a dataset, rules or
 * a part of the criteria chosen once would come back after a new export or new rules, and the launch would put them
 * back in force. Nor the agent's version: it is the chosen dataset's own (lab/datasets).
 */
type Draft = { modes: Mode[]; size: number; target: string };
/** The ways a launch can check; the simulations' only while they are shown (app/product). */
const MODES: Mode[] = SIMULATIONS ? ["dataset", "questions", "simulations"] : ["dataset", "questions"];
function readDraft(check: Check): Draft {
  const fallback: Draft = { modes: ["dataset"], size: 100, target: "" };
  try {
    const value = JSON.parse(localStorage.getItem(agentKey(`launch-draft-${check}`)) ?? "null");
    if (!value || !Array.isArray(value.modes)) return fallback;
    const modes = value.modes.filter(
      (mode: unknown): mode is Mode => typeof mode === "string" && MODES.includes(mode as Mode),
    );
    return {
      modes: modes.length ? [...new Set<Mode>(modes)] : fallback.modes,
      size: Number.isFinite(value.size) ? Math.max(1, Math.min(MAX, value.size)) : 100,
      target: typeof value.target === "string" ? value.target : "",
    };
  } catch {
    return fallback;
  }
}

/** One rule set is one choice, at its latest version; the version chosen before stays offered when it is older. */
function ruleChoices(versions: JudgeVersion[], selectedId: string | null): JudgeVersion[] {
  const latest = new Map<string, JudgeVersion>();
  for (const v of versions) latest.set(v.setId, v);
  const chosen = versions.find((v) => v.id === selectedId);
  const list = [...latest.values()];
  if (chosen && !list.includes(chosen)) list.push(chosen);
  return list.reverse();
}

const versionWord = (v: JudgeVersion, all: JudgeVersion[]) =>
  all.some((other) => other.setId === v.setId && other.id !== v.id) ? ` · версия ${v.version}` : "";

/** The count of conversations inside the sentence that says it: a small field, plainly one to change. */
const NUMBER = "h-8 w-16 px-2 py-0 text-center font-semibold tabular-nums";

/**
 * A step done before the launch, as a soft card: a tick or a ring, what the step is, what it gave, one line under it.
 * A step not done says so and gives the way to it.
 */
function StepCard({
  done,
  label,
  title,
  children,
}: {
  done: boolean;
  label: string;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section aria-label={label} className="flex min-w-0 flex-col rounded-[18px] bg-inset p-4">
      <p className="flex items-center gap-2 text-small text-fg-3">
        <span
          aria-hidden
          className={cn(
            "grid size-4 place-items-center rounded-full",
            done ? "bg-fg text-canvas" : "ring-[1.5px] ring-inset ring-fg-4",
          )}
        >
          {done && <Tick className="size-2.5" strokeWidth={3.5} />}
        </span>
        {label}
        <span className="sr-only">{done ? " — готово" : " — не готово"}</span>
      </p>
      <div className="mt-2 min-w-0 text-title font-semibold text-fg">{title}</div>
      {children && <div className="mt-1 text-body text-fg-3">{children}</div>}
    </section>
  );
}

/**
 * One way to check as a card: a picture of what it gives, its name, what it does, a grey button that takes it into the
 * check or leaves it out — the form's one black button is «Запустить проверку». A way that cannot run says what it
 * needs.
 */
function WayCard({
  id,
  on,
  off,
  check,
  onToggle,
  children,
}: {
  id: Mode;
  on: boolean;
  off: boolean;
  check: Check;
  onToggle: () => void;
  children?: ReactNode;
}) {
  const option = OPTIONS.find((o) => o.id === id)!;
  const Picture = WAY_PICTURE[id];
  return (
    <section
      aria-label={MODE_NAME[id]}
      className={cn(
        "flex items-center gap-4 rounded-block border bg-canvas p-3 pr-4 transition-colors",
        on ? "border-fg/50" : "border-line",
      )}
    >
      <div aria-hidden className={cn("hidden h-[84px] w-28 shrink-0 sm:block", PAPER, off && "opacity-50")}>
        <Picture />
      </div>
      <div className="min-w-0 flex-1 py-1">
        <p className={cn("text-read font-semibold", off ? "text-fg-3" : "text-fg")}>{MODE_NAME[id]}</p>
        <p className="mt-0.5 text-body text-fg-3">{option.description}</p>
        {children && <div className="mt-1 text-body text-fg-3">{children}</div>}
      </div>
      {off ? (
        <Link
          to={`${SECTIONS.agent}?return=${check}`}
          className="shrink-0 rounded-sm text-body font-medium text-run hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
        >
          Подключить агента
        </Link>
      ) : (
        <Button size="sm" icon={on ? Tick : Plus} aria-pressed={on} onClick={onToggle} className="shrink-0">
          {on ? "Выбрано" : "Добавить"}
        </Button>
      )}
    </section>
  );
}

/**
 * «Новая проверка»: which conversations, by which rules, and what to check — the recorded answers, the same questions
 * asked of the live agent, the simulations. The fields are only the launch's: nothing in the product changes until
 * «Запустить» (the service makes the dataset and the rules current then, and keeps the version typed here as the
 * dataset's, api/launches.py). A way that cannot run now is shown greyed with what it needs, not offered and then
 * refused; without models nothing starts, and the line beside the button says so. Before the first check the three
 * first steps lead the form, as on «Обзор» and «Критерии».
 */
export function LaunchPage({ check }: { check: Check }) {
  const { state, offline, refresh } = useLabState();
  const datasets = useDatasets();
  const judges = useJudges(check);
  const navigate = useNavigate();
  const first = useFirstRun(check) === true && check === "tone";
  const [draft] = useState(() => readDraft(check));
  const [modes, setModes] = useState<Mode[]>(draft.modes);
  // The version of the agent in the chosen dataset as typed here; until then the dataset's own.
  const [version, setVersion] = useState<string | null>(null);
  // The count as typed, so the field can be emptied on the way to another number; it settles when the field is left.
  const [size, setSize] = useState(String(draft.size));
  const [target, setTarget] = useState(draft.target);
  // «Проверить» on a dataset's page opens this form with it chosen (?dataset=); «Извлечь заново» of Точность, with its
  // criteria to be read from the code anew (?replan=1).
  const [query] = useSearchParams();
  const [datasetId, setDatasetId] = useState(query.get("dataset") ?? undefined);
  const [judgeId, setJudgeId] = useState<string | undefined>(undefined);
  const [picked, setPicked] = useState<{ rulesId: string; ids: string[] } | undefined>(undefined);
  const [picking, setPicking] = useState(false);
  const [replan, setReplan] = useState(query.get("replan") === "1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const library = datasets.data;
  const dataset =
    library?.datasets.find((d) => d.id === datasetId && !d.archivedAt) ??
    library?.datasets.find((d) => d.id === library.activeId) ??
    null;
  const agentVersion = version ?? dataset?.agentVersion ?? "";
  const versions = judges.data?.versions ?? [];
  // «» is accuracy by the criteria from the agent's code; tone of voice always needs a rule set.
  const remembered =
    judgeId !== undefined && (judgeId === "" ? check === "code" : versions.some((v) => v.id === judgeId));
  const rulesId = remembered ? judgeId! : (judges.data?.selectedId ?? "");
  const rules = versions.find((v) => v.id === rulesId) ?? null;
  const rulesReady = rules ? rules.criteria.length > 0 : check === "code" && codeSources(state).length > 0;
  // Tone of voice can be checked by some of its criteria, as a person chose them for these rules; all of them else.
  const criteria = rules?.criteria ?? [];
  const pickedIds = picked?.rulesId === rulesId ? picked.ids.filter((id) => criteria.some((c) => c.id === id)) : null;
  const subset = check === "tone" && pickedIds && pickedIds.length < criteria.length ? pickedIds : null;
  const toggle = (id: string) => {
    const base = subset ?? criteria.map((c) => c.id);
    const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    setPicked(next.length === criteria.length ? undefined : { rulesId, ids: next });
  };
  // Точность by the agent's code: its criteria are read from the code on the first check, anew when asked.
  const fromCode = check === "code" && !rules && codeSources(state).length > 0;
  const extractedBefore = fromCode && !!resultOf(state, "code");
  const total = dataset?.total ?? 0;
  const most = Math.min(MAX, total);
  const wanted = Number.parseInt(size, 10);
  const conversations = total && wanted > 0 ? Math.min(wanted, most) : 0;
  // A way the agent can be asked on: offered (the test stand alone in the first release), set up, and for «На этом
  // компьютере» (whose address is there by default) only when the person chose it in «Агент» — otherwise a launch
  // would ask an address nobody may answer on.
  const chosenWay = useConnectionMemory().way;
  const reachable = state ? waysOf(state).filter((t) => t.ready && (t.id !== "local-http" || chosenWay === t.id)) : [];
  const chosen = modes.filter((m) => MODES.includes(m) && (m === "dataset" || reachable.length > 0));
  const live = chosen.some((m) => m !== "dataset");
  const way = reachable.find((t) => t.id === target) ?? reachable.find((t) => t.id === chosenWay) ?? reachable[0];

  useEffect(() => {
    try {
      localStorage.setItem(
        agentKey(`launch-draft-${check}`),
        JSON.stringify({ modes, size: wanted > 0 ? wanted : draft.size, target } satisfies Draft),
      );
    } catch {
      /* Drafts are optional when browser storage is unavailable. */
    }
  }, [check, modes, wanted, target, draft.size]);

  const blocked = busy || !!state?.job.running;
  // Without models a check would start and fail at its first conversation (api/launches.py refuses it too).
  const noModels = !!state?.models.problem;
  // What the last check found, beside the next one: the way into its history.
  const last = resultOf(state, check);
  const loading = !library || !judges.data;
  const failed = datasets.isError || judges.isError;
  // Scenarios are built from the errors the check of the recorded answers finds: by chosen criteria, or by criteria
  // read anew, the simulations need that check in the same launch (api/launches.py says the same).
  const scenariosWait =
    chosen.includes("simulations") && !chosen.includes("dataset") && (!!subset || (extractedBefore && replan));
  const ready =
    !loading &&
    !failed &&
    !!dataset &&
    rulesReady &&
    conversations > 0 &&
    chosen.length > 0 &&
    !(subset && !subset.length) &&
    !scenariosWait;
  const missing: ReactNode = failed
    ? "Не удалось загрузить датасеты или правила."
    : loading
      ? "Загружаем датасеты и правила…"
      : !dataset
        ? // The lines above say what is missing and give the way to it; here, only that the launch waits for it.
          "Сначала загрузите датасет."
        : !rulesReady
          ? check === "tone"
            ? "Сначала нужны правила общения."
            : "Сначала нужны критерии."
          : subset && !subset.length
            ? "Отметьте хотя бы один критерий."
            : !conversations
              ? "Укажите, сколько разговоров проверить."
              : !chosen.length
                ? "Отметьте, что проверить."
                : scenariosWait
                  ? "Сценарии собираются из ошибок в записанных ответах: чтобы сыграть их по выбранным критериям, отметьте и «Ответы в датасете»."
                  : null;
  const start = async () => {
    if (blocked || !ready || noModels || !dataset) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<{ id: string }>("/api/launches", {
        check,
        datasetId: dataset.id,
        judgeId: rules?.id ?? null,
        agentVersion: agentVersion.trim(),
        modes: chosen,
        count: conversations,
        ...(subset ? { ruleIds: subset } : {}),
        ...(extractedBefore && replan ? { replan: true } : {}),
        target: way?.id ?? "prod",
      });
      await refresh();
      navigate(launchLink(check, r.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  // What the launch waits for, said beside its button; the step that is missing gives the way to it above.
  const why = state?.job.running ? "Сейчас идёт другая задача этого агента." : ready ? null : missing;
  const plan =
    dataset && conversations && rulesReady
      ? `Проверим ${count(conversations, "разговор", "разговора", "разговоров")} из датасета ${inQuotes(shownName(dataset))} ${
          rules
            ? `по ${subset ? `${subset.length} из ${criteria.length}` : criteria.length} ${plural(
                subset ? subset.length : criteria.length,
                "критерию",
                "критериям",
                "критериям",
              )}`
            : extractedBefore && replan
              ? "по критериям, которые заново извлечём из кода"
              : "по критериям из кода агента"
        }.`
      : null;
  const criteriaPage = criterionLink(check);
  const rulesMenu = [
    ...(check === "code" && codeSources(state).length > 0
      ? [
          {
            key: "code",
            label: "Критерии из кода агента",
            sub: "Из инструкций и инструментов агента",
            on: rulesId === "",
            run: () => setJudgeId(""),
          },
        ]
      : []),
    ...ruleChoices(versions, rulesId).map((v) => ({
      key: v.id,
      label: `${v.name}${versionWord(v, versions)}`,
      sub: count(v.criteria.length, "критерий", "критерия", "критериев"),
      on: v.id === rulesId,
      run: () => setJudgeId(v.id),
    })),
    ...(extractedBefore && rulesId === ""
      ? [
          {
            key: "replan",
            label: "Извлечь критерии заново",
            sub: "Если у агента изменились инструкции или инструменты",
            on: replan,
            run: () => setReplan((on) => !on),
          },
        ]
      : []),
    ...(check === "tone" && criteria.length > 1
      ? [{ key: "pick", label: "Выбрать часть критериев", run: () => setPicking(true) }]
      : []),
    { key: "open", label: "Открыть критерии", run: () => void navigate(criteriaPage) },
  ];
  const criteriaTitle = rules ? (
    <>
      {subset ? `${subset.length} из ${criteria.length}` : criteria.length}{" "}
      {plural(criteria.length, "критерий", "критерия", "критериев")}
    </>
  ) : fromCode ? (
    "Из кода агента"
  ) : check === "tone" ? (
    "Нужны правила общения"
  ) : (
    "Нужен код агента"
  );
  return (
    <div>
      <Header title={CHECK_NAME[check]} tabs={<StageTabs stage={check} />} />
      {offline && !state ? (
        <ServiceDown />
      ) : (
        <div className="max-w-[920px] px-4 pb-16 pt-8 lg:px-10">
          <h2 className="text-page font-semibold text-fg">Новая проверка</h2>
          {first && !loading && (
            <FirstStepsLine
              criteria={criteria.length}
              collecting={state?.job.running && state.job.kind === "tone-criteria"}
              className="mt-4"
            />
          )}
          {failed && (
            <div className="mt-6">
              <LoadFailed
                title="Не удалось загрузить датасеты или правила"
                error={datasets.error ?? judges.error}
                onRetry={() => {
                  void datasets.refetch();
                  void judges.refetch();
                }}
              />
            </div>
          )}
          <fieldset disabled={blocked}>
            {/* The steps before the launch: what is checked, and by what — the criteria are the step after the rules. */}
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <StepCard
                done={!!dataset}
                label="Разговоры"
                title={
                  !library ? (
                    <Skeleton className="h-7 w-48" />
                  ) : !dataset ? (
                    "Нет датасета"
                  ) : library.datasets.length > 1 ? (
                    <Menu
                      className="max-w-full"
                      items={library.datasets.map((d) => ({
                        key: d.id,
                        label: shownName(d),
                        sub: datasetFacts(d).join(" · "),
                        on: d.id === dataset.id,
                        run: () => {
                          setDatasetId(d.id);
                          // Another dataset holds another agent's answers: its own version comes with it.
                          setVersion(null);
                        },
                      }))}
                      trigger={
                        <span className="flex min-w-0 items-center gap-1 text-left">
                          <span className="min-w-0 truncate">{shownName(dataset)}</span>
                          <ChevronDown aria-hidden className="size-5 shrink-0 text-fg-3" />
                        </span>
                      }
                    />
                  ) : (
                    <span className="block truncate">{shownName(dataset)}</span>
                  )
                }
              >
                {!library ? null : !dataset ? (
                  // The first step not done: loading the dataset is the form's black button until it is.
                  <span className="flex flex-wrap items-center gap-3">
                    Проверка идёт по датасету разговоров.
                    <UploadButton size="sm" />
                  </span>
                ) : (
                  <>
                    {/* The sample as a field, and why its number matters: the same number takes the same
                        conversations (domain/sampling.py), so the checks of the dataset compare. */}
                    <label className="flex flex-wrap items-center gap-x-2 gap-y-1 text-read text-fg-2">
                      Проверим
                      <Input
                        aria-label="Сколько разговоров проверить"
                        inputMode="numeric"
                        value={wanted > most && most > 0 ? String(most) : size}
                        onChange={(e) => setSize(e.target.value.replace(/\D/g, "").slice(0, 3))}
                        onBlur={() => setSize(String(conversations || Math.min(100, most) || draft.size))}
                        className={NUMBER}
                      />
                      из {count(total, "разговора", "разговоров", "разговоров")}
                    </label>
                    <span className="mt-2 block text-small text-fg-3">
                      При том же числе это всегда те же разговоры датасета, поэтому проверки можно сравнивать.
                      {total > MAX ? ` За раз — не больше ${MAX}.` : ""}
                    </span>
                  </>
                )}
              </StepCard>
              <StepCard
                done={rulesReady}
                label="Критерии"
                title={
                  !judges.data ? (
                    <Skeleton className="h-7 w-40" />
                  ) : rulesReady && rulesMenu.length > 1 ? (
                    <Menu
                      className="max-w-full"
                      items={rulesMenu}
                      trigger={
                        <span className="flex min-w-0 items-center gap-1 text-left">
                          <span className="min-w-0 truncate">{criteriaTitle}</span>
                          <ChevronDown aria-hidden className="size-5 shrink-0 text-fg-3" />
                        </span>
                      }
                    />
                  ) : (
                    criteriaTitle
                  )
                }
              >
                {!judges.data ? null : rules ? (
                  <>
                    из правил {inQuotes(`${rules.name}${versionWord(rules, versions)}`)} ·{" "}
                    <Link to={criteriaPage} className="text-run hover:underline">
                      открыть
                    </Link>
                  </>
                ) : fromCode ? (
                  <>
                    {extractedBefore && replan ? "Извлечём заново при проверке" : "Соберутся при проверке"} ·{" "}
                    <Link to={criteriaPage} className="text-run hover:underline">
                      открыть
                    </Link>
                    {extractedBefore && replan && (
                      <span className="mt-1 block text-small text-fg-3">
                        Счёт, ссылки на проблемы и ответы людей Точности начнутся с нуля, сценарии из неё сбросятся.
                        Итог Tone of voice не изменится.
                      </span>
                    )}
                  </>
                ) : (
                  <span className="flex flex-wrap items-center gap-3">
                    {check === "tone" ? "Критерии соберутся из правил." : "Критерии соберутся из кода."}
                    {/* The step after the dataset: black once the dataset is here, quiet before. */}
                    <Link
                      to={check === "tone" ? criterionLink("tone") : criteriaPage}
                      className={buttonClass({ variant: dataset ? "primary" : "outline", size: "sm" })}
                    >
                      {check === "tone" ? "Добавить правила" : "К критериям"}
                    </Link>
                  </span>
                )}
              </StepCard>
            </div>

            <h3 className="mt-10 text-lead font-semibold text-fg">Что проверить</h3>
            <div className="mt-3 space-y-3">
              {OPTIONS.map(({ id, live: needsAgent }) => (
                <WayCard
                  key={id}
                  id={id}
                  check={check}
                  on={chosen.includes(id)}
                  off={needsAgent && !reachable.length}
                  onToggle={() => setModes((all) => (all.includes(id) ? all.filter((m) => m !== id) : [...all, id]))}
                >
                  {id === "simulations" && chosen.includes(id)
                    ? "Если сценариев ещё нет, сначала найдём ошибки в выбранных разговорах."
                    : null}
                </WayCard>
              ))}
            </div>
            {live && way && (
              <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-fg-3">
                {reachable.length > 1 ? (
                  <label className="flex items-center gap-2">
                    Агент
                    <Select value={way.id} onChange={(e) => setTarget(e.target.value)} className="h-8 w-auto">
                      {reachable.map((t) => (
                        <option value={t.id} key={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </Select>
                  </label>
                ) : (
                  <span>
                    Агент: {way.name}
                    {way.where ? ` · ${way.where}` : ""}
                  </span>
                )}
                <Link to={`${SECTIONS.agent}?return=${check}`} className="text-run hover:underline">
                  Проверить связь
                </Link>
              </p>
            )}

            {/* The version whose answers the dataset holds: the dataset's own, and a check of it keeps the one typed
                here as the dataset's (api/launches.py), so the checks of versions can be told apart. */}
            {dataset && (
              <label className="mt-10 block max-w-sm">
                <span className="block text-read font-medium text-fg">
                  Версия агента в этом датасете <span className="font-normal text-fg-3">· по желанию</span>
                </span>
                <Input
                  name="agent-version"
                  value={agentVersion}
                  onChange={(e) => setVersion(e.target.value)}
                  maxLength={80}
                  placeholder="Например, v2.4"
                  className="mt-2"
                />
                <span className="mt-1.5 block text-small text-fg-3">
                  Какая версия агента дала ответы этого датасета. Сохранится у датасета, видна в итоге и в истории.
                </span>
              </label>
            )}

            <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
              <Button
                size="lg"
                variant="primary"
                icon={Play}
                loading={busy}
                disabled={!ready || blocked || noModels}
                onClick={start}
              >
                Запустить проверку
              </Button>
              {noModels ? (
                <NoModels className="basis-full" />
              ) : (
                (why ?? plan) && <p className="min-w-0 basis-full text-body text-fg-3">{why ?? plan}</p>
              )}
            </div>
            {error && (
              <p role="alert" className="mt-3 text-body text-bad">
                {error}
              </p>
            )}
          </fieldset>
          <Link
            to={historyLink(check)}
            className="mt-12 inline-flex flex-wrap items-center gap-x-1.5 text-body text-fg-2 hover:text-fg hover:underline"
          >
            {last ? (
              <>
                Прошлая проверка, {longDay(last.finishedAt)}:{" "}
                <span className="tabular-nums">
                  {last.summary.failed} из {last.summary.measured}
                </span>{" "}
                с ошибкой агента
              </>
            ) : (
              "История проверок"
            )}
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
          <Sheet
            open={picking}
            onClose={() => setPicking(false)}
            title="Критерии проверки"
            sub={rules ? `${inQuotes(rules.name)}: отметьте, по каким проверить` : undefined}
            actions={
              subset ? (
                <Button size="sm" onClick={() => setPicked(undefined)}>
                  Все
                </Button>
              ) : undefined
            }
          >
            <ul className="divide-y divide-line px-5 sm:px-7">
              {criteria.map((c, i) => (
                <li key={c.id}>
                  <label className="flex cursor-pointer items-start gap-3 py-3">
                    <input
                      type="checkbox"
                      checked={(subset ?? criteria.map((x) => x.id)).includes(c.id)}
                      onChange={() => toggle(c.id)}
                      className="mt-1 size-4 accent-primary"
                    />
                    <span className="min-w-0 text-read text-fg">
                      <span className="tabular-nums text-fg-3">{i + 1}.</span> {c.name}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </Sheet>
        </div>
      )}
    </div>
  );
}
