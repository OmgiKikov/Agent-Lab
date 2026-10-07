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
import { useDatasets } from "../../lab/datasets";
import { count, longDay } from "../../lab/format";
import { useJudges, type JudgeVersion } from "../../lab/judges";
import { useLabState } from "../../lab/LabProvider";
import { MODE_NAME, type Mode } from "../../lab/launches";
import { codeSources } from "../../lab/tone";
import type { Check } from "../../lab/types";
import { Button } from "../../ui/Button";
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

function Row({ label, aside, children }: { label: string; aside?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="text-body">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="font-medium text-fg">
          {label}
        </label>
        {aside}
      </div>
      {children(id)}
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
  const [datasetId, setDatasetId] = useState(draft.datasetId);
  const [judgeId, setJudgeId] = useState(draft.judgeId);
  const [picked, setPicked] = useState(draft.picked);
  const [picking, setPicking] = useState(false);
  // «Извлечь заново» of Точность opens this form with its criteria to be read from the code anew (?replan=1).
  const [query] = useSearchParams();
  const [replan, setReplan] = useState(query.get("replan") === "1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
  const ready =
    !loading &&
    !failed &&
    !!dataset &&
    rulesReady &&
    conversations > 0 &&
    chosen.length > 0 &&
    !(subset && !subset.length);
  const missing: ReactNode = failed ? (
    "Не удалось загрузить датасеты или правила."
  ) : loading ? (
    "Загружаем датасеты и правила…"
  ) : !dataset ? (
    <>
      Нет разговоров для проверки.{" "}
      <Link to={SECTIONS.data} className="text-run hover:underline">
        Добавить датасет
      </Link>
    </>
  ) : !rulesReady ? (
    check === "tone" ? (
      <>
        Нужны правила общения.{" "}
        <Link to={criterionLink("tone", null, { rules: "1", doc: "1" })} className="text-run hover:underline">
          Собрать критерии из документа
        </Link>
      </>
    ) : (
      <>
        Нет критериев: прочитайте{" "}
        <Link to={`${SECTIONS.agent}?return=code`} className="text-run hover:underline">
          код агента
        </Link>{" "}
        или выберите{" "}
        <Link to={criterionLink("code", null, { rules: "1" })} className="text-run hover:underline">
          набор правил
        </Link>
        .
      </>
    )
  ) : subset && !subset.length ? (
    "Отметьте хотя бы один критерий."
  ) : !conversations ? (
    "Укажите, сколько разговоров проверить."
  ) : !chosen.length ? (
    "Отметьте, что проверить."
  ) : null;
  const plan =
    dataset && conversations
      ? `Проверим ${count(conversations, "разговор", "разговора", "разговоров")} из «${dataset.name}» ${
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

  return (
    <div>
      <Header title={CHECK_NAME[check]} tabs={<StageTabs stage={check} />} />
      {offline && !state ? (
        <ServiceDown />
      ) : (
        <div className="max-w-[760px] px-4 pb-16 pt-8 lg:px-10">
          <h2 className="text-page font-semibold text-fg">Новая проверка</h2>
          <p className="mt-3 text-read text-fg-3">
            Выберите разговоры, правила и что проверить. У каждого режима будет свой итог.
          </p>
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
          <fieldset disabled={blocked} className="mt-7 space-y-5 rounded-block border border-line p-5">
            <Row
              label="Датасет"
              aside={
                <Link to={SECTIONS.data} className="text-small text-run hover:underline">
                  Все датасеты
                </Link>
              }
            >
              {(id) =>
                !library ? (
                  <Skeleton className="h-10" />
                ) : library.datasets.length ? (
                  <Select id={id} value={dataset?.id ?? ""} onChange={(e) => setDatasetId(e.target.value)}>
                    {library.datasets.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} · {count(d.total, "разговор", "разговора", "разговоров")}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <p className="text-small text-fg-3">Датасетов пока нет.</p>
                )
              }
            </Row>
            <Row
              label="Правила"
              aside={
                <Link to={criterionLink(check, null, { rules: "1" })} className="text-small text-run hover:underline">
                  Изменить правила
                </Link>
              }
            >
              {(id) =>
                !judges.data ? (
                  <Skeleton className="h-10" />
                ) : (
                  <Select id={id} value={rulesId} onChange={(e) => setJudgeId(e.target.value)}>
                    {check === "code" && <option value="">Критерии из кода агента</option>}
                    {check === "tone" && !rules && (
                      <option value="" disabled>
                        Правил пока нет
                      </option>
                    )}
                    {ruleChoices(versions, rulesId).map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                        {versionWord(v, versions)} · {count(v.criteria.length, "критерий", "критерия", "критериев")}
                      </option>
                    ))}
                  </Select>
                )
              }
            </Row>
            {check === "tone" && criteria.length > 1 && (
              <div className="text-body">
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
              <label className="flex cursor-pointer items-start gap-3 text-body">
                <input
                  type="checkbox"
                  checked={replan}
                  onChange={(e) => setReplan(e.target.checked)}
                  className="mt-1 size-4 accent-primary"
                />
                <span>
                  <span className="block font-medium text-fg">Извлечь критерии из кода заново</span>
                  <span className="mt-0.5 block text-small text-fg-3">
                    Если у агента изменились инструкции или инструменты. Прежний итог и ответы людей останутся в
                    истории.
                  </span>
                </span>
              </label>
            )}
            <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <Row label="Сколько разговоров">
                {(id) => (
                  <>
                    <div className="flex items-center gap-3">
                      <Input
                        id={id}
                        inputMode="numeric"
                        value={size}
                        onChange={(e) => setSize(e.target.value.replace(/\D/g, "").slice(0, 3))}
                        onBlur={() => setSize(String(conversations || Math.min(100, most) || draft.size))}
                        className="w-20"
                      />
                      <span className="whitespace-nowrap text-small text-fg-3">из {total}</span>
                    </div>
                    {total > MAX && <p className="mt-1.5 text-small text-fg-3">За раз — до {MAX}.</p>}
                  </>
                )}
              </Row>
              <Row label="Версия агента · по желанию">
                {(id) => (
                  <Input
                    id={id}
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    maxLength={80}
                    placeholder="Например: v2.4, после правки промпта"
                  />
                )}
              </Row>
            </div>
          </fieldset>
          <fieldset disabled={blocked} className="mt-8">
            <legend className="mb-3 text-read font-semibold text-fg">Что проверить</legend>
            <div className="space-y-3">
              {OPTIONS.map(({ id, icon: Icon, description, live: needsAgent }) => {
                const off = needsAgent && !reachable.length;
                const on = chosen.includes(id);
                return (
                  <div
                    key={id}
                    className={cn(
                      "rounded-block border p-4 transition-colors",
                      on ? "border-fg-3 bg-inset/50" : "border-line",
                      off && "border-dashed",
                    )}
                  >
                    <label className={cn("flex items-start gap-3", off ? "cursor-default" : "cursor-pointer")}>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={off}
                        onChange={() =>
                          setModes((all) => (all.includes(id) ? all.filter((m) => m !== id) : [...all, id]))
                        }
                        className="mt-1 size-4 accent-primary"
                      />
                      <Icon aria-hidden className={cn("mt-0.5 size-5 shrink-0", off ? "text-fg-4" : "text-fg-3")} />
                      <span>
                        <span className={cn("block text-body font-semibold", off ? "text-fg-3" : "text-fg")}>
                          {MODE_NAME[id]}
                        </span>
                        <span className="mt-1 block text-small text-fg-3">{description}</span>
                      </span>
                    </label>
                    {off && (
                      <p className="ml-[52px] mt-2 text-small text-fg-3">
                        Нужно подключение к агенту.{" "}
                        <Link to={`${SECTIONS.agent}?return=${check}`} className="text-run hover:underline">
                          Настроить в «Агенте»
                        </Link>
                      </p>
                    )}
                    {id === "simulations" && on && (
                      <p className="ml-[52px] mt-2 text-small text-fg-3">
                        Если сценариев ещё нет, сначала найдём ошибки в выбранных разговорах и соберём из них сценарии.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            {live && way && (
              <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-body text-fg-3">
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
          </fieldset>
          <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-line pt-6">
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
        </div>
      )}
    </div>
  );
}
