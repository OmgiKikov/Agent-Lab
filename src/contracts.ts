import { importBatchSchema, preparationProgressSchema, scenarioLibrarySchema, type ImportBatch, type ScenarioLibrary, type ScenarioProposal, type SemanticFinding, type PreparationProgress } from './scenario-contracts.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const VERSION = '6';
export const DEFAULT_JUDGE = { provider: 'openrouter', model: 'openai/gpt-5.6-sol', upstream: 'openai' } as const;
export const TOOL_NAMES = ['search_materials', 'lookup_record', 'update_record'] as const;
export type ToolName = typeof TOOL_NAMES[number];
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).refine(v => !['__proto__', 'prototype', 'constructor'].includes(v), 'Reserved identifier');
const text = z.string().trim().min(1);
const dialogueContent = z.string().min(1).max(8000).refine(v => !!v.trim(), 'Empty dialogue content');
const unique = <T>(values: T[]) => new Set(values).size === values.length;
/**
 * Value-like tokens: runs of letters/digits/`:./-` that contain a digit and are at least three
 * characters long after trailing punctuation is trimmed, lower-cased. `4321`, `A103`, `14:00`,
 * `202-7` and `11.03.2024` are tokens; `two cards` has none. Used by the answers rule and by
 * the fabrication heuristic, so both sides of the simulator agree on what a "value" is.
 */
const VALUE_TOKEN = /[A-Za-zА-Яа-яЁё0-9:./-]+/g;
export function valueTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.match(VALUE_TOKEN) ?? []) {
    const token = raw.replace(/[.,:]+$/, '').toLocaleLowerCase();
    if (token.length >= 3 && /\d/.test(token)) tokens.add(token);
  }
  return tokens;
}
export const scalarSchema = z.union([z.string().max(8000), z.number().finite(), z.boolean(), z.null()]);
export const agentSchema = z.strictObject({
  name: text.max(120),
  instructions: text.max(24000),
  tools: z.array(z.enum(TOOL_NAMES)).max(3).refine(unique, 'Duplicate tools'),
});
export type AgentSpec = z.infer<typeof agentSchema>;
/** `kind: 'prompt'` marks the agent's own instructions: rules the user can observe are extracted from it, and the harness grades compliance with them. */
export const sourceKindSchema = z.enum(['knowledge', 'prompt']);
export type SourceKind = z.infer<typeof sourceKindSchema>;
export const materialSchema = z.strictObject({ name: text.max(180), content: text.max(120000), kind: sourceKindSchema.optional() });

/*
 * How the simulated user's side of a dialogue is produced:
 *   reactive  – a model plays the user card and answers the target's actual replies
 *   scripted  – user.script lines are sent in order, ignoring the target's replies
 *   static    – only the opening message; the dialogue ends after the first reply
 * Running the same cards in all three modes measures what the reactive simulator adds.
 */
export const userModeSchema = z.enum(['reactive', 'scripted', 'static']);
export type UserMode = z.infer<typeof userModeSchema>;
export const modelChoiceSchema = z.strictObject({ provider: text.max(120), model: text.max(200) });
export const settingsSchema = z.strictObject({
  provider: z.string().max(120).default(''),
  model: z.string().max(200).default(''),
  judge: z.strictObject({ provider: z.string().min(1).max(120), model: z.string().min(1).max(200), upstream: z.string().min(1).max(120).optional() })
    .refine(v => !v.upstream || v.provider === 'openrouter', 'Judge upstream routing requires OpenRouter').optional(),
  repeats: z.number().int().min(1).max(5).default(2),
  maxIterations: z.number().int().min(1).max(5).default(2),
  maxTurns: z.number().int().min(2).max(16).default(6),
  maxCalls: z.number().int().min(5).max(3000).default(300),
  /** One model call. A reasoning judge on a long trace can take minutes. */
  timeoutMs: z.number().int().min(1000).max(600000).default(120000),
  /** The whole run. Thirty reactive dialogues with a slow agent take about an hour; the owner may allow up to four. */
  maxDurationMs: z.number().int().min(5000).max(14400000).default(600000),
  userModes: z.array(userModeSchema).min(1).max(3).refine(unique, 'Duplicate user modes').default(['reactive']),
  roles: z.strictObject({ builder: modelChoiceSchema.optional(), simulator: modelChoiceSchema.optional(), judge: modelChoiceSchema.optional() }).default({}),
});
export type Settings = z.infer<typeof settingsSchema>;
// A patch must never materialize defaults for keys the caller did not send.
const settingsPatchSchema = z.strictObject({
  provider: settingsSchema.shape.provider.removeDefault(), model: settingsSchema.shape.model.removeDefault(),
  judge: settingsSchema.shape.judge,
  repeats: settingsSchema.shape.repeats.removeDefault(), maxIterations: settingsSchema.shape.maxIterations.removeDefault(),
  maxTurns: settingsSchema.shape.maxTurns.removeDefault(), maxCalls: settingsSchema.shape.maxCalls.removeDefault(),
  timeoutMs: settingsSchema.shape.timeoutMs.removeDefault(), maxDurationMs: settingsSchema.shape.maxDurationMs.removeDefault(),
  userModes: settingsSchema.shape.userModes.removeDefault(),
  roles: z.strictObject({ builder: modelChoiceSchema.nullable().optional(), simulator: modelChoiceSchema.nullable().optional(), judge: modelChoiceSchema.nullable().optional() }),
}).partial();

/*
 * Who answers the simulated user. The sandbox target is a nested Pi session with trusted tools.
 * External targets speak a JSON contract (see targets.ts); their secrets stay in environment variables.
 */
const promptFile = z.string().min(1).max(4000).refine(p => p.startsWith('/'), 'Absolute prompt path required').optional();
const absolutePath = z.string().min(1).max(4000).refine(p => p.startsWith('/'), 'Absolute path required');
/** Deploys the version under test before a run. Identity still comes from the adapter's `version`; the hook only performs the rollout. */
const releaseSchema = z.strictObject({
  command: z.string().min(1).max(4000), args: z.array(z.string().max(4000)).max(50).default([]),
  cwd: absolutePath.optional(), timeoutMs: z.number().int().min(1000).max(600000).default(120000),
}).optional();
export const targetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('sandbox') }),
  z.strictObject({
    kind: z.literal('http'), promptFile, url: z.string().url().max(2000),
    headersEnv: z.record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/, 'Invalid header name'), z.string().regex(/^[A-Z_][A-Z0-9_]{0,99}$/, 'Header values must name environment variables')).default({}),
    timeoutMs: z.number().int().min(1000).max(600000).default(60000),
    release: releaseSchema,
  }),
  z.strictObject({
    kind: z.literal('module'), promptFile, path: z.string().min(1).max(4000).refine(p => p.startsWith('/'), 'Absolute path required'),
    exportName: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/).default('createSession'),
    timeoutMs: z.number().int().min(1000).max(600000).optional(),
    release: releaseSchema,
  }),
  /** A local process (for example `python3 agent.py`) speaking one JSON request/reply per line over stdin/stdout. */
  z.strictObject({
    kind: z.literal('command'), promptFile, command: z.string().min(1).max(4000), args: z.array(z.string().max(4000)).max(50).default([]),
    cwd: z.string().min(1).max(4000).refine(p => p.startsWith('/'), 'Absolute path required').optional(),
    timeoutMs: z.number().int().min(1000).max(600000).default(60000),
    release: releaseSchema,
  }),
]);
export type Target = z.infer<typeof targetSchema>;
export type ReleaseHook = NonNullable<Extract<Target, { kind: 'command' }>['release']>;
export interface ReleaseLog { command: string; exitCode: number | null; signal: string | null; stdout: string; stderr: string; startedAt: string; durationMs: number }
const releaseLogSchema = z.strictObject({ command: z.string().max(8000), exitCode: z.number().int().nullable(), signal: z.string().max(40).nullable(), stdout: z.string().max(4000), stderr: z.string().max(4000), startedAt: text, durationMs: z.number().nonnegative() });

export interface Source { id: string; name: string; content: string; hash: string; kind?: SourceKind }
/** Requirements per run: the budget is stated to the model, and an overshoot is answered with what to do. */
export const REQUIREMENT_LIMIT = 80;
/** Generated cards per run; owner cards come on top. */
export const SCENARIO_LIMIT = 20;
export const requirementSchema = z.strictObject({
  id: identifier, text: text.max(2000), sourceId: identifier, quote: text.max(3000), critical: z.boolean(),
});
export type Requirement = z.infer<typeof requirementSchema>;
export const worldSchema = z.strictObject({
  records: z.record(identifier, z.record(identifier, scalarSchema)).refine(v => Object.keys(v).length <= 30, 'Too many records'),
  writableFields: z.array(identifier).max(16),
  transientFailures: z.number().int().min(0).max(2).default(0),
  /** Opaque state for the agent's own test environment (cards, contracts, tool fixtures). The sandbox ignores it; adapters must apply and confirm it. */
  external: z.record(z.string().max(120), z.json()).optional(),
}).superRefine((v, ctx) => {
  if (v.external !== undefined && JSON.stringify(v.external).length > 20000) ctx.addIssue({ code: 'custom', message: 'External state exceeds 20,000 characters', path: ['external'] });
});
export type World = z.infer<typeof worldSchema>;
/**
 * Which job of the agent this criterion is about. A dialogue is a chain of jobs — understand
 * the request, look things up, act, compose the answer, validate it — and a single end-to-end
 * verdict cannot say which link broke. The label changes nothing in measurement and everything
 * in diagnosis: results are grouped by it. Optional, because a one-step agent has one job.
 */
