import { Input, Select } from "../../ui/Field";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Database, FlaskConical, MessagesSquare, Play } from "lucide-react";
import { agentKey } from "../../app/agent";
import { Header } from "../../app/Header";
import { StageTabs } from "../../app/StageTabs";
import { historyLink, judgesLink, launchLink, SECTIONS, stageRoot, toneCheckLink } from "../../app/links";
import { api } from "../../lab/api";
import { CHECK_NAME } from "../../lab/checks";
import { useDatasets } from "../../lab/datasets";
import { useJudges } from "../../lab/judges";
import { useLabState } from "../../lab/LabProvider";
import { MODE_NAME, type Mode } from "../../lab/launches";
import { codeSources } from "../../lab/tone";
import type { Check } from "../../lab/types";
import { DatasetPicker } from "../../product/DatasetPicker";
import { JudgePicker } from "../../product/JudgePicker";
import { Button } from "../../ui/Button";
import { ServiceDown } from "../../ui/EmptyState";

const OPTIONS = [
  {
    id: "dataset" as const,
    icon: Database,
    description: "Оценить уже записанные ответы. Подключение к агенту не требуется.",
  },
  {
    id: "questions" as const,
    icon: MessagesSquare,
    description: "Отправить исходные вопросы на стенд и сохранить новые ответы рядом с оригиналом.",
  },
  {
    id: "simulations" as const,
    icon: FlaskConical,
    description: "Синтетические клиенты разыграют сценарии из найденных ошибок.",
  },
];
type Draft = { modes: Mode[]; version: string; size: number; target: string };
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
      size: Number.isFinite(value.size) ? Math.max(1, Math.min(300, value.size)) : 100,
      target: typeof value.target === "string" ? value.target : "",
    };
  } catch {
    return fallback;
  }
}

