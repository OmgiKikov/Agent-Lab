import { Input, Select } from "../../ui/Field";
import { useEffect, useId, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Database, FlaskConical, MessagesSquare, Play } from "lucide-react";
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
import { Button, buttonClass } from "../../ui/Button";
import { UploadButton } from "../../product/UploadLogs";
import { shownName } from "../data/DatasetInfo";
import { DocumentRules } from "../judges/DocumentRules";
import { useConnectionMemory } from "../agent/Connection";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";

const MAX = 300; // conversations one launch takes at most (api/launches.py, LaunchCommand)
const OPTIONS: { id: Mode; icon: typeof Database; description: string; live: boolean }[] = [
  {
    id: "dataset",
    icon: Database,
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

/** The parts of a launch, each a line of the form that opens its editor under it. */
type Part = "dataset" | "rules" | "size" | "modes" | "version";

/**
 * One line of the launch in words: what it is, what is chosen, «Изменить». `below` stays under it whatever is open
 * (what this part still lacks and the way to it); the editor opens under it on «Изменить».
 */
function Line({
  label,
  value,
  open,
  onEdit,
  below,
  children,
}: {
  label: string;
  value: ReactNode;
  open?: boolean;
  onEdit?: () => void;
  below?: ReactNode;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="py-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="w-full text-small text-fg-3 sm:w-32 sm:text-body">{label}</span>
        <span className="min-w-0 flex-1 break-words text-read text-fg">{value}</span>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            aria-expanded={!!open}
            aria-controls={id}
            className="rounded-sm text-body text-run hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
          >
            {open ? "Готово" : "Изменить"}
          </button>
        )}
      </div>
      {below && <div className="mt-2 sm:pl-36">{below}</div>}
      {open && (
        <div id={id} className="mt-3 sm:pl-36">
          {children}
        </div>
      )}
    </div>
  );
}