const stage = { stage: text.max(80).optional() };
const checkBase = { id: identifier, description: text.max(1000), ...stage };
const toolIdentifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:/-]{0,199}$/);
export const checkSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...checkBase, kind: z.literal('state_equals'), recordId: identifier, field: identifier, value: scalarSchema }),
  z.strictObject({ ...checkBase, kind: z.literal('tool_called'), tool: toolIdentifier }),
  z.strictObject({ ...checkBase, kind: z.literal('tool_not_called'), tool: toolIdentifier }),
  z.strictObject({ ...checkBase, kind: z.literal('tool_count'), tool: toolIdentifier, min: z.number().int().min(0).max(1000), max: z.number().int().min(0).max(1000) }),
  z.strictObject({ ...checkBase, kind: z.literal('fresh_read_before_update') }),
  z.strictObject({ ...checkBase, kind: z.literal('answer_contains'), value: text.max(1000) }),
  /** The last assistant reply must match exactly; whitespace, case and newlines are significant. */
  z.strictObject({ ...checkBase, kind: z.literal('answer_equals'), value: z.string().min(1).max(8000) }),
  /** Wording that must never reach the user: internal instructions, staff-only phrasing, forbidden promises. */
  z.strictObject({ ...checkBase, kind: z.literal('answer_omits'), value: text.max(1000) }),
]);
export type Check = z.infer<typeof checkSchema>;
export function describeCheck(check: Check): string {
  if (check.kind === 'state_equals') return `${check.recordId}.${check.field} = ${JSON.stringify(check.value)} в конце диалога`;
  if (check.kind === 'answer_equals') return `Последний ответ в точности: ${JSON.stringify(check.value)}`;
  if (check.kind === 'answer_contains') return `В ответах есть: ${JSON.stringify(check.value)} (без учёта регистра)`;
  if (check.kind === 'answer_omits') return `В ответах нет: ${JSON.stringify(check.value)} (без учёта регистра)`;
  if (check.kind === 'tool_called') return `Есть вызов ${check.tool}`;
  if (check.kind === 'tool_not_called') return `Нет вызовов ${check.tool}`;
  if (check.kind === 'tool_count') return `${check.tool}: от ${check.min} до ${check.max} попыток вызова`;
  return 'Перед каждым изменением — успешное чтение той же записи';
}
export const rubricSchema = z.strictObject({
  id: identifier, name: text.max(120), subject: z.enum(['agent', 'simulator']),
  description: text.max(2000), passCriteria: text.max(2000), failCriteria: text.max(2000), ...stage,
});
export type Rubric = z.infer<typeof rubricSchema>;
export const simulatorFidelity: Rubric = {
  id: 'user_fidelity', name: 'Верность симулятора', subject: 'simulator',
  description: 'Соблюдение заданных фактов, цели, поведения и лимита реплик; персона и характеристики учитываются только если заданы.',
  passCriteria: 'Пользователь следует карточке, отвечает на необходимые уточнения только известными фактами и соблюдает каждое условие остановки. Если карточка требует закончить после достаточной инструкции, дальнейших реплик нет. Не оценивает агента и не выдумывает его ответы или результаты инструментов.',
  failCriteria: 'Пользователь придумывает факты, знает скрытые ответы или состояние, меняет роль, оценивает агента, пропускает обязательное уточнение или продолжает разговор вопреки карточке. Новый вопрос после достаточной инструкции нарушает требование закончить, даже если все сообщённые факты верны. Неудача агента сама по себе не является провалом симулятора.',
};
/** Added by the harness to generated external cards when a source is the agent's own prompt: «по правилам промпта он этого сказать не мог». */
export const promptCompliance: Rubric = {
  id: 'prompt_compliance', name: 'Соблюдение правил промпта', subject: 'agent',
  description: 'Ответ соблюдает явные правила собственного промпта агента (источник с пометкой «промпт агента»): формат ответа, обязательные элементы, запреты. Проверяются только правила, которые пользователь может наблюдать в ответе; внутренние инструкции по инструментам и машинный формат ответа (JSON, именованные поля, обёртка) не оцениваются: клиент их не видит.',
  passCriteria: 'Каждое явное правило промпта, применимое к этому диалогу, соблюдено: формат, обязательные элементы и запреты выполнены. Если ни одно правило не применимо к доставленным репликам, условие выполнено.',
  failCriteria: 'Хотя бы одно явное правило промпта нарушено: неверный формат или структура, пропущен обязательный элемент, сказано запрещённое, дан ответ вне разрешённого периметра. В rationale процитируйте нарушенное правило дословно из источника-промпта и реплику, которая его нарушает.',
};
export const goalAttainment: Rubric = {
  id: 'goal_attainment', name: 'Достижение цели', subject: 'agent',
  description: 'Достиг ли пользователь заявленной цели по наблюдаемым фактам диалога.',
  passCriteria: 'Цель достигнута; если требовалось действие, его результат подтверждён наблюдаемым состоянием или событием инструмента.',
  failCriteria: 'Наблюдаемые факты показывают, что цель не достигнута или достигнута неверно. Одно заявление агента о ненаблюдавшемся действии не доказывает ни успех, ни провал.',
};
export const replyQuality: Rubric = {
  id: 'reply_quality', name: 'Качество ответа', subject: 'agent',
  description: 'Насколько ответ корректен, уместен, заземлён и исполним для пользователя независимо от результата внешнего действия.',
  passCriteria: 'Ответ корректен по материалам владельца, отвечает на запрос и, если следующий шаг нужен, даёт его без выдуманных фактов.',
  failCriteria: 'Ответ неверен, не по существу, неисполняем, противоречит материалам владельца или выдаёт неподтверждённое за факт.',
};
/** Diagnostic-only RAG rubrics. They are added to a judge run only when the adapter reports retrieval events. */
export const ragContextRecall: Rubric = {
  id: 'rag_context_recall', name: 'RAG · нужное знание найдено', subject: 'agent',
  description: 'Содержат ли найденные RAG-фрагменты достаточно информации для ответа по применимым требованиям владельца.',
  passCriteria: 'Найденные RAG-фрагменты содержат все существенные факты и правила, необходимые для корректного ответа на доставленный запрос пользователя.',
  failCriteria: 'В найденных RAG-фрагментах отсутствует хотя бы один существенный факт или правило, без которого нельзя корректно выполнить доставленный запрос пользователя.',
};
export const ragContextRelevance: Rubric = {
  id: 'rag_context_relevance', name: 'RAG · найденное по делу', subject: 'agent',
  description: 'Насколько найденные RAG-фрагменты относятся к доставленному запросу пользователя.',
  passCriteria: 'Найденные RAG-фрагменты относятся к доставленному запросу и не состоят преимущественно из посторонней информации.',
  failCriteria: 'Найденные RAG-фрагменты не относятся к доставленному запросу или преимущественно состоят из посторонней информации, мешающей использовать нужное знание.',
};
export const ragContextFaithfulness: Rubric = {
  id: 'rag_context_faithfulness', name: 'RAG · ответ подтверждён найденным', subject: 'agent',
  description: 'Подтверждаются ли фактические и бизнес-утверждения ответа именно найденными RAG-фрагментами.',
  passCriteria: 'Каждое проверяемое фактическое и бизнес-утверждение ответа подтверждается найденными RAG-фрагментами и не противоречит им.',
  failCriteria: 'Ответ содержит хотя бы одно проверяемое фактическое или бизнес-утверждение, которое не подтверждается найденными RAG-фрагментами или противоречит им.',
};
export const validationExclusionSchema = z.strictObject({
  dialogueId: identifier, kind: z.enum(['customer_data', 'masked', 'length', 'unconfirmed']), reason: text.max(1000),
});
export type ValidationExclusion = z.infer<typeof validationExclusionSchema>;
export const RAG_RUBRICS = [ragContextRecall, ragContextRelevance, ragContextFaithfulness] as const;
export const RAG_METRIC_IDS = new Set<string>(RAG_RUBRICS.map(metric => metric.id));
export const assessmentFindingSchema = z.strictObject({
  criterion: text.max(2000), result: z.enum(['pass', 'fail', 'unknown']), rationale: text.max(1000),
  citations: z.array(z.strictObject({ seq: z.number().int().nonnegative(), quote: z.string().min(1).max(2000) })).max(6),
});
export const metricAssessmentSchema = z.strictObject({
  metricId: identifier, result: z.enum(['pass', 'fail', 'unknown']),
  rationale: text.max(4000), evidence: z.array(z.number().int().nonnegative()).max(30),
  findings: z.array(assessmentFindingSchema).min(1).max(12).optional(),
  citations: z.array(z.strictObject({ seq: z.number().int().nonnegative(), quote: z.string().min(1).max(2000) })).max(30).optional(),
});
export type MetricAssessment = z.infer<typeof metricAssessmentSchema>;
/** The fixed opening belongs to the card, not to the reactive actor. */
export function metricApplies(metric: Rubric, trial: Pick<Trial, 'userMode' | 'events'>): boolean {
  if (RAG_METRIC_IDS.has(metric.id)) return ragEvidenceComplete(trial);
  return metric.id !== 'user_fidelity' || metric.subject !== 'simulator'
    || trial.userMode === 'reactive' && trial.events.some(event => event.type === 'simulator');
}
export const judgeAuditSchema = z.strictObject({
  protocolHash: text, inputHash: text, provider: text, model: text,
  configurationHash: text.optional(),
  transport: z.strictObject({ api: text, upstream: text.optional(), structured: z.boolean() }).optional(),
  prompt: text, input: text,
  attempts: z.array(z.strictObject({
    metricId: identifier.optional(), input: text.optional(),
    startedAt: text, raw: z.string().optional(), error: text.optional(),
    assessments: z.array(metricAssessmentSchema).optional(),
  })).max(24),
  notApplicable: z.array(identifier),
});
export type JudgeAudit = z.infer<typeof judgeAuditSchema>;
/**
 * The small trace a judgment leaves on the trial when the full audit lives in the sidecar
 * `{runId}.judge/{trialId}.json`. It alone never proves a judgment: the verifier re-derives the
 * input hash from the record and re-aggregates these votes against the recorded assessments.
 */
export const judgeReceiptSchema = z.strictObject({
  protocolHash: text, inputHash: text, provider: text, model: text,
  configurationHash: text.optional(),
  transport: z.strictObject({ api: text, upstream: text.optional(), structured: z.boolean() }).optional(),
  auditHash: text,
  votes: z.array(z.strictObject({ metricId: identifier, result: z.enum(['pass', 'fail', 'unknown']).optional(), error: z.boolean().optional() })).max(48),
  notApplicable: z.array(identifier),
  complete: z.boolean(),
});
export type JudgeReceipt = z.infer<typeof judgeReceiptSchema>;
export const userSchema = z.strictObject({
  goal: text.max(3000), facts: text.max(5000), behavior: text.max(2000), opening: text.max(3000),
  maxFollowUps: z.number().int().min(0).max(15).optional(),
  persona: text.max(2000).optional(), characteristics: z.array(text.max(300)).max(12).optional(),
  script: z.array(z.string().min(1).max(3000).refine(v => !!v.trim(), 'Empty user message')).max(15).optional()
    .describe('Follow-up messages AFTER opening, never include opening itself. [] means opening only. Every line must fit maxFollowUps and maxTurns.'),
  /** Atomic facts the user can state, with their exact values. */
  knows: z.array(text.max(300)).max(20).refine(v => unique(v.map(x => x.toLocaleLowerCase())), 'Duplicate known facts').optional(),
  /** What the user cannot know, in words: backend reasons, correct business answers, hidden state. */
  cannotKnow: z.array(text.max(300)).max(20).optional(),
  /** Complete replies to clarifications the agent is likely to ask; the simulator uses them verbatim. */
  answers: z.array(z.strictObject({ ifAsked: text.max(300), reply: text.max(1000) })).max(20).optional(),
});
/**
 * The rung a card occupies. smoke: the basics that must never break, whatever else changes.
 * regression: behaviour that already works and must not get worse. frontier: what the product
 * is still climbing towards, where failures are expected and informative. One flat suite hides
 * the difference between "we broke the product" and "we have not got there yet".
 */
