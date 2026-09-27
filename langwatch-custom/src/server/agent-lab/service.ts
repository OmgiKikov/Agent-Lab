import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "~/server/db";
import { getProjectModelProviders } from "~/server/api/routers/modelProviders.utils";
import { resolveModelForFeature } from "~/server/modelProviders/resolveModelForFeature";
import { structured, PLAN, JUDGE, CUSTOMER_CARD } from "./model";
import { messages, evidenceSources, criterionText } from "./evidence";
import { scheduleBatch, batchSummary, KeyedSerial, assertDispatchKnown } from "./workflow";
export { messages } from "./evidence";
import {
  planSchema,
  verdictSchema,
  cardProposalSchema,
  type Analysis,
  type Start,
  type Source,
  type Card,
  type Rule,
  type Verdict,
} from "./schema";

const directory = path.join(
  path.dirname(
    process.env.LANGWATCH_LOCAL_STORAGE_PATH ?? path.resolve("storage/objects"),
  ),
  "agent-lab",
);
const running = new Set<string>();
const serial = new KeyedSerial();
export const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safe = (id: string) => {
  if (!/^[\w-]{1,128}$/.test(id)) throw new Error("Некорректный идентификатор");
  return id;
};
export async function api(
  projectId: string,
  suffix: string,
  body?: unknown,
  method?: string,
): Promise<any> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("Проект не найден");
  const base = (process.env.NEXTAUTH_URL ?? "http://localhost:5560").replace(
    /\/$/,
    "",
  );
  const response = await fetch(base + suffix, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      "X-Auth-Token": project.apiKey,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.message ?? result.error ?? "LangWatch не выполнил запрос",
    );
  return result;
}
async function file(projectId: string, id: string) {
  return path.join(directory, safe(projectId), safe(id) + ".json");
}
export async function save(job: Analysis) {
  const filename = await file(job.projectId, job.id);
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const tmp = filename + "." + randomUUID() + ".tmp";
  await writeFile(tmp, JSON.stringify(job), { mode: 0o600 });
  await rename(tmp, filename);
}
export async function get(projectId: string, id: string): Promise<Analysis> {
  const job = JSON.parse(
    await readFile(await file(projectId, id), "utf8"),
  ) as Analysis;
  if (job.projectId !== projectId) throw new Error("Разбор другого проекта");
  if (["planning", "judging"].includes(job.status) && !running.has(job.id)) {
    job.status = "interrupted";
    job.message = "Процесс прервался. Сделанные оценки сохранены.";
    await save(job);
  }
  return job;
}
export function view(job: Analysis) {
  return {
    ...job,
    sources: job.sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      chars: s.content.length,
    })),
  };
}
export async function list(projectId: string) {
  let files: string[];
  try {
    files = await readdir(path.join(directory, safe(projectId)));
  } catch {
    return [];
  }
  const jobs = await Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => get(projectId, f.slice(0, -5)).catch(() => null)),
  );
  return jobs
    .filter((j): j is Analysis => !!j)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ id, name, status, createdAt, selected, processed, datasetId }) => ({
      id,
      name,
      status,
      createdAt,
      selected,
      processed,
      datasetId,
    }));
}
export async function catalog(projectId: string) {
  const [datasets, agents, providers, jobs] = await Promise.all([
    api(projectId, "/api/dataset"),
    api(projectId, "/api/agents"),
    getProjectModelProviders(projectId),
    list(projectId),
  ]);
  const models: string[] = [];
  for (const [provider, config] of Object.entries(providers) as [
    string,
    any,
  ][]) {
    if (!config.enabled) continue;
    for (const item of [
      ...(config.models ?? []),
      ...(config.customModels ?? []),
    ]) {
      const id = typeof item === "string" ? item : item.modelId;
      if (id) models.push(provider + "/" + id);
    }
  }
  return {
    datasets: (datasets.data ?? datasets).map((d: any) => ({
      id: d.id,
      name: d.name,
      columnTypes: Array.isArray(d.columnTypes) ? d.columnTypes : [],
      recordCount: d.recordCount,
    })),
    agents: (agents.data ?? agents)
      .filter((a: any) => a.type === "http")
      .map((a: any) => ({ id: a.id, name: a.name })),
    models: [...new Set(models)],
    jobs,
  };
}
async function records(projectId: string, datasetId: string) {
  const response = await api(projectId, "/api/dataset/" + safe(datasetId));
  return (response.data ?? response.entries ?? response).map((r: any) => ({
    id: r.id,
    entry: r.entry ?? r,
  }));
}
function inputs(job: Analysis, query: string, rules: Rule[] = []) {
  return evidenceSources(job.sources, query, rules);
}
function customer(text: string) {
  return messages(text)
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
}
function grounded(job: Analysis, rule: Rule) {
  const s = job.sources.find((x) => x.id === rule.sourceId);
  return !!s && s.content.includes(rule.quote);
}

