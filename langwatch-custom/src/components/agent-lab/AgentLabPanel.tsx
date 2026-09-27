import {
  Badge,
  Box,
  Button,
  HStack,
  Input,
  Text,
  Textarea,
  VStack,
  Drawer,
  Portal,
  Spinner,
} from "@chakra-ui/react";
import { FlaskConical, FileText, ArrowRight, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router";
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
  const [ordinaryId, setOrdinaryId] = useState("");
  const [syntheticTopicId, setSyntheticTopicId] = useState("");
  const [runData, setRunData] = useState<any>();
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
    setAgent((a) => a || next.agents[0]?.id || "");
    setLogs(
      (value) =>
        value ||
        next.datasets.find((d) =>
          d.columnTypes?.some((c) =>
            ["conversation", "Текст"].includes(c.name),
          ),
        )?.id ||
        "",
    );
    return next;
  }
  async function load(id: string) {
    const next = await call<Analysis>("/analysis/" + id, projectId);
    setJob(next);
    setLogs(next.datasetId);
    setOwnerRules(next.ownerRules);
    setTask(next.task);
    setCount(next.selected);
    setMaterials(
      Object.fromEntries(
        next.materialRefs.map((ref) => [ref.datasetId, ref.kind]),
      ),
    );
    if (!next.model.startsWith("historical/")) setModel(next.model);
    setCard(undefined);
    setRunData(undefined);
    setStep(["ready", "planning", "failed"].includes(next.status) ? 2 : 3);
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
        (analysisPrefix
          ? next.jobs.find((j) => j.id.startsWith(analysisPrefix))?.id
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
    if (!open || !job || !["planning", "judging"].includes(job.status)) return;
    const interval = setInterval(() => {
      void call<Analysis>("/analysis/" + job.id, projectId)
        .then((j) => {
          setJob(j);
          if (j.status === "ready") setStep(2);
          if (j.status === "done") setStep(3);
        })
        .catch((e) => setError(String(e)));
    }, 3000);
    return () => clearInterval(interval);
  }, [open, job?.id, job?.status, projectId]);
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
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        colorPalette="blue"
        onClick={() => {
          setOpen(true);
          url(job);
        }}
      >
        <FlaskConical size={14} />
        Анализ агента
      </Button>
      <Drawer.Root
        open={open}
        onOpenChange={(d) => {
          setOpen(d.open);
          if (!d.open) {
            const u = new URL(window.location.href);
            u.searchParams.delete("agentLab");
            u.searchParams.delete("labId");
            window.history.replaceState(null, "", u);
          }
        }}
        size="full"
      >
        <Portal>
          <Drawer.Backdrop />
          <Drawer.Positioner>
            <Drawer.Content>
              <Drawer.Header borderBottomWidth="1px">
                <HStack justifyContent="space-between" width="full">
                  <Box>
                    <Drawer.Title>Анализ агента</Drawer.Title>
                    <Text fontSize="sm" color="fg.muted">
                      Реальные разговоры → правила → карточки → проверка версии
                    </Text>
                  </Box>
                  <Drawer.CloseTrigger asChild>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Закрыть анализ агента"
                    >
                      <X size={18} />
                    </Button>
                  </Drawer.CloseTrigger>
                </HStack>
              </Drawer.Header>
              <Drawer.Body padding={6}>
                <Box maxWidth="1100px" marginX="auto">
                  <HStack gap={2} marginBottom={5} flexWrap="wrap">
                    {[
                      "Логи и материалы",
                      "Темы и правила",
                      "Проблемы и покрытие",
                      "Карточки и прогоны",
                    ].map((label, i) => (
                      <Button
                        key={label}
                        size="sm"
                        variant={step === i + 1 ? "solid" : "outline"}
                        colorPalette={step === i + 1 ? "blue" : undefined}
                        disabled={i > 0 && !job}
                        onClick={() => setStep(i + 1)}
                      >
                        {i + 1}. {label}
                      </Button>
                    ))}
                  </HStack>
                  {error && (
                    <Box
                      background="bg.error"
                      color="fg.error"
                      padding={4}
                      borderRadius="md"
                      marginBottom={4}
                      role="alert"
                    >
                      {error}
                    </Box>
                  )}
                  {job && (
                    <HStack
                      marginBottom={4}
                      justifyContent="space-between"
                      flexWrap="wrap"
                    >
                      <Text fontSize="sm">
                        {job.message} · выбрано {job.selected} из {job.total} ·
                        вызовов модели {job.calls}
                      </Text>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          setJob(undefined);
                          setCard(undefined);
                          setStep(1);
                          url();
                        }}
                      >
                        Новый разбор
                      </Button>
                    </HStack>
                  )}
                  {step === 1 && (
                    <VStack gap={4} align="stretch">
                      <Paper>
                        <Text fontSize="lg" fontWeight="semibold">
                          Что проверяем
                        </Text>
                        <Select
                          label="Набор с логами"
                          value={logs}
                          onChange={setLogs}
                          items={catalog?.datasets ?? []}
                        />
                        <HStack align="start" gap={4}>
                          <Select
                            label="Колонка ID разговора"
                            value={idColumn}
                            onChange={setIdColumn}
                            items={(
                              catalog?.datasets.find((d) => d.id === logs)
                                ?.columnTypes ?? []
                            ).map((c) => ({ id: c.name, name: c.name }))}
                          />
                          <Select
                            label="Колонка текста"
                            value={textColumn}
                            onChange={setTextColumn}
                            items={(
                              catalog?.datasets.find((d) => d.id === logs)
                                ?.columnTypes ?? []
                            ).map((c) => ({ id: c.name, name: c.name }))}
                          />
                        </HStack>
                        <Label>
                          Загрузить XLSX как обычный набор LangWatch
                        </Label>
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
                            marginTop={2}
                            loading={busy}
                            onClick={() => void act(() => xlsx(false))}
                          >
                            Проверить листы
                          </Button>
                        )}
                        {sheets && (
                          <HStack>
                            <Select
                              label="Лист XLSX"
                              value={sheet}
                              onChange={setSheet}
                              items={sheets.map((s, i) => ({
                                id: String(i),
                                name: `${s.name} · ${s.rows} строк`,
                              }))}
                            />
                            <Button
                              marginTop={8}
                              loading={busy}
                              onClick={() => void act(() => xlsx(true))}
                            >
                              Импортировать в LangWatch
                            </Button>
                          </HStack>
                        )}
                        <Text fontSize="xs" color="fg.muted" marginTop={2}>
                          CSV и JSONL загружаются штатной кнопкой Upload
                          datasets. Текст разговора должен различать CLIENT и
                          AGENT.
                        </Text>
                        <Label>Что делает агент</Label>
                        <Input
                          aria-label="Что делает агент"
                          value={task}
                          onChange={(e) => setTask(e.target.value)}
                        />
                        <Label>Правила или промпт агента</Label>
                        <Textarea
                          aria-label="Правила или промпт агента"
                          rows={4}
                          value={ownerRules}
                          onChange={(e) => setOwnerRules(e.target.value)}
                          placeholder="Можно дать промпт целиком: Lab выделит наблюдаемые правила и сохранит цитаты."
                        />
                        <input
                          aria-label="Файл с правилами"
                          type="file"
                          accept=".txt,.md"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void f.text().then(setOwnerRules);
                          }}
                        />
                        <Label>Материалы в наборах LangWatch</Label>
                        <VStack
                          align="stretch"
                          maxHeight="180px"
                          overflowY="auto"
                          gap={2}
                        >
                          {catalog?.datasets
                            .filter((d) => d.id !== logs)
                            .map((d) => (
                              <HStack key={d.id}>
                                <label style={{ flex: 1, fontSize: "14px" }}>
                                  <input
                                    type="checkbox"
                                    checked={!!materials[d.id]}
                                    onChange={(e) =>
                                      setMaterials((old) => {
                                        const next = { ...old };
                                        if (e.target.checked)
                                          next[d.id] = "knowledge";
                                        else delete next[d.id];
                                        return next;
                                      })
                                    }
                                  />{" "}
                                  {d.name}
                                </label>
                                {materials[d.id] && (
                                  <select
                                    aria-label={"Тип материала " + d.name}
                                    style={{ ...fieldStyle, width: "180px" }}
                                    value={materials[d.id]}
                                    onChange={(e) =>
                                      setMaterials((old) => ({
                                        ...old,
                                        [d.id]: e.target.value as
                                          "prompt" | "knowledge",
                                      }))
                                    }
                                  >
                                    <option value="knowledge">
                                      Справочник фактов
                                    </option>
                                    <option value="prompt">
                                      Промпт / правила бота
                                    </option>
                                  </select>
                                )}
                              </HStack>
                            ))}
                        </VStack>
                        <HStack gap={4} align="start">
                          <Select
                            label="Модель анализа"
                            value={model}
                            onChange={setModel}
                            items={(catalog?.models ?? []).map((id) => ({
                              id,
                              name: id,
                            }))}
                          />
                          <Box width="150px">
                            <Label>Разговоров</Label>
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
                        <Text fontSize="sm" color="fg.muted" marginTop={3}>
                          Сначала один вызов на темы и критерии. После их
                          принятия — до одного вызова на разговор. Выбранные
                          тексты и материалы уйдут настроенному провайдеру
                          модели. Статьи — основание фактов, а не автоматические
                          обязанности бота.
                        </Text>
                        <Button
                          colorPalette="blue"
                          marginTop={4}
                          disabled={!logs || !model}
                          loading={busy}
                          onClick={() =>
                            void act(async () => {
                              const next = await call<Analysis>(
                                "/plan",
                                projectId,
                                {
                                  datasetId: logs,
                                  textColumn,
                                  idColumn,
                                  task,
                                  ownerRules,
                                  count,
                                  model,
                                  materials: Object.entries(materials).map(
                                    ([datasetId, kind]) => ({
                                      datasetId,
                                      kind,
                                    }),
                                  ),
                                },
                              );
                              setJob(next);
                              setStep(2);
                              url(next);
                            })
                          }
                        >
                          Найти темы и правила
                          <ArrowRight size={16} />
                        </Button>
                      </Paper>
                      <Paper>
                        <Text fontWeight="semibold">Сохранённые разборы</Text>
                        {catalog?.jobs.map((j) => (
                          <Button
                            key={j.id}
                            size="sm"
                            variant="ghost"
                            justifyContent="start"
                            width="full"
                            onClick={() => void act(() => load(j.id))}
                          >
                            {j.name} · {j.processed}/{j.selected} · {j.status}
                          </Button>
                        ))}
                      </Paper>
                    </VStack>
                  )}
                  {step === 2 && job && (
                    <VStack gap={4} align="stretch">
                      {job.status === "planning" && (
                        <HStack>
                          <Spinner />
                          <Text>Нахожу темы и дословные основания правил…</Text>
                        </HStack>
                      )}
                      {job.error && <Text color="fg.error">{job.error}</Text>}
                      {job.knowledgeGap && (
                        <Text color="fg.muted">{job.knowledgeGap}</Text>
                      )}
                      {job.topics.map((topic) => (
                        <Paper key={topic.id}>
                          <Text fontSize="lg" fontWeight="semibold">
                            {topic.title} · {topic.dialogueIds.length}{" "}
                            разговоров
                          </Text>
                          {topic.gap && (
                            <Text color="fg.muted">{topic.gap}</Text>
                          )}
                          {topic.rules.map((rule) => (
                            <Box
                              key={rule.id}
                              marginTop={4}
                              borderTopWidth="1px"
                              paddingTop={3}
                            >
                              <label>
                                <input
                                  type="checkbox"
                                  disabled={job.status !== "ready"}
                                  checked={rule.approved}
                                  onChange={(e) =>
                                    updateRule(rule.id, {
                                      approved: e.target.checked,
                                    })
                                  }
                                />{" "}
                                Применить это правило к подходящим ситуациям
                              </label>
                              <Label>Ожидание</Label>
                              <Textarea
                                aria-label={"Ожидание " + rule.id}
                                value={rule.text}
                                disabled={job.status !== "ready"}
                                rows={2}
                                onChange={(e) =>
                                  updateRule(rule.id, { text: e.target.value })
                                }
                              />
                              <HStack gap={3} align="start">
                                <Box flex={1}>
                                  <Label>Когда применяется</Label>
                                  <Textarea
                                    aria-label={"Условие " + rule.id}
                                    value={rule.condition}
                                    disabled={job.status !== "ready"}
                                    rows={2}
                                    onChange={(e) =>
                                      updateRule(rule.id, {
                                        condition: e.target.value,
                                      })
                                    }
                                  />
                                </Box>
                                <Box flex={1}>
                                  <Label>Допустимые пути / исключения</Label>
                                  <Textarea
                                    aria-label={"Исключения " + rule.id}
                                    value={rule.acceptable}
                                    disabled={job.status !== "ready"}
                                    rows={2}
                                    onChange={(e) =>
                                      updateRule(rule.id, {
                                        acceptable: e.target.value,
                                      })
                                    }
                                  />
                                </Box>
                              </HStack>
                              <Box
                                padding={3}
                                background="bg.muted"
                                marginTop={2}
                                borderRadius="md"
                              >
                                <Text fontSize="sm">«{rule.quote}»</Text>
                                <Text fontSize="xs" color="fg.muted">
                                  {
                                    job.sources.find(
                                      (s) => s.id === rule.sourceId,
                                    )?.name
                                  }{" "}
                                  · наблюдение: {rule.observation}
                                </Text>
                              </Box>
                            </Box>
                          ))}
                        </Paper>
                      ))}
                      {job.status === "ready" && (
                        <HStack flexWrap="wrap">
                          <Button
                            colorPalette="blue"
                            disabled={!approved.length}
                            loading={busy}
                            onClick={() =>
                              void act(async () => {
                                await approve();
                                setJob(
                                  await call("/evaluate", projectId, base),
                                );
                                setStep(3);
                              })
                            }
                          >
                            Принять правила и оценить логи
                          </Button>
                          <Button
                            variant="outline"
                            disabled={!approved.length}
                            loading={busy}
                            onClick={() =>
                              void act(async () => {
                                await approve();
                                setStep(3);
                              })
                            }
                          >
                            Принять и собрать обычные ситуации без оценки логов
                          </Button>
                        </HStack>
                      )}
                    </VStack>
                  )}
                  {step === 3 && job && (
                    <VStack align="stretch" gap={4}>
                      <Paper>
                        <Text fontSize="lg" fontWeight="semibold">
                          Что найдено в реальных разговорах
                        </Text>
                        <Text fontSize="sm" color="fg.muted">
                          Обработано {job.processed} из {job.selected}{" "}
                          выбранных, всего в наборе {job.total}. Число нарушений
                          относится к принятым критериям и этой выборке.
                        </Text>
                        {job.exportError && (
                          <Text color="fg.error">{job.exportError}</Text>
                        )}
                        {job.experimentSlug && (
                          <a
                            href={`/${projectSlug}/experiments/${job.experimentSlug}`}
                            style={{ color: "var(--chakra-colors-blue-600)" }}
                          >
                            Открыть этот запуск в Experiments ↗
                          </a>
                        )}
                        {job.status === "judging" && (
                          <HStack marginTop={3}>
                            <Spinner size="sm" />
                            <Text>Оцениваю записанные разговоры…</Text>
                          </HStack>
                        )}
                        <HStack marginTop={3} gap={5} flexWrap="wrap">
                          <Text>Замечаний судьи: {patterns.length}</Text>
                          <Text>
                            Разговоров с замечаниями:{" "}
                            {
                              new Set(patterns.map((p) => p.result.dialogueId))
                                .size
                            }
                          </Text>
                          <Text>
                            UNKNOWN:{" "}
                            {
                              job.results
                                .flatMap((r) => r.rules)
                                .filter((v) => v.status === "UNKNOWN").length
                            }
                          </Text>
                          <Text>
                            Не применялось:{" "}
                            {
                              job.results
                                .flatMap((r) => r.rules)
                                .filter((v) => v.status === "NOT_APPLICABLE")
                                .length
                            }
                          </Text>
                        </HStack>
                      </Paper>
                      {health.map((topic) => (
                        <Paper key={topic.id}>
                          <Text fontWeight="semibold">
                            {topic.title} · {topic.processed} / {topic.total}{" "}
                            разговоров
                          </Text>
                          <HStack marginTop={2} gap={4} flexWrap="wrap">
                            <Badge colorPalette="green">
                              Без замечаний по принятым правилам: {topic.passed}
                            </Badge>
                            <Badge colorPalette="orange">
                              С замечаниями: {topic.failed}
                            </Badge>
                            <Badge>Недостаточно данных: {topic.unknown}</Badge>
                          </HStack>
                          <Text fontSize="xs" color="fg.muted" marginTop={2}>
                            Результат судьи на выбранных разговорах.
                            Подтверждённые нарушения отмечены в примерах ниже.
                          </Text>
                        </Paper>
                      ))}
                      {groups.map((group) => (
                        <Paper key={group.ruleId}>
                          <Text fontSize="lg" fontWeight="semibold">
                            {group.items[0]!.verdict.title ||
                              group.items[0]!.rule.text}
                          </Text>
                          <Text fontSize="sm" color="fg.muted">
                            {group.items.length} примеров по одному правилу.
                            Одинаковые ID не считаются повторными клиентами.
                          </Text>
                          {group.items.map(({ result, verdict, rule }) => {
                            const review = job.reviews
                              .filter(
                                (r) =>
                                  r.dialogueId === result.dialogueId &&
                                  r.ruleId === rule.id,
                              )
                              .at(-1);
                            const ref = result.dialogueId + rule.id;
                            return (
                              <Box
                                key={ref}
                                marginTop={4}
                                borderTopWidth="1px"
                                paddingTop={3}
                              >
                                <Badge
                                  colorPalette={
                                    review?.decision === "confirmed"
                                      ? "green"
                                      : review?.decision === "disputed"
                                        ? "gray"
                                        : "orange"
                                  }
                                >
                                  {review?.decision === "confirmed"
                                    ? "Подтверждено"
                                    : review?.decision === "disputed"
                                      ? "Отклонено"
                                      : "Нужна проверка примера"}
                                </Badge>
                                <Text marginTop={2}>{verdict.reason}</Text>
                                <Box
                                  background="bg.muted"
                                  padding={3}
                                  marginY={2}
                                >
                                  <Text>Агент: «{verdict.agentQuote}»</Text>
                                  <Text fontSize="sm" marginTop={2}>
                                    Правило: «{rule.quote}»
                                  </Text>
                                </Box>
                                <details>
                                  <summary>
                                    Открыть весь реальный разговор ·{" "}
                                    {result.dialogueId}
                                  </summary>
                                  <Text
                                    whiteSpace="pre-wrap"
                                    fontSize="sm"
                                    padding={3}
                                  >
                                    {
                                      job.dialogues.find(
                                        (d) => d.id === result.dialogueId,
                                      )?.text
                                    }
                                  </Text>
                                </details>
                                <Textarea
                                  rows={2}
                                  aria-label={"Основание " + ref}
                                  placeholder="Основание решения: почему это нарушение или допустимый ответ"
                                  value={reviewNotes[ref] ?? review?.note ?? ""}
                                  onChange={(e) =>
                                    setReviewNotes((n) => ({
                                      ...n,
                                      [ref]: e.target.value,
                                    }))
                                  }
                                />
                                <HStack marginTop={2} flexWrap="wrap">
                                  {(
                                    ["confirmed", "disputed", "unsure"] as const
                                  ).map((decision, i) => (
                                    <Button
                                      key={decision}
                                      size="sm"
                                      disabled={busy || job.status !== "done"}
                                      onClick={() =>
                                        void act(async () => {
                                          const note =
                                            reviewNotes[ref] ??
                                            review?.note ??
                                            "";
                                          if (!note.trim())
                                            throw new Error(
                                              "Укажите основание решения",
                                            );
                                          setJob(
                                            await call("/review", projectId, {
                                              ...base,
                                              dialogueId: result.dialogueId,
                                              ruleId: rule.id,
                                              decision,
                                              note,
                                            }),
                                          );
                                        })
                                      }
                                    >
                                      {
                                        [
                                          "Подтвердить",
                                          "Отклонить",
                                          "Не уверен",
                                        ][i]
                                      }
                                    </Button>
                                  ))}
                                  {review?.decision === "confirmed" && (
                                    <Button
                                      size="sm"
                                      colorPalette="blue"
                                      loading={busy}
                                      onClick={() =>
                                        void act(() =>
                                          propose(
                                            "regression",
                                            result.dialogueId,
                                            [rule.id],
                                          ),
                                        )
                                      }
                                    >
                                      Сделать регрессионную карточку
                                    </Button>
                                  )}
                                </HStack>
                              </Box>
                            );
                          })}
                        </Paper>
                      ))}
                      <Paper>
                        <Text fontSize="lg" fontWeight="semibold">
                          Обычные ситуации и синтетика
                        </Text>
                        <Text fontSize="sm" color="fg.muted">
                          Этот путь работает и без поиска ошибок. Он проверяет
                          навыки агента на обычных обращениях и новых вариантах
                          правил.
                        </Text>
                        <Select
                          label="Обычная ситуация из логов"
                          value={ordinaryId}
                          onChange={setOrdinaryId}
                          items={ordinary.map((d) => ({
                            id: d.id,
                            name:
                              job.topics.find((t) => t.id === d.topicId)
                                ?.title +
                              " · " +
                              d.id.slice(0, 8),
                          }))}
                        />
                        <Select
                          label="Тема для синтетической ситуации"
                          value={
                            syntheticTopicId ||
                            job.topics.find((t) =>
                              t.rules.some((r) => r.approved),
                            )?.id ||
                            ""
                          }
                          onChange={setSyntheticTopicId}
                          items={job.topics
                            .filter((t) => t.rules.some((r) => r.approved))
                            .map((t) => ({ id: t.id, name: t.title }))}
                        />
                        <HStack marginTop={3} flexWrap="wrap">
                          <Button
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
                                        ordinary.find(
                                          (d) => d.id === ordinaryId,
                                        )?.topicId,
                                    )
                                    ?.rules.filter((r) => r.approved)
                                    .map((r) => r.id),
                                ),
                              )
                            }
                          >
                            Собрать карточку из обычного обращения
                          </Button>
                          <Button
                            variant="outline"
                            disabled={
                              !approved.length ||
                              busy ||
                              !["ready", "done"].includes(job.status)
                            }
                            onClick={() =>
                              void act(() =>
                                propose(
                                  "synthetic",
                                  undefined,
                                  (
                                    job.topics.find(
                                      (t) => t.id === syntheticTopicId,
                                    ) ??
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
                            Предложить синтетическую ситуацию из правил
                          </Button>
                        </HStack>
                      </Paper>
                      <details>
                        <summary>Все оценки принятых критериев</summary>
                        {job.results.map((r) => (
                          <Box
                            key={r.dialogueId}
                            padding={3}
                            borderBottomWidth="1px"
                          >
                            <Text fontWeight="medium">{r.dialogueId}</Text>
                            {r.rules.map((v) => (
                              <Text key={v.ruleId} fontSize="sm">
                                {v.status} · {v.reason}
                              </Text>
                            ))}
                            {!r.rules.length && (
                              <Text>
                                Не оценён: нет принятых применимых правил.
                              </Text>
                            )}
                          </Box>
                        ))}
                      </details>
                    </VStack>
                  )}
                  {step === 4 && job && (
                    <VStack gap={4} align="stretch">
                      <Paper>
                        <Text fontSize="lg" fontWeight="semibold">
                          Библиотека карточек этого разбора
                        </Text>
                        {job.cards.map((c) => (
                          <Button
                            key={c.id}
                            variant="ghost"
                            width="full"
                            justifyContent="start"
                            onClick={() => {
                              setCard(c);
                              setRunData(undefined);
                            }}
                          >
                            {c.origin === "coverage"
                              ? "Обычное обращение"
                              : c.origin === "regression"
                                ? "Регрессия"
                                : "Синтетика"}{" "}
                            · {c.name} ·{" "}
                            {c.status === "saved" ? "в LangWatch" : "черновик"}
                          </Button>
                        ))}
                        {!job.cards.length && (
                          <Text color="fg.muted">
                            Создайте карточку из подтверждённой проблемы или
                            обычного обращения.
                          </Text>
                        )}
                      </Paper>
                      {card && (
                        <Paper>
                          <Badge>
                            {card.origin === "coverage"
                              ? "Coverage · обычный трафик"
                              : card.origin === "regression"
                                ? "Regression · известная ошибка"
                                : "Синтетическая ситуация"}
                          </Badge>
                          <Label>Название карточки</Label>
                          <Input
                            aria-label="Название карточки"
                            disabled={card.status === "saved"}
                            value={card.name}
                            onChange={(e) =>
                              setCard({ ...card, name: e.target.value })
                            }
                          />
                          <Label>
                            Мир клиента: цель, исходные факты и поведение
                          </Label>
                          <Textarea
                            aria-label="Мир клиента"
                            rows={5}
                            disabled={card.status === "saved"}
                            value={card.situation}
                            onChange={(e) =>
                              setCard({ ...card, situation: e.target.value })
                            }
                          />
                          <Label>Критерии проверки</Label>
                          {card.criteria.map((criterion, i) => (
                            <Textarea
                              key={i}
                              aria-label={"Критерий карточки " + (i + 1)}
                              marginBottom={2}
                              rows={3}
                              disabled={card.status === "saved"}
                              value={criterion}
                              onChange={(e) =>
                                setCard({
                                  ...card,
                                  criteria: card.criteria.map((v, index) =>
                                    index === i ? e.target.value : v,
                                  ),
                                })
                              }
                            />
                          ))}
                          {card.status === "draft" ? (
                            <Button
                              colorPalette="blue"
                              loading={busy}
                              onClick={() =>
                                void act(async () => {
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
                                  setJob(
                                    await call(
                                      "/analysis/" + job.id,
                                      projectId,
                                    ),
                                  );
                                })
                              }
                            >
                              Принять и сохранить в Scenarios
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              onClick={() => nativeScenario(card.scenarioId!)}
                            >
                              Открыть штатный редактор сценария LangWatch
                            </Button>
                          )}
                          <Select
                            label="Агент для прогона"
                            value={agent}
                            onChange={setAgent}
                            items={catalog?.agents ?? []}
                          />
                          <Label>Версия / что менялось в агенте</Label>
                          <Input
                            aria-label="Версия агента"
                            value={note}
                            placeholder="Например: baseline · текущая версия или commit новой версии"
                            onChange={(e) => setNote(e.target.value)}
                          />
                          <Text fontSize="xs" color="fg.muted">
                            Укажите версию и закрепите модели в плане запуска.
                            Смена судьи не доказывает улучшение агента. Проверки
                            инструментов требуют настоящих трасс.
                          </Text>
                          <Button
                            marginTop={3}
                            colorPalette="blue"
                            disabled={card.status !== "saved" || !agent}
                            loading={busy}
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
                                setCard(
                                  next.cards.find((c) => c.id === card.id),
                                );
                              })
                            }
                          >
                            Запустить настоящего агента
                          </Button>
                        </Paper>
                      )}
                      {runData?.comparison && (
                        <Paper>
                          <Text fontWeight="semibold">
                            Сравнение последних двух прогонов
                          </Text>
                          <Text>{runData.comparison.verdict}</Text>
                          <Text fontSize="sm" color="fg.muted">
                            {runData.comparison.limitation}
                          </Text>
                        </Paper>
                      )}
                      {runData?.runs?.map((run: any) => (
                        <Paper key={run.id}>
                          <HStack justifyContent="space-between">
                            <Text fontWeight="semibold">
                              {run.data.status} ·{" "}
                              {new Date(run.at).toLocaleString("ru-RU")}
                            </Text>
                            <a
                              href={`/${projectSlug}/simulations?drawer.open=scenarioRunDetail&drawer.scenarioRunId=${run.id}`}
                            >
                              Полный прогон ↗
                            </a>
                          </HStack>
                          <Text fontSize="sm" color="fg.muted">
                            {run.note} · судья:{" "}
                            {run.judgeModel ?? "не зафиксирован"} · клиент:{" "}
                            {run.simulatorModel ?? "не зафиксирован"}
                          </Text>
                          <Text>
                            {run.data.results?.reasoning ??
                              "Симулятор разговаривает с агентом…"}
                          </Text>
                          {run.data.messages?.map((message: any, i: number) => (
                            <Box
                              key={message.id ?? i}
                              padding={3}
                              background="bg.muted"
                              marginTop={2}
                              borderRadius="md"
                            >
                              <Text fontSize="xs" fontWeight="medium">
                                {message.role === "user"
                                  ? "Синтетический клиент"
                                  : "Настоящий агент"}
                              </Text>
                              <Text fontSize="sm" whiteSpace="pre-wrap">
                                {typeof message.content === "string"
                                  ? message.content
                                  : JSON.stringify(message.content)}
                              </Text>
                            </Box>
                          ))}
                        </Paper>
                      ))}
                    </VStack>
                  )}
                </Box>
              </Drawer.Body>
            </Drawer.Content>
          </Drawer.Positioner>
        </Portal>
      </Drawer.Root>
    </>
  );
}
