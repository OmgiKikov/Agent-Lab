import { Select } from "../../ui/Field";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Check as Tick, ChevronDown, Database, FlaskConical, MessagesSquare, Play } from "lucide-react";
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
import { ServiceDown } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { Menu } from "../../ui/Menu";
import { Sheet } from "../../ui/Sheet";
import { MarkNo } from "../../product/MarkNo";

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

/** A small capital label over a value, as the figures of a card name theirs. */
function Caps({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-label font-semibold uppercase tracking-caps text-fg-3", className)}>{children}</p>;
}

const bar = "block h-1.5 rounded-full bg-fg/10";
/** The grid paper the pictures of the ways lie on. */
const PAPER =
  "rounded-control bg-inset [background-image:radial-gradient(rgb(var(--fg-4)/0.35)_1px,transparent_1px)] [background-size:8px_8px]";

/** What checking the recorded answers gives: the agent's reply with the quote the check found marked. */
function RecordedPicture() {
  return (
    <div className="flex h-full flex-col justify-center gap-1.5 px-5">
      <span className="ml-auto block h-2.5 w-16 rounded-full bg-customer" />
      <div className="w-4/5 space-y-1.5 rounded-lg bg-list p-2 ring-1 ring-line">
        <span className={cn(bar, "w-4/5")} />
        <span className="flex items-center gap-1">
          <span className="block h-1.5 w-1/2 rounded-full bg-mark" />
          <MarkNo n={1} className="h-3 min-w-3 px-0.5 text-[8px]" />
        </span>
        <span className={cn(bar, "w-3/5")} />
      </div>
    </div>
  );
}

/** What asking the live agent gives: the same question, the recorded reply beside the new one. */
function LivePicture() {
  return (
    <div className="flex h-full flex-col justify-center gap-1.5 px-5">
      <span className="ml-auto block h-2.5 w-16 rounded-full bg-customer" />
      <div className="flex gap-1.5">
        <div className="flex-1 space-y-1.5 rounded-lg bg-list p-2 opacity-50 ring-1 ring-line">
          <span className={cn(bar, "w-4/5")} />
          <span className={cn(bar, "w-1/2")} />
        </div>
        <div className="flex-1 space-y-1.5 rounded-lg bg-list p-2 ring-1 ring-line-strong">
          <span className={cn(bar, "w-3/4")} />
          <span className={cn(bar, "w-3/5")} />
        </div>
      </div>
    </div>
  );
}

/** What the simulations give: clients of different kinds playing the scenarios through. */
function SimulationPicture() {
  return (
    <div className="flex h-full flex-col justify-center gap-2 px-5">
      <div className="flex -space-x-1.5">
        {["bg-mark", "bg-run/40", "bg-fg/20", "bg-ok/40"].map((tint) => (
          <span key={tint} className={cn("size-5 rounded-full ring-2 ring-inset", tint)} />
        ))}
      </div>
      <div className="w-4/5 space-y-1.5 rounded-lg bg-list p-2 ring-1 ring-line">
        <span className={cn(bar, "w-3/4")} />
        <span className={cn(bar, "w-1/2")} />
      </div>
    </div>
  );
}

const PICTURE: Record<Mode, () => ReactNode> = {
  dataset: RecordedPicture,
  questions: LivePicture,
  simulations: SimulationPicture,
};

/**
 * One way to check as a card to tick: a picture of what it gives, its name, what it does. A way that cannot run now
 * stays in its place, dashed, saying what it needs.
 */
function WayCard({
  id,
  on,
  off,
  onToggle,
  children,
}: {
  id: Mode;
  on: boolean;
  off: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  const option = OPTIONS.find((o) => o.id === id)!;
  const Picture = PICTURE[id];
  return (
    <label
      className={cn(
        "relative flex flex-col rounded-block border bg-canvas p-3 transition-[border-color,box-shadow] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-run/60",
        on ? "border-fg shadow-card" : "border-line",
        off ? "cursor-default border-dashed" : "cursor-pointer hover:border-line-strong",
      )}
    >
      <input type="checkbox" className="sr-only" checked={on} disabled={off} onChange={onToggle} />
      <span
        aria-hidden
        className={cn(
          "absolute right-5 top-5 z-10 grid size-5 place-items-center rounded-full transition-colors",
          on ? "bg-fg text-canvas" : "bg-canvas ring-1 ring-line-strong",
        )}
      >
        {on && <Tick className="size-3" strokeWidth={3} />}
      </span>
      <div aria-hidden className={cn("h-24", PAPER, off && "opacity-50")}>
        <Picture />
      </div>
      <span className={cn("mt-3 px-1 text-body font-semibold", off ? "text-fg-3" : "text-fg")}>{MODE_NAME[id]}</span>
      <span className="mt-1 px-1 text-small text-fg-3">{option.description}</span>
      {children && <span className="mt-2 px-1 text-small text-fg-3">{children}</span>}
    </label>
  );
}

/** The conversations a launch takes, as a fan of small chats on the right of its card; the front one with a quote marked. */
function ConversationFan() {
  const chat = (front: boolean) => (
    <div className="flex h-full flex-col justify-center gap-2 p-4">
      <span className="ml-auto block h-3 w-20 rounded-full bg-customer" />
      <div className="w-4/5 space-y-1.5 rounded-lg bg-list p-2.5 ring-1 ring-line">
        <span className={cn(bar, "w-4/5")} />
        {front ? (
          <span className="flex items-center gap-1">
            <span className="block h-1.5 w-1/2 rounded-full bg-mark" />
            <MarkNo n={1} className="h-3.5 min-w-3.5 px-0.5 text-[9px]" />
          </span>
        ) : (
          <span className={cn(bar, "w-1/2")} />
        )}
        <span className={cn(bar, "w-3/5")} />
      </div>
      <span className="ml-auto block h-3 w-14 rounded-full bg-customer" />
    </div>
  );
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute right-12 top-1/2 hidden h-40 w-60 -translate-y-1/2 xl:block"
    >
      <div className="absolute inset-0 -rotate-[9deg] rounded-block bg-canvas/80 shadow-card ring-1 ring-line">
        {chat(false)}
      </div>
      <div className="absolute inset-0 rotate-[6deg] rounded-block bg-canvas/90 shadow-card ring-1 ring-line">
        {chat(false)}
      </div>
      <div className="absolute inset-0 rounded-block bg-canvas shadow-card ring-1 ring-line">{chat(true)}</div>
    </div>
  );
}

/**
 * How many conversations, as a bar to drag: filled as far as the count goes, the ends of what one launch takes under
 * it. The keyboard moves it by one.
 */
function CountBar({ value, most, onChange }: { value: number; most: number; onChange: (n: number) => void }) {
  const share = most > 1 ? ((value - 1) / (most - 1)) * 100 : 100;
  return (
    <div>
      <div className="relative h-10 rounded-full bg-fg/[0.06] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-run/60">
        <div
          aria-hidden
          className="absolute inset-y-0 left-0 rounded-full bg-[linear-gradient(90deg,rgb(var(--mark)),rgb(var(--run)/0.35))]"
          style={{ width: `max(2.5rem, ${share}%)` }}
        />
        {/* The handle at the end of the fill: the bar is dragged by it. */}
        <span
          aria-hidden
          className="absolute top-1.5 size-7 rounded-full bg-canvas shadow-card ring-1 ring-line"
          style={{ left: `calc(max(2.5rem, ${share}%) - 2rem)` }}
        />
        <input
          type="range"
          min={1}
          max={Math.max(1, most)}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label="Сколько разговоров проверить"
          className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
        />
      </div>
      <div className="mt-1.5 flex justify-between text-small tabular-nums text-fg-3">
        <span>1</span>
        <span>{most}</span>
      </div>
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
  // The next step is the screen's one black button: what is missing first, the launch when nothing is.
  const step: ReactNode = !library ? null : !dataset ? (
    <UploadButton label="Загрузить выгрузку" />
  ) : judges.data && !rulesReady ? (
    check === "tone" ? (
      <Button size="lg" variant="primary" disabled={collecting || blocked} onClick={() => setCollect(true)}>
        {collecting ? "Собираем критерии…" : "Добавить правила"}
      </Button>
    ) : (
      <Link to={`${SECTIONS.agent}?return=code`} className={buttonClass({ variant: "primary", size: "lg" })}>
        Подключить код агента
      </Link>
    )
  ) : (
    <Button size="lg" variant="primary" icon={Play} loading={busy} disabled={!ready || blocked} onClick={start}>
      Запустить проверку
    </Button>
  );
  const why =
    state?.job.running && !collecting
      ? "Сейчас идёт другая задача этого агента."
      : !dataset
        ? "Проверка идёт по выгрузке чата с настоящими разговорами."
        : judges.data && !rulesReady
          ? check === "tone"
            ? collecting
              ? "Модель собирает критерии из документа — потом можно запускать."
              : "Критерии соберутся из правил общения банка: документ или текст."
            : "Критерии соберутся из кода агента. Или выберите готовый набор правил ниже."
          : ready
            ? null
            : missing;
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
      : check === "tone"
        ? "по правилам общения — их ещё нет"
        : "по критериям — их ещё нет";
  return (
    <div>
      <Header title={CHECK_NAME[check]} tabs={<StageTabs stage={check} />} />
      {offline && !state ? (
        <ServiceDown />
      ) : (
        <div className="max-w-[1040px] px-4 pb-16 pt-6 lg:px-10 lg:pt-8">
          {failed && (
            <div className="mb-6">
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
          {/* The launch in one sentence, its number first: how many conversations, from what, by what. */}
          <section
            aria-label="Новая проверка"
            className="relative overflow-hidden rounded-sheet border border-line p-6 sm:p-8"
            style={{
              backgroundImage:
                "radial-gradient(55% 90% at 92% 0%, rgb(var(--customer)) 0%, transparent 70%), radial-gradient(45% 75% at 100% 100%, rgb(var(--mark) / 0.4) 0%, transparent 70%)",
            }}
          >
            {dataset && <ConversationFan />}
            <Caps>Новая проверка · {CHECK_NAME[check]}</Caps>
            <h2 className="mt-4 flex flex-wrap items-baseline gap-x-3">
              <span className="text-display font-semibold tabular-nums text-fg sm:text-hero">
                {conversations || "—"}
              </span>
              <span className="text-lead text-fg-2">
                {plural(conversations, "разговор", "разговора", "разговоров")}
                {dataset && (
                  <>
                    {" "}
                    из <span className="font-medium text-fg">«{shownName(dataset)}»</span>
                  </>
                )}
              </span>
            </h2>
            <p className="mt-2 max-w-[60ch] text-read text-fg-2">{by}</p>
            {dataset && most > 1 && (
              <fieldset disabled={blocked} className="mt-6 max-w-lg">
                <CountBar value={Math.max(1, conversations || 1)} most={most} onChange={(n) => setSize(String(n))} />
              </fieldset>
            )}
            <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
              {step}
              {why && <p className="min-w-0 flex-1 basis-64 text-body text-fg-3">{why}</p>}
            </div>
            {error && (
              <p role="alert" className="mt-3 text-body text-bad">
                {error}
              </p>
            )}
          </section>

          <fieldset disabled={blocked} className="mt-10">
            <legend>
              <Caps>Что проверить</Caps>
            </legend>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {OPTIONS.map(({ id, live: needsAgent }) => {
                const off = needsAgent && !reachable.length;
                const on = chosen.includes(id);
                return (
                  <WayCard
                    key={id}
                    id={id}
                    on={on}
                    off={off}
                    onToggle={() => setModes((all) => (all.includes(id) ? all.filter((m) => m !== id) : [...all, id]))}
                  >
                    {off ? (
                      <>
                        Нужно подключение к агенту.{" "}
                        <Link to={`${SECTIONS.agent}?return=${check}`} className="text-run hover:underline">
                          Настроить
                        </Link>
                      </>
                    ) : id === "simulations" && on ? (
                      "Если сценариев ещё нет, сначала найдём ошибки в выбранных разговорах."
                    ) : null}
                  </WayCard>
                );
              })}
            </div>
            {live && way && (
              <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-body text-fg-3">
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
              </p>
            )}
          </fieldset>

          <fieldset disabled={blocked} className="mt-10">
            <legend>
              <Caps>Из чего</Caps>
            </legend>
            <div className="mt-3 grid gap-x-8 gap-y-6 rounded-block border border-line p-5 sm:grid-cols-3">
              <div className="min-w-0">
                <Caps>Датасет</Caps>
                {library && library.datasets.length > 1 && dataset ? (
                  <Menu
                    className="mt-1 max-w-full"
                    items={library.datasets.map((d) => ({
                      key: d.id,
                      label: shownName(d),
                      sub: datasetFacts(d).join(" · "),
                      on: d.id === dataset.id,
                      run: () => setDatasetId(d.id),
                    }))}
                    trigger={
                      <span className="flex min-w-0 items-center gap-1 text-left text-lead font-semibold text-fg">
                        <span className="min-w-0 truncate">{shownName(dataset)}</span>
                        <ChevronDown aria-hidden className="size-4 shrink-0 text-fg-3" />
                      </span>
                    }
                  />
                ) : (
                  <p className="mt-1 truncate text-lead font-semibold text-fg">
                    {dataset ? shownName(dataset) : library ? "Пока нет" : "…"}
                  </p>
                )}
                <p className="mt-0.5 text-small text-fg-3">
                  {dataset ? datasetFacts(dataset).slice(0, 2).join(" · ") : "Выгрузка чата"}
                </p>
              </div>
              <div className="min-w-0">
                <Caps>Правила</Caps>
                {judges.data && (versions.length > 0 || codeSources(state).length > 0) ? (
                  <Menu
                    className="mt-1 max-w-full"
                    items={[
                      ...(check === "code" && codeSources(state).length > 0
                        ? [
                            {
                              key: "code",
                              label: "Критерии из кода агента",
                              sub: "Соберутся из инструкций и инструментов",
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
                      <span className="flex min-w-0 items-center gap-1 text-left text-lead font-semibold text-fg">
                        <span className="min-w-0 truncate">
                          {rules
                            ? `${rules.name}${versionWord(rules, versions)}`
                            : fromCode
                              ? "Из кода агента"
                              : "Выбрать"}
                        </span>
                        <ChevronDown aria-hidden className="size-4 shrink-0 text-fg-3" />
                      </span>
                    }
                  />
                ) : (
                  <p className="mt-1 text-lead font-semibold text-fg-3">{judges.data ? "Пока нет" : "…"}</p>
                )}
                <p className="mt-0.5 text-small text-fg-3">
                  {rules ? (
                    <>
                      {subset ? `${subset.length} из ${criteria.length}` : `все ${criteria.length}`}{" "}
                      {plural(criteria.length, "критерий", "критерия", "критериев")}
                      {check === "tone" && criteria.length > 1 && (
                        <>
                          {" · "}
                          <button type="button" onClick={() => setPicking(true)} className="text-run hover:underline">
                            {subset ? "изменить выбор" : "выбрать часть"}
                          </button>
                        </>
                      )}
                    </>
                  ) : fromCode ? (
                    "Соберутся при проверке"
                  ) : check === "code" ? (
                    <Link to={criterionLink("code", null, { rules: "1" })} className="text-run hover:underline">
                      Выбрать набор правил
                    </Link>
                  ) : (
                    "Из документа банка"
                  )}
                </p>
                {extractedBefore && (
                  <label className="mt-2 flex cursor-pointer items-start gap-2 text-small text-fg-2">
                    <input
                      type="checkbox"
                      checked={replan}
                      onChange={(e) => setReplan(e.target.checked)}
                      className="mt-0.5 size-4 accent-primary"
                    />
                    Извлечь критерии из кода заново
                  </label>
                )}
              </div>
              <div className="min-w-0">
                <Caps>Версия агента</Caps>
                <input
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  maxLength={80}
                  aria-label="Версия агента"
                  placeholder="не указана"
                  className="mt-1 w-full border-b border-dashed border-line-strong bg-transparent pb-0.5 text-lead font-semibold text-fg placeholder:font-normal placeholder:text-fg-4 focus:border-solid focus:border-fg focus:outline-none"
                />
                <p className="mt-0.5 text-small text-fg-3">По желанию: чтобы отличать прогоны</p>
              </div>
            </div>
          </fieldset>

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