export function LaunchPage({ check }: { check: Check }) {
  const { state, offline, refresh } = useLabState();
  const datasets = useDatasets();
  const judges = useJudges(check);
  const navigate = useNavigate();
  const [draft] = useState(() => readDraft(check));
  const [modes, setModes] = useState<Mode[]>(draft.modes);
  const [version, setVersion] = useState(draft.version);
  const [size, setSize] = useState(draft.size);
  const [target, setTarget] = useState(draft.target);
  useEffect(() => {
    try {
      localStorage.setItem(agentKey(`launch-draft-${check}`), JSON.stringify({ modes, version, size, target }));
    } catch {
      /* Drafts are optional when browser storage is unavailable. */
    }
  }, [check, modes, version, size, target]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chosenTarget = target || state?.targets.find((t) => t.ready)?.id || "prod";
  const live = modes.some((m) => m !== "dataset");
  const count = Math.min(size, state?.logs.total ?? 0);
  const rulesReady =
    check === "tone" ? !!state?.toneOfVoice?.criteria.length : !!judges.selected || codeSources(state).length > 0;
  const ready =
    !datasets.isPending &&
    !judges.isPending &&
    !datasets.isError &&
    !judges.isError &&
    !datasets.changing &&
    !judges.changing &&
    !!datasets.data?.activeId &&
    !!count &&
    rulesReady &&
    modes.length > 0 &&
    (!live || !!state?.targets.find((t) => t.id === chosenTarget)?.ready);
  const blocked = busy || !!state?.job.running;
  const missing =
    datasets.isError || judges.isError
      ? "Не удалось загрузить настройки. Повторите загрузку выше."
      : !datasets.data?.activeId || !count
        ? "Добавьте датасет с разговорами."
        : !rulesReady
          ? "Выберите набор правил или подготовьте критерии."
          : !modes.length
            ? "Выберите хотя бы один режим проверки."
            : live && !state?.targets.find((t) => t.id === chosenTarget)?.ready
              ? "Для выбранных режимов настройте подключение к агенту."
              : datasets.changing || judges.changing
                ? "Сохраняем выбранные данные и правила…"
                : "Загружаем настройки…";
  const start = async () => {
    if (blocked || !ready) return;
    setBusy(true);
    setError("");
    try {
      const r = await api<{ id: string }>("/api/launches", {
        check,
        datasetId: datasets.data?.activeId,
        judgeId: judges.data?.selectedId ?? null,
        agentVersion: version.trim(),
        modes,
        count,
        target: chosenTarget,
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
        <div className="max-w-[1180px] px-4 pb-16 pt-8 lg:px-10">
          <h2 className="text-page font-semibold text-fg">Новая проверка</h2>
          <p className="mt-3 text-read text-fg-3">
            Выберите данные, правила и способы проверки. У каждого режима будет свой результат.
          </p>
          <div className="mt-7 grid items-start gap-8 lg:grid-cols-[minmax(0,1.6fr)_minmax(260px,1fr)]">
            <div className="min-w-0 space-y-6">
              <div className="space-y-5 rounded-block border border-line p-5">
                <DatasetPicker />
                <JudgePicker check={check} />
                {check === "code" && !judges.selected && !codeSources(state).length && (
                  <Link to={`${SECTIONS.agent}?return=code`} className="text-small text-run">
                    Прочитать код агента →
                  </Link>
                )}
                {!rulesReady && (
                  <Link className="text-small text-run" to={judgesLink(check)}>
                    Подготовьте правила судьи →
                  </Link>
                )}
                <label className="block text-body text-fg">
                  Версия или метка агента <span className="text-fg-3">· по желанию</span>
                  <Input
                    value={version}
                    disabled={blocked}
                    onChange={(e) => setVersion(e.target.value)}
                    maxLength={80}
                    placeholder="Например: v2.4 · после правки промпта"
                    className="mt-2"
                  />
                </label>
                <label className="flex flex-wrap items-center gap-3 text-body text-fg">
                  Разговоров из датасета
                  <Input
                    aria-label="Сколько разговоров проверить"
                    type="number"
                    min={1}
                    max={Math.min(300, state?.logs.total || 300)}
                    value={count || size}
                    disabled={blocked}
                    onChange={(e) => setSize(Math.max(1, Math.min(300, Number(e.target.value) || 1)))}
                    className="w-20"
                  />
                  <span className="text-small text-fg-3">из {state?.logs.total ?? 0}</span>
                </label>
              </div>
              <fieldset disabled={blocked}>
                <legend className="mb-3 text-read font-semibold text-fg">Что оцениваем</legend>
                <div className="space-y-3">
                  {OPTIONS.map(({ id, icon: Icon, description }) => (
                    <label
                      key={id}
                      className={`flex cursor-pointer items-start gap-3 rounded-block border p-4 ${modes.includes(id) ? "border-fg-3 bg-inset/50" : "border-line"}`}
                    >
                      <input
                        type="checkbox"
                        checked={modes.includes(id)}
                        onChange={() =>
                          setModes((all) => (all.includes(id) ? all.filter((m) => m !== id) : [...all, id]))
                        }
                        className="mt-1 size-4 accent-primary"
                      />
                      <Icon className="mt-0.5 size-5 shrink-0 text-fg-3" />
                      <span>
                        <span className="block text-body font-semibold text-fg">{MODE_NAME[id]}</span>
                        <span className="mt-1 block text-small text-fg-3">{description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {live && (
                <div className="rounded-block border border-line p-5">
                  <label className="block text-body font-medium text-fg">
                    Подключение агента
                    <Select
                      value={chosenTarget}
                      disabled={blocked}
                      onChange={(e) => setTarget(e.target.value)}
                      className="mt-2"
                    >
                      {state?.targets.map((t) => (
                        <option value={t.id} key={t.id} disabled={!t.ready}>
                          {t.name}
                          {!t.ready ? " · не настроено" : ""}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <Link className="mt-3 inline-block text-small text-run" to={`${SECTIONS.agent}?return=${check}`}>
                    Настроить или проверить связь →
                  </Link>
                </div>
              )}
            </div>
            <aside className="rounded-block border border-line bg-inset/40 p-5 lg:sticky lg:top-5">
              <h3 className="text-read font-semibold text-fg">Перед запуском</h3>
              <dl className="mt-4 space-y-3 text-body">
                <div>
                  <dt className="text-fg-3">Данные</dt>
                  <dd className="mt-1 break-words text-fg">{state?.logs.name || state?.logs.file || "Не выбраны"}</dd>
                </div>
                <div>
                  <dt className="text-fg-3">Правила</dt>
                  <dd className="mt-1 text-fg">
                    {judges.selected
                      ? `${judges.selected.name} · v${judges.selected.version}`
                      : check === "code"
                        ? "Из кода агента"
                        : "Не выбраны"}
                  </dd>
                </div>
                <div>
                  <dt className="text-fg-3">Режимы</dt>
                  <dd className="mt-1 text-fg">{modes.map((m) => MODE_NAME[m]).join(", ") || "Не выбраны"}</dd>
                </div>
              </dl>
              {modes.includes("simulations") && (
                <p className="mt-4 text-small text-fg-3">
                  Если сценариев ещё нет, сначала проверим выбранные диалоги и соберём сценарии из ошибок.
                </p>
              )}
              <Button
                className="mt-6 w-full"
                size="lg"
                variant="primary"
                icon={Play}
                loading={busy}
                disabled={!ready || blocked}
                onClick={start}
              >
                Запустить проверку
              </Button>
              {!ready && <p className="mt-3 text-small text-fg-3">{missing}</p>}
              {state?.job.running && (
                <p className="mt-3 text-small text-warn">Сейчас выполняется другая задача этого агента.</p>
              )}
              {error && (
                <p role="alert" className="mt-3 text-body text-bad">
                  {error}
                </p>
              )}
            </aside>
          </div>
          <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3 border-t border-line pt-5 text-body">
            <Link to={historyLink(check)} className="text-run hover:underline">
              История проверок →
            </Link>
            <Link
              to={check === "tone" ? toneCheckLink("criteria") : `${stageRoot(check)}?assess=1`}
              className="text-fg-3 hover:text-fg hover:underline"
            >
              {check === "tone" ? "Проверить отдельные критерии" : "Переизвлечь критерии и проверить"}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