export const tierSchema = z.enum(['smoke', 'regression', 'frontier']);
export type Tier = z.infer<typeof tierSchema>;
export const goalObservationSchema = z.enum(['reply', 'tool', 'state']);
export type GoalObservation = z.infer<typeof goalObservationSchema>;
/** The evidence channel an external agent is judged on when the owner did not pick one. */
export const DEFAULT_GOAL_OBSERVATION: GoalObservation = 'reply';
export const scenarioSchema = z.strictObject({
  id: identifier, familyId: identifier, title: text.max(200),
  requirementIds: z.array(identifier).max(20),
  provenance: z.enum(['synthetic', 'curated', 'production']),
  tier: tierSchema.default('regression'),
  profileId: identifier.optional(),
  user: userSchema, initialState: worldSchema,
  checks: z.array(checkSchema).max(12),
  /** Owner-selected evidence channel. Optional only for legacy/production records. */
  goalObservation: goalObservationSchema.optional(),
  successCriteria: text.max(3000).optional(), assumptions: z.array(text.max(1000)).max(12).optional(),
  metrics: z.array(rubricSchema).max(8).optional(),
});
export type Scenario = z.infer<typeof scenarioSchema> & { split: 'dev' | 'control' };

/** Validate the conversation we will actually send, before spending any target calls. */
export function scriptIssue(user: Scenario['user'], maxTurns: number): string | undefined {
  const available = Math.min(user.maxFollowUps ?? maxTurns - 1, maxTurns - 1);
  if (user.script && user.script.length > available) {
    return `Скрипт содержит ${user.script.length} продолжения, но лимит допускает ${available}. script содержит только реплики после opening; уберите повтор первой реплики или увеличьте лимит.`;
  }
}

/*
 * Real data supplied by the owner:
 *   Dialogue    – a de-identified production conversation; grounds user profiles and fidelity metrics
 *   Profile     – observed persona/characteristics extracted from dialogues, with evidence IDs
 *   GoldenCase  – a human-reviewed test case; becomes a curated scenario without model generation
 */
export const dialogueSchema = z.strictObject({
  id: identifier, goal: text.max(3000).optional(),
  messages: z.array(z.strictObject({ role: z.enum(['user', 'assistant']), content: dialogueContent })).min(1).max(60),
  outcome: z.enum(['success', 'failure', 'abandoned', 'unknown']).default('unknown'),
});
export type Dialogue = z.infer<typeof dialogueSchema>;
export const discoveryDialogueSchema = z.strictObject({
  id: identifier,
  messages: z.array(z.strictObject({ seq: z.number().int().nonnegative(), role: z.enum(['user', 'assistant']), content: dialogueContent })).min(1).max(60),
});
export type DiscoveryDialogue = z.infer<typeof discoveryDialogueSchema>;
const discoveryCitationSchema = z.strictObject({ seq: z.number().int().nonnegative(), quote: z.string().min(1).max(2000) });
export const discoveryObservationSchema = z.strictObject({
  dialogueId: identifier, classification: z.enum(['candidate', 'clean', 'unknown']),
  requirementId: identifier.optional(), summary: text.max(500), citations: z.array(discoveryCitationSchema).max(8).default([]),
}).superRefine((value, ctx) => {
  if (value.classification === 'candidate' && (!value.requirementId || !value.citations.length)) {
    ctx.addIssue({ code: 'custom', message: 'A candidate needs an owner requirement and dialogue evidence.' });
  }
});
export type DiscoveryObservation = z.infer<typeof discoveryObservationSchema>;
export const discoveryGroupSchema = z.strictObject({
  requirementId: identifier, dialogueIds: z.array(identifier).min(1).max(300).refine(unique, 'Duplicate dialogue IDs'),
  summary: text.max(500),
});
export type DiscoveryGroup = z.infer<typeof discoveryGroupSchema>;
const profileFields = {
  id: identifier, persona: text.max(2000).optional(), characteristics: z.array(text.max(300)).max(12).default([]),
  observedStyle: text.max(2000).optional(), evidenceDialogueIds: z.array(identifier).max(50).default([]),
};
const profileOverrideSchema = z.strictObject({ persona: text.max(2000).nullable().optional(), characteristics: z.array(text.max(300)).max(12).optional() })
  .refine(v => Object.keys(v).length > 0, 'Supply a profile change');
/** Persisted observed profiles remain readable for legacy experiment files. */
export const profileSchema = z.strictObject({ ...profileFields, source: z.enum(['observed', 'owner']).default('observed'), draftOverride: profileOverrideSchema.optional() })
  .refine(p => p.source === 'owner' || p.evidenceDialogueIds.length > 0, { message: 'Observed profiles need evidence dialogue IDs', path: ['evidenceDialogueIds'] });
export type Profile = z.infer<typeof profileSchema>;
/** Original evidence remains immutable; null explicitly removes the persona from linked cards. */
export function profileUser(profile: Profile): Pick<Scenario['user'], 'persona' | 'characteristics'> {
  const persona = profile.draftOverride?.persona !== undefined ? profile.draftOverride.persona : profile.persona;
  return { ...(persona ? { persona } : {}), characteristics: [...(profile.draftOverride?.characteristics ?? profile.characteristics)] };
}
/** Profiles the owner writes by hand: a legitimate way to describe users when no dialogues exist. Synthetic, and labelled so. */
export const ownerProfileSchema = z.strictObject({ ...profileFields, source: z.literal('owner').default('owner') });
export const goldenCaseSchema = z.strictObject({
  id: identifier, familyId: identifier.optional(), title: text.max(200).optional(), tier: tierSchema.default('regression'),
  goal: text.max(3000), opening: text.max(3000),
  facts: text.max(5000).default('No additional facts beyond the opening request.'), persona: text.max(2000).optional(),
  characteristics: z.array(text.max(300)).max(12).default([]),
  behavior: text.max(2000).default('Ask once; answer clarifications from the known facts; finish when the request is answered.'),
  script: z.array(text.max(3000)).max(15).optional(), maxFollowUps: z.number().int().min(0).max(15).default(1),
  successCriteria: text.max(3000), initialState: worldSchema.default({ records: {}, writableFields: [], transientFailures: 0 }),
  checks: z.array(checkSchema).max(12).default([]), metrics: z.array(rubricSchema).max(8).default([]),
  knows: userSchema.shape.knows, cannotKnow: userSchema.shape.cannotKnow, answers: userSchema.shape.answers,
});
export type GoldenCase = z.infer<typeof goldenCaseSchema>;
export function goldenToScenario(c: GoldenCase): Omit<Scenario, 'split'> {
  return {
    id: c.id, familyId: c.familyId ?? c.id, title: c.title ?? c.goal.slice(0, 200), requirementIds: [], provenance: 'curated', tier: c.tier,
    user: {
      goal: c.goal, facts: c.facts, behavior: c.behavior, opening: c.opening, maxFollowUps: c.maxFollowUps,
      ...(c.persona ? { persona: c.persona } : {}), ...(c.characteristics.length ? { characteristics: c.characteristics } : {}), ...(c.script ? { script: c.script } : {}),
      ...(c.knows ? { knows: c.knows } : {}), ...(c.cannotKnow ? { cannotKnow: c.cannotKnow } : {}), ...(c.answers ? { answers: c.answers } : {}),
    },
    initialState: c.initialState, checks: c.checks, successCriteria: c.successCriteria,
    assumptions: ['Curated golden case supplied by the owner; not generated by a model.'], metrics: c.metrics,
  };
}

/*
 * ObservedGoal: what a real user actually tried to do, extracted from production dialogues.
 * The opening is the real user's own message, verbatim; it becomes a production card without model-written text.
 */
export const observedGoalSchema = z.strictObject({
  id: identifier, goal: text.max(3000), opening: text.max(3000), profileId: identifier.optional(),
  requirementIds: z.array(identifier).max(20).refine(unique, 'Duplicate requirement IDs').optional(),
  evidenceDialogueIds: z.array(identifier).min(1).max(50), successCriteria: text.max(3000),
  facts: text.max(5000).default('Only what the real user revealed in the evidence dialogues.'),
  testability: z.enum(['knowledge', 'customer_data', 'unknown']).optional(),
  testabilityReason: text.max(1000).optional(),
  outcome: z.enum(['success', 'failure', 'abandoned', 'unknown']).default('unknown'),
});
export type ObservedGoal = z.infer<typeof observedGoalSchema>;
export function validateObservedGoals(goals: ObservedGoal[], dialogues: Pick<Dialogue, 'id' | 'messages'>[], profiles: Profile[]): void {
  if (!unique(goals.map(g => g.id))) throw new Error('Observed goals have duplicate IDs');
  const byId = new Map(dialogues.map(d => [d.id, d]));
  for (const goal of goals) {
    if (goal.profileId !== undefined && !profiles.some(p => p.id === goal.profileId)) throw new Error(`Observed goal ${goal.id} references an unknown profileId ${goal.profileId}`);
    const evidence = goal.evidenceDialogueIds.map(id => byId.get(id));
    if (evidence.some(d => !d)) throw new Error(`Observed goal ${goal.id} cites a dialogue that was not supplied`);
    if (!evidence.some(d => d!.messages.some(m => m.role === 'user' && m.content.trim() === goal.opening.trim()))) {
      throw new Error(`Observed goal ${goal.id} opening is not a verbatim user message from its evidence dialogues`);
    }
  }
}
export function goalToScenario(goal: ObservedGoal, profile?: Profile): Omit<Scenario, 'split'> {
  return {
    id: goal.id, familyId: goal.id, title: goal.goal.slice(0, 200), requirementIds: goal.requirementIds ?? [], provenance: 'production', tier: 'regression', profileId: goal.profileId,
    user: {
      goal: goal.goal, facts: goal.facts, opening: goal.opening, maxFollowUps: 2,
      behavior: 'Behave like the real user in the evidence dialogues: answer clarifications from the known facts, stop when the goal is reached or clearly blocked.',
      ...(profile ? profileUser(profile) : {}),
    },
    initialState: { records: {}, writableFields: [], transientFailures: 0 }, checks: [], successCriteria: goal.successCriteria,
    assumptions: [`Derived from a real dialogue (${goal.evidenceDialogueIds.join(', ')}); the opening is the real user's own message and the success criteria require owner review.`],
    metrics: [
      { id: 'goal_attainment', name: 'Goal attainment', subject: 'agent', description: 'Did the user get what they came for, as the real user would judge it.', passCriteria: 'The stated goal is reached or the user is told clearly and correctly why it cannot be.', failCriteria: 'The goal is not reached and no correct explanation is given, or the answer contradicts the success criteria.' },
      { id: 'perimeter', name: 'Stays within the agent perimeter', subject: 'agent', description: 'The agent answers only what it is meant to answer and grounds answers in its materials.', passCriteria: 'Answers stay within the described perimeter and materials; out-of-scope requests are declined or redirected.', failCriteria: 'The agent answers outside its perimeter, invents facts, or fails to decline an out-of-scope request.' },
      { ...simulatorFidelity },
    ],
  };
}

