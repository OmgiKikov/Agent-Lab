import { Select } from "../../ui/Field";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  ArrowRight,
  ChevronRight,
  ChevronsUpDown,
  Database,
  FlaskConical,
  Hash,
  ListChecks,
  MessageSquareQuote,
  MessagesSquare,
  Minus,
  Play,
  Plus,
  RefreshCw,
  ScrollText,
  Tag,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { agentKey } from "../../app/agent";
import { Header } from "../../app/Header";
import { StageTabs } from "../../app/StageTabs";
import { criterionLink, historyLink, launchLink, SECTIONS } from "../../app/links";
import { api } from "../../lab/api";
import { CHECK_NAME, resultOf } from "../../lab/checks";
import { datasetFacts, useDatasets } from "../../lab/datasets";
import { count, longDay, plural } from "../../lab/format";
import { useJudges, type JudgeVersion } from "../../lab/judges";
import { useLabState } from "../../lab/LabProvider";
import { MODE_NAME, type Mode } from "../../lab/launches";
import { codeSources } from "../../lab/tone";
import type { Check } from "../../lab/types";
import { Button } from "../../ui/Button";
import { UploadButton } from "../../product/UploadLogs";
import { shownName } from "../data/DatasetInfo";
import { DocumentRules } from "../judges/DocumentRules";
import { useConnectionMemory } from "../agent/Connection";
import { ServiceDown } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { Menu } from "../../ui/Menu";
import { Sheet } from "../../ui/Sheet";
import { Switch } from "../../ui/Switch";