export async function start(config: Start, userId: string) {
  if (config.agentId) {
    const agents = await api(config.projectId, "/api/agents");
    if (!(agents.data ?? agents).some((a: any) => a.id === config.agentId && a.type === "http")) throw new Error("Подключённый HTTP агент не найден");
    config.autoEvaluate = true;
  }
  const rows = await records(config.projectId, config.datasetId);
  if (!rows.length) throw new Error("Набор пуст");
  if (config.textColumn === config.idColumn)
    throw new Error("ID и текст должны быть в разных колонках");
  const dialogues = rows.flatMap((r: any) => {
    const text = r.entry[config.textColumn];
    return typeof text === "string" && text.trim()
      ? [{ id: String(r.entry[config.idColumn] ?? r.id), text }]
      : [];
  });
  if (!dialogues.length)
    throw new Error("В выбранной колонке нет текстов разговоров");
  const sources: Source[] = config.ownerRules.trim()
    ? [
        {
          id: "owner-rules",
          name: "Правила владельца",
          content: config.ownerRules,
          kind: "prompt",
        },
      ]
    : [];
  for (const ref of config.materials) {
    const sourceRows = await records(config.projectId, ref.datasetId);
    for (const row of sourceRows) {
      const content = String(
        row.entry.content ??
          row.entry.text ??
          row.entry.prompt ??
          row.entry.instructions ??
          "",
      );
      if (!content.trim()) continue;
      sources.push({
        id: ref.datasetId + ":" + row.id,
        name: String(row.entry.title ?? row.entry.name ?? "Материал"),
        content,
        kind: ref.kind,
      });
    }
  }
  if (!sources.length)
    throw new Error(
      "Укажите правила или выберите материалы с колонкой text/content/prompt",
    );
  if (
    sources
      .filter((s) => s.kind === "prompt")
      .reduce((n, s) => n + s.content.length, 0) > 60000
  )
    throw new Error(
      "Промпты длиннее 60 000 символов. Выберите правила проверяемого агента.",
    );
  const selected = dialogues
    .sort((a: any, b: any) => hash(a.text).localeCompare(hash(b.text)))
    .slice(0, config.count);
  if (new Set(selected.map((x: any) => x.id)).size !== selected.length)
    throw new Error(
      "ID разговоров повторяются. Выберите уникальную колонку ID.",
    );
  const job: Analysis = {
    id: randomUUID(),
    projectId: config.projectId,
    datasetId: config.datasetId,
    name: "Анализ · " + config.task.slice(0, 80),
    task: config.task,
    model: config.model,
    autoEvaluate: config.autoEvaluate,
    agentId: config.agentId,
    repeatCount: config.repeatCount,
    batches: [],
    ownerRules: config.ownerRules,
    materialRefs: config.materials,
    textColumn: config.textColumn,
    idColumn: config.idColumn,
    createdAt: new Date().toISOString(),
    status: "planning",
    message: "Нахожу темы и правила",
    total: dialogues.length,
    selected: selected.length,
    processed: 0,
    calls: 0,
    sources,
    dialogues: selected,
    topics: [],
    results: [],
    cards: [],
    reviews: [],
  };
  running.add(job.id);
  await save(job);
  void plan(job).finally(() => running.delete(job.id));
  return view(job);
}
async function ownerRules(job: Analysis) {
  const folder = path.join(directory, safe(job.projectId));
  const files = await readdir(folder);
  const accepted: Rule[] = [];
  const seen = new Set<string>();
  for (const filename of files.filter((f) => f.endsWith(".json"))) {
    const previous = JSON.parse(
      await readFile(path.join(folder, filename), "utf8"),
    ) as Analysis;
    if (
      previous.id === job.id ||
      previous.autoEvaluate ||
      previous.model.startsWith("historical/") ||
      hash(previous.ownerRules) !== hash(job.ownerRules)
    )
      continue;
    for (const rule of previous.topics
      .flatMap((t) => t.rules)
      .filter((r) => r.approved)) {
      const source = job.sources.find((s) => s.content.includes(rule.quote));
      const key = hash([rule.quote, rule.condition, rule.acceptable]);
      if (source && !seen.has(key)) {
        seen.add(key);
        accepted.push({ ...rule, sourceId: source.id });
      }
    }
  }
  return accepted.slice(0, 2);
}
async function plan(job: Analysis) {
  try {
    const usable = job.dialogues.filter(
      (d) => d.text.length <= 30000 && customer(d.text),
    );
    if (!usable.length)
      throw new Error(
        "Нужны разговоры с ролями CLIENT и AGENT, длиной до 30 000 символов.",
      );
    const query = usable.map((d) => customer(d.text)).join("\n");
    job.calls++;
    await save(job);
    const proposal = await structured(
      job.projectId,
      job.model,
      PLAN,
      {
        task: job.task,
        examples: usable.map((d) => ({
          id: d.id,
          customer: customer(d.text).slice(0, 2500),
        })),
        sources: inputs(job, query),
      },
      planSchema,
    );
    const assigned = new Set<string>();
    const topicIds = new Set<string>();
    const rules = new Set<string>();
    for (const topic of proposal.topics) {
      if (topicIds.has(topic.id)) throw new Error("Модель повторила ID темы");
      topicIds.add(topic.id);
      for (const id of topic.dialogueIds) {
        if (!usable.some((d) => d.id === id) || assigned.has(id))
          throw new Error("Модель неверно связала разговоры с темами");
        assigned.add(id);
      }
      for (const rule of topic.rules) {
        if (rules.has(rule.id) || !grounded(job, rule))
          throw new Error(
            "Правило не имеет уникального ID или дословного основания",
          );
        rules.add(rule.id);
        rule.approved = false;
      }
    }
    const retained = job.autoEvaluate ? await ownerRules(job) : [];
    for (const topic of proposal.topics)
      for (const rule of retained) {
        if (topic.rules.some((r) => r.quote === rule.quote)) continue;
        topic.rules.unshift({
          ...rule,
          id: "owner-" + topic.id + "-" + rule.id,
          approved: true,
        });
        topic.rules = topic.rules.slice(0, 6);
      }
    job.topics = proposal.topics;
    for (const d of job.dialogues)
      d.topicId = job.topics.find((t) => t.dialogueIds.includes(d.id))?.id;
    job.status = "ready";
    job.message =
      "Темы и правила найдены. Проверьте условия и допустимые ответы перед оценкой.";
    if (assigned.size < job.selected)
      job.knowledgeGap = `${job.selected - assigned.size} разговоров не связаны с правилами; они не получат оценку качества.`;
    if (job.autoEvaluate) {
      // Imported conversations expose rendered replies, not the transport envelope.
      for (const topic of job.topics)
        for (const rule of topic.rules) {
          rule.approved =
            !/валидн[а-я]*\s+json|json.?формат|пол[ея]\s+output|\{\{?"output"/iu.test(
              rule.text + " " + rule.quote,
            );
        }
      job.status = "judging";
      job.message = "Проверяем реальные ответы по правилам агента";
      await save(job);
      await judge(job);
      return;
    }
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.message = "Правила не готовы: " + job.error;
  }
  await save(job);
}
async function approveUnlocked(
  projectId: string,
  id: string,
  changes: {
    id: string;
    approved: boolean;
    text: string;
    condition: string;
    acceptable: string;
  }[],
) {
  const job = await get(projectId, id);
  if (job.status !== "ready")
    throw new Error("Правила можно менять только до оценки");
  for (const topic of job.topics)
    for (const rule of topic.rules) {
      const change = changes.find((x) => x.id === rule.id);
      if (change) {
        rule.approved = change.approved;
        rule.text = change.text;
        rule.condition = change.condition;
        rule.acceptable = change.acceptable;
      }
    }
  if (!job.topics.some((t) => t.rules.some((r) => r.approved)))
    throw new Error("Выберите хотя бы одно правило");
  await save(job);
  return view(job);
}
export function checked(job: Analysis, id: string) {
  return job.topics
    .flatMap((t) => t.rules)
    .find((r) => r.id === id && r.approved);
}
async function report(job: Analysis, finished = false) {
  const dataset = job.results.map((r, index) => ({
    index,
    target_id: "production-logs",
    entry: {
      dialogue_id: r.dialogueId,
      conversation: job.dialogues.find((d) => d.id === r.dialogueId)?.text,
      topic: job.topics.find((t) => t.id === r.topicId)?.title,
    },
    predicted: { judgments: r.rules },
  }));
  const evaluations = job.results.flatMap((r, index) =>
    r.rules.map((v) => ({
      index,
      target_id: "production-logs",
      evaluator: "agent-lab/" + v.ruleId,
      name: checked(job, v.ruleId)?.text ?? v.ruleId,
      status: v.status === "NOT_APPLICABLE" ? "skipped" : "processed",
      label: v.status,
      ...(v.status === "PASS" || v.status === "FAIL"
        ? { passed: v.status === "PASS" }
        : {}),
      details:
        v.reason +
        (v.agentQuote ? "\nЦитата агента: «" + v.agentQuote + "»" : ""),
      inputs: { rule: checked(job, v.ruleId), evidence: v.agentQuote },
    })),
  );
  const slug = job.experimentSlug ?? "real-log-analysis-" + job.id.slice(0, 8);
  job.experimentSlug = slug;
  job.runId ??= job.id;
  await api(job.projectId, "/api/evaluations/batch/log_results", {
    experiment_slug: slug,
    name: job.name,
    run_id: job.runId,
    total: job.selected,
    progress: job.processed,
    targets: [
      {
        id: "production-logs",
        name: "Реальные разговоры · " + job.model,
        type: "custom",
        model: job.model,
      },
    ],
    dataset,
    evaluations,
    timestamps: {
      created_at: new Date(job.createdAt).getTime(),
      ...(finished ? { finished_at: Date.now() } : {}),
    },
  });
}
async function evaluateUnlocked(projectId: string, id: string) {
  const job = await get(projectId, id);
  if (!["ready", "interrupted"].includes(job.status))
    throw new Error("Разбор ещё не готов или уже оценён");
  if (!job.topics.some((t) => t.rules.some((r) => r.approved)))
    throw new Error("Сначала примите правила");
  job.status = "judging";
  job.message = "Оцениваю реальные разговоры";
  running.add(job.id);
  await save(job);
  void judge(job).finally(() => running.delete(job.id));
  return view(job);
}
function unseenCondition(rule: Rule) {
  return /контекст|полезное уточнение невозможно/iu.test(rule.condition);
}

async function judge(job: Analysis) {
  try {
    const done = new Set(job.results.map((r) => r.dialogueId));
    for (const dialogue of job.dialogues) {
      if (done.has(dialogue.id)) continue;
      const topic = job.topics.find((t) => t.id === dialogue.topicId);
      const duties = topic?.rules.filter((r) => r.approved) ?? [];
      job.message = `Оцениваю разговор ${job.processed + 1} из ${job.selected}`;
      await save(job);
      let judgments: Verdict[] = [];
      if (
        duties.length &&
        dialogue.text.length <= 30000 &&
        messages(dialogue.text).some((m) => m.role === "assistant")
      ) {
        const observed = duties.filter(
          (r) => r.observation === "reply" && !unseenCondition(r),
        );
        judgments = duties
          .filter((r) => r.observation !== "reply" || unseenCondition(r))
          .map((r) => ({
            ruleId: r.id,
            status: "UNKNOWN",
            reason: unseenCondition(r)
              ? "Не сохранён контекст, переданный агенту. Условие этого правила нельзя доказать по репликам."
              : "В наборе только реплики. Действия инструментов и состояние не наблюдались.",
            agentQuote: "",
            title: "",
          }));
        if (observed.length) {
          job.calls++;
          await save(job);
          try {
            const reply = await structured(
              job.projectId,
              job.model,
              JUDGE,
              {
                conversation: dialogue.text,
                rules: observed,
                sources: inputs(job, customer(dialogue.text), observed),
              },
              verdictSchema,
            );
            for (const rule of observed) {
              const rows = reply.rules.filter((v) => v.ruleId === rule.id);
              let row =
                rows.length === 1
                  ? rows[0]
                  : {
                      ruleId: rule.id,
                      status: "UNKNOWN" as const,
                      reason: "Судья не дал единственной оценки этого правила.",
                      agentQuote: "",
                      title: "",
                    };
              if (
                ["PASS", "FAIL"].includes(row!.status) &&
                (!row!.agentQuote.trim() ||
                  row!.agentQuote.length < 8 ||
                  !messages(dialogue.text).some(
                    (m) =>
                      m.role === "assistant" &&
                      m.content.includes(row!.agentQuote),
                  ))
              )
                row = {
                  ...row!,
                  status: "UNKNOWN",
                  reason: "Дословная цитата агента не прошла проверку.",
                  agentQuote: "",
                };
              judgments.push(row!);
            }
          } catch (error) {
            judgments.push(
              ...observed.map((r) => ({
                ruleId: r.id,
                status: "UNKNOWN" as const,
                reason: "Оценка не завершилась: " + String(error).slice(0, 180),
                agentQuote: "",
                title: "",
              })),
            );
          }
        }
      } else
        judgments = duties.map((r) => ({
          ruleId: r.id,
          status: "UNKNOWN",
          reason:
            "Не виден ответ агента или разговор слишком длинный. Он не обрезан и не оценён.",
          agentQuote: "",
          title: "",
        }));
      job.results.push({
        dialogueId: dialogue.id,
        topicId: topic?.id ?? "",
        rules: judgments,
      });
      job.processed++;
      await save(job);
      try {
        await report(job);
      } catch (error) {
        job.exportError =
          "Эксперимент пока не записан: " + String(error).slice(0, 180);
        await save(job);
      }
    }
    if (job.autoEvaluate) {
      job.message = "Собираем проверки из разговоров";
      await save(job);
      try {
        await assembleCards(job);
      } catch (error) {
        job.knowledgeGap =
          (job.knowledgeGap ?? "") +
          " Часть проверок не сохранена: " +
          String(error).slice(0, 160);
      }
    }
    job.status = "done";
    job.message = "Разбор завершён. Проверьте примеры найденных нарушений.";
    try {
      await report(job, true);
      job.exportError = undefined;
    } catch (error) {
      job.exportError =
        "Результат сохранён, но запись эксперимента не завершилась: " +
        String(error).slice(0, 180);
    }
  } catch (error) {
    job.status = "failed";
    job.error = String(error);
    job.message = "Разбор прервался; сделанные оценки сохранены.";
  }
  await save(job);
  if (job.status === "done" && job.agentId && !job.batches?.length) {
    try {
      await runAll(job.projectId, job.id, job.agentId, "Поручение: разбор логов и проверка агента", job.repeatCount ?? 1);
    } catch (error) {
      // Re-read: the queue may have accepted part of the work and persisted its receipt.
      const current = await get(job.projectId, job.id);
      current.workflowError = "Прогон не завершён: " + (error instanceof Error ? error.message : String(error));
      await save(current);
    }
  }
}
async function reviewUnlocked(
  projectId: string,
  id: string,
  dialogueId: string,
  ruleId: string,
  decision: "confirmed" | "disputed" | "unsure",
  note: string,
  userId: string,
) {
  const job = await get(projectId, id);
  if (job.status !== "done") throw new Error("Дождитесь конца оценки");
  if (
    !job.results.some(
      (r) =>
        r.dialogueId === dialogueId &&
        r.rules.some((v) => v.ruleId === ruleId && v.status === "FAIL"),
    )
  )
    throw new Error("Нарушение не найдено");
  job.reviews.push({
    dialogueId,
    ruleId,
    decision,
    note,
    userId,
    at: new Date().toISOString(),
  });
  await save(job);
  return view(job);
}
async function proposeUnlocked(
  projectId: string,
  id: string,
  origin: Card["origin"],
  dialogueId: string | undefined,
  ruleIds: string[],
  userId: string,
) {
  const job = await get(projectId, id);
  if (!["ready", "done"].includes(job.status))
    throw new Error("Нужны готовые принятые правила");
  if (job.model.startsWith("historical/"))
    throw new Error(
      "Для новых карточек создайте новый разбор с выбранной моделью. Старые карточки и прогоны сохранены.",
    );
  let rules = ruleIds.map((r) => checked(job, r));
  if (!rules.length || rules.some((r) => !r))
    throw new Error("Выберите принятые правила");
  if (origin !== "regression") {
    rules = rules.filter(
      (r) => r!.observation === "reply" && !unseenCondition(r!),
    );
    if (!rules.length)
      throw new Error(
        "Для этих правил нужны контекст или трассы агента. По одним репликам проверку создать нельзя.",
      );
    ruleIds = rules.map((r) => r!.id);
  }
  const dialogue = dialogueId
    ? job.dialogues.find((d) => d.id === dialogueId)
    : undefined;
  if (origin !== "synthetic" && !dialogue)
    throw new Error("Нужен исходный разговор");
  if (origin === "regression") {
    for (const ruleId of ruleIds) {
      const last = job.reviews
        .filter((r) => r.dialogueId === dialogueId && r.ruleId === ruleId)
        .at(-1);
      if (last?.decision !== "confirmed")
        throw new Error("Сначала подтвердите нарушение по этому правилу");
    }
  }
  const prior = job.cards.find(
    (c) =>
      c.origin === origin &&
      c.dialogueId === dialogueId &&
      hash([...c.ruleIds].sort()) === hash([...ruleIds].sort()),
  );
  if (prior) return prior;
  job.calls++;
  await save(job);
  const proposal = await structured(
    job.projectId,
    job.model,
    CUSTOMER_CARD,
    {
      mode: origin,
      customer: dialogue ? customer(dialogue.text) : undefined,
      task: job.task,
      approvedRules: rules,
    },
    cardProposalSchema,
  );
  const criteria = rules.map(rule => criterionText(rule!, job.sources));
  const card: Card = {
    id: randomUUID(),
    origin,
    dialogueId,
    ruleIds,
    name: proposal.name,
    situation: proposal.situation,
    criteria,
    definitionHash: hash({ situation: proposal.situation, criteria }),
    status: "draft",
    runs: [],
  };
  job.cards.push(card);
  await save(job);
  if (origin !== "regression") {
    const scenario = await api(projectId, "/api/scenarios", {
      name: card.name,
      situation: card.situation,
      criteria: card.criteria,
      labels: [
        "agent-lab",
        origin,
        "coverage",
        "generated",
        "card-" + card.id.slice(0, 8),
      ],
    });
    card.scenarioId = scenario.id;
    card.status = "saved";
    card.generated = true;
    await save(job);
  }
  return card;
}
async function changeCardUnlocked(
  projectId: string,
  id: string,
  cardId: string,
  changes: { name: string; situation: string; criteria: string[] },
) {
  const job = await get(projectId, id);
  const card = job.cards.find((c) => c.id === cardId);
  if (!card) throw new Error("Карточка не найдена");
  if (card.status === "saved")
    throw new Error(
      "Сохранённый сценарий изменяется в штатном редакторе LangWatch",
    );
  Object.assign(card, changes);
  card.definitionHash = hash({
    situation: card.situation,
    criteria: card.criteria,
  });
  await save(job);
  return card;
}
export async function accept(
  projectId: string,
  id: string,
  cardId: string,
  userId: string,
) {
  return exclusive(id, async () => {
    const job = await get(projectId, id);
    const card = job.cards.find((c) => c.id === cardId);
    if (!card) throw new Error("Карточка не найдена");
    if (
      card.origin === "regression" &&
      card.ruleIds.some(
        (ruleId) =>
          job.reviews
            .filter(
              (r) => r.dialogueId === card.dialogueId && r.ruleId === ruleId,
            )
            .at(-1)?.decision !== "confirmed",
      )
    )
      throw new Error("Сначала подтвердите замечание по исходному разговору");
    if (card.scenarioId) return card;
    const scenario = await api(projectId, "/api/scenarios", {
      name: card.name,
      situation:
        card.situation +
        "\n\nПроисхождение: " +
        card.origin +
        ", набор " +
        job.datasetId +
        (card.dialogueId ? ", разговор " + card.dialogueId : ""),
      criteria: card.criteria,
      labels: ["agent-lab", card.origin, "card-" + card.id.slice(0, 8)],
    });
    card.scenarioId = scenario.id;
    card.status = "saved";
    card.confirmedBy = userId;
    card.confirmedAt = new Date().toISOString();
    await save(job);
    return card;
  });
}
async function exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
  return serial.run(id, fn);
}
export async function run(
  projectId: string,
  id: string,
  cardId: string,
  agentId: string,
  note: string,
) {
  return exclusive(id, async () => {
    const job = await get(projectId, id);
    assertDispatchKnown(job);
    const card = job.cards.find((c) => c.id === cardId);
    if (!card?.scenarioId) throw new Error("Сначала сохраните сценарий");
    const agents = await api(projectId, "/api/agents");
    if (
      !(agents.data ?? agents).some(
        (a: any) => a.id === agentId && a.type === "http",
      )
    )
      throw new Error("HTTP агент не найден");
    const scenario = await api(projectId, "/api/scenarios/" + card.scenarioId);
    const liveHash = hash({
      situation: scenario.situation,
      criteria: scenario.criteria,
    });
    const [simulator, judge] = await Promise.all([
      resolveModelForFeature("scenarios.user_simulator", { prisma, projectId }),
      resolveModelForFeature("scenarios.judge", { prisma, projectId }),
    ]);
    const modelHash = hash([simulator.model, judge.model]).slice(0, 8);
    const plans = await api(projectId, "/api/suites");
    const name =
      "Agent Lab · " +
      card.id.slice(0, 8) +
      " · " +
      agentId.slice(0, 8) +
      " · " +
      modelHash;
    let plan = (plans.data ?? plans).find((p: any) => p.name === name);
    if (!plan)
      plan = await api(projectId, "/api/suites", {
        name,
        scenarioIds: [card.scenarioId],
        targets: [{ type: "http", referenceId: agentId }],
        repeatCount: 1,
      });
    // Pin the native plan's supported model fields, including on installs whose
    // legacy REST create response omitted them. Never change them on an old run.
    await prisma.simulationSuite.update({
      where: { id: plan.id, projectId },
      data: { simulatorModel: simulator.model, judgeModel: judge.model },
    });
    const last = card.runs.at(-1);
    if (last) {
      const current = await api(projectId, "/api/simulation-runs/" + last.id);
      if (["IN_PROGRESS", "PENDING", "QUEUED"].includes(current.status))
        throw new Error("Предыдущий прогон ещё идёт");
    }
    const started = await api(projectId, "/api/suites/" + plan.id + "/run", {
      note: note || "Проверка " + card.origin + " из реальных логов",
    });
    const run = started.items[0];
    card.runs.push({
      id: run.scenarioRunId,
      agentId,
      definitionHash: liveHash,
      judgeModel: judge.model,
      simulatorModel: simulator.model,
      note,
      at: new Date().toISOString(),
    });
    await save(job);
    return { ...run, status: "QUEUED" };
  });
}
export async function runData(projectId: string, id: string, cardId: string) {
  const job = await get(projectId, id);
  const card = job.cards.find((c) => c.id === cardId);
  if (!card) throw new Error("Карточка не найдена");
  const runs = await Promise.all(
    card.runs.slice(-5).map(async (run) => ({
      ...run,
      data: await api(projectId, "/api/simulation-runs/" + run.id).catch(
        (error) => {
          if (String(error).includes("Simulation run not found"))
            return {
              status: "QUEUED",
              messages: [],
              results: {
                reasoning: "Прогон принят и ожидает начала симуляции",
              },
            };
          throw error;
        },
      ),
    })),
  );
  let comparison: any;
  const [before, after] = runs.slice(-2);
  if (before && after) {
    const sameBatch = !!before.batchId && before.batchId === after.batchId;
    const comparable =
      !sameBatch &&
      before.definitionHash === after.definitionHash &&
      typeof before.data.scenarioVersion === "number" &&
      before.data.scenarioVersion === after.data.scenarioVersion &&
      !!before.judgeModel &&
      before.judgeModel === after.judgeModel &&
      !!before.simulatorModel &&
      before.simulatorModel === after.simulatorModel;
    const sameReplies =
      hash(
        before.data.messages
          ?.filter((m: any) => m.role === "assistant")
          .map((m: any) => m.content),
      ) ===
      hash(
        after.data.messages
          ?.filter((m: any) => m.role === "assistant")
          .map((m: any) => m.content),
      );
    const status = (run: any) => run.data.status;
    comparison = {
      comparable,
      before: status(before),
      after: status(after),
      verdict: sameBatch
        ? "Это повторы одной проверки. Их различие показывает нестабильность, а не исправление агента."
        : !comparable
        ? "Условия изменились или не зафиксированы — вывод об исправлении не доказан"
        : sameReplies && status(before) !== status(after)
          ? "Ответы агента одинаковые. Различие оценок судьи не доказывает изменение агента"
          : status(before) === "FAILED" && status(after) === "SUCCESS"
            ? "В этой ситуации проблема не воспроизвелась после воспроизведения на baseline"
            : status(before) === "SUCCESS" && status(after) === "FAILED"
              ? "Регрессия: ранее сценарий проходил"
              : status(after) === "ERROR"
                ? "Новая версия не измерена"
                : "Нет доказанного исправления",
      limitation:
        "Другие сценарии и обычный трафик этим сравнением не проверяются. Модель судьи и версия агента должны быть зафиксированы в настройках прогона.",
    };
  }
  return { runs, comparison };
}

function loggedSituation(text: string) {
  const turns = messages(text);
  const first = turns.find((t) => t.role === "user");
  const facts = turns.flatMap((t, i) =>
    t.role === "user" && t !== first
      ? [
          turns[i - 1]?.role === "assistant" &&
          turns[i - 1]!.content.trim().endsWith("?")
            ? "Если у вас спрашивают «" +
              turns[i - 1]!.content +
              "», ответьте «" +
              t.content +
              "»."
            : "В дальнейшем вы говорили: «" + t.content + "».",
        ]
      : [],
  );
  return (
    "Вы — клиент из реального обращения. Начните: «" +
    (first?.content ?? "") +
    "».\n" +
    [...new Set(facts)].join("\n") +
    "\nОтвечайте на уточнения естественно. Не перечисляйте все реплики заранее и не добавляйте сведений, которых нет в этой ситуации."
  );
}
async function assembleCards(job: Analysis) {
  const add = async (
    origin: "coverage" | "regression",
    dialogue: Analysis["dialogues"][number],
    rules: Rule[],
    name: string,
  ) => {
    if (
      !rules.length ||
      job.cards.some(
        (c) =>
          c.origin === origin &&
          c.dialogueId === dialogue.id &&
          hash(c.ruleIds.slice().sort()) ===
            hash(rules.map((r) => r.id).sort()),
      )
    )
      return;
    const situation = loggedSituation(dialogue.text);
    const criteria = rules.map(rule => criterionText(rule, job.sources));
    const card: Card = {
      id: randomUUID(),
      origin,
      dialogueId: dialogue.id,
      ruleIds: rules.map((r) => r.id),
      name: name.slice(0, 180),
      situation,
      criteria,
      definitionHash: hash({ situation, criteria }),
      status: "draft",
      generated: true,
      runs: [],
    };
    job.cards.push(card);
    await save(job);
    if (origin === "coverage") {
      const scenario = await api(job.projectId, "/api/scenarios", {
        name: card.name,
        situation:
          card.situation +
          "\n\nИсточник: разговор " +
          dialogue.id +
          ", набор " +
          job.datasetId,
        criteria: card.criteria,
        labels: [
          "agent-lab",
          "coverage",
          "generated",
          "card-" + card.id.slice(0, 8),
        ],
      });
      card.scenarioId = scenario.id;
      card.status = "saved";
      await save(job);
    }
  };
  for (const topic of job.topics.slice(0, 8)) {
    const rules = topic.rules.filter(
      (r) => r.approved && r.observation === "reply" && !unseenCondition(r),
    );
    const dialogue = job.dialogues.find((d) => d.topicId === topic.id);
    if (dialogue)
      await add(
        "coverage",
        dialogue,
        rules,
        "Обычное обращение: " + topic.title,
      );
  }
  const grouped = new Map<
    string,
    { dialogueId: string; verdict: Verdict; count: number }
  >();
  for (const result of job.results)
    for (const verdict of result.rules) {
      if (verdict.status !== "FAIL") continue;
      const old = grouped.get(verdict.ruleId);
      if (old) old.count++;
      else
        grouped.set(verdict.ruleId, {
          dialogueId: result.dialogueId,
          verdict,
          count: 1,
        });
    }
  for (const entry of [...grouped.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)) {
    const dialogue = job.dialogues.find((d) => d.id === entry.dialogueId);
    const rule = checked(job, entry.verdict.ruleId);
    if (dialogue && rule)
      await add(
        "regression",
        dialogue,
        [rule],
        entry.verdict.title || rule.text,
      );
  }
}

export async function runAll(projectId: string, id: string, agentId: string, note: string, repeats = 1) {
  return exclusive(id, async () => {
    const job = await get(projectId, id);
    if (running.has(id) && job.status !== "done") throw new Error("Подготовка ещё идёт");
    const batch = await scheduleBatch(job, agentId, repeats, note, {
      save,
      api: (url, body) => api(projectId, url, body),
      models: async () => {
        const [simulator, judge] = await Promise.all([
          resolveModelForFeature("scenarios.user_simulator", { prisma, projectId }),
          resolveModelForFeature("scenarios.judge", { prisma, projectId }),
        ]);
        return { simulatorModel: simulator.model, judgeModel: judge.model };
      },
      configureSuite: (suiteId, models) => prisma.simulationSuite.update({where:{id:suiteId,projectId},data:models}),
    });
    return batch;
  });
}

export async function runSummary(projectId: string, id: string) {
  const job = await get(projectId, id);
  const latest = job.batches?.at(-1);
  const items = latest ? latest.items : job.cards.filter(c => c.status === "saved").flatMap(card => {
    const run = card.runs.at(-1);
    return run ? [{id:run.id,cardId:card.id,scenarioId:card.scenarioId!}] : [{id:"",cardId:card.id,scenarioId:card.scenarioId!}];
  });
  const rows = await Promise.all(items.map(async item => {
    const card = job.cards.find(card => card.id === item.cardId)!;
    let data: any = {status:"NOT_RUN"};
    if (item.id) try { data = await api(projectId, "/api/simulation-runs/" + item.id); }
    catch (error) {
      data = {status:"QUEUED",results:{reasoning:"Запуск сохранён; результат LangWatch пока недоступен. " + String(error).slice(0,160)}};
    }
    return {id:item.id,cardId:item.cardId,name:card.name,runId:item.id,status:data.status,reason:data.results?.reasoning};
  }));
  return {rows,batch:latest,summary:latest?batchSummary(latest,rows):undefined};
}

/** Continue known unfinished work. Completed judgments are never paid for again. */
export async function resume(projectId: string, id: string) {
  return exclusive(id, async () => {
    const job = await get(projectId, id);
    if (running.has(id)) return view(job);
    if (!["failed","interrupted"].includes(job.status)) throw new Error("Этот разбор не нуждается в продолжении");
    job.error=undefined;
    job.status=job.topics.length?"judging":"planning";
    running.add(id);
    await save(job);
    void (job.topics.length ? judge(job) : plan(job)).finally(()=>running.delete(id));
    return view(job);
  });
}

export const approve = (...args: Parameters<typeof approveUnlocked>) => exclusive(args[1], () => approveUnlocked(...args));

export const evaluate = (...args: Parameters<typeof evaluateUnlocked>) => exclusive(args[1], () => evaluateUnlocked(...args));

export const review = (...args: Parameters<typeof reviewUnlocked>) => exclusive(args[1], () => reviewUnlocked(...args));

export const propose = (...args: Parameters<typeof proposeUnlocked>) => exclusive(args[1], () => proposeUnlocked(...args));

export const changeCard = (...args: Parameters<typeof changeCardUnlocked>) => exclusive(args[1], () => changeCardUnlocked(...args));