export function dialogueToScenario(dialogue: Dialogue, criteria: { goal: string; successCriteria?: string; requirementIds?: string[]; goalObservation?: GoalObservation }): Omit<Scenario, 'split'> {
  const userMessages = dialogue.messages.filter(message => message.role === 'user');
  const opening = userMessages[0]?.content;
  if (!opening) throw new Error(`В записанном диалоге ${dialogue.id} нет реплики пользователя.`);
  const script = userMessages.slice(1).map(message => message.content);
  // ponytail: long production evidence is not a runnable script; Phase 3 builds a separate accepted test from it.
  const replayable = script.length <= 15;
  return {
    id: dialogue.id, familyId: dialogue.id, title: criteria.goal.slice(0, 200), requirementIds: [...(criteria.requirementIds ?? [])],
    provenance: 'production', tier: 'regression',
    user: {
      goal: criteria.goal, facts: 'Только факты, сообщённые пользователем в записанном диалоге.',
      behavior: replayable ? 'Воспроизводить реплики пользователя из записи в исходном порядке.'
        : 'Полный длинный диалог хранится как неизменяемое доказательство; отдельный тест строится после принятия гипотезы.',
      opening, maxFollowUps: replayable ? script.length : 0, ...(replayable ? { script } : {}),
    },
    initialState: { records: {}, writableFields: [], transientFailures: 0 }, checks: [], goalObservation: criteria.goalObservation ?? DEFAULT_GOAL_OBSERVATION,
    ...(criteria.successCriteria ? { successCriteria: criteria.successCriteria } : {}),
    assumptions: [`Recorded dialogue ${dialogue.id}; no target or simulator execution and no observed external state.`],
    metrics: [{ ...goalAttainment }, { ...replyQuality }],
  };
}

export function dialogueToTrial(dialogue: Dialogue, scenario: Scenario, revisionId: string): Trial {
  const initialState: World = { records: {}, writableFields: [], transientFailures: 0 };
  return {
    id: dialogue.id, revisionId, scenarioId: scenario.id, familyId: scenario.familyId, repeat: 0, userMode: 'scripted',
    split: scenario.split, manifestHash: 'unreviewed', outcome: 'ungraded',
    reason: 'Записанный диалог импортирован без повторного запуска агента; семантическая оценка ещё не выполнялась.',
    checks: [], events: dialogue.messages.map((message, seq) => ({ seq, type: message.role, text: message.content })),
    initialState, finalState: structuredClone(initialState), usage: emptyUsage(), elapsedMs: 0,
    observation: { state: 'missing', tools: 'partial' },
  };
}

/** Recorded turns provide facts, never an unconditional script for a new agent conversation. */
export function validationScenario(dialogue: Dialogue, goal: ObservedGoal): Omit<Scenario, 'split'> {
  const scenario = dialogueToScenario(dialogue, goal);
  const quotes = dialogue.messages.filter(message => message.role === 'user').map(message => message.content);
  delete scenario.user.script;
  scenario.user.facts = goal.facts;
  scenario.user.knows = [...new Map(quotes.filter(quote => quote.length <= 300).map(quote => [quote.toLocaleLowerCase(), quote])).values()].slice(0, 20);
  scenario.user.cannotKnow = ['Правильный бизнес-ответ, скрытые данные клиента и состояние банковских систем.'];
  scenario.user.maxFollowUps = 5;
  scenario.user.behavior = 'Ответь на текущий вопрос агента, используя только известные факты. Старые реплики — факты, а не порядок разговора. Каждый раз, когда агент называет другую организацию, точку или объект, поправь его. Если нужного факта нет, скажи, что не знаешь. Если агент отказал, сказал, что не может ответить, передал вопрос оператору или на другую линию, заверши разговор пустым сообщением: ничего больше не пиши.';
  scenario.assumptions = [`Источник фактов клиента: ${dialogue.id}. Продолжения генерирует симулятор по текущим вопросам; ответы старого агента не являются эталоном.`];
  scenario.metrics!.push({ ...simulatorFidelity });
  return scenario;
}

export const createInputSchema = z.strictObject({
  task: text.max(8000),
  originalImport: importBatchSchema.optional(),
  /** Owner-confirmed hypothesis that requests the strict one-test preparation path. */
  confirmedHypothesis: text.max(3000).optional(),
  goalObservation: goalObservationSchema.optional(),
  materials: z.array(materialSchema).min(1).max(12),
  mode: z.enum(['demo', 'live']),
  settings: settingsSchema.default(() => settingsSchema.parse({})),
  existingAgent: agentSchema.optional(),
  workflow: z.enum(['evaluate', 'compare']).default('evaluate'),
  /** 0 means: run only the owner's own cards and generate nothing. */
  scenarioCount: z.number().int().min(0).max(SCENARIO_LIMIT).default(5),
  /** Build reactive prompt/RAG cards where owner requirements define the answer without unavailable customer data. */
  validationCount: z.number().int().min(1).max(SCENARIO_LIMIT).optional(),
  target: targetSchema.default({ kind: 'sandbox' }),
  targetVersion: text.max(200).optional(),
  goldenCases: z.array(goldenCaseSchema).max(40).default([]),
  dialogues: z.array(dialogueSchema).max(200).default([]),
  /** The owner's own hints about users, goals and situations. First-class input for cards; never a business rule. */
  notes: z.string().trim().max(8000).default(''),
  profiles: z.array(ownerProfileSchema).max(6).default([]),
}).superRefine((v, ctx) => {
  if (v.materials.reduce((n, m) => n + m.content.length, 0) > 300000) ctx.addIssue({ code: 'custom', message: 'Materials exceed 300,000 characters', path: ['materials'] });
  if (v.dialogues.reduce((n, d) => n + d.messages.reduce((m, x) => m + x.content.length, 0), 0) > 2000000) ctx.addIssue({ code: 'custom', message: 'Dialogues exceed 2,000,000 characters', path: ['dialogues'] });
  if (!unique(v.dialogues.map(d => d.id))) ctx.addIssue({ code: 'custom', message: 'Duplicate dialogue IDs', path: ['dialogues'] });
  if (!unique(v.goldenCases.map(g => g.id))) ctx.addIssue({ code: 'custom', message: 'Duplicate golden case IDs', path: ['goldenCases'] });
  if (v.scenarioCount === 0 && !v.goldenCases.length && !v.dialogues.length && !v.originalImport?.dialogues.length) {
    ctx.addIssue({ code: 'custom', message: 'scenarioCount 0 needs golden cases or production dialogues to have anything to run', path: ['scenarioCount'] });
  }
  if (!unique(v.profiles.map(p => p.id))) ctx.addIssue({ code: 'custom', message: 'Duplicate profile IDs', path: ['profiles'] });
  if (v.confirmedHypothesis && (v.workflow !== 'evaluate' || v.scenarioCount !== 1 || v.goldenCases.length)) {
    ctx.addIssue({ code: 'custom', message: 'A confirmed hypothesis builds exactly one generated evaluate test without golden cases', path: ['confirmedHypothesis'] });
  }
  if (v.validationCount && (v.workflow !== 'evaluate' || v.scenarioCount !== 0 || !v.dialogues.length && !v.originalImport?.dialogues.length)) {
    ctx.addIssue({ code: 'custom', message: 'validationCount needs evaluate, scenarioCount 0 and real dialogues', path: ['validationCount'] });
  }
  if (v.confirmedHypothesis && !v.goalObservation) {
    ctx.addIssue({ code: 'custom', message: 'A confirmed hypothesis needs an owner-selected goal observation', path: ['goalObservation'] });
  }
});
export type CreateInput = z.infer<typeof createInputSchema>;

export const discoverInputSchema = z.strictObject({
  task: text.max(8000), materials: z.array(materialSchema).min(1).max(12), mode: z.enum(['demo', 'live']),
  settings: settingsSchema.default(() => settingsSchema.parse({})), existingAgent: agentSchema.optional(),
  target: targetSchema.default({ kind: 'sandbox' }), targetVersion: text.max(200).optional(),
  dialogues: z.array(dialogueSchema).min(1).max(300), notes: z.string().trim().max(8000).default(''),
}).superRefine((value, ctx) => {
  if (value.materials.reduce((sum, item) => sum + item.content.length, 0) > 300000) {
    ctx.addIssue({ code: 'custom', message: 'Materials exceed 300,000 characters', path: ['materials'] });
  }
  if (value.dialogues.reduce((sum, dialogue) => sum + dialogue.messages.reduce((n, message) => n + message.content.length, 0), 0) > 2000000) {
    ctx.addIssue({ code: 'custom', message: 'Dialogues exceed 2,000,000 characters', path: ['dialogues'] });
  }
  if (!unique(value.dialogues.map(dialogue => dialogue.id))) ctx.addIssue({ code: 'custom', message: 'Duplicate dialogue IDs', path: ['dialogues'] });
});
export type DiscoverInput = z.infer<typeof discoverInputSchema>;

export const preparationSchema = z.strictObject({
  requirements: z.array(requirementSchema).min(1).max(REQUIREMENT_LIMIT),
  questions: z.array(text.max(2000)).max(12),
  agent: agentSchema,
  scenarios: z.array(scenarioSchema).max(200),
});
export interface Preparation {
  requirements: Requirement[]; questions: string[]; agent: AgentSpec; scenarios: Scenario[];
}
export interface Revision { id: string; parentId: string | null; spec: AgentSpec; hypothesis: string; createdAt: string }
export type Outcome = 'pass' | 'fail' | 'ungraded' | 'invalid' | 'cancelled';
export interface Usage { calls: number; inputTokens: number; outputTokens: number; costUsd: number | null }
export const emptyUsage = (): Usage => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
export interface TraceEvent {
  seq: number; type: 'user' | 'assistant' | 'simulator' | 'retrieval' | 'tool_call' | 'tool_result' | 'error';
  text?: string; tool?: string; args?: unknown; result?: unknown; state?: World;
}
export const assessmentEventContent = (event: TraceEvent): string =>
  event.text !== undefined && [event.tool, event.args, event.result, event.state].every(value => value === undefined) ? event.text
    : JSON.stringify({ text: event.text, tool: event.tool, args: event.args, result: event.result, state: event.state });