const MAX = 300; // conversations one launch takes at most (api/launches.py, LaunchCommand)
const OPTIONS: { id: Mode; icon: typeof Database; description: string; live: boolean }[] = [
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

/** The colour of each way's tile: the recorded answers dark, the live agent blue, the simulations orange. */
const WAY_TINT: Record<Mode, string> = { dataset: "bg-fg", questions: "bg-run", simulations: "bg-warn" };

/** What the form remembers between visits, per agent and check: a choice that is gone falls back to the current one. */
type Draft = {
  modes: Mode[];
  version: string;
  size: number;
  target: string;
  datasetId?: string;
  judgeId?: string;
  /** Some of the criteria of tone of voice, chosen for these rules. */
  picked?: { rulesId: string; ids: string[] };
};
function readDraft(check: Check): Draft {
  const fallback: Draft = { modes: ["dataset"], version: "", size: 100, target: "" };
  try {
    const value = JSON.parse(localStorage.getItem(agentKey(`launch-draft-${check}`)) ?? "null");
    if (!value || !Array.isArray(value.modes)) return fallback;
    const modes = value.modes.filter(
      (mode: unknown): mode is Mode =>
        typeof mode === "string" && ["dataset", "questions", "simulations"].includes(mode),
    );
    return {
      modes: [...new Set<Mode>(modes)],
      version: typeof value.version === "string" ? value.version : "",
      size: Number.isFinite(value.size) ? Math.max(1, Math.min(MAX, value.size)) : 100,
      target: typeof value.target === "string" ? value.target : "",
      datasetId: typeof value.datasetId === "string" ? value.datasetId : undefined,
      judgeId: typeof value.judgeId === "string" ? value.judgeId : undefined,
      picked:
        value.picked && typeof value.picked.rulesId === "string" && Array.isArray(value.picked.ids)
          ? { rulesId: value.picked.rulesId, ids: value.picked.ids.filter((id: unknown) => typeof id === "string") }
          : undefined,
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

/** The coloured square of a row, as a setting's icon: what the row is about at a glance. */
function Tile({ icon: Icon, tint }: { icon: typeof Database; tint: string }) {
  return (
    <span aria-hidden className={cn("grid size-7 shrink-0 place-items-center rounded-[8px] text-white", tint)}>
      <Icon className="size-4" strokeWidth={2.2} />
    </span>
  );
}

/**
 * A white rounded list on the grey page; the line between its rows starts after the tiles, as in a list of settings.
 * Nothing is clipped at its edge: a row's menu opens over the rows below.
 */
const LIST =
  "rounded-block bg-canvas shadow-[0_1px_2px_rgb(0_0_0/0.04)] ring-1 ring-line [&>*+*]:relative [&>*+*]:before:pointer-events-none [&>*+*]:before:absolute [&>*+*]:before:left-14 [&>*+*]:before:right-0 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-line [&>*+*]:before:content-['']";

/** A group of rows on the grey page: its name over it, a line under it that explains it. */
function Group({ title, note, children }: { title?: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-7 first:mt-0">
      {title && <h3 className="mb-2 px-4 text-small text-fg-3">{title}</h3>}
      <div className={LIST}>{children}</div>
      {note && <div className="mt-2 px-4 text-small text-fg-3">{note}</div>}
    </section>
  );
}

/** One row of a group: its tile and name, a line under the name, what is chosen on the right. */
function Row({
  tile,
  title,
  sub,
  children,
}: {
  tile: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-[52px] items-center gap-3 px-4 py-2.5">
      {tile}
      <div className="min-w-0 flex-1">
        <p className="text-read text-fg">{title}</p>
        {sub && <p className="text-small text-fg-3">{sub}</p>}
      </div>
      {children && <div className="flex min-w-0 shrink-0 items-center justify-end gap-2">{children}</div>}
    </div>
  );
}

/** The chosen value of a row that opens a list to choose from, as a pop-up button reads. */
function Picked({ children }: { children: ReactNode }) {
  return (
    <span className="flex max-w-[16rem] items-center gap-1 text-read text-fg-3 hover:text-fg">
      <span className="min-w-0 truncate">{children}</span>
      <ChevronsUpDown aria-hidden className="size-3.5 shrink-0" />
    </span>
  );
}

/** A number with − and +, typed in as well: by ten, within what one launch takes. */
function Stepper({
  value,
  shown,
  most,
  onType,
  onSet,
  onBlur,
}: {
  value: number;
  shown: string;
  most: number;
  onType: (text: string) => void;
  onSet: (n: number) => void;
  onBlur: () => void;
}) {
  const button =
    "grid size-7 place-items-center rounded-[8px] text-fg-2 transition-colors hover:bg-canvas hover:text-fg disabled:opacity-30";
  return (
    <div className="flex items-center rounded-control bg-fg/[0.06] p-0.5">
      <button
        type="button"
        aria-label="Меньше"
        className={button}
        disabled={value <= 1}
        onClick={() => onSet(Math.max(1, value - 10))}
      >
        <Minus className="size-3.5" />
      </button>
      <input
        aria-label="Сколько разговоров проверить"
        inputMode="numeric"
        value={shown}
        onChange={(e) => onType(e.target.value.replace(/\D/g, "").slice(0, 3))}
        onBlur={onBlur}
        className="w-12 bg-transparent text-center text-read tabular-nums text-fg focus:outline-none"
      />
      <button
        type="button"
        aria-label="Больше"
        className={button}
        disabled={value >= most}
        onClick={() => onSet(Math.min(most, value + 10))}
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}

/**
 * «Новая проверка»: which conversations, by which rules, and what to check — the recorded answers, the same questions
 * asked of the live agent, the simulations. The fields are only the launch's: nothing in the product changes until
 * «Запустить» (the service makes the dataset and the rules current then, api/launches.py). A way that cannot run now
 * is shown greyed with what it needs, not offered and then refused.
 */
export function LaunchPage({ check }: { check: Check }) {
  const { state, offline, refresh } = useLabState();
  const datasets = useDatasets();
  const judges = useJudges(check);
  const navigate = useNavigate();
  const [draft] = useState(() => readDraft(check));
  const [modes, setModes] = useState<Mode[]>(draft.modes);
  const [version, setVersion] = useState(draft.version);
  // The count as typed, so the field can be emptied on the way to another number; it settles when the field is left.
  const [size, setSize] = useState(String(draft.size));
  const [target, setTarget] = useState(draft.target);
  // «Проверить» on a dataset's page opens this form with it chosen (?dataset=); «Извлечь заново» of Точность, with its
  // criteria to be read from the code anew (?replan=1).
  const [query] = useSearchParams();
  const [datasetId, setDatasetId] = useState(query.get("dataset") ?? draft.datasetId);
  const [judgeId, setJudgeId] = useState(draft.judgeId);
  const [picked, setPicked] = useState(draft.picked);
  const [picking, setPicking] = useState(false);
  const [replan, setReplan] = useState(query.get("replan") === "1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The rules of communication collected right over the form, without leaving it.
  const [collect, setCollect] = useState(false);

  const library = datasets.data;
  const dataset =
    library?.datasets.find((d) => d.id === datasetId && !d.archivedAt) ??
    library?.datasets.find((d) => d.id === library.activeId) ??
    null;
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
  // A way the agent can be asked on: set up, and for «На этом компьютере» (whose address is there by default) only when
  // the person chose it in «Агент» — otherwise a launch would ask an address nobody may answer on.
  const chosenWay = useConnectionMemory().way;
  const reachable = state?.targets.filter((t) => t.ready && (t.id !== "local-http" || chosenWay === t.id)) ?? [];
  const chosen = modes.filter((m) => m === "dataset" || reachable.length > 0);
  const live = chosen.some((m) => m !== "dataset");
  const way = reachable.find((t) => t.id === target) ?? reachable.find((t) => t.id === chosenWay) ?? reachable[0];

  useEffect(() => {
    try {
      localStorage.setItem(
        agentKey(`launch-draft-${check}`),
        JSON.stringify({
          modes,
          version,
          size: wanted > 0 ? wanted : draft.size,
          target,
          datasetId,
          judgeId,
          picked,
        }),
      );
    } catch {
      /* Drafts are optional when browser storage is unavailable. */
    }
  }, [check, modes, version, wanted, target, datasetId, judgeId, picked, draft.size]);

  const blocked = busy || !!state?.job.running;
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
          "Сначала загрузите выгрузку чата."
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
    if (blocked || !ready || !dataset) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<{ id: string }>("/api/launches", {
        check,
        datasetId: dataset.id,
        judgeId: rules?.id ?? null,
        agentVersion: version.trim(),
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

  const collecting = !!state?.job.running && state.job.kind === "tone-criteria";
  const [more, setMore] = useState(false);
  // What the launch waits for, said beside its button; the row of what is missing gives the way to it.
  const why = state?.job.running && !collecting ? "Сейчас идёт другая задача этого агента." : ready ? null : missing;
  const by = rules
    ? `по ${subset ? `${subset.length} из ${criteria.length}` : criteria.length} ${plural(
        subset ? subset.length : criteria.length,
        "критерию",
        "критериям",
        "критериям",
      )} «${rules.name}»`
    : fromCode
      ? extractedBefore && replan
        ? "по критериям, которые заново извлечём из кода агента"
        : "по критериям из кода агента"
      : null;
  const plan =
    dataset && conversations
      ? `Проверим ${count(conversations, "разговор", "разговора", "разговоров")} из «${shownName(dataset)}»${
          by ? ` ${by}` : ""
        }.`
      : "Выберите разговоры, правила и что проверить.";
  const action =
    "rounded-sm text-read text-run hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60";
  return (
    <div className="flex min-h-full flex-col bg-inset">
      <Header title={CHECK_NAME[check]} tabs={<StageTabs stage={check} />} />
      {offline && !state ? (
        <ServiceDown />
      ) : (
        <div className="w-full max-w-[720px] px-4 pb-16 pt-8 lg:px-10">
          <h2 className="px-4 text-page font-semibold text-fg">Новая проверка</h2>
          <p className="mt-1.5 px-4 text-read text-fg-3">{plan}</p>
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
          <fieldset disabled={blocked} className="mt-8">
            <Group
              title="Разговоры"
              note={
                !library
                  ? null
                  : !dataset
                    ? "Проверка идёт по выгрузке чата с настоящими разговорами."
                    : total > MAX
                      ? `За раз — до ${MAX} разговоров.`
                      : null
              }
            >
              <Row tile={<Tile icon={Database} tint="bg-run" />} title="Датасет">
                {!library ? null : !dataset ? (
                  <UploadButton variant="outline" label="Загрузить" />
                ) : library.datasets.length > 1 ? (
                  <Menu
                    align="right"
                    items={library.datasets.map((d) => ({
                      key: d.id,
                      label: shownName(d),
                      sub: datasetFacts(d).join(" · "),
                      on: d.id === dataset.id,
                      run: () => setDatasetId(d.id),
                    }))}
                    trigger={
                      <Picked>
                        {shownName(dataset)} · {total}
                      </Picked>
                    }
                  />
                ) : (
                  <span className="truncate text-read text-fg-3">
                    {shownName(dataset)} · {total}
                  </span>
                )}
              </Row>
              {dataset && (
                <Row
                  tile={<Tile icon={Hash} tint="bg-fg/60" />}
                  title="Сколько проверить"
                  sub={`из ${count(total, "разговора", "разговоров", "разговоров")}`}
                >
                  <Stepper
                    value={conversations || 1}
                    // The count kept from before is shown as what this dataset allows: 12, not 100, of 12.
                    shown={wanted > most && most > 0 ? String(most) : size}
                    most={most}
                    onType={setSize}
                    onSet={(n) => setSize(String(n))}
                    onBlur={() => setSize(String(conversations || Math.min(100, most) || draft.size))}
                  />
                </Row>
              )}
            </Group>

            <Group
              title="Правила"
              note={
                judges.data && !rulesReady ? (
                  check === "tone" ? (
                    collecting ? (
                      "Модель собирает критерии из документа — потом можно запускать."
                    ) : (
                      "Критерии соберутся из правил общения банка: документ или текст."
                    )
                  ) : (
                    <>
                      Критерии соберутся из кода агента, когда он подключён. Или{" "}
                      <Link to={criterionLink("code", null, { rules: "1" })} className="text-run hover:underline">
                        выберите готовый набор правил
                      </Link>
                      .
                    </>
                  )
                ) : fromCode ? (
                  "Критерии соберутся из инструкций и инструментов агента."
                ) : null
              }
            >
              <Row tile={<Tile icon={ScrollText} tint="bg-mark-strong" />} title="Правила">
                {!judges.data ? null : !rulesReady && !fromCode ? (
                  check === "tone" ? (
                    collecting ? (
                      <span className="text-read text-fg-3">Собираем…</span>
                    ) : (
                      <button type="button" onClick={() => setCollect(true)} className={action}>
                        Добавить
                      </button>
                    )
                  ) : (
                    <Link to={`${SECTIONS.agent}?return=code`} className={action}>
                      Подключить код
                    </Link>
                  )
                ) : (
                  <Menu
                    align="right"
                    items={[
                      ...(check === "code" && codeSources(state).length > 0
                        ? [
                            {
                              key: "code",
                              label: "Критерии из кода агента",
                              sub: "Из инструкций и инструментов",
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
                      ...(check === "tone"
                        ? [{ key: "doc", label: "Собрать из документа", run: () => setCollect(true) }]
                        : []),
                      {
                        key: "edit",
                        label: "Изменить правила",
                        run: () => void navigate(criterionLink(check, null, { rules: "1" })),
                      },
                    ]}
                    trigger={
                      <Picked>{rules ? `${rules.name}${versionWord(rules, versions)}` : "Из кода агента"}</Picked>
                    }
                  />
                )}
              </Row>
              {check === "tone" && rules && criteria.length > 1 && (
                <button
                  type="button"
                  onClick={() => setPicking(true)}
                  className="block w-full text-left first:rounded-t-block last:rounded-b-block hover:bg-hover"
                >
                  <Row tile={<Tile icon={ListChecks} tint="bg-mark-strong/80" />} title="Критерии">
                    <span className="flex items-center gap-1 text-read text-fg-3">
                      {subset ? `${subset.length} из ${criteria.length}` : `Все ${criteria.length}`}
                      <ChevronRight aria-hidden className="size-4" />
                    </span>
                  </Row>
                </button>
              )}
            </Group>

            <Group
              title="Что проверить"
              note={
                live && way ? (
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
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
                  </span>
                ) : (
                  "У каждого режима будет свой итог."
                )
              }
            >
              {OPTIONS.map(({ id, icon, description, live: needsAgent }) => {
                const off = needsAgent && !reachable.length;
                const on = chosen.includes(id);
                return (
                  <Row
                    key={id}
                    tile={<Tile icon={icon} tint={off ? "bg-fg/25" : WAY_TINT[id]} />}
                    title={<span className={off ? "text-fg-3" : undefined}>{MODE_NAME[id]}</span>}
                    sub={
                      off ? (
                        <>
                          Нужно подключение к агенту.{" "}
                          <Link to={`${SECTIONS.agent}?return=${check}`} className="text-run hover:underline">
                            Настроить
                          </Link>
                        </>
                      ) : id === "simulations" && on ? (
                        "Если сценариев ещё нет, сначала найдём ошибки в выбранных разговорах."
                      ) : (
                        description
                      )
                    }
                  >
                    <Switch
                      checked={on}
                      disabled={off}
                      label={MODE_NAME[id]}
                      hideLabel
                      onChange={() =>
                        setModes((all) => (all.includes(id) ? all.filter((m) => m !== id) : [...all, id]))
                      }
                    />
                  </Row>
                );
              })}
            </Group>

            <section className="mt-7">
              <button
                type="button"
                aria-expanded={more}
                onClick={() => setMore((on) => !on)}
                className="flex items-center gap-1 px-4 text-small text-fg-3 hover:text-fg"
              >
                <ChevronRight aria-hidden className={cn("size-3.5 transition-transform", more && "rotate-90")} />
                Дополнительно
              </button>
              {more && (
                <div className={cn("mt-2", LIST)}>
                  <Row tile={<Tile icon={Tag} tint="bg-fg/60" />} title="Версия агента" sub="Чтобы отличать прогоны">
                    <input
                      value={version}
                      onChange={(e) => setVersion(e.target.value)}
                      maxLength={80}
                      aria-label="Версия агента"
                      placeholder="не указана"
                      className="w-40 bg-transparent text-right text-read text-fg placeholder:text-fg-4 focus:outline-none"
                    />
                  </Row>
                  {extractedBefore && (
                    <Row
                      tile={<Tile icon={RefreshCw} tint="bg-fg/60" />}
                      title="Извлечь критерии заново"
                      sub="Если у агента изменились инструкции или инструменты"
                    >
                      <Switch checked={replan} label="Извлечь критерии заново" hideLabel onChange={setReplan} />
                    </Row>
                  )}
                </div>
              )}
            </section>
          </fieldset>

          <div className="mt-8 flex flex-wrap-reverse items-center justify-end gap-x-5 gap-y-3 px-4">
            {why && <p className="min-w-0 flex-1 basis-56 text-body text-fg-3">{why}</p>}
            <Button size="lg" variant="primary" icon={Play} loading={busy} disabled={!ready || blocked} onClick={start}>
              Запустить проверку
            </Button>
          </div>
          {error && (
            <p role="alert" className="mt-3 px-4 text-right text-body text-bad">
              {error}
            </p>
          )}
          <Link
            to={historyLink(check)}
            className="mt-10 inline-flex flex-wrap items-center gap-x-1.5 px-4 text-body text-fg-2 hover:text-fg hover:underline"
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
            sub={rules ? `«${rules.name}»: отметьте, по каким проверить` : undefined}
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
          {check === "tone" && <DocumentRules open={collect} onClose={() => setCollect(false)} />}
        </div>
      )}
    </div>
  );
}