/** A choice of a list: a round mark, its words and a line under them. */
function Choice({
  name,
  checked,
  onChange,
  title,
  sub,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  title: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-control px-2 py-2 hover:bg-hover">
      <input type="radio" name={name} checked={checked} onChange={onChange} className="mt-1 size-4 accent-primary" />
      <span className="min-w-0">
        <span className="block text-body text-fg">{title}</span>
        {sub && <span className="block text-small text-fg-3">{sub}</span>}
      </span>
    </label>
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
  // One line's editor open at a time; «Извлечь заново» opens the rules where its choice is.
  const [open, setOpen] = useState<Part | null>(query.get("replan") === "1" ? "rules" : null);
  const edit = (part: Part) => () => setOpen((now) => (now === part ? null : part));
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
  const plan =
    dataset && conversations
      ? `Проверим ${count(conversations, "разговор", "разговора", "разговоров")} из «${shownName(dataset)}» ${
          rules
            ? `${subset ? `по ${subset.length} из ${count(criteria.length, "критерия", "критериев", "критериев")} правил` : "по правилам"} «${rules.name}»${versionWord(rules, versions)}`
            : replan && extractedBefore
              ? "по критериям, которые извлечём из кода агента заново"
              : "по критериям из кода агента"
        }.`
      : "";

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
  const words = chosen.map((m, i) => (i ? MODE_NAME[m].toLowerCase() : MODE_NAME[m]));
  const what = words.length > 1 ? `${words.slice(0, -1).join(", ")} и ${words[words.length - 1]}` : words[0];
  const rulesWords = rules
    ? `${rules.name}${versionWord(rules, versions)} · ${
        subset ? `${subset.length} из ${criteria.length}` : `все ${criteria.length}`
      } ${plural(criteria.length, "критерий", "критерия", "критериев")}`
    : fromCode
      ? `Критерии из кода агента${extractedBefore && replan ? " · извлечём заново" : ""}`
      : check === "tone"
        ? "Правил ещё нет"
        : "Критериев ещё нет";
  // What the rules still lack, and the way to it, said under their line whatever is open.
  const rulesLack =
    judges.data && !rulesReady ? (
      check === "tone" ? (
        collecting ? (
          <p className="text-body text-fg-3">Собираем критерии из документа — проверку можно будет запустить потом.</p>
        ) : (
          <div className="space-y-3">
            <p className="text-body text-fg-3">Критерии соберутся из правил общения банка: документ или текст.</p>
            <Button size="sm" variant="primary" onClick={() => setCollect(true)}>
              Добавить правила
            </Button>
          </div>
        )
      ) : (
        <div className="space-y-3">
          <p className="text-body text-fg-3">
            Критерии соберутся из кода агента, когда он подключён. Или выберите готовый набор правил.
          </p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Link to={`${SECTIONS.agent}?return=code`} className={buttonClass({ variant: "primary", size: "sm" })}>
              Подключить код агента
            </Link>
            <Link to={criterionLink("code", null, { rules: "1" })} className="text-body text-run hover:underline">
              Выбрать набор правил
            </Link>
          </div>
        </div>
      )
    ) : null;
  return (
    <div>
      <Header title={CHECK_NAME[check]} tabs={<StageTabs stage={check} />} />
      {offline && !state ? (
        <ServiceDown />
      ) : (
        <div className="max-w-[760px] px-4 pb-16 pt-8 lg:px-10">
          <h2 className="text-page font-semibold text-fg">Новая проверка</h2>
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
          <fieldset disabled={blocked} className="mt-6 divide-y divide-line rounded-block border border-line px-5">
            <Line
              label="Датасет"
              value={
                !library ? (
                  <Skeleton className="h-6 w-56" />
                ) : dataset ? (
                  <>
                    {shownName(dataset)}{" "}
                    <span className="text-fg-3">· {count(dataset.total, "разговор", "разговора", "разговоров")}</span>
                  </>
                ) : (
                  "Датасетов пока нет"
                )
              }
              open={open === "dataset"}
              onEdit={library && library.datasets.length > 1 ? edit("dataset") : undefined}
              below={
                library && !dataset ? (
                  <div className="space-y-3">
                    <p className="text-body text-fg-3">Проверка идёт по выгрузке чата с настоящими разговорами.</p>
                    <UploadButton label="Загрузить выгрузку" />
                  </div>
                ) : null
              }
            >
              <div className="space-y-0.5">
                {library?.datasets.map((d) => (
                  <Choice
                    key={d.id}
                    name="dataset"
                    checked={d.id === dataset?.id}
                    onChange={() => setDatasetId(d.id)}
                    title={shownName(d)}
                    sub={datasetFacts(d).join(" · ")}
                  />
                ))}
              </div>
              <Link to={SECTIONS.data} className="mt-2 inline-block px-2 text-small text-run hover:underline">
                Все датасеты
              </Link>
            </Line>
            <Line
              label="Правила"
              value={!judges.data ? <Skeleton className="h-6 w-64" /> : rulesWords}
              open={open === "rules"}
              onEdit={judges.data && (versions.length > 0 || fromCode) ? edit("rules") : undefined}
              below={rulesLack}
            >
              <div className="space-y-0.5">
                {check === "code" && codeSources(state).length > 0 && (
                  <Choice
                    name="rules"
                    checked={rulesId === ""}
                    onChange={() => setJudgeId("")}
                    title="Критерии из кода агента"
                    sub="Соберутся из инструкций и инструментов агента"
                  />
                )}
                {ruleChoices(versions, rulesId).map((v) => (
                  <Choice
                    key={v.id}
                    name="rules"
                    checked={v.id === rulesId}
                    onChange={() => setJudgeId(v.id)}
                    title={`${v.name}${versionWord(v, versions)}`}
                    sub={count(v.criteria.length, "критерий", "критерия", "критериев")}
                  />
                ))}
              </div>
              {check === "tone" && criteria.length > 1 && (
                <div className="mt-3 px-2 text-body">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-fg-2">
                    Критерии: {subset ? `${subset.length} из ${criteria.length}` : `все ${criteria.length}`}
                    <button type="button" onClick={() => setPicking((on) => !on)} className="text-run hover:underline">
                      {picking ? "Свернуть" : subset ? "Изменить выбор" : "Выбрать часть"}
                    </button>
                    {subset && (
                      <button type="button" onClick={() => setPicked(undefined)} className="text-run hover:underline">
                        Все
                      </button>
                    )}
                  </p>
                  {picking && (
                    <ul className="mt-2 max-h-72 divide-y divide-line overflow-auto rounded-control border border-line">
                      {criteria.map((c, i) => (
                        <li key={c.id}>
                          <label className="flex cursor-pointer items-start gap-3 px-3 py-2 hover:bg-hover">
                            <input
                              type="checkbox"
                              checked={(subset ?? criteria.map((x) => x.id)).includes(c.id)}
                              onChange={() => toggle(c.id)}
                              className="mt-1 size-4 accent-primary"
                            />
                            <span className="min-w-0 text-fg">
                              {i + 1}. {c.name}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {extractedBefore && (
                <label className="mt-3 flex cursor-pointer items-start gap-3 px-2 text-body">
                  <input
                    type="checkbox"
                    checked={replan}
                    onChange={(e) => setReplan(e.target.checked)}
                    className="mt-1 size-4 accent-primary"
                  />
                  <span>
                    <span className="block text-fg">Извлечь критерии из кода заново</span>
                    <span className="mt-0.5 block text-small text-fg-3">
                      Если у агента изменились инструкции или инструменты. Прежний итог и ответы людей останутся в
                      истории.
                    </span>
                  </span>
                </label>
              )}
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 px-2 text-small">
                <Link to={criterionLink(check, null, { rules: "1" })} className="text-run hover:underline">
                  Изменить правила
                </Link>
                {check === "tone" && (
                  <button type="button" onClick={() => setCollect(true)} className="text-run hover:underline">
                    Собрать из документа
                  </button>
                )}
              </div>
            </Line>
            <Line
              label="Сколько"
              value={
                <>
                  <span className="tabular-nums">{conversations || "—"}</span>{" "}
                  <span className="text-fg-3">из {total}</span>
                </>
              }
              open={open === "size"}
              onEdit={total > 0 ? edit("size") : undefined}
            >
              <div className="flex items-center gap-3">
                <Input
                  aria-label="Сколько разговоров проверить"
                  inputMode="numeric"
                  value={size}
                  onChange={(e) => setSize(e.target.value.replace(/\D/g, "").slice(0, 3))}
                  onBlur={() => setSize(String(conversations || Math.min(100, most) || draft.size))}
                  className="w-24"
                />
                <span className="text-small text-fg-3">
                  из {total}
                  {total > MAX ? ` · за раз — до ${MAX}` : ""}
                </span>
              </div>
            </Line>
            <Line label="Что" value={what ?? "Ничего не выбрано"} open={open === "modes"} onEdit={edit("modes")}>
              <div className="space-y-0.5">
                {OPTIONS.map(({ id, icon: Icon, description, live: needsAgent }) => {
                  const off = needsAgent && !reachable.length;
                  const on = chosen.includes(id);
                  return (
                    <label
                      key={id}
                      className={cn(
                        "flex items-start gap-3 rounded-control px-2 py-2",
                        off ? "cursor-default" : "cursor-pointer hover:bg-hover",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={off}
                        onChange={() =>
                          setModes((all) => (all.includes(id) ? all.filter((m) => m !== id) : [...all, id]))
                        }
                        className="mt-1 size-4 accent-primary"
                      />
                      <span className="min-w-0">
                        <span className={cn("flex items-center gap-2 text-body", off ? "text-fg-3" : "text-fg")}>
                          <Icon aria-hidden className="size-4 shrink-0 text-fg-3" />
                          {MODE_NAME[id]}
                        </span>
                        <span className="mt-0.5 block text-small text-fg-3">{description}</span>
                        {off && (
                          <span className="mt-1 block text-small text-fg-3">
                            Нужно подключение к агенту.{" "}
                            <Link to={`${SECTIONS.agent}?return=${check}`} className="text-run hover:underline">
                              Настроить в «Агенте»
                            </Link>
                          </span>
                        )}
                        {id === "simulations" && on && (
                          <span className="mt-1 block text-small text-fg-3">
                            Если сценариев ещё нет, сначала найдём ошибки в выбранных разговорах и соберём из них
                            сценарии.
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
              {live && way && (
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 px-2 text-body text-fg-3">
                  {reachable.length > 1 ? (
                    <label className="flex flex-wrap items-center gap-2">
                      Агент
                      <Select value={way.id} onChange={(e) => setTarget(e.target.value)} className="w-auto">
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
                </div>
              )}
            </Line>
            <Line
              label="Версия агента"
              value={version.trim() ? version : <span className="text-fg-3">не указана · по желанию</span>}
              open={open === "version"}
              onEdit={edit("version")}
            >
              <Input
                aria-label="Версия агента"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                maxLength={80}
                placeholder="Например: v2.4, после правки промпта"
              />
            </Line>
          </fieldset>
          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
            <Button size="lg" variant="primary" icon={Play} loading={busy} disabled={!ready || blocked} onClick={start}>
              Запустить проверку
            </Button>
            <p className="min-w-0 flex-1 basis-64 text-body text-fg-3">
              {state?.job.running ? "Сейчас идёт другая задача этого агента." : (missing ?? plan)}
            </p>
          </div>
          {error && (
            <p role="alert" className="mt-3 text-body text-bad">
              {error}
            </p>
          )}
          <Link
            to={historyLink(check)}
            className="mt-8 inline-flex flex-wrap items-center gap-x-1.5 text-body text-fg-2 hover:text-fg hover:underline"
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
          {check === "tone" && <DocumentRules open={collect} onClose={() => setCollect(false)} />}
        </div>
      )}
    </div>
  );
}