export interface CheckResult { id: string; description: string; passed: boolean; evidence: string }
export const SIMULATOR_PROTOCOL = 'simulator-2';
export const SIMULATOR_CHECK_IDS = ['simulator_leak', 'simulator_fabrication', 'simulator_loop'] as const;
export type SimulatorCheckId = typeof SIMULATOR_CHECK_IDS[number];
/** A code predicate over the simulated user's own replies. Never an agent grade; never shown to the judge. */
export interface SimulatorCheck { id: SimulatorCheckId; description: string; passed: boolean; evidence: string; seq?: number; heuristic: boolean }
export interface Trial {
  id: string; revisionId: string; scenarioId: string; familyId: string; repeat: number; userMode: UserMode;
  split: 'dev' | 'control'; manifestHash: string; outcome: Outcome; reason: string;
  checks: CheckResult[]; simulatorChecks?: SimulatorCheck[]; events: TraceEvent[]; initialState: World; finalState: World;
  usage: Usage; elapsedMs: number;
  assessments?: MetricAssessment[]; assessmentError?: string; judgeAudit?: JudgeAudit; judgeReceipt?: JudgeReceipt;
  observation?: { state: 'sandbox' | 'reported' | 'missing'; tools: 'sandbox' | 'complete' | 'partial'; resetConfirmed?: boolean; version?: string; toolScope?: string[] };
  externalUsage?: Usage;
}
/** Keep RAG diagnosis outside the frozen card: it appears only when the target exposes retrieval evidence. */
export function assessmentRubrics(scenario: Pick<Scenario, 'metrics'>, trial: Pick<Trial, 'events'>): Rubric[] {
  const metrics = [...(scenario.metrics ?? [])];
  if (!trial.events.some(event => event.type === 'retrieval')) return metrics;
  for (const rubric of RAG_RUBRICS) if (!metrics.some(metric => metric.id === rubric.id)) metrics.push(rubric);
  return metrics;
}
/** Absence of a chunk is evidence only when the adapter confirms the full context for every delivered reply. */
export function ragEvidenceComplete(trial: Pick<Trial, 'events'>): boolean {
  let complete = false, replies = 0;
  for (const event of trial.events) {
    if (event.type === 'user') complete = false;
    if (event.type === 'retrieval') {
      const value = event.result as { complete?: unknown; chunks?: unknown } | undefined;
      complete = value?.complete === true && Array.isArray(value.chunks);
    }
    if (event.type === 'assistant') { if (!complete) return false; replies++; }
  }
  return replies > 0;
}
export const simulatorWasUsed = (trial: Trial) => trial.userMode === 'reactive' && trial.events.some(e => e.type === 'simulator');
export function validateAssessments(metrics: Rubric[], events: TraceEvent[], raw: unknown): MetricAssessment[] {
  const assessments = z.array(metricAssessmentSchema).parse(raw);
  const metricIds = new Set(metrics.map(metric => metric.id));
  if (metricIds.size !== metrics.length || assessments.length !== metricIds.size
    || new Set(assessments.map(a => a.metricId)).size !== metricIds.size || assessments.some(a => !metricIds.has(a.metricId))) {
    throw new Error('Assessment must cover every requested metric exactly once');
  }
  const eventIds = new Set(events.map(event => event.seq));
  for (const assessment of assessments) {
    if (assessment.evidence.some(seq => !eventIds.has(seq))) throw new Error(`Assessment ${assessment.metricId} cites a nonexistent trace event`);
    if (assessment.result !== 'unknown' && !assessment.evidence.length) throw new Error(`Assessment ${assessment.metricId} needs trace evidence for pass/fail`);
    if (assessment.citations) {
      const cited = new Set(assessment.citations.map(c => c.seq));
      if (cited.size !== assessment.evidence.length || assessment.evidence.some(seq => !cited.has(seq))) throw new Error('Evidence must match quoted citations.');
      for (const citation of assessment.citations) {
        const event = events.find(e => e.seq === citation.seq);
        if (!event || !assessmentEventContent(event).includes(citation.quote)) throw new Error(`Citation #${citation.seq} is not a verbatim quote from that event's content.`);
      }
    }
    if (!assessment.findings) continue; // Historical assessments retain their original evidence format.
    const metric = metrics.find(m => m.id === assessment.metricId)!;
    for (const finding of assessment.findings) {
      if (![metric.description, metric.passCriteria, metric.failCriteria].some(text => text.includes(finding.criterion))) {
        throw new Error('Each criterion must be copied verbatim from the supplied rubric; do not invent requirements.');
      }
      if (finding.result !== 'unknown' && !finding.citations.length) throw new Error('Every pass/fail finding needs a quoted trace event.');
      for (const citation of finding.citations) {
        const event = events.find(e => e.seq === citation.seq);
        if (!event || !assessmentEventContent(event).includes(citation.quote)) throw new Error(`Citation #${citation.seq} is not a verbatim quote from that event's content.`);
      }
    }
    const expected = assessment.findings.some(f => f.result === 'fail') ? 'fail' : assessment.findings.some(f => f.result === 'unknown') ? 'unknown' : 'pass';
    const cited = new Set(assessment.findings.flatMap(f => f.citations.map(c => c.seq)));
    if (assessment.result !== expected || cited.size !== assessment.evidence.length || assessment.evidence.some(seq => !cited.has(seq))) {
      throw new Error('Assessment result and evidence must match its findings.');
    }
  }
  return assessments;
}
export interface Comparison {
  baselineId: string; candidateId: string; manifestHash: string; split: 'dev' | 'control';
  plannedPairs: number; validPairs: number; invalidPairs: number; families: number;
  baselinePasses: number; candidatePasses: number; fixed: number; regressed: number; tied: number;
  delta: number | null; interval: [number, number] | null;
  verdict: 'improved' | 'regressed' | 'no_change' | 'insufficient' | 'incomparable';
  reasons: string[]; cases: { scenarioId: string; baselinePasses: number; candidatePasses: number; repeats: number }[];
}
/** The judgment a human verdict refers to: the judge protocol and the exact input it was asked about. */
export const judgeSnapshotSchema = z.strictObject({ protocolHash: text, inputHash: text });
export type JudgeSnapshot = z.infer<typeof judgeSnapshotSchema>;
export const humanReviewInputSchema = z.strictObject({
  trialId: identifier, metricId: identifier.optional(), checkId: identifier.optional(),
  verdict: z.enum(['pass', 'fail', 'unknown', 'invalid']), note: text.max(3000), reviewedDialogue: z.literal(true).optional(),
  durationMs: z.number().int().nonnegative().max(3600000).optional(),
  /** A one-key agreement mark on a metric that decided the situation (outcomes.ts markTargets). */
  source: z.literal('quick').optional(),
  /** The recorded judge result the person saw; filled and checked by the lab, never trusted from a caller. */
  judgeVerdict: z.enum(['pass', 'fail', 'unknown']).optional(),
  /** The judgment the person agreed or disagreed with; absent when the trial has neither receipt nor audit (demo). */
  judge: judgeSnapshotSchema.optional(),
  /** The counting rule a quick mark was given under (COUNTING_RULES); filled by the lab, never trusted from a caller. */
  countingRules: text.optional(),
}).refine(v => !(v.metricId && v.checkId), 'Review either one metric, one check, or the whole trial')
  .refine(v => !v.reviewedDialogue || (!v.metricId && !v.checkId), 'Only a whole-dialogue verdict can mark a complete review')
  .refine(v => v.source !== 'quick' || (!!v.metricId && v.verdict !== 'invalid'), 'Быстрая отметка ставится на одну оценку судьи.');
export type HumanReviewInput = z.infer<typeof humanReviewInputSchema>;
export type HumanReview = HumanReviewInput & { id: string; createdAt: string };
const humanReviewSchema = humanReviewInputSchema.safeExtend({ id: identifier, createdAt: text });
export const draftPatchSchema = z.strictObject({
  /** Full cards to update or add by id. Omitted cards are always preserved. */
  scenarios: z.array(scenarioSchema.extend({ split: z.enum(['dev', 'control']).optional() })).min(1).max(40)
    .refine(cards => unique(cards.map(card => card.id)), 'Повторяются идентификаторы изменяемых карточек.').optional(),
  removeScenarioIds: z.array(identifier).min(1).max(40)
    .refine(unique, 'Повторяются идентификаторы удаляемых карточек.').optional(),
  profileEdits: z.array(z.strictObject({ id: identifier, override: profileOverrideSchema.nullable() })).min(1).max(12)
    .refine(edits => unique(edits.map(e => e.id)), 'Duplicate profile edits').optional(),
  agent: agentSchema.optional(), settings: settingsPatchSchema.optional(),
  target: targetSchema.optional(), targetVersion: text.max(200).optional(),
}).refine(v => Object.keys(v).length > 0, 'Supply a draft change')
  .refine(v => !v.scenarios?.some(card => v.removeScenarioIds?.includes(card.id)), 'Нельзя одновременно изменить и удалить одну карточку.');
