import { Select } from "../../ui/Field";
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

/**
 * A word of the sentence that is chosen: the word itself, dotted under, a small chevron when it opens a list; a light
 * ground only under the pointer. Opened or typed in, it stays a word of the line.
 */
const WORD =
  "inline-flex items-center gap-0.5 rounded-md px-1 align-baseline font-medium text-fg transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60";
const DOTTED = "underline decoration-fg-4 decoration-dotted decoration-[1.5px] underline-offset-[7px]";

/** A word to be added: what the sentence still lacks, in the colour of a link. */
const LACK =
  "inline-flex items-center gap-1 rounded-control px-1.5 py-0.5 align-baseline font-medium text-run transition-colors hover:bg-run/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60";

/** A word that opens a list of choices: its value and a small chevron. */
function Word({ children }: { children: ReactNode }) {
  return (
    <span className={WORD}>
      <span className={DOTTED}>{children}</span>
      <ChevronDown aria-hidden className="size-4 text-fg-3" />
    </span>
  );
}

/** One way to check as a chip to switch on and off: dark with a tick when on, a «+» when off, dashed when it cannot run. */
function WayChip({ id, on, off, onToggle }: { id: Mode; on: boolean; off: boolean; onToggle: () => void }) {
  const Icon = on ? Tick : Plus;
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={off}
      onClick={onToggle}
      className={cn(
        "inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-body transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60",
        on ? "bg-fg text-canvas" : "text-fg-2 ring-1 ring-inset ring-line-strong hover:bg-hover hover:text-fg",
        off && "cursor-default text-fg-4 ring-dashed hover:bg-transparent hover:text-fg-4",
      )}
    >
      <Icon aria-hidden className="size-3.5" strokeWidth={on ? 3 : 2} />
      {MODE_NAME[id]}
    </button>
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
  const [versioning, setVersioning] = useState(!!draft.version);
  // What the launch waits for, said beside its button; the word that is missing in the sentence gives the way to it.
  const why = state?.job.running && !collecting ? "Сейчас идёт другая задача этого агента." : ready ? null : missing;
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
    ...(check === "tone" ? [{ key: "doc", label: "Собрать из документа", run: () => setCollect(true) }] : []),
    {
      key: "edit",
      label: "Изменить правила",
      run: () => void navigate(criterionLink(check, null, { rules: "1" })),
    },
  ];
  const lackOfRules =
    judges.data && !rulesReady && !fromCode ? (
      check === "tone" ? (
        collecting ? (
          <span className={cn(LACK, "text-fg-3 hover:bg-transparent")}>собираем критерии…</span>
        ) : (
          <button type="button" onClick={() => setCollect(true)} className={LACK}>
            <Plus aria-hidden className="size-4" />
            правилам общения
          </button>
        )
      ) : (
        <Link to={`${SECTIONS.agent}?return=code`} className={LACK}>
          <Plus aria-hidden className="size-4" />
          критериям из кода агента
        </Link>
      )
    ) : null;
  const hint =
    library && !dataset ? (
      <span className="flex flex-wrap items-center gap-3">
        Проверка идёт по выгрузке чата с настоящими разговорами.
        <UploadButton variant="outline" label="Загрузить выгрузку" />
      </span>
    ) : lackOfRules ? (
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
    ) : null;
  return (
    <div>
      <Header title={CHECK_NAME[check]} tabs={<StageTabs stage={check} />} />
      {offline && !state ? (
        <ServiceDown />
      ) : (
        <div className="max-w-[880px] px-4 pb-16 pt-8 lg:px-10">
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
          <fieldset disabled={blocked}>
            {/* The launch said as one sentence; each of its words that can be chosen is chosen right in it. */}
            <p className="mt-6 max-w-[40ch] text-title leading-[2.75rem] text-fg-2 sm:max-w-none">
              Проверим{" "}
              {dataset ? (
                <input
                  aria-label="Сколько разговоров проверить"
                  inputMode="numeric"
                  value={wanted > most && most > 0 ? String(most) : size}
                  onChange={(e) => setSize(e.target.value.replace(/\D/g, "").slice(0, 3))}
                  onBlur={() => setSize(String(conversations || Math.min(100, most) || draft.size))}
                  style={{ width: `${Math.max(2, (wanted > most ? String(most) : size).length) + 0.6}ch` }}
                  className="inline-block border-b-[1.5px] border-dotted border-fg-4 bg-transparent text-center font-medium tabular-nums text-fg transition-colors hover:border-fg-3 focus:border-solid focus:border-fg focus:outline-none"
                />
              ) : null}{" "}
              {plural(conversations || 0, "разговор", "разговора", "разговоров")} из{" "}
              {!library ? (
                "…"
              ) : !dataset ? (
                <span className="text-fg-3">выгрузки чата</span>
              ) : library.datasets.length > 1 ? (
                <Menu
                  items={library.datasets.map((d) => ({
                    key: d.id,
                    label: shownName(d),
                    sub: datasetFacts(d).join(" · "),
                    on: d.id === dataset.id,
                    run: () => setDatasetId(d.id),
                  }))}
                  trigger={<Word>«{shownName(dataset)}»</Word>}
                />
              ) : (
                <span className="font-medium text-fg">«{shownName(dataset)}»</span>
              )}
              <br />
              по{" "}
              {!judges.data ? (
                "…"
              ) : lackOfRules ? (
                lackOfRules
              ) : rules ? (
                <>
                  {check === "tone" && criteria.length > 1 ? (
                    <button type="button" onClick={() => setPicking(true)} className={WORD}>
                      <span className={DOTTED}>
                        {subset ? `${subset.length} из ${criteria.length}` : criteria.length}{" "}
                        {plural(subset ? subset.length : criteria.length, "критерию", "критериям", "критериям")}
                      </span>
                      <ChevronDown aria-hidden className="size-4 text-fg-3" />
                    </button>
                  ) : (
                    <span className="font-medium text-fg">
                      {criteria.length} {plural(criteria.length, "критерию", "критериям", "критериям")}
                    </span>
                  )}{" "}
                  из правил{" "}
                  <Menu
                    items={rulesMenu}
                    trigger={
                      <Word>
                        «{rules.name}
                        {versionWord(rules, versions)}»
                      </Word>
                    }
                  />
                </>
              ) : (
                <Menu
                  items={rulesMenu}
                  trigger={
                    <Word>
                      {extractedBefore && replan ? "критериям, извлечённым заново из кода" : "критериям из кода агента"}
                    </Word>
                  }
                />
              )}
            </p>
            {hint && <div className="mt-3 text-body text-fg-3">{hint}</div>}

            <div className="mt-8 flex flex-wrap gap-2">
              {OPTIONS.map(({ id, live: needsAgent }) => (
                <WayChip
                  key={id}
                  id={id}
                  on={chosen.includes(id)}
                  off={needsAgent && !reachable.length}
                  onToggle={() => setModes((all) => (all.includes(id) ? all.filter((m) => m !== id) : [...all, id]))}
                />
              ))}
            </div>
            <p className="mt-3 max-w-[70ch] text-body text-fg-3">
              {OPTIONS.filter((o) => chosen.includes(o.id))
                .map((o) => o.description)
                .join(" ")}
              {!reachable.length && (
                <>
                  {chosen.length ? " " : ""}
                  Вопросы агенту и симуляции — когда он подключён.{" "}
                  <Link to={`${SECTIONS.agent}?return=${check}`} className="text-run hover:underline">
                    Подключить
                  </Link>
                </>
              )}
              {chosen.includes("simulations") &&
                " Если сценариев ещё нет, сначала найдём ошибки в выбранных разговорах."}
            </p>
            {live && way && (
              <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-fg-3">
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

            <div className="mt-10 flex flex-wrap items-center gap-x-5 gap-y-3">
              <Button
                size="lg"
                variant="primary"
                icon={Play}
                loading={busy}
                disabled={!ready || blocked}
                onClick={start}
              >
                Запустить проверку
              </Button>
              {versioning ? (
                <label className="flex items-center gap-2 text-body text-fg-3">
                  версия агента
                  <input
                    autoFocus={!version}
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    maxLength={80}
                    placeholder="например, v2.4"
                    className="w-40 border-b border-line-strong bg-transparent pb-0.5 text-body text-fg placeholder:text-fg-4 focus:border-fg focus:outline-none"
                  />
                </label>
              ) : (
                <button
                  type="button"
                  onClick={() => setVersioning(true)}
                  className="inline-flex items-center gap-1 text-body text-fg-3 hover:text-fg"
                >
                  <Plus aria-hidden className="size-3.5" />
                  версия агента
                </button>
              )}
              {why && <p className="min-w-0 basis-full text-body text-fg-3">{why}</p>}
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
