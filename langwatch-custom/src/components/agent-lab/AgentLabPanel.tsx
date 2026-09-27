import {
  Badge,
  Box,
  Button,
  HStack,
  Input,
  Text,
  Textarea,
  VStack,
  Spinner,
} from "@chakra-ui/react";
import {
  FlaskConical,
  FileText,
  ArrowRight,
  X,
  CheckCircle2,
  AlertTriangle,
  ChevronLeft,
  Upload,
  Play,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { analysisNeedsRefresh } from "~/server/agent-lab/progress";
import type { Analysis, Card, Rule } from "~/server/agent-lab/schema";

type Catalog = {
  datasets: {
    id: string;
    name: string;
    columnTypes: { name: string; type: string }[];
    recordCount?: number;
  }[];
  agents: { id: string; name: string }[];
  models: string[];
  jobs: {
    id: string;
    name: string;
    status: string;
    createdAt: string;
    agentId?: string;
    selected: number;
    processed: number;
  }[];
};
const fieldStyle = {
  width: "100%",
  padding: "9px 12px",
  border: "1px solid var(--chakra-colors-border)",
  borderRadius: "6px",
  background: "var(--chakra-colors-bg)",
  fontSize: "14px",
};
async function call<T>(
  path: string,
  projectId: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(
    "/api/agent-lab" +
      path +
      (body ? "" : "?projectId=" + encodeURIComponent(projectId)),
    {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body
        ? JSON.stringify({ ...(body as object), projectId })
        : undefined,
    },
  );
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Запрос не выполнен");
  return data;
}
function Label({ children }: { children: React.ReactNode }) {
  return (
    <Text fontSize="sm" fontWeight="medium" marginTop={3} marginBottom={1}>
      {children}
    </Text>
  );
}
function Select({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  items: { id: string; name: string }[];
}) {
  return (
    <Box width="full">
      <Label>{label}</Label>
      <select
        aria-label={label}
        style={fieldStyle}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Выберите…</option>
        {items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
      </select>
    </Box>
  );
}
function Paper({ children }: { children: React.ReactNode }) {
  return (
    <Box
      borderWidth="1px"
      borderColor="border"
      borderRadius="lg"
      padding={5}
      background="bg"
      width="full"
    >
      {children}
    </Box>
  );
}

/** Native dataset action: uses the LangWatch shell, providers, scenarios and experiments. */
export function AgentLabPanel({
  projectId,
  projectSlug,
  datasetId,
  analysisPrefix,
}: {
  projectId: string;
  projectSlug: string;
  datasetId?: string;
  analysisPrefix?: string;
}) {
  const route = useLocation();
  const [open, setOpen] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("agentLab") === "1",
  );
  const [catalog, setCatalog] = useState<Catalog>();
  const [job, setJob] = useState<Analysis>();
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [logs, setLogs] = useState(datasetId ?? "");
  const [textColumn, setTextColumn] = useState("");
  const [idColumn, setIdColumn] = useState("");
  const [materials, setMaterials] = useState<
    Record<string, "prompt" | "knowledge">
  >({});
  const [ownerRules, setOwnerRules] = useState("");
  const [task, setTask] = useState(
    "Проверить ответы агента поддержки на реальных обращениях",
  );
  const [count, setCount] = useState(3);
  const [model, setModel] = useState("");
  const [card, setCard] = useState<Card>();
  const [agent, setAgent] = useState("");
  const [note, setNote] = useState("");
  const [runAfter, setRunAfter] = useState(true);
  const [repeats, setRepeats] = useState(1);
  const [batchProgress, setBatchProgress] = useState<any>();
  const [ordinaryId, setOrdinaryId] = useState("");
  const [syntheticTopicId, setSyntheticTopicId] = useState("");
  const [runData, setRunData] = useState<any>();
  const [suiteResults, setSuiteResults] = useState<any[]>([]);
  const [reviewNotes, setReviewNotes] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File>();
  const [sheets, setSheets] = useState<any[]>();
  const [sheet, setSheet] = useState("0");
  const base = { projectId, id: job?.id };
  const approved =
    job?.topics.flatMap((t) => t.rules.filter((r) => r.approved)) ?? [];
  function url(next?: Analysis) {
    const u = new URL(window.location.href);
    u.searchParams.set("agentLab", "1");
    if (next) u.searchParams.set("labId", next.id);
    else u.searchParams.delete("labId");
    window.history.replaceState(null, "", u);
  }
  async function loadCatalog() {
    const next = await call<Catalog>("/catalog", projectId);
    setCatalog(next);
    setModel(
      (m) =>
        m ||
        next.models.find((x) => x.includes("gpt-5.6-sol")) ||
        next.models[0] ||
        "",
    );
    setAgent((a) => a || next.agents.find(a => !/^Synthetic frozen-contract/.test(a.name))?.id || next.agents[0]?.id || "");
    setLogs(
      (value) =>
        value ||
        next.datasets.find(
          (d) =>
            !d.columnTypes.some((c) =>
              ["findings", "judgments", "analysis_id"].includes(c.name),
            ) &&
            d.columnTypes?.some((c) =>
              ["conversation", "Текст"].includes(c.name),
            ),
        )?.id ||
        "",
    );
    const currentId = new URLSearchParams(window.location.search).get("labId");
    if (!currentId) {
      const recent = next.jobs.find((j) => j.agentId && !j.name.startsWith("Перенесённый"));
      if (recent) {
        const profile = await call<Analysis>(
          "/analysis/" + recent.id,
          projectId,
        );
        setOwnerRules((old) => old || profile.ownerRules);
        setTask(profile.task);
        if (next.agents.some(a => a.id === profile.agentId)) setAgent(profile.agentId!);
        if (next.datasets.some(d => d.id === profile.datasetId)) setLogs(profile.datasetId);
        setMaterials((old) =>
          Object.keys(old).length
            ? old
            : Object.fromEntries(
                profile.materialRefs.map((r) => [r.datasetId, r.kind]),
              ),
        );
      }
    }
    return next;
  }
  async function load(id: string) {
    const next = await call<Analysis>("/analysis/" + id, projectId);
    setJob(next);
    setLogs(next.datasetId);
    setOwnerRules(next.ownerRules);
    setTask(next.task);
    setCount(next.selected);
    setRepeats(next.repeatCount ?? 1);
    if (next.agentId) setAgent(next.agentId);
    setMaterials(
      Object.fromEntries(
        next.materialRefs.map((ref) => [ref.datasetId, ref.kind]),
      ),
    );
    if (!next.model.startsWith("historical/")) setModel(next.model);
    setCard(next.cards.at(-1));
    setRunData(undefined);
    setBatchProgress(undefined);
    setStep(
      next.batches?.length || (next.purpose === "verify" && next.status === "done")
        ? 4
        : next.status === "ready" ||
            (!next.autoEvaluate && ["planning", "failed"].includes(next.status))
          ? 2
          : 3,
    );
    url(next);
    return next;
  }
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (new URLSearchParams(route.search).get("agentLab") === "1")
      setOpen(true);
  }, [route.search]);
  useEffect(() => {
    if (!open || !projectId) return;
    void act(async () => {
      const next = await loadCatalog();
      const id =
        new URLSearchParams(window.location.search).get("labId") ??
        ((analysisPrefix ??
        new URLSearchParams(window.location.search).get("labPrefix"))
          ? next.jobs.find((j) =>
              j.id.startsWith(
                analysisPrefix ??
                  new URLSearchParams(window.location.search).get(
                    "labPrefix",
                  ) ??
                  "-",
              ),
            )?.id
          : undefined);
      if (id) await load(id);
    });
  }, [open, projectId]);
  useEffect(() => {
    const source = catalog?.datasets.find((d) => d.id === logs);
    const columns = source?.columnTypes ?? [];
    setTextColumn(
      columns.find((c) => ["conversation", "Текст", "text"].includes(c.name))
        ?.name ??
        columns[0]?.name ??
        "",
    );
    setIdColumn(
      columns.find((c) => ["dialogue_id", "Id диалога", "id"].includes(c.name))
        ?.name ??
        columns[0]?.name ??
        "",
    );
  }, [logs, catalog?.datasets]);
  useEffect(() => {
    if (!open || !job || !analysisNeedsRefresh(job)) return;
    const interval = setInterval(() => {
      void call<Analysis>("/analysis/" + job.id, projectId)
        .then((j) => {
          setJob(j);
          if (j.status === "ready") setStep(2);
          if (j.status === "done") {
            setStep(j.batches?.length || j.purpose === "verify" ? 4 : 3);
            if (j.batches?.length)
              setCard(
                (old) =>
                  j.cards.find((c) => c.id === old?.id) ??
                  j.cards.find((c) => c.status === "saved"),
              );
          }
        })
        .catch((e) => setError(String(e)));
    }, 3000);
    return () => clearInterval(interval);
  }, [
    open,
    job?.id,
    job?.status,
    job?.batches?.at(-1)?.status,
    job?.workflowError,
    projectId,
  ]);
  useEffect(() => {
    if (!open || !card?.runs.length || !job) return;
    let stopped = false;
    async function poll() {
      try {
        const data = await call<any>(
          "/runs/" + job!.id + "/" + card!.id,
          projectId,
        );
        if (!stopped) {
          setRunData(data);
          setError((old) =>
            old.includes("Simulation run not found") ? "" : old,
          );
        }
      } catch (e) {
        if (!stopped) setError(String(e));
      }
    }
    void poll();
    const interval = setInterval(() => void poll(), 5000);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [open, card?.id, card?.runs.length, job?.id, projectId]);
  useEffect(() => {
    if (!open || step !== 4 || !job) return;
    let cancelled = false;
    async function poll() {
      try {
        const data = await call<any>("/run-summary/" + job!.id, projectId);
        if (!cancelled) {
          setSuiteResults(data.rows ?? data);
          setBatchProgress(data);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }
    void poll();
    const interval = setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [
    open,
    step,
    job?.id,
    job?.cards.length,
    job?.cards.map((c) => c.runs.length).join(","),
    projectId,
  ]);
  function updateRule(ruleId: string, change: Partial<Rule>) {
    setJob((old) =>
      old
        ? {
            ...old,
            topics: old.topics.map((t) => ({
              ...t,
              rules: t.rules.map((r) =>
                r.id === ruleId ? { ...r, ...change } : r,
              ),
            })),
          }
        : old,
    );
  }
  async function approve() {
    if (!job) return;
    const next = await call<Analysis>("/approve", projectId, {
      ...base,
      rules: job.topics.flatMap((t) =>
        t.rules.map((r) => ({
          id: r.id,
          approved: r.approved,
          text: r.text,
          condition: r.condition,
          acceptable: r.acceptable,
        })),
      ),
    });
    setJob(next);
  }
  async function propose(
    origin: Card["origin"],
    dialogueId?: string,
    ruleIds?: string[],
  ) {
    await approveIfReady();
    const next = await call<Card>("/propose", projectId, {
      ...base,
      origin,
      dialogueId,
      ruleIds: ruleIds ?? approved.slice(0, 4).map((r) => r.id),
    });
    setRunData(undefined);
    setCard(next);
    setStep(4);
    setJob(await call<Analysis>("/analysis/" + job!.id, projectId));
  }
  async function approveIfReady() {
    if (job?.status === "ready") await approve();
  }
  async function xlsx(commit: boolean) {
    if (!file) return;
    const form = new FormData();
    form.set("file", file);
    if (commit) form.set("sheet", sheet);
    const response = await fetch(
      "/api/agent-lab/xlsx?projectId=" + encodeURIComponent(projectId),
      { method: "POST", body: form, credentials: "same-origin" },
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (commit) {
      await loadCatalog();
      setLogs(data.datasetId);
      setSheets(undefined);
      setFile(undefined);
    } else setSheets(data.sheets);
  }
  function nativeScenario(id: string) {
    window.location.href = `/${projectSlug}/simulations/scenarios?drawer.open=scenarioEditor&drawer.scenarioId=${encodeURIComponent(id)}`;
  }
  const health =
    job?.topics.map((topic) => {
      const rows = job.results.filter((result) => result.topicId === topic.id);
      const failed = rows.filter((result) =>
        result.rules.some((v) => v.status === "FAIL"),
      ).length;
      const passed = rows.filter(
        (result) =>
          result.rules.some((v) => v.status === "PASS") &&
          result.rules.every((v) =>
            ["PASS", "NOT_APPLICABLE"].includes(v.status),
          ),
      ).length;
      return {
        id: topic.id,
        title: topic.title,
        total: topic.dialogueIds.length,
        processed: rows.length,
        failed,
        passed,
        unknown: rows.length - failed - passed,
      };
    }) ?? [];
  const patterns =
    job?.results.flatMap((result) =>
      result.rules
        .filter((v) => v.status === "FAIL")
        .map((verdict) => ({
          result,
          verdict,
          rule: job.topics
            .flatMap((t) => t.rules)
            .find((r) => r.id === verdict.ruleId)!,
        })),
    ) ?? [];
  const groups = [...new Set(patterns.map((p) => p.rule.id))].map((ruleId) => ({
    ruleId,
    items: patterns.filter((p) => p.rule.id === ruleId),
  }));
  const ordinary =
    job?.dialogues.filter((d) =>
      job.topics.find((t) => t.id === d.topicId)?.rules.some((r) => r.approved),
    ) ?? [];
  const stateName = (status: string) =>
    ({
      planning: "Готовим правила",
      ready: "Правила ждут проверки",
      judging: "Анализируем разговоры",
      done: "Разбор готов",
      failed: "Разбор не завершён",
      interrupted: "Разбор прерван",
    })[status] ?? status;
  const originName = (origin: Card["origin"]) =>
    ({
      coverage: "Из обращения клиента",
      regression: "Из найденной ошибки",
      synthetic: "Новая ситуация по правилам",
    })[origin];
  const runName = (status: string) =>
    ({
      SUCCESS: "Проверка пройдена",
      FAILED: "Проверка не пройдена",
      ERROR: "Ошибка запуска",
      QUEUED: "Ожидает запуска",
      PENDING: "Ожидает запуска",
      IN_PROGRESS: "Агент проходит проверку",
      CANCELLED: "Остановлено",
      STALLED: "Прогон прерван",
      NOT_RUN: "Не запускалась",
    })[status] ?? status;
  const inProgress = job && ["planning", "judging"].includes(job.status);
  const materialDatasets =
    catalog?.datasets.filter(
      (d) =>
        d.id !== logs &&
        d.columnTypes.some((c) =>
          ["text", "content", "prompt", "instructions"].includes(c.name),
        ),
    ) ?? [];
  const latestReview = (dialogueId: string, ruleId: string) =>
    job?.reviews
      .filter((r) => r.dialogueId === dialogueId && r.ruleId === ruleId)
      .at(-1);
  const confirmed = patterns.filter(
    (p) =>
      latestReview(p.result.dialogueId, p.rule.id)?.decision === "confirmed",
  ).length;
  function newAnalysis() {
    window.location.href = `/${projectSlug}/datasets?agentLab=1&new=1`;
  }
  function entry() {
    const u = new URL(`/${projectSlug}/datasets`, window.location.origin);
    u.searchParams.set("agentLab", "1");
    if (datasetId) u.searchParams.set("datasetId", datasetId);
    if (analysisPrefix) u.searchParams.set("labPrefix", analysisPrefix);
    window.location.href = u.toString();
  }
  async function decide(
    dialogueId: string,
    rule: Rule,
    decision: "confirmed" | "disputed" | "unsure",
  ) {
    const key = dialogueId + rule.id;
    const note =
      reviewNotes[key]?.trim() ||
      (decision === "confirmed"
        ? "Проверено владельцем: ответ в показанном разговоре нарушает принятое правило «" +
          rule.text +
          "»."
        : decision === "unsure"
          ? "Владелец не может подтвердить нарушение по доступным данным."
          : "");
    if (!note)
      throw new Error(
        "Чтобы отклонить замечание, укажите в комментарии, почему ответ допустим.",
      );
    setJob(
      await call("/review", projectId, {
        ...base,
        dialogueId,
        ruleId: rule.id,
        decision,
        note,
      }),
    );
  }
  async function promoteFinding(dialogueId: string, rule: Rule) {
    if (latestReview(dialogueId, rule.id)?.decision !== "confirmed")
      await decide(dialogueId, rule, "confirmed");
    const draft = await call<Card>("/propose", projectId, {
      ...base,
      origin: "regression",
      dialogueId,
      ruleIds: [rule.id],
    });
    const saved = await call<Card>("/accept", projectId, {
      ...base,
      cardId: draft.id,
    });
    setRunData(undefined);
    setCard(saved);
    setJob(await call("/analysis/" + job!.id, projectId));
    setStep(4);
  }
  if (!open)
    return (
      <Button size="sm" variant="outline" onClick={entry}>
        <FlaskConical size={15} />
        Разобрать работу агента
      </Button>
    );
  return (
    <Box
      maxWidth="1120px"
      width="full"
      marginX="auto"
      padding={{ base: 4, md: 7 }}
    >
      <HStack
        justifyContent="space-between"
        gap={4}
        marginBottom={5}
        align="start"
      >
        <Box>
          <Text fontSize="2xl" fontWeight="bold">
            Проверка агента
          </Text>
          <Text color="fg.muted" fontSize="sm">
            Логи → правила → ситуации → разговоры с агентом. Все доказательства
            и результаты остаются в LangWatch.
          </Text>
        </Box>
        {job && (
          <Button variant="outline" size="sm" onClick={newAnalysis}>
            Новый разбор
          </Button>
        )}
      </HStack>
      {error && (
        <Box
          role="alert"
          padding={4}
          marginBottom={4}
          background="bg.error"
          color="fg.error"
          borderRadius="lg"
        >
          {error}
        </Box>
      )}
      {job?.workflowError && (
        <Box role="alert" padding={4} marginBottom={4} background="bg.error">
          <Text>{job.workflowError}</Text>
          <Text fontSize="sm">
            Разбор и созданные ситуации сохранены. Проверьте Simulations перед
            повторным запуском.
          </Text>
        </Box>
      )}
      {job && ["interrupted", "failed"].includes(job.status) && (
        <Box padding={4} marginBottom={4} borderWidth="1px" borderRadius="lg">
          <Text>{job.message}</Text>
          <Button
            marginTop={2}
            loading={busy}
            onClick={() =>
              void act(async () => {
                const next = await call<Analysis>("/resume", projectId, base);
                setJob(next);
                setStep(3);
              })
            }
          >
            Продолжить с сохранённого места
          </Button>
        </Box>
      )}
      {job && (
        <HStack
          borderBottomWidth="1px"
          marginBottom={5}
          paddingBottom={3}
          gap={2}
          flexWrap="wrap"
        >
          <Button
            variant={step === 3 || step === 2 ? "solid" : "ghost"}
            colorPalette="blue"
            onClick={() =>
              setStep(
                job.status === "ready" || job.status === "planning" ? 2 : 3,
              )
            }
          >
            Разбор разговоров
          </Button>
          <Button
            variant={step === 4 ? "solid" : "ghost"}
            colorPalette="blue"
            onClick={() => {
              setStep(4);
              if (!card) setCard(job.cards.at(-1));
            }}
          >
            Сохранённые проверки
            {job.cards.length ? " · " + job.cards.length : ""}
          </Button>
          <Badge
            marginLeft="auto"
            colorPalette={
              inProgress ? "blue" : job.status === "done" ? "green" : "gray"
            }
          >
            {stateName(job.status)}
          </Badge>
        </HStack>
      )}
      {(!job || step === 1) && (
        <VStack align="stretch" gap={5}>
          <Paper>
            <Text fontSize="xl" fontWeight="semibold">
              Загрузите разговоры с агентом
            </Text>
            <Text color="fg.muted" fontSize="sm" marginTop={1}>
              Выберите логи и материалы. Lab разберёт обращения, подготовит
              ситуации и проверит подключённого агента.
            </Text>
            <Select
              label="Разговоры"
              value={logs}
              onChange={setLogs}
              items={(catalog?.datasets ?? [])
                .filter(
                  (d) =>
                    d.columnTypes.some((c) =>
                      ["conversation", "Текст"].includes(c.name),
                    ) ||
                    (d.columnTypes.some((c) => c.name === "text") &&
                      d.columnTypes.some((c) =>
                        ["dialogue_id", "Id диалога", "id", "ID"].includes(
                          c.name,
                        ),
                      )),
                )
                .map((d) => ({ id: d.id, name: d.name }))}
            />
            <details style={{ marginTop: 14 }}>
              <summary style={{ cursor: "pointer" }}>
                Загрузить новую выгрузку XLSX
              </summary>
              <Box paddingTop={3}>
                <input
                  aria-label="Файл XLSX"
                  type="file"
                  accept=".xlsx"
                  onChange={(e) => {
                    setFile(e.target.files?.[0]);
                    setSheets(undefined);
                  }}
                />
                {file && (
                  <Button
                    size="sm"
                    marginTop={3}
                    loading={busy}
                    onClick={() => void act(() => xlsx(false))}
                  >
                    Прочитать файл
                  </Button>
                )}
                {sheets && (
                  <Box>
                    <Select
                      label="Лист с разговорами"
                      value={sheet}
                      onChange={setSheet}
                      items={sheets.map((s, i) => ({
                        id: String(i),
                        name: `${s.name} · ${s.rows} разговоров`,
                      }))}
                    />
                    <Button
                      marginTop={3}
                      loading={busy}
                      onClick={() => void act(() => xlsx(true))}
                    >
                      Использовать эту выгрузку
                    </Button>
                  </Box>
                )}
              </Box>
            </details>
            <Box borderTopWidth="1px" marginTop={5} paddingTop={4}>
              <details
                open={!ownerRules.trim() && !Object.keys(materials).length}
              >
                <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                  {ownerRules.trim()
                    ? "Промпт агента подключён · изменить"
                    : "Добавить промпт или правила агента"}
                </summary>
                <Box paddingTop={3}>
                  <Text fontWeight="semibold">
                    По каким правилам должен отвечать агент?
                  </Text>
                  <Text fontSize="sm" color="fg.muted" marginTop={1}>
                    Дайте его промпт или правила работы. Мы предложим критерии,
                    пометим, что они предложены моделью. Любое правило можно
                    проверить и уточнить.
                  </Text>
                  <Label>Файл с промптом или правилами</Label>
                  <input
                    aria-label="Файл с правилами"
                    type="file"
                    accept=".txt,.md"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void f.text().then(setOwnerRules);
                    }}
                  />
                  {ownerRules && (
                    <Text color="green.500" fontSize="sm" marginTop={2}>
                      Правила добавлены ·{" "}
                      {ownerRules.length.toLocaleString("ru-RU")} символов
                    </Text>
                  )}
                  <details style={{ marginTop: 12 }}>
                    <summary style={{ cursor: "pointer" }}>
                      Вставить или изменить текст правил
                    </summary>
                    <Textarea
                      aria-label="Правила или промпт агента"
                      rows={5}
                      marginTop={3}
                      value={ownerRules}
                      onChange={(e) => setOwnerRules(e.target.value)}
                      placeholder="Вставьте промпт вашего агента…"
                    />
                  </details>
                  {!!materialDatasets.length && (
                    <details style={{ marginTop: 12 }}>
                      <summary style={{ cursor: "pointer" }}>
                        Добавить базу знаний или сохранённые правила
                        {Object.keys(materials).length
                          ? " · выбрано " + Object.keys(materials).length
                          : ""}
                      </summary>
                      <VStack align="stretch" gap={3} marginTop={3}>
                        {materialDatasets.map((d) => (
                          <HStack key={d.id}>
                            <label style={{ flex: 1, fontSize: 14 }}>
                              <input
                                type="checkbox"
                                checked={!!materials[d.id]}
                                onChange={(e) =>
                                  setMaterials((old) => {
                                    const n = { ...old };
                                    if (e.target.checked) n[d.id] = "knowledge";
                                    else delete n[d.id];
                                    return n;
                                  })
                                }
                              />{" "}
                              {d.name}
                            </label>
                            {materials[d.id] && (
                              <select
                                aria-label={"Тип материала " + d.name}
                                style={{ ...fieldStyle, width: 180 }}
                                value={materials[d.id]}
                                onChange={(e) =>
                                  setMaterials((old) => ({
                                    ...old,
                                    [d.id]: e.target.value as
                                      "prompt" | "knowledge",
                                  }))
                                }
                              >
                                <option value="knowledge">База знаний</option>
                                <option value="prompt">Правила агента</option>
                              </select>
                            )}
                          </HStack>
                        ))}
                      </VStack>
                    </details>
                  )}
                </Box>
              </details>
            </Box>
            <HStack marginTop={5} align="start" gap={4}>
              <Box flex={1}>
                <Label>Что делает агент</Label>
                <Input
                  aria-label="Что делает агент"
                  value={task}
                  onChange={(e) => setTask(e.target.value)}
                />
              </Box>
              <Box width="145px">
                <Label>Размер выборки</Label>
                <Input
                  aria-label="Число разговоров"
                  type="number"
                  min={1}
                  max={48}
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                />
              </Box>
            </HStack>
            <Box marginTop={5} borderTopWidth="1px" paddingTop={4}>
              <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={runAfter}
                  onChange={(e) => setRunAfter(e.target.checked)}
                />
                <Text fontWeight="semibold">
                  Подготовить ситуации и проверить агента
                </Text>
              </label>
              {runAfter && (
                <HStack align="end" gap={4} flexWrap="wrap" marginTop={3}>
                  <Box flex={1} minWidth="220px">
                    <Select
                      label="Подключённый агент"
                      value={agent}
                      onChange={setAgent}
                      items={catalog?.agents ?? []}
                    />
                  </Box>
                  <Box width="145px">
                    <Label>Повторов ситуации</Label>
                    <Input
                      aria-label="Повторов ситуации"
                      type="number"
                      min={1}
                      max={10}
                      value={repeats}
                      onChange={(e) => setRepeats(Number(e.target.value))}
                    />
                  </Box>
                </HStack>
              )}
              {runAfter && !catalog?.agents.length && (
                <Text fontSize="sm" marginTop={2}>
                  Добавьте HTTP агента в{" "}
                  <a href={`/${projectSlug}/agents`}>Agents LangWatch</a> или
                  снимите флажок, чтобы разобрать только логи.
                </Text>
              )}
              <Text color="fg.muted" fontSize="xs" marginTop={2}>
                Разбор и симуляции используют настроенные модели. Подтверждение
                ошибок владельцем учитывается отдельно от выводов модели.
              </Text>
            </Box>
            <details style={{ marginTop: 15 }}>
              <summary style={{ cursor: "pointer" }}>Настройки анализа</summary>
              <Select
                label="Модель анализа"
                value={model}
                onChange={setModel}
                items={(catalog?.models ?? []).map((id) => ({ id, name: id }))}
              />
              <HStack gap={3}>
                <Select
                  label="Колонка ID разговора"
                  value={idColumn}
                  onChange={setIdColumn}
                  items={(
                    catalog?.datasets.find((d) => d.id === logs)?.columnTypes ??
                    []
                  ).map((c) => ({ id: c.name, name: c.name }))}
                />
                <Select
                  label="Колонка текста"
                  value={textColumn}
                  onChange={setTextColumn}
                  items={(
                    catalog?.datasets.find((d) => d.id === logs)?.columnTypes ??
                    []
                  ).map((c) => ({ id: c.name, name: c.name }))}
                />
              </HStack>
            </details>
            <Button
              marginTop={5}
              colorPalette="blue"
              size="lg"
              loading={busy}
              disabled={
                !logs ||
                !model ||
                (runAfter &&
                  (!agent ||
                    !Number.isInteger(repeats) ||
                    repeats < 1 ||
                    repeats > 10)) ||
                (!ownerRules.trim() && !Object.keys(materials).length)
              }
              onClick={() =>
                void act(async () => {
                  const next = await call<Analysis>("/plan", projectId, {
                    datasetId: logs,
                    textColumn,
                    idColumn,
                    task,
                    ownerRules,
                    count,
                    model,
                    autoEvaluate: true,
                    purpose: runAfter ? "verify" : "discover",
                    ...(runAfter
                      ? { agentId: agent, repeatCount: repeats }
                      : {}),
                    materials: Object.entries(materials).map(
                      ([datasetId, kind]) => ({ datasetId, kind }),
                    ),
                  });
                  setJob(next);
                  setStep(3);
                  url(next);
                })
              }
            >
              {runAfter
                ? "Проверить агента от начала до результата"
                : "Разобрать только логи"}
              <ArrowRight size={17} />
            </Button>
            <Text fontSize="xs" color="fg.muted" marginTop={2}>
              Подготовим ситуации из {count} разговоров
              {runAfter
                ? `, затем запустим по ${repeats} попытке каждой готовой ситуации`
                : ""}
              . Закрытие вкладки не остановит работу. Тексты и выбранные
              материалы будут переданы вашей настроенной модели.
            </Text>
          </Paper>
          {!!catalog?.jobs.length && (
            <Paper>
              <Text fontWeight="semibold" marginBottom={3}>
                Предыдущие разборы
              </Text>
              {catalog.jobs.map((j) => (
                <Button
                  key={j.id}
                  variant="ghost"
                  width="full"
                  height="auto"
                  padding={3}
                  justifyContent="space-between"
                  onClick={() => void act(() => load(j.id))}
                >
                  <Text textAlign="left" whiteSpace="normal">
                    {j.name
                      .replace(/^Анализ · /, "")
                      .replace(/^Перенесённый разбор · /, "")}
                  </Text>
                  <Badge>
                    {stateName(j.status)} · {j.processed}/{j.selected}
                  </Badge>
                </Button>
              ))}
            </Paper>
          )}
        </VStack>
      )}
      {step === 2 && job && (
        <VStack align="stretch" gap={4}>
          <Box>
            <Text fontSize="xl" fontWeight="semibold">
              Проверьте правила перед анализом
            </Text>
            <Text fontSize="sm" color="fg.muted" marginTop={1}>
              Отметьте требования, которые относятся к этому агенту. Затем мы
              проверим его реальные ответы.
            </Text>
          </Box>
          {job.status === "planning" && (
            <Paper>
              <HStack>
                <Spinner />
                <Text>Читаем разговоры и готовим правила…</Text>
              </HStack>
            </Paper>
          )}
          {job.error && <Text color="fg.error">{job.error}</Text>}
          {job.knowledgeGap && (
            <Text fontSize="sm" color="fg.muted">
              {job.knowledgeGap}
            </Text>
          )}
          {job.topics.map((topic) => (
            <Paper key={topic.id}>
              <Text fontWeight="semibold">
                {topic.title} · {topic.dialogueIds.length} разговоров
              </Text>
              {topic.gap && (
                <Text fontSize="sm" color="fg.muted" marginTop={2}>
                  {topic.gap}
                </Text>
              )}
              {topic.rules.map((rule) => (
                <Box
                  key={rule.id}
                  marginTop={4}
                  borderTopWidth="1px"
                  paddingTop={4}
                >
                  <label
                    style={{ display: "flex", gap: 10, alignItems: "start" }}
                  >
                    <input
                      type="checkbox"
                      style={{ marginTop: 5 }}
                      disabled={job.status !== "ready"}
                      checked={rule.approved}
                      onChange={(e) =>
                        updateRule(rule.id, { approved: e.target.checked })
                      }
                    />
                    <span>{rule.text}</span>
                  </label>
                  <Text fontSize="sm" color="fg.muted" marginTop={2}>
                    Когда: {rule.condition}
                  </Text>
                  <details style={{ marginTop: 10 }}>
                    <summary style={{ cursor: "pointer", fontSize: 14 }}>
                      Основание и условия правила
                    </summary>
                    <Box
                      background="bg.muted"
                      borderRadius="md"
                      padding={3}
                      marginTop={3}
                    >
                      <Text fontSize="sm">«{rule.quote}»</Text>
                      <Text fontSize="xs" color="fg.muted" marginTop={2}>
                        {job.sources.find((s) => s.id === rule.sourceId)?.name}
                      </Text>
                    </Box>
                    <Label>Ожидание</Label>
                    <Textarea
                      aria-label={"Ожидание " + rule.id}
                      value={rule.text}
                      rows={2}
                      disabled={job.status !== "ready"}
                      onChange={(e) =>
                        updateRule(rule.id, { text: e.target.value })
                      }
                    />
                    <Label>Когда применяется</Label>
                    <Textarea
                      aria-label={"Условие " + rule.id}
                      value={rule.condition}
                      rows={2}
                      disabled={job.status !== "ready"}
                      onChange={(e) =>
                        updateRule(rule.id, { condition: e.target.value })
                      }
                    />
                    <Label>Допустимые ответы и исключения</Label>
                    <Textarea
                      aria-label={"Исключения " + rule.id}
                      value={rule.acceptable}
                      rows={2}
                      disabled={job.status !== "ready"}
                      onChange={(e) =>
                        updateRule(rule.id, { acceptable: e.target.value })
                      }
                    />
                  </details>
                </Box>
              ))}
            </Paper>
          ))}
          {job.status === "ready" && (
            <Paper>
              <Button
                colorPalette="blue"
                size="lg"
                disabled={!approved.length}
                loading={busy}
                onClick={() =>
                  void act(async () => {
                    await approve();
                    setJob(await call("/evaluate", projectId, base));
                    setStep(3);
                  })
                }
              >
                Проверить {job.selected} разговоров по выбранным правилам
              </Button>
              <Text fontSize="sm" color="fg.muted" marginTop={3}>
                Или сразу создайте проверки из обычных обращений, если разбор
                ошибок сейчас не нужен.
              </Text>
              <Button
                variant="ghost"
                marginTop={1}
                disabled={!approved.length}
                loading={busy}
                onClick={() =>
                  void act(async () => {
                    await approve();
                    setStep(3);
                  })
                }
              >
                Создать проверки без оценки логов
              </Button>
            </Paper>
          )}
        </VStack>
      )}
      {step === 3 && job && (
        <VStack align="stretch" gap={5}>
          <Box>
            <Text fontSize="xl" fontWeight="semibold">
              Что стоит проверить
            </Text>
            <Text color="fg.muted" fontSize="sm" marginTop={1}>
              Проверено {job.processed} из {job.selected} выбранных разговоров.
              В исходном наборе — {job.total}. Замечания нужно подтвердить по
              примерам.
            </Text>
          </Box>
          {inProgress && (
            <Paper>
              <HStack>
                <Spinner size="sm" />
                <Text>
                  {job.status === "planning"
                    ? "Находим темы и правила…"
                    : "Проверяем реальные ответы · " +
                      job.processed +
                      "/" +
                      job.selected}
                </Text>
              </HStack>
            </Paper>
          )}
          {job.status === "interrupted" && (
            <Paper>
              <Text>Разбор прервался. Готовые оценки сохранены.</Text>
              {!!approved.length && (
                <Button
                  marginTop={3}
                  colorPalette="blue"
                  loading={busy}
                  onClick={() =>
                    void act(async () =>
                      setJob(await call("/evaluate", projectId, base)),
                    )
                  }
                >
                  Продолжить разбор
                </Button>
              )}
            </Paper>
          )}
          <HStack align="stretch" gap={3} flexWrap="wrap">
            {[
              {
                n: new Set(patterns.map((p) => p.result.dialogueId)).size,
                label: "Разговоров с замечаниями",
                color: "orange.500",
              },
              { n: confirmed, label: "Подтверждённых замечаний", color: "fg" },
              {
                n: health.reduce((n, t) => n + t.unknown, 0),
                label: "Разговоров без достаточных данных",
                color: "fg.muted",
              },
            ].map((item) => (
              <Box
                key={item.label}
                flex={1}
                minWidth="180px"
                borderWidth="1px"
                borderRadius="lg"
                padding={4}
              >
                <Text fontSize="3xl" fontWeight="bold" color={item.color}>
                  {item.n}
                </Text>
                <Text fontSize="sm" color="fg.muted">
                  {item.label}
                </Text>
              </Box>
            ))}
          </HStack>
          {!groups.length && !inProgress && (
            <Paper>
              <Text fontWeight="semibold">
                {job.results.length
                  ? "Подтверждённых оснований для замечаний пока нет"
                  : "Сначала выберите правила и запустите разбор"}
              </Text>
              <Text fontSize="sm" color="fg.muted" marginTop={2}>
                Это не доказывает, что агент справляется со всеми запросами.
                Ниже можно сохранить обычные ситуации для проверки.
              </Text>
            </Paper>
          )}
          {groups.map((group) => (
            <Paper key={group.ruleId}>
              <HStack align="start" justifyContent="space-between">
                <Box>
                  <Text fontSize="lg" fontWeight="semibold">
                    {group.items[0]!.verdict.title || group.items[0]!.rule.text}
                  </Text>
                  <Text fontSize="sm" color="fg.muted" marginTop={1}>
                    {group.items.length}{" "}
                    {group.items.length === 1 ? "пример" : "примеров"} в
                    выбранных разговорах
                  </Text>
                </Box>
                <Badge colorPalette="orange">Замечание</Badge>
              </HStack>
              {group.items.map(({ result, verdict, rule }) => {
                const review = latestReview(result.dialogueId, rule.id);
                const ref = result.dialogueId + rule.id;
                const dialogue = job.dialogues.find(
                  (d) => d.id === result.dialogueId,
                );
                const customerTurns = dialogue
                  ? dialogue.text.match(/CLIENT\s+([\s\S]*?)(?=\bAGENT\b|$)/gi)
                  : [];
                return (
                  <Box
                    key={ref}
                    marginTop={4}
                    borderTopWidth="1px"
                    paddingTop={4}
                  >
                    <Text fontSize="sm" color="fg.muted">
                      {review?.decision === "confirmed"
                        ? "Вы подтвердили ошибку"
                        : review?.decision === "disputed"
                          ? "Вы отметили ответ как допустимый"
                          : review?.decision === "unsure"
                            ? "Не хватает данных для решения"
                            : "Посмотрите ответ и решите, нарушено ли правило"}
                    </Text>
                    <Box
                      background="bg.muted"
                      borderRadius="lg"
                      padding={4}
                      marginTop={3}
                    >
                      <Text
                        fontSize="xs"
                        fontWeight="semibold"
                        color="fg.muted"
                      >
                        КЛИЕНТ
                      </Text>
                      <Text marginTop={1}>
                        {(customerTurns?.length
                          ? [
                              ...new Set(
                                [customerTurns[0]!, customerTurns.at(-1)!].map(
                                  (t) => t.replace(/^CLIENT\s+/i, ""),
                                ),
                              ),
                            ].join(" → ")
                          : undefined) ?? "Вопрос в исходном разговоре"}
                      </Text>
                      <Text
                        fontSize="xs"
                        fontWeight="semibold"
                        color="fg.muted"
                        marginTop={4}
                      >
                        ОТВЕТ АГЕНТА
                      </Text>
                      <Text marginTop={1}>«{verdict.agentQuote}»</Text>
                    </Box>
                    <Text marginTop={3} fontSize="sm">
                      {verdict.reason}
                    </Text>
                    <details style={{ marginTop: 12 }}>
                      <summary style={{ cursor: "pointer", fontSize: 14 }}>
                        Правило и полный разговор
                      </summary>
                      <Box padding={3} marginTop={2}>
                        <Text fontSize="sm" fontWeight="medium">
                          Правило: {rule.text}
                        </Text>
                        <Text fontSize="sm" color="fg.muted" marginTop={2}>
                          «{rule.quote}»
                        </Text>
                        <Text fontSize="sm" whiteSpace="pre-wrap" marginTop={4}>
                          {dialogue?.text}
                        </Text>
                        <Textarea
                          aria-label={"Комментарий " + ref}
                          rows={2}
                          marginTop={3}
                          placeholder="Комментарий к решению — обязателен, если ответ допустим"
                          value={reviewNotes[ref] ?? review?.note ?? ""}
                          onChange={(e) =>
                            setReviewNotes((n) => ({
                              ...n,
                              [ref]: e.target.value,
                            }))
                          }
                        />
                      </Box>
                    </details>
                    <HStack marginTop={4} gap={2} flexWrap="wrap">
                      {review?.decision === "confirmed" ? (
                        <Button
                          colorPalette="blue"
                          loading={busy}
                          onClick={() =>
                            void act(() =>
                              promoteFinding(result.dialogueId, rule),
                            )
                          }
                        >
                          Открыть сохранённую проверку
                          <ArrowRight size={15} />
                        </Button>
                      ) : (
                        <Button
                          colorPalette="blue"
                          disabled={busy || job.status !== "done"}
                          onClick={() =>
                            void act(() =>
                              promoteFinding(result.dialogueId, rule),
                            )
                          }
                        >
                          Подтвердить и сохранить проверку
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || job.status !== "done"}
                        onClick={() =>
                          void act(() =>
                            decide(result.dialogueId, rule, "disputed"),
                          )
                        }
                      >
                        Ответ допустим
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy || job.status !== "done"}
                        onClick={() =>
                          void act(() =>
                            decide(result.dialogueId, rule, "unsure"),
                          )
                        }
                      >
                        Не хватает данных
                      </Button>
                    </HStack>
                  </Box>
                );
              })}
            </Paper>
          ))}
          {job.autoEvaluate ? (
            <Paper>
              <Text fontWeight="semibold">
                {inProgress
                  ? "Проверки появятся после анализа"
                  : "Проверки готовы к запуску"}
              </Text>
              <Text fontSize="sm" color="fg.muted" marginTop={2}>
                Готово к запуску:{" "}
                {job.cards.filter((c) => c.status === "saved").length}. Ситуации
                из логов и новые варианты сохраняются автоматически. Замечания
                добавляются после вашего подтверждения.
              </Text>
              <Button
                marginTop={3}
                colorPalette="blue"
                disabled={
                  inProgress || !job.cards.some((c) => c.status === "saved")
                }
                onClick={() => {
                  setStep(4);
                  setCard(job.cards.find((c) => c.status === "saved"));
                  setRunData(undefined);
                }}
              >
                Перейти к проверке агента
                <ArrowRight size={15} />
              </Button>
              <details style={{ marginTop: 14 }}>
                <summary style={{ cursor: "pointer", fontSize: 14 }}>
                  Добавить синтетическую ситуацию
                </summary>
                <Select
                  label="Тема новой ситуации"
                  value={
                    syntheticTopicId ||
                    job.topics.find((t) => t.rules.some((r) => r.approved))
                      ?.id ||
                    ""
                  }
                  onChange={setSyntheticTopicId}
                  items={job.topics
                    .filter((t) => t.rules.some((r) => r.approved))
                    .map((t) => ({ id: t.id, name: t.title }))}
                />
                <Button
                  marginTop={3}
                  disabled={busy || inProgress || !approved.length}
                  loading={busy}
                  onClick={() =>
                    void act(() =>
                      propose(
                        "synthetic",
                        undefined,
                        (
                          job.topics.find((t) => t.id === syntheticTopicId) ??
                          job.topics.find((t) =>
                            t.rules.some((r) => r.approved),
                          )
                        )?.rules
                          .filter((r) => r.approved)
                          .map((r) => r.id),
                      ),
                    )
                  }
                >
                  Создать новую проверку
                </Button>
              </details>
            </Paper>
          ) : (
            <Paper>
              <Text fontWeight="semibold">Проверяйте и обычные обращения</Text>
              <Text fontSize="sm" color="fg.muted" marginTop={2}>
                Сохраните ситуацию из логов или создайте новую по правилам.
                Затем запустите на ней своего агента.
              </Text>
              <Select
                label="Обращение клиента"
                value={ordinaryId}
                onChange={setOrdinaryId}
                items={ordinary.map((d) => ({
                  id: d.id,
                  name:
                    (job.topics.find((t) => t.id === d.topicId)?.title ??
                      "Обращение") +
                    " · " +
                    d.id.slice(0, 8),
                }))}
              />
              <Button
                marginTop={3}
                variant="outline"
                disabled={!ordinaryId || busy}
                onClick={() =>
                  void act(() =>
                    propose(
                      "coverage",
                      ordinaryId,
                      job.topics
                        .find(
                          (t) =>
                            t.id ===
                            ordinary.find((d) => d.id === ordinaryId)?.topicId,
                        )
                        ?.rules.filter((r) => r.approved)
                        .map((r) => r.id),
                    ),
                  )
                }
              >
                Создать проверку из обращения
              </Button>
              <details style={{ marginTop: 18 }}>
                <summary style={{ cursor: "pointer" }}>
                  Создать новую ситуацию по правилам
                </summary>
                <Select
                  label="Тема новой ситуации"
                  value={
                    syntheticTopicId ||
                    job.topics.find((t) => t.rules.some((r) => r.approved))
                      ?.id ||
                    ""
                  }
                  onChange={setSyntheticTopicId}
                  items={job.topics
                    .filter((t) => t.rules.some((r) => r.approved))
                    .map((t) => ({ id: t.id, name: t.title }))}
                />
                <Button
                  marginTop={3}
                  loading={busy}
                  disabled={
                    !approved.length || !["ready", "done"].includes(job.status)
                  }
                  onClick={() =>
                    void act(() =>
                      propose(
                        "synthetic",
                        undefined,
                        (
                          job.topics.find((t) => t.id === syntheticTopicId) ??
                          job.topics.find((t) =>
                            t.rules.some((r) => r.approved),
                          )
                        )?.rules
                          .filter((r) => r.approved)
                          .map((r) => r.id),
                      ),
                    )
                  }
                >
                  Создать новую проверку
                </Button>
              </details>
            </Paper>
          )}
          <details>
            <summary
              style={{
                cursor: "pointer",
                color: "var(--chakra-colors-fg-muted)",
                fontSize: 14,
              }}
            >
              Правила, результаты и настройки разбора
            </summary>
            <Box padding={4} fontSize="sm">
              <Text>
                Модель: {job.model} · проверено {job.processed}/{job.selected} ·
                запросов к модели: {job.calls}
              </Text>
              {job.knowledgeGap && (
                <Text marginTop={2}>{job.knowledgeGap}</Text>
              )}
              {job.exportError && (
                <Text color="fg.error">{job.exportError}</Text>
              )}
              {job.experimentSlug && (
                <a href={`/${projectSlug}/experiments/${job.experimentSlug}`}>
                  Таблица оценок в LangWatch ↗
                </a>
              )}
              {health.map((t) => (
                <Text key={t.id} marginTop={2}>
                  {t.title}: {t.passed} без замечаний, {t.failed} с замечаниями,{" "}
                  {t.unknown} без достаточных данных
                </Text>
              ))}
              {job.results.map((r) => (
                <Box
                  key={r.dialogueId}
                  marginTop={3}
                  borderTopWidth="1px"
                  paddingTop={3}
                >
                  <Text color="fg.muted">Разговор {r.dialogueId}</Text>
                  {r.rules.map((v) => (
                    <Text key={v.ruleId}>
                      {
                        {
                          PASS: "Правило соблюдено",
                          FAIL: "Замечание",
                          UNKNOWN: "Недостаточно данных",
                          NOT_APPLICABLE: "Правило не применялось",
                        }[v.status]
                      }{" "}
                      · {v.reason}
                    </Text>
                  ))}
                </Box>
              ))}
            </Box>
          </details>
        </VStack>
      )}
      {step === 4 && job && (
        <VStack gap={5} align="stretch">
          {!!job.cards.filter((c) => c.status === "saved").length && (
            <Paper>
              <HStack gap={4} align="end" flexWrap="wrap">
                <Box flex={1} minWidth="200px">
                  <Select
                    label="Ваш агент"
                    value={agent}
                    onChange={setAgent}
                    items={catalog?.agents ?? []}
                  />
                </Box>
                <Box width="120px">
                  <Label>Повторов</Label>
                  <Input
                    aria-label="Повторов в прогоне"
                    type="number"
                    min={1}
                    max={10}
                    value={repeats}
                    onChange={(e) => setRepeats(Number(e.target.value))}
                  />
                </Box>
                <Button
                  colorPalette="blue"
                  size="lg"
                  loading={busy}
                  disabled={
                    !agent ||
                    !!batchProgress?.summary?.pending ||
                    ["dispatching", "dispatch_unknown"].includes(
                      batchProgress?.batch?.status,
                    )
                  }
                  onClick={() =>
                    void act(async () => {
                      await call("/run-all", projectId, {
                        ...base,
                        agentId: agent,
                        note: note.slice(0, 200),
                        repeatCount: repeats,
                      });
                      const next = await call<Analysis>(
                        "/analysis/" + job.id,
                        projectId,
                      );
                      setJob(next);
                      setCard(next.cards.find((c) => c.status === "saved"));
                      setRunData(undefined);
                    })
                  }
                >
                  Проверить агента на{" "}
                  {job.cards.filter((c) => c.status === "saved").length}{" "}
                  {job.cards.filter((c) => c.status === "saved").length % 10 ===
                    1 &&
                  job.cards.filter((c) => c.status === "saved").length % 100 !==
                    11
                    ? "ситуации"
                    : "ситуациях"}
                </Button>
              </HStack>
              <Text fontSize="xs" color="fg.muted" marginTop={2}>
                Запустим готовые проверки. Неподтверждённые замечания в этот
                прогон не попадут.
              </Text>
            </Paper>
          )}

          {(!!suiteResults.length || batchProgress?.batch) && (
            <Paper>
              <Text fontWeight="semibold">Результат прогона</Text>
              {batchProgress?.summary && (
                <Box marginY={3}>
                  <Text>
                    Измерено {batchProgress.summary.measured} из{" "}
                    {batchProgress.summary.planned} запланированных попыток ·{" "}
                    {batchProgress.batch.repeatCount} повтор(а) каждой ситуации.
                  </Text>
                  {!!batchProgress.summary.schedulingUnknown && (
                    <Text color="fg.error">
                      Отправка {batchProgress.summary.schedulingUnknown} попыток
                      не подтверждена. Они могут выполняться: сначала сверьте
                      Simulations.
                    </Text>
                  )}
                  {!!batchProgress.summary.notScheduled && (
                    <Text color="fg.error">
                      Не поставлено в очередь:{" "}
                      {batchProgress.summary.notScheduled}. Эти попытки не
                      считаются успешными.
                    </Text>
                  )}
                  <Text fontSize="sm" color="fg.muted">
                    Оценка относится только к этому набору. Судья и поведение
                    синтетического клиента ещё требуют сверки с человеком.
                  </Text>
                  <a href={`/${projectSlug}/simulations`}>
                    Все разговоры и оценки в Simulations ↗
                  </a>
                </Box>
              )}
              {batchProgress?.batch?.error && (
                <Text color="fg.error">{batchProgress.batch.error}</Text>
              )}
              <HStack gap={4} flexWrap="wrap" marginTop={2}>
                <Text fontSize="sm">
                  Пройдены:{" "}
                  {suiteResults.filter((r) => r.status === "SUCCESS").length}
                </Text>
                <Text fontSize="sm">
                  Не пройдены:{" "}
                  {suiteResults.filter((r) => r.status === "FAILED").length}
                </Text>
                <Text fontSize="sm">
                  Ошибки запуска:{" "}
                  {suiteResults.filter((r) => r.status === "ERROR").length}
                </Text>
                <Text fontSize="sm">
                  В работе:{" "}
                  {
                    suiteResults.filter((r) =>
                      ["QUEUED", "PENDING", "IN_PROGRESS"].includes(r.status),
                    ).length
                  }
                </Text>
              </HStack>
              {suiteResults.map((row) => (
                <HStack
                  key={row.runId || row.cardId}
                  justifyContent="space-between"
                  align="start"
                  paddingY={3}
                  borderBottomWidth="1px"
                >
                  <Box flex={1}>
                    <Text fontSize="sm">{row.name}</Text>
                    <Text fontSize="xs" color="fg.muted" marginTop={1}>
                      {runName(row.status)}
                    </Text>
                  </Box>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setCard(job.cards.find((c) => c.id === row.cardId));
                      setRunData(undefined);
                    }}
                  >
                    Результат
                  </Button>
                </HStack>
              ))}
            </Paper>
          )}
          <Box>
            <Text fontSize="xl" fontWeight="semibold">
              Сохранённые проверки
            </Text>
            <Text fontSize="sm" color="fg.muted" marginTop={1}>
              Каждая проверка — ситуация клиента и ожидаемое поведение агента.
              Запустите её снова после изменения агента.
            </Text>
          </Box>
          {!job.cards.length && (
            <Paper>
              <Text>Проверок пока нет.</Text>
              <Button
                marginTop={3}
                colorPalette="blue"
                onClick={() => setStep(3)}
              >
                Создать из разговоров
              </Button>
            </Paper>
          )}
          {!!job.cards.length && (
            <HStack align="stretch" gap={3} flexWrap="wrap">
              {job.cards.map((c) => (
                <Box
                  key={c.id}
                  flex={1}
                  minWidth="210px"
                  borderWidth="1px"
                  borderColor={card?.id === c.id ? "blue.500" : "border"}
                  borderRadius="lg"
                  padding={4}
                  background={card?.id === c.id ? "bg.muted" : "bg"}
                >
                  <Text fontSize="xs" color="fg.muted">
                    {originName(c.origin)}
                  </Text>
                  <Text fontWeight="semibold" marginTop={2}>
                    {c.name}
                  </Text>
                  <Text fontSize="xs" color="fg.muted" marginTop={2}>
                    {c.status === "saved" ? "Сохранена" : "Черновик"}
                    {c.runs.length ? " · прогонов " + c.runs.length : ""}
                  </Text>
                  <Button
                    size="sm"
                    variant="ghost"
                    marginTop={2}
                    onClick={() => {
                      setCard(c);
                      setRunData(undefined);
                    }}
                  >
                    Открыть
                  </Button>
                </Box>
              ))}
            </HStack>
          )}
          {card && (
            <Paper>
              <HStack justifyContent="space-between">
                <Text fontSize="lg" fontWeight="semibold">
                  {card.name}
                </Text>
                <Badge>
                  {card.status === "saved"
                    ? "Готова к запуску"
                    : "Предложенная проверка"}
                </Badge>
              </HStack>
              <Text fontSize="sm" color="fg.muted" marginTop={2}>
                {originName(card.origin)}
              </Text>
              <Box
                background="bg.muted"
                borderRadius="lg"
                padding={4}
                marginTop={4}
              >
                <Text fontSize="xs" fontWeight="semibold" color="fg.muted">
                  СИТУАЦИЯ КЛИЕНТА
                </Text>
                <Text whiteSpace="pre-wrap" marginTop={2}>
                  {card.situation}
                </Text>
                <Text
                  fontSize="xs"
                  fontWeight="semibold"
                  color="fg.muted"
                  marginTop={4}
                >
                  ЧТО ПРОВЕРЯЕМ
                </Text>
                {card.criteria.map((criterion, i) => (
                  <Text
                    key={i}
                    fontSize="sm"
                    whiteSpace="pre-wrap"
                    marginTop={2}
                  >
                    {criterion}
                  </Text>
                ))}
              </Box>
              {card.status === "saved" && card.origin === "regression" && card.approvalState !== "confirmed" && (
                <Box marginTop={3} borderWidth="1px" borderRadius="md" padding={3}>
                  <Text fontSize="sm">{card.approvalState === "stale" ? "Условия изменены в LangWatch. Подтверждение относится к прошлой версии." : "Эта версия условий ещё не подтверждена владельцем."} Прогон проверит текущую версию.</Text>
                  <Button marginTop={2} size="sm" loading={busy} onClick={() => void act(async () => {
                    await call("/accept", projectId, {...base, cardId: card.id});
                    const refreshed = await call<Analysis>("/analysis/" + job.id, projectId);
                    setJob(refreshed); setCard(refreshed.cards.find(c => c.id === card.id));
                  })}>Подтвердить текущие условия</Button>
                </Box>
              )}
              {card.status === "draft" && (
                <details style={{ marginTop: 14 }}>
                  <summary style={{ cursor: "pointer" }}>
                    Изменить черновик
                  </summary>
                  <Label>Название</Label>
                  <Input
                    aria-label="Название проверки"
                    value={card.name}
                    onChange={(e) => setCard({ ...card, name: e.target.value })}
                  />
                  <Label>Ситуация клиента</Label>
                  <Textarea
                    aria-label="Ситуация клиента"
                    rows={5}
                    value={card.situation}
                    onChange={(e) =>
                      setCard({ ...card, situation: e.target.value })
                    }
                  />
                  {card.criteria.map((criterion, i) => (
                    <Box key={i}>
                      <Label>Критерий {i + 1}</Label>
                      <Textarea
                        aria-label={"Критерий проверки " + (i + 1)}
                        rows={3}
                        value={criterion}
                        onChange={(e) =>
                          setCard({
                            ...card,
                            criteria: card.criteria.map((v, n) =>
                              n === i ? e.target.value : v,
                            ),
                          })
                        }
                      />
                    </Box>
                  ))}
                </details>
              )}
              {card.status === "draft" ? (
                <Button
                  marginTop={4}
                  colorPalette="blue"
                  loading={busy}
                  onClick={() =>
                    void act(async () => {
                      if (card.origin === "regression" && card.dialogueId) {
                        for (const ruleId of card.ruleIds) {
                          const rule = job.topics
                            .flatMap((t) => t.rules)
                            .find((r) => r.id === ruleId);
                          if (
                            rule &&
                            latestReview(card.dialogueId, ruleId)?.decision !==
                              "confirmed"
                          )
                            await decide(card.dialogueId, rule, "confirmed");
                        }
                      }
                      await call("/card", projectId, {
                        ...base,
                        cardId: card.id,
                        name: card.name,
                        situation: card.situation,
                        criteria: card.criteria,
                      });
                      setCard(
                        await call("/accept", projectId, {
                          ...base,
                          cardId: card.id,
                        }),
                      );
                      setJob(await call("/analysis/" + job.id, projectId));
                    })
                  }
                >
                  {card.origin === "regression"
                    ? "Подтвердить и сохранить проверку"
                    : "Сохранить проверку"}
                </Button>
              ) : (
                <Box marginTop={4} borderTopWidth="1px" paddingTop={4}>
                  <Select
                    label="Какого агента проверяем"
                    value={agent}
                    onChange={setAgent}
                    items={catalog?.agents ?? []}
                  />
                  <details style={{ marginTop: 12 }}>
                    <summary style={{ cursor: "pointer", fontSize: 14 }}>
                      Версия агента и редактор проверки
                    </summary>
                    <Input
                      aria-label="Версия агента"
                      marginTop={3}
                      value={note}
                      placeholder="Например: текущая версия или номер сборки"
                      onChange={(e) => setNote(e.target.value)}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      marginTop={2}
                      onClick={() => nativeScenario(card.scenarioId!)}
                    >
                      Изменить в редакторе LangWatch ↗
                    </Button>
                  </details>
                  <Button
                    marginTop={4}
                    size="lg"
                    colorPalette="blue"
                    loading={busy}
                    disabled={
                      !agent ||
                      runData?.runs?.some((r: any) =>
                        ["QUEUED", "PENDING", "IN_PROGRESS"].includes(
                          r.data.status,
                        ),
                      )
                    }
                    onClick={() =>
                      void act(async () => {
                        await call("/run", projectId, {
                          ...base,
                          cardId: card.id,
                          agentId: agent,
                          note: note.slice(0, 200),
                        });
                        const next = await call<Analysis>(
                          "/analysis/" + job.id,
                          projectId,
                        );
                        setJob(next);
                        setCard(next.cards.find((c) => c.id === card.id));
                      })
                    }
                  >
                    <Play size={16} />
                    Проверить агента
                  </Button>
                  <Text fontSize="xs" color="fg.muted" marginTop={2}>
                    Симулятор сыграет клиента и отправит сообщения настоящему
                    агенту.
                  </Text>
                </Box>
              )}
            </Paper>
          )}
          {runData?.comparison && (
            <Paper>
              <Text fontWeight="semibold">Что изменилось между прогонами</Text>
              <Text marginTop={2}>{runData.comparison.verdict}</Text>
              <Text fontSize="sm" color="fg.muted" marginTop={2}>
                {runData.comparison.limitation}
              </Text>
            </Paper>
          )}
          {runData?.runs?.map((run: any) => (
            <Paper key={run.id}>
              <HStack justifyContent="space-between" align="start">
                <Box>
                  <Text
                    fontSize="lg"
                    fontWeight="semibold"
                    color={
                      run.data.status === "FAILED"
                        ? "orange.500"
                        : run.data.status === "SUCCESS"
                          ? "green.500"
                          : "fg"
                    }
                  >
                    {runName(run.data.status)}
                  </Text>
                  <Text fontSize="xs" color="fg.muted" marginTop={1}>
                    {new Date(run.at).toLocaleString("ru-RU")}
                    {run.note ? " · " + run.note : ""}
                  </Text>
                </Box>
                <a
                  href={`/${projectSlug}/simulations?drawer.open=scenarioRunDetail&drawer.scenarioRunId=${run.id}`}
                >
                  Полный результат ↗
                </a>
              </HStack>
              <Text marginTop={3}>
                {run.data.results?.reasoning ??
                  "Ожидаем результат разговора с агентом…"}
              </Text>
              <details style={{ marginTop: 15 }}>
                <summary style={{ cursor: "pointer" }}>
                  Посмотреть разговор · {run.data.messages?.length ?? 0} реплик
                </summary>
                {run.data.messages?.map((m: any, i: number) => (
                  <Box
                    key={m.id ?? i}
                    borderLeftWidth="3px"
                    borderColor={m.role === "user" ? "blue.500" : "border"}
                    padding={3}
                    marginTop={3}
                    background="bg.muted"
                  >
                    <Text fontSize="xs" fontWeight="semibold" color="fg.muted">
                      {m.role === "user" ? "Клиент-симулятор" : "Ваш агент"}
                    </Text>
                    <Text whiteSpace="pre-wrap" fontSize="sm" marginTop={1}>
                      {typeof m.content === "string"
                        ? m.content
                        : JSON.stringify(m.content)}
                    </Text>
                  </Box>
                ))}
                <Text fontSize="xs" color="fg.muted" marginTop={3}>
                  Модель клиента: {run.simulatorModel ?? "не сохранена"} ·
                  модель оценки: {run.judgeModel ?? "не сохранена"}
                </Text>
              </details>
            </Paper>
          ))}
        </VStack>
      )}
    </Box>
  );
}