export const reassessmentSchema = z.strictObject({
  criteria: z.array(z.strictObject({ scenarioId: identifier, successCriteria: text.max(3000).optional(),
    checks: z.array(checkSchema).max(12).optional(), metrics: z.array(rubricSchema).max(8).optional(),
  })).max(200).refine(v => unique(v.map(c => c.scenarioId)), 'Duplicate scenario criteria').default([]),
  trialIds: z.array(identifier).min(1).max(3000).refine(unique, 'Duplicate trial IDs').optional(),
  judge: settingsSchema.shape.judge, codeOnly: z.boolean().default(false),
});
export type ReassessmentInput = z.input<typeof reassessmentSchema>;
export type DraftPatch = z.infer<typeof draftPatchSchema>;
export const DISCOVERY_PROTOCOL = 'discovery-1';
const discoveryCallPlanFields = z.strictObject({
  batches: z.number().int().nonnegative(), selectedCap: z.number().int().min(0).max(5), metrics: z.number().int().min(1).max(8),
  nominalCalls: z.number().int().nonnegative(), maxCalls: z.number().int().positive(),
  baseMaxCalls: z.number().int().positive(),
  baseMaxDurationMs: z.number().int().positive(),
  maxDurationMs: z.number().int().positive(),
  legacyBudgetMissing: z.boolean().optional(),
});
export const discoveryCallPlanSchema = z.preprocess(value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const plan = value as Record<string, unknown>;
  if (plan.baseMaxCalls !== undefined && plan.baseMaxDurationMs !== undefined && plan.maxDurationMs !== undefined) return value;
  return { ...plan, baseMaxCalls: 5, baseMaxDurationMs: 5000, maxDurationMs: 5000, legacyBudgetMissing: true };
}, discoveryCallPlanFields);
export type DiscoveryCallPlan = z.infer<typeof discoveryCallPlanSchema>;
export interface DiscoveryPlan extends Omit<DiscoveryCallPlan, 'batches' | 'legacyBudgetMissing'> {
  batches: DiscoveryDialogue[][];
  batchCount: number;
  oversizedIds: string[];
  seed: string;
}
export const discoveryDeepResultSchema = z.strictObject({
  dialogueId: identifier, role: z.enum(['representative', 'control']),
  /** Key of this judgment's sidecar `{runId}.judge/{judgeTrialId}.json` and journal entries; absent in older records. */
  judgeTrialId: identifier.optional(),
  goal: observedGoalSchema.optional(), assessments: z.array(metricAssessmentSchema).max(8).optional(), error: text.max(4000).optional(),
});
export const discoveryHypothesisSchema = z.strictObject({
  text: text.max(3000), proposedGoalObservation: z.literal('reply'), requirementId: identifier,
  eventIds: z.array(z.strictObject({ dialogueId: identifier, seq: z.number().int().nonnegative() })).min(1).max(24),
});
export type DiscoveryHypothesis = z.infer<typeof discoveryHypothesisSchema>;
export const discoveryRecordSchema = z.strictObject({
  protocol: z.literal(DISCOVERY_PROTOCOL),
  phase: z.enum(['running', 'ready', 'insufficient', 'partial', 'budget_exhausted', 'error']),
  error: z.string().max(4000).nullable(), requirements: z.array(requirementSchema).max(REQUIREMENT_LIMIT),
  observations: z.array(discoveryObservationSchema).max(300), seed: text,
  focusRequirementId: identifier.optional(), representativeIds: z.array(identifier).max(3), controlIds: z.array(identifier).max(2), selectedIds: z.array(identifier).max(5),
  completedBatchCount: z.number().int().nonnegative(), groupingComplete: z.boolean(), completedDeepIds: z.array(identifier).max(5),
  groups: z.array(discoveryGroupSchema).max(80).optional(),
  activeCall: text.max(200).optional(),
  deep: z.array(discoveryDeepResultSchema).max(5), hypothesis: discoveryHypothesisSchema.optional(),
  callPlan: discoveryCallPlanSchema, callsUsed: z.number().int().nonnegative(), elapsedMs: z.number().int().nonnegative().optional(),
  totalDialogues: z.number().int().min(1).max(300), oversizedIds: z.array(identifier).max(300),
});
export type DiscoveryRecord = z.infer<typeof discoveryRecordSchema>;
export type DiscoveryRuntimeInput =
  | { kind: 'requirements'; task: string; sources: Source[] }
  | { kind: 'coarse'; requirements: Requirement[]; dialogues: DiscoveryDialogue[] }
  | { kind: 'group'; requirements: Requirement[]; observations: DiscoveryObservation[] }
  | { kind: 'hypothesis'; requirement: Requirement; observations: DiscoveryObservation[]; deep: z.infer<typeof discoveryDeepResultSchema>[] };
export type DiscoveryRuntimeOutput =
  | { kind: 'requirements'; requirements: Requirement[]; questions: string[] }
  | { kind: 'coarse'; observations: DiscoveryObservation[] }
  | { kind: 'group'; groups: DiscoveryGroup[] }
  | { kind: 'hypothesis'; hypothesis: string };
export type Phase = 'preparing' | 'review' | 'evaluating' | 'results_review' | 'baseline' | 'improving' | 'control' | 'complete' | 'cancelled' | 'error' | 'interrupted';
export interface AcceptedTest {
  testId: string; scenarioId: string; definitionHash: string; acceptedAt: string;
}
/**
 * What the source run was when its evidence was embedded: the agent, the evaluator, the judge and
 * each card's comparison identity. A run rebuilt from embedded evidence has no other trustworthy
 * copy of these fields. Absent in records written before it existed.
 */
export interface SourceIdentity {
  libraryHash?: string; importHash?: string;
  targetFingerprint?: string; targetVersion?: string; evaluatorVersion?: string; manifestHash: string | null;
  /** Fingerprint of the baseline agent definition (the sandbox agent or the reviewed external spec). */
  agent: string;
  /** Fingerprint of the configured judge (provider, model, upstream). */
  judge: string;
  /** Scenario id → fingerprint of its normalized comparison identity. */
  scenarios: Record<string, string>;
}
export interface Experiment {
  librarySnapshot?: ScenarioLibrary;
  originalImport?: { id: string; contentHash: string };
  preparationProgress?: PreparationProgress;
  schemaVersion: '1'; id: string; task: string; mode: 'demo' | 'live'; workflow: 'evaluate' | 'compare';
  createdAt: string; updatedAt: string; phase: Phase; message: string;
  sources: Source[]; settings: Settings; target: Target; requirements: Requirement[]; questions: string[];
  goldenCases: GoldenCase[]; dialogues: Dialogue[]; profiles: Profile[]; notes: string;
  scenarios: Scenario[]; revisions: Revision[]; selectedRevisionId: string | null;
  manifestHash: string | null; reviewedAt: string | null;
  /**
   * Who checked what before the run. `expectations`: the owner confirmed the expectations of the
   * situations in the run dialog — narrower than `human`, which also means a person reviewed the
   * card definitions. Neither ever means a person checked the judge's verdicts.
   */
  reviewMode: 'human' | 'expectations' | 'automated' | null; controlConsumedAt: string | null;
  acceptedDraftHash?: string;
  /** Portable identity of explicitly accepted scenario definitions. Optional only for legacy in-memory fixtures. */
  acceptedTests?: AcceptedTest[];
  trials: Trial[]; comparisons: Comparison[]; iterations: { revisionId: string; accepted: boolean; reason: string }[];
  usage: Usage; error: string | null; limitations: string[];
  humanReviews: HumanReview[]; resultsReviewedAt?: string; resultsReviewHash?: string;
  /** Named clusters over the failed dialogues of this run; the bridge from evaluation to fixing. */
  failureModes?: FailureMode[];
  releaseLog?: ReleaseLog;
  /** Recorded dialogues left out of a validation set, with the reason; they never enter the accuracy denominator. */
  validationExclusions?: ValidationExclusion[];
  parentRunId?: string;
  selectedScenarioIds?: string[];
  /** Real situations the agent is known to handle. Shown apart from the headline number and never counted in it. */
  positiveControlScenarioIds?: string[];
  /** Situations whose expectation the owner wrote in their own words; they cannot be compared with runs before the change. */
  ownerExpectationScenarioIds?: string[];
  targetVersion?: string;
  targetFingerprint?: string;
  evaluatorVersion?: string;
  targetRelease?: string;
  sourceEvidence?: { runId: string; parentRunId?: string; trials: Trial[]; humanReviews: HumanReview[]; identity?: SourceIdentity };
  clarifications?: { question: string; answer: string }[];
  assessmentOf?: string;
  assessmentTrialIds?: string[];
  evidenceHash?: string;
  discovery?: DiscoveryRecord;
}
export const usageSchema = z.strictObject({ calls: z.number().int().nonnegative(), inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), costUsd: z.number().finite().nonnegative().nullable() });
const revisionSchema = z.strictObject({ id: text, parentId: text.nullable(), spec: agentSchema, hypothesis: z.string(), createdAt: text });
export const trialSchema = z.strictObject({
  id: identifier, revisionId: text, scenarioId: identifier, familyId: identifier, repeat: z.number().int().nonnegative(),
  userMode: userModeSchema.default('reactive'),
  split: z.enum(['dev', 'control']), manifestHash: text, outcome: z.enum(['pass', 'fail', 'ungraded', 'invalid', 'cancelled']), reason: z.string(),
  checks: z.array(z.strictObject({ id: identifier, description: z.string(), passed: z.boolean(), evidence: z.string() })),
  simulatorChecks: z.array(z.strictObject({ id: z.enum(SIMULATOR_CHECK_IDS), description: z.string(), passed: z.boolean(), evidence: z.string(), seq: z.number().int().nonnegative().optional(), heuristic: z.boolean() })).max(12).optional(),
  events: z.array(z.strictObject({ seq: z.number().int().nonnegative(), type: z.enum(['user', 'assistant', 'simulator', 'retrieval', 'tool_call', 'tool_result', 'error']), text: z.string().optional(), tool: z.string().max(200).optional(), args: z.unknown().optional(), result: z.unknown().optional(), state: worldSchema.optional() })),
  initialState: worldSchema, finalState: worldSchema, usage: usageSchema, elapsedMs: z.number().finite().nonnegative(),
  assessments: z.array(metricAssessmentSchema).max(12).optional(), assessmentError: z.string().max(4000).optional(),
  observation: z.strictObject({ state: z.enum(['sandbox', 'reported', 'missing']), tools: z.enum(['sandbox', 'complete', 'partial']), resetConfirmed: z.boolean().optional(), version: text.max(200).optional(), toolScope: z.array(z.string().max(200)).max(50).optional() }).optional(),
  externalUsage: usageSchema.optional(),
  judgeAudit: judgeAuditSchema.optional(),
  judgeReceipt: judgeReceiptSchema.optional(),
});
const comparisonSchema = z.strictObject({
  baselineId: text, candidateId: text, manifestHash: text, split: z.enum(['dev', 'control']),
  plannedPairs: z.number().int().nonnegative(), validPairs: z.number().int().nonnegative(), invalidPairs: z.number().int().nonnegative(), families: z.number().int().nonnegative(),
  baselinePasses: z.number().int().nonnegative(), candidatePasses: z.number().int().nonnegative(), fixed: z.number().int().nonnegative(), regressed: z.number().int().nonnegative(), tied: z.number().int().nonnegative(),
  delta: z.number().finite().nullable(), interval: z.tuple([z.number().finite(), z.number().finite()]).nullable(),
  verdict: z.enum(['improved', 'regressed', 'no_change', 'insufficient', 'incomparable']), reasons: z.array(z.string()),
  cases: z.array(z.strictObject({ scenarioId: identifier, baselinePasses: z.number().int().nonnegative(), candidatePasses: z.number().int().nonnegative(), repeats: z.number().int().nonnegative() })),
});
const acceptedTestSchema = z.strictObject({
  testId: identifier, scenarioId: identifier, definitionHash: z.string().regex(/^[a-f0-9]{64}$/), acceptedAt: text,
});
/** Files written by older versions load with defaults; the in-memory type is always complete. */
/*
 * FailureMode: a named cluster of dialogues that broke the same way. "Bad answer" is not a
 * failure mode; "found the article and still handed the client to the hotline" is. Naming the
 * failure precisely is what turns an evaluation into an improvement loop, so every cluster
 * must cite the dialogues it was drawn from and may name the stage where the chain broke.
 * Clusters cover the traces of this run only; they are not a picture of production traffic.
 */
/** A JSON envelope, a named field, a structured-output directive or a bare quoted key: an internal interface between the agent's components, never a rule a user can observe in a reply. */
export const MACHINE_FORMAT = /\bjson\b|response_format|\{\s*"[a-z_]+"\s*:|^\s*"[a-z_]+"\s*$/i;
export const failureModeSchema = z.strictObject({
  id: identifier, name: text.max(160), description: text.max(2000),
  stage: text.max(80).optional(), trialIds: z.array(identifier).min(1).max(200),
  /** Verbatim fragments of the agent's prompt that govern the broken behaviour; empty when no fragment does. */
  promptQuotes: z.array(text.max(300)).max(5).optional(),
});
export type FailureMode = z.infer<typeof failureModeSchema>;
export function validateFailureModes(modes: FailureMode[], trials: Trial[], prompt?: string): void {
  const failed = new Set(trials.filter(t => t.outcome === 'fail' || t.outcome === 'ungraded'
    || t.outcome === 'pass' && t.assessments?.some(a => a.result === 'fail')).map(t => t.id));
  if (!unique(modes.map(m => m.id))) throw new Error('Названия провалов повторяются.');
  for (const mode of modes) {
    if (!unique(mode.trialIds)) throw new Error(`Кластер ${mode.id} ссылается на один диалог дважды.`);
    const unknown = mode.trialIds.filter(id => !failed.has(id));
    if (unknown.length) throw new Error(`Кластер ${mode.id} ссылается на диалоги, которые не проваливались: ${unknown.join(', ')}`);
    for (const quote of mode.promptQuotes ?? []) {
      if (prompt === undefined) throw new Error(`Кластер ${mode.id} цитирует промпт, но промпт не передавался.`);
      if (!prompt.includes(quote)) throw new Error(`Кластер ${mode.id} цитирует фрагмент, которого нет дословно в промпте: «${quote.slice(0, 80)}»`);
      if (MACHINE_FORMAT.test(quote)) throw new Error(`Кластер ${mode.id} цитирует машинный формат ответа, а не правило, которое видит пользователь: «${quote.slice(0, 80)}»`);
    }
  }
}

function validateReviewReferences(reviews: HumanReview[], trials: Trial[], path: (string | number)[], ctx: z.RefinementCtx): void {
  reviews.forEach((review, index) => {
    if (!review.reviewedDialogue) return;
    const trial = trials.find(candidate => candidate.id === review.trialId);
    if (!trial || ![...review.note.matchAll(/#(\d+)\b/g)].some(match => trial.events.some(event => event.seq === Number(match[1])))) {
      ctx.addIssue({ code: 'custom', path: [...path, index, 'note'], message: 'Полный разбор должен ссылаться на событие текущего диалога.' });
    }
  });
}

export const experimentSchema: z.ZodType<Experiment> = z.strictObject({
  librarySnapshot: scenarioLibrarySchema.optional(),
  originalImport: z.strictObject({ id: identifier, contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  preparationProgress: preparationProgressSchema.optional(),
  schemaVersion: z.literal('1'), id: identifier, task: text.max(8000), mode: z.enum(['demo', 'live']), createdAt: text, updatedAt: text,
  workflow: z.enum(['evaluate', 'compare']).default('compare'),
  phase: z.enum(['preparing', 'review', 'evaluating', 'results_review', 'baseline', 'improving', 'control', 'complete', 'cancelled', 'error', 'interrupted']), message: z.string(),
  sources: z.array(z.strictObject({ id: identifier, name: text, content: text, hash: text, kind: sourceKindSchema.optional() })).max(12), settings: settingsSchema,
  target: targetSchema.default({ kind: 'sandbox' }),
  requirements: z.array(requirementSchema), questions: z.array(z.string()), scenarios: z.array(scenarioSchema.extend({ split: z.enum(['dev', 'control']) })),
  goldenCases: z.array(goldenCaseSchema).max(40).default([]), dialogues: z.array(dialogueSchema).max(300).default([]), profiles: z.array(profileSchema).max(12).default([]),
  notes: z.string().max(8000).default(''),
  revisions: z.array(revisionSchema), selectedRevisionId: text.nullable(), manifestHash: text.nullable(), reviewedAt: text.nullable(), reviewMode: z.enum(['human', 'expectations', 'automated']).nullable().default(null), controlConsumedAt: text.nullable(),
  acceptedDraftHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  acceptedTests: z.array(acceptedTestSchema).max(200)
    .refine(tests => unique(tests.map(test => test.testId)) && unique(tests.map(test => test.scenarioId)), 'Accepted test identities must be unique').default([]),
  trials: z.array(trialSchema), comparisons: z.array(comparisonSchema), iterations: z.array(z.strictObject({ revisionId: text, accepted: z.boolean(), reason: z.string() })),
  usage: usageSchema, error: z.string().nullable(), limitations: z.array(z.string()),
  humanReviews: z.array(humanReviewSchema).default([]), resultsReviewedAt: text.optional(), resultsReviewHash: text.optional(),
  failureModes: z.array(failureModeSchema).max(30).optional(),
  releaseLog: releaseLogSchema.optional(),
  validationExclusions: z.array(validationExclusionSchema).max(300).optional(),
  parentRunId: identifier.optional(), selectedScenarioIds: z.array(identifier).min(1).max(200).optional(),
  positiveControlScenarioIds: z.array(identifier).min(1).max(5).refine(unique, 'Duplicate control IDs').optional(),
  ownerExpectationScenarioIds: z.array(identifier).min(1).max(40).refine(unique, 'Duplicate owner expectation IDs').optional(),
  targetVersion: text.max(200).optional(), targetFingerprint: text.optional(),
  clarifications: z.array(z.strictObject({ question: text.max(3000), answer: text.max(5000) })).max(100).optional(),
  assessmentOf: identifier.optional(), assessmentTrialIds: z.array(identifier).max(3000).optional(), evidenceHash: text.optional(),
  evaluatorVersion: text.optional(), targetRelease: text.max(200).optional(),
  sourceEvidence: z.strictObject({ runId: identifier, parentRunId: identifier.optional(), trials: z.array(trialSchema).max(600), humanReviews: z.array(humanReviewSchema).max(1000),
    identity: z.strictObject({ libraryHash: text.optional(), importHash: text.optional(), targetFingerprint: text.optional(), targetVersion: text.max(200).optional(), evaluatorVersion: text.optional(), manifestHash: text.nullable(),
      agent: text, judge: text, scenarios: z.record(identifier, text).refine(value => Object.keys(value).length <= 200, 'Too many scenario identities') }).optional() }).optional(),
  discovery: discoveryRecordSchema.optional(),
}).superRefine((record, ctx) => {
  record.scenarios.forEach((scenario, index) => {
    if (scenario.checks.some(check => (SIMULATOR_CHECK_IDS as readonly string[]).includes(check.id))) {
      ctx.addIssue({ code: 'custom', path: ['scenarios', index, 'checks'], message: 'ID объективной проверки зарезервирован для проверки симулятора.' });
    }
  });
  const scenarioIds = new Set(record.scenarios.map(scenario => scenario.id));
  record.positiveControlScenarioIds?.forEach((id, index) => {
    if (!scenarioIds.has(id)) ctx.addIssue({ code: 'custom', path: ['positiveControlScenarioIds', index], message: 'Контрольная ситуация должна быть из этого набора.' });
  });
  record.ownerExpectationScenarioIds?.forEach((id, index) => {
    if (!scenarioIds.has(id)) ctx.addIssue({ code: 'custom', path: ['ownerExpectationScenarioIds', index], message: 'Изменённое ожидание должно относиться к ситуации этого набора.' });
  });
  validateReviewReferences(record.humanReviews, record.trials, ['humanReviews'], ctx);
  if (record.sourceEvidence) validateReviewReferences(record.sourceEvidence.humanReviews, record.sourceEvidence.trials, ['sourceEvidence', 'humanReviews'], ctx);
});
export interface CallContext {
  signal: AbortSignal; timeoutMs: number;
  beforeCall(): void;
  addUsage(usage: Omit<Usage, 'calls'>): void;
  onTrace?(trialId: string, event: TraceEvent): void;
  onTargetEvent?(event: Omit<TraceEvent, 'seq'>): void;
  /** Called on every audit change; final is true exactly once, after the last vote of this judgment settled. */
  onJudgment?(trialId: string, audit: JudgeAudit, final?: boolean): void;
}
export interface Tool {
  name: ToolName; description: string; parameters: Record<string, unknown>;
  execute(args: unknown): Promise<unknown>;
}
export interface DialogueMessage { role: 'user' | 'assistant'; content: string }
export interface TargetSession { respond(message: string): Promise<string>; close(): Promise<void> }
export const userTurnSchema = z.strictObject({ done: z.boolean(), message: z.string().max(6000) }).refine(v => v.done || v.message.trim().length > 0, 'Empty user message');
export type UserTurn = z.infer<typeof userTurnSchema>;
export interface PrepareInput {
  task: string; sources: Source[]; existingAgent?: AgentSpec; workflow?: 'evaluate' | 'compare'; scenarioCount?: number;
  profiles?: Profile[]; goldenCases?: GoldenCase[]; notes?: string; observedGoals?: ObservedGoal[];
  confirmedHypothesis?: string; goalObservation?: GoalObservation; dialogues?: Dialogue[]; userModes?: UserMode[];
  requirements?: Requirement[];
  /** The sandbox agent is only built when the sandbox answers; an external target has its own. */
  targetKind?: Target['kind'];
}
export interface ImproveInput {
  task: string; sources: Source[]; requirements: Requirement[]; agent: AgentSpec;
  feedback: { scenario: Scenario; trials: Trial[] }[];
}
export const proposalSchema = z.strictObject({ agent: agentSchema, hypothesis: text.max(3000) });
export interface ScenarioProposalsInput {
  businessCatalog?: Pick<ScenarioLibrary['businessScenarios'][number], 'key' | 'title' | 'goal' | 'conditions' | 'requirementIds'>[];
  feedback?: { proposals: ScenarioProposal[]; issues: { code: string; path: string; message: string }[] };
  protocol: 'chronological-scenarios-v1'; task: string; sources: Source[]; requirements: Requirement[]; batchId: string;
  dialogues: { id: string; observation: ImportBatch['dialogues'][number]['observation']; events: ImportBatch['dialogues'][number]['events'];
    messages: { index: number; role: 'user' | 'assistant' | 'tool' | 'system'; content: string }[] }[];
}
export interface ScenarioAssessmentInput {
  protocol: 'chronological-scenarios-v1'; contentHash: string; scope: 'fields' | 'relations';
  library: Pick<ScenarioLibrary, 'sources' | 'requirements' | 'businessScenarios' | 'variants'> & {
    imports: { id: string; dialogues: Pick<ImportBatch['dialogues'][number], 'id' | 'events' | 'observation'>[] }[];
  };
  fields: { variantId: string; paths: string[] }[];
  comparisonCandidates: (Omit<ScenarioLibrary['variants'][number], 'quality' | 'issues' | 'ownerDecision'> & {
    business: Pick<ScenarioLibrary['businessScenarios'][number], 'goal' | 'conditions' | 'requirementIds'>;
  })[];
}
export interface Runtime {
  scenarioProposals?(input: ScenarioProposalsInput, ctx: CallContext): Promise<ScenarioProposal[]>;
  assessScenarioProposals?(input: ScenarioAssessmentInput, ctx: CallContext): Promise<SemanticFinding[]>;
  prepare(input: PrepareInput, ctx: CallContext): Promise<z.infer<typeof preparationSchema>>;
  improve(input: ImproveInput, ctx: CallContext): Promise<z.infer<typeof proposalSchema>>;
  openTarget(agent: AgentSpec, sources: Source[], tools: Tool[], ctx: CallContext): Promise<TargetSession>;
  userTurn(input: { user: Scenario['user']; messages: DialogueMessage[]; turn: number }, ctx: CallContext): Promise<UserTurn>;
  assess?(input: { scenario: Scenario; sources: Source[]; trial: Trial }, ctx: CallContext): Promise<MetricAssessment[]>;
  goals?(input: { task: string; sources: Source[]; dialogues: Dialogue[]; profiles: Profile[]; requirements?: Requirement[]; requireApplicable?: boolean }, ctx: CallContext): Promise<ObservedGoal[]>;
  failureModes?(input: { task: string; failures: { trialId: string; card: string; reason: string; failed: string[]; trace: string }[]; prompt?: string }, ctx: CallContext): Promise<FailureMode[]>;
  discover?(input: DiscoveryRuntimeInput, ctx: CallContext): Promise<DiscoveryRuntimeOutput>;
}

/** Stable JSON content identity; array order remains significant. */
/**
 * A model copies a source but normalises its typography: straight quotes for «», a hyphen for a
 * dash, -> for →, е for ё, one space for a line break. Such a quote is still the source's own words.
 * Find it and hand back the source's exact characters, so every stored quote is verbatim.
 * Words, order and case must match; a paraphrase is still rejected.
 */
const LOOSE_CHARACTERS: Record<string, string> = {
  '«': '"', '»': '"', '“': '"', '”': '"', '„': '"', '‹': "'", '›': "'", '‘': "'", '’': "'",
  '–': '-', '—': '-', '−': '-', '→': '>', 'ё': 'е', 'Ё': 'Е', '\u00a0': ' ',
};
/** A list marker after whitespace («- », «• », «1. ») is layout, not words; a model drops it or keeps it inline when it quotes. */
const LIST_MARKER = /^(?:[-*•–—]|\d{1,2}[.)])\s/u;
function foldTypography(text: string): { text: string; starts: number[]; ends: number[] } {
  const out: string[] = [], starts: number[] = [], ends: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const raw = text[i]!;
    let ch = LOOSE_CHARACTERS[raw] ?? raw, width = 1;
    if (raw === '-' && text[i + 1] === '>') { ch = '>'; width = 2; }
    if ((!out.length || out[out.length - 1] === ' ') && !/\s/.test(raw)) {
      const marker = LIST_MARKER.exec(text.slice(i, i + 4));
      if (marker) { ch = ' '; width = marker[0].length; }
    }
    if (/\s/.test(ch)) {
      if (out.length && out[out.length - 1] === ' ') { ends[ends.length - 1] = i + width; i += width - 1; continue; }
      ch = ' ';
    }
    out.push(ch); starts.push(i); ends.push(i + width); i += width - 1;
  }
  return { text: out.join(''), starts, ends };
}
/**
 * The source's own characters behind a quote, together with the offset the match was actually made
 * at. Callers that need the place (a line number, a sort key) take `offset` from here instead of
 * searching the source again for the returned text: a re-search answers «the first copy of these
 * characters», which is a different question from «where this requirement's quote was found».
 */
export function verbatimSpanAt(content: string, quote: string): { span: string; offset: number } | undefined {
  const direct = content.indexOf(quote);
  if (direct >= 0) return { span: quote, offset: direct };
  const source = foldTypography(content);
  const needle = foldTypography(quote).text.trim();
  if (!needle) return undefined;
  // A quote that starts mid-sentence gets capitalised; only its first letter may differ in case.
  const first = needle[0]!, swapped = first === first.toLowerCase() ? first.toUpperCase() : first.toLowerCase();
  for (const candidate of [needle, ...(swapped !== first ? [swapped + needle.slice(1)] : [])]) {
    const at = source.text.indexOf(candidate);
    if (at >= 0) {
      const start = source.starts[at]!;
      return { span: content.slice(start, source.ends[at + candidate.length - 1]!), offset: start };
    }
  }
  return undefined;
}
export function verbatimSpan(content: string, quote: string): string | undefined {
  return verbatimSpanAt(content, quote)?.span;
}
export function fingerprint(value: unknown): string {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, normalize(x)])) : v;
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

export function validatePreparation(raw: unknown, sources: Source[], workflow: 'evaluate' | 'compare' = 'compare', profiles: Profile[] = []): Preparation {
  const p = preparationSchema.parse(raw);
  if (!p.scenarios.length) throw new Error('No cards to run: supply golden cases or ask for generated ones');
  const requireUnique = (values: string[], name: string) => {
    if (!unique(values)) throw new Error(`Duplicate ${name}`);
  };
  requireUnique(p.requirements.map(r => r.id), 'requirement IDs');
  requireUnique(p.scenarios.map(s => s.id), 'scenario IDs');
  for (const r of p.requirements) {
    const source = sources.find(s => s.id === r.sourceId);
    if (!source?.content.includes(r.quote)) throw new Error(`Requirement ${r.id} has an ungrounded source quote`);
  }
  const families = [...new Set(p.scenarios.map(s => s.familyId))].sort();
  if (workflow === 'compare' && families.length < 4) throw new Error('At least four distinct scenario families are required');
  const control = new Set(families.filter((_, i) => i % 2 === 1));
  for (const s of p.scenarios) {
    const synthetic = s.provenance === 'synthetic';
    if (synthetic && !s.requirementIds.length) throw new Error(`Scenario ${s.id} needs at least one grounded requirement`);
    if (synthetic) for (const answer of s.user.answers ?? []) {
      const known = valueTokens([s.user.opening, s.user.facts, ...(s.user.knows ?? [])].join('\n'));
      const unknown = [...valueTokens(answer.reply)].filter(token => !known.has(token));
      if (unknown.length) throw new Error(`Scenario ${s.id}: the reply to "${answer.ifAsked}" reveals a value the user does not know: ${unknown[0]}`);
    }
    if (s.profileId !== undefined && !profiles.some(profile => profile.id === s.profileId)) throw new Error(`Scenario ${s.id} references an unknown profileId`);
    if (s.profileId !== undefined) {
      const profile = profiles.find(candidate => candidate.id === s.profileId)!;
      delete s.user.persona;
      Object.assign(s.user, profileUser(profile));
    }
    if (workflow === 'evaluate' && (!s.successCriteria || s.user.maxFollowUps === undefined)) {
      throw new Error(`Scenario ${s.id} needs success criteria and an explicit follow-up limit`);
    }
    requireUnique(s.checks.map(c => c.id), 'check IDs');
    if (s.checks.some(check => (SIMULATOR_CHECK_IDS as readonly string[]).includes(check.id))) throw new Error(`Scenario ${s.id}: check ID is reserved for simulator checks`);
    requireUnique((s.metrics ?? []).map(m => m.id), 'metric IDs');
    if (!s.checks.length && !s.metrics?.length) throw new Error(`Scenario ${s.id} has no evaluation criteria`);
    if (s.requirementIds.some(id => !p.requirements.some(r => r.id === id))) throw new Error(`Unknown requirement in ${s.id}`);
    const states = new Map<string, unknown>();
    const calls = new Map<string, { min: number; max: number }>();
    const phrases = new Map<string, boolean>();
    let exactAnswer: string | undefined;
    for (const c of s.checks) {
      if (c.kind === 'state_equals') {
        const key = `${c.recordId}.${c.field}`;
        if (states.has(key) && !Object.is(states.get(key), c.value)) throw new Error(`Contradictory state checks in ${s.id}`);
        states.set(key, c.value);
      } else if (c.kind === 'answer_contains' || c.kind === 'answer_omits') {
        const required = c.kind === 'answer_contains';
        const seen = phrases.get(c.value.toLocaleLowerCase());
        if (seen !== undefined && seen !== required) throw new Error(`Contradictory answer checks in ${s.id}`);
        phrases.set(c.value.toLocaleLowerCase(), required);
      } else if (c.kind === 'answer_equals') {
        if (exactAnswer !== undefined && exactAnswer !== c.value) throw new Error(`Contradictory exact answer checks in ${s.id}`);
        exactAnswer = c.value;
      } else if (c.kind === 'tool_called' || c.kind === 'tool_not_called' || c.kind === 'tool_count') {
        const before = calls.get(c.tool) ?? { min: 0, max: Infinity };
        const min = Math.max(before.min, c.kind === 'tool_count' ? c.min : c.kind === 'tool_called' ? 1 : 0);
        const max = Math.min(before.max, c.kind === 'tool_count' ? c.max : c.kind === 'tool_not_called' ? 0 : Infinity);
        if (min > max) throw new Error(`Contradictory tool checks in ${s.id}`);
        calls.set(c.tool, { min, max });
      }
    }
    if (exactAnswer !== undefined && [...phrases].some(([phrase, required]) => !required && exactAnswer.toLocaleLowerCase().includes(phrase))) {
      throw new Error(`Exact answer contains forbidden wording in ${s.id}`);
    }
    for (const c of s.checks) if (c.kind === 'state_equals') {
      const record = s.initialState.records[c.recordId];
      if (!record || !Object.hasOwn(record, c.field)) throw new Error(`Invalid expected state in ${s.id}`);
      if (!Object.is(record[c.field], c.value) && !s.initialState.writableFields.includes(c.field)) throw new Error(`Unreachable expected state in ${s.id}`);
      if (!Object.is(record[c.field], c.value) && calls.get('update_record')?.max === 0) throw new Error(`Contradictory update prohibition in ${s.id}`);
    }
  }
  if (workflow === 'compare') for (const r of p.requirements) if (r.critical && !p.scenarios.some(s => s.requirementIds.includes(r.id))) throw new Error(`Critical requirement ${r.id} has no test coverage`);
  return { ...p, scenarios: p.scenarios.map(s => ({ ...s, split: workflow === 'compare' && control.has(s.familyId) ? 'control' : 'dev' })) };
}
