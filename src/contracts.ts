import { USER_CONTROLLER_PROTOCOL, userViewSchema } from './user-controller.js';
import { checkpointSchema, importBatchSchema, requirementKindSchema } from './scenario-contracts.js';
import { expectationSchema, preparationProgressSchema, scenarioLibrarySchema, type PreparationProgress, type ScenarioLibrary } from './card/schema.js';
import { calibrationSchema, calibrationSettingSchema, type Calibration } from './card/calibration.js';
import { judgeAuditSchema, judgeReceiptSchema, metricAssessmentSchema, rubricSchema, stage, type JudgeAudit, type JudgeReceipt, type MetricAssessment, type Rubric } from './assessment.js';
import { createHash } from 'node:crypto';
import { MATERIAL_CHARS, MATERIAL_LIMIT, MATERIALS_TOTAL_CHARS, RECORD_REQUIREMENT_LIMIT } from './limits.js';
import { z } from 'zod';
import { identifierSchema as identifier, sha256Schema } from './ids.js';
import { PHASES, type Phase } from './phases.js';
import { STOP_REASONS, type StopReason } from './errors.js';
import { caveatsSchema, type Caveat } from './caveats.js';
import { valueTokens } from './verbatim.js';
import { referencesSchema, type Reference } from './reference.js';
export { referenceSchema, referencesSchema, type Reference } from './reference.js';

/*
 * The stored record: a run of situations against an agent — its sources and rules, its situations, every dialogue
 * with its evidence and verdicts, people's reviews, and the settings it was measured under. Old records open without
 * migration: a retired field stays readable, and nothing reads it.
 */

/* The stored verdicts of the checkpoint judge of first-format runs (checkpoints.ts reads them); nothing writes them any more. */
const checkpointDecisionSchema = z.strictObject({
  checkpointId: z.string().min(1).max(80), result: z.enum(['pass', 'fail', 'unknown', 'not_applicable']),
  evidence: z.array(z.number().int().nonnegative()).max(30), rationale: z.string().trim().min(1).max(2000),
});
const checkpointResultSchema = checkpointDecisionSchema.extend({ requirementId: z.string(), role: z.enum(['required', 'diagnostic']), observation: z.enum(['reply', 'tool', 'state']), contextEvidence: z.array(z.number().int().nonnegative()).max(30).optional() });
type CheckpointResult = z.infer<typeof checkpointResultSchema>;
const checkpointRawDecisionsSchema = z.array(z.json()).max(48).refine(values => JSON.stringify(values).length <= 128000, 'Checkpoint response exceeds 128000 characters');
const checkpointReceiptSchema = z.strictObject({ protocolHash: z.string(), inputHash: z.string(), resultHash: z.string(), decisionHash: z.string(), decisions: checkpointRawDecisionsSchema });

export const VERSION = '6';
export const DEFAULT_JUDGE = { provider: 'openrouter', model: 'openai/gpt-5.6-sol', upstream: 'openai' } as const;
/**
 * The judge of a new draft made in the chat: the independent default judge when Pi can reach it, otherwise the
 * session's own model (a work network that reaches only its internal model gateway). The result then says that the
 * judge is the model that built the situations, never hides it.
 */
export function judgeFor(available: readonly { provider: string; id: string }[], session: { provider: string; id: string } | undefined):
  { provider: string; model: string; upstream?: string } {
  const reachable = available.some(model => model.provider === DEFAULT_JUDGE.provider && model.id === DEFAULT_JUDGE.model);
  return reachable || !session ? { ...DEFAULT_JUDGE } : { provider: session.provider, model: session.id };
}
/**
 * The judge a run takes instead when this network does not reach the draft's one (lab/run.ts start): for the
 * independent default judge, the draft's own model — the fallback judgeFor makes — and nothing for a judge named in a
 * role, or when the draft has no other model. The result then says the judge is the model that built the situations.
 */
export function judgeFallback(settings: { provider: string; model: string; judge?: { provider: string; model: string }; roles?: { judge?: unknown } }):
  { provider: string; model: string } | undefined {
  const { judge } = settings;
  if (settings.roles?.judge || !judge || judge.provider !== DEFAULT_JUDGE.provider || judge.model !== DEFAULT_JUDGE.model) return undefined;
  if (!settings.provider || !settings.model || (settings.provider === judge.provider && settings.model === judge.model)) return undefined;
  return { provider: settings.provider, model: settings.model };
}
const TOOL_NAMES = ['search_materials', 'lookup_record', 'update_record'] as const;
const text = z.string().trim().min(1);
const dialogueContent = z.string().min(1).max(8000).refine(v => !!v.trim(), 'Empty dialogue content');
const unique = <T>(values: T[]) => new Set(values).size === values.length;
/** A field of a retired feature: old records still parse, nothing reads it. */
const retired = z.unknown().optional();
export const scalarSchema = z.union([z.string().max(8000), z.number().finite(), z.boolean(), z.null()]);
export const agentSchema = z.strictObject({
  name: text.max(120),
  instructions: text.max(24000),
  tools: z.array(z.enum(TOOL_NAMES)).max(3).refine(unique, 'Duplicate tools'),
});
export type AgentSpec = z.infer<typeof agentSchema>;
/** `kind: 'prompt'` marks the agent's own instructions: rules the user can observe are extracted from it, and the harness grades compliance with them. */
const sourceKindSchema = z.enum(['knowledge', 'prompt']);
export type SourceKind = z.infer<typeof sourceKindSchema>;
const materialSchema = z.strictObject({ name: text.max(180), content: text.max(MATERIAL_CHARS), kind: sourceKindSchema.optional() });

/*
 * How the simulated user's side of a dialogue is produced:
 *   reactive  – a model plays the user card and answers the target's actual replies
 *   scripted  – user.script lines are sent in order, ignoring the target's replies
 *   static    – only the opening message; the dialogue ends after the first reply
 * Running the same cards in all three modes measures what the reactive simulator adds.
 */
const userModeSchema = z.enum(['reactive', 'scripted', 'static']);
export type UserMode = z.infer<typeof userModeSchema>;
const providerName = z.string().max(120).describe('Provider key, e.g. openrouter. Never include the model or vendor path here.');
const modelName = z.string().max(200).describe('Exact model ID within that provider, e.g. z-ai/glm-5.3-flash or openai/gpt-5.6-sol for openrouter.');
const modelChoiceSchema = z.strictObject({ provider: providerName.min(1), model: modelName.min(1) });
export const settingsSchema = z.strictObject({
  provider: providerName.default(''),
  model: modelName.default(''),
  judge: z.strictObject({ provider: providerName.min(1), model: modelName.min(1), upstream: z.string().min(1).max(120).optional() })
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
  calibration: calibrationSettingSchema.optional(), // sim-to-real after the run (card/calibrate.ts): 'auto' when absent
});
export type Settings = z.infer<typeof settingsSchema>;
// A patch must never materialize defaults for keys the caller did not send.
const settingsPatchSchema = z.strictObject({
  provider: settingsSchema.shape.provider.removeDefault(), model: settingsSchema.shape.model.removeDefault(),
  judge: settingsSchema.shape.judge,
  repeats: settingsSchema.shape.repeats.removeDefault(), maxIterations: settingsSchema.shape.maxIterations.removeDefault(),
  maxTurns: settingsSchema.shape.maxTurns.removeDefault(), maxCalls: settingsSchema.shape.maxCalls.removeDefault(),
  timeoutMs: settingsSchema.shape.timeoutMs.removeDefault(), maxDurationMs: settingsSchema.shape.maxDurationMs.removeDefault(),
  userModes: settingsSchema.shape.userModes.removeDefault(), calibration: settingsSchema.shape.calibration,
  roles: z.strictObject({ builder: modelChoiceSchema.nullable().optional(), simulator: modelChoiceSchema.nullable().optional(), judge: modelChoiceSchema.nullable().optional() }),
}).partial();

import { draftTargetSchema, runnableTargetSchema, targetSchema, type Target } from './target-schema.js';
export { draftTargetSchema, isRunnable, runnableTarget, runnableTargetSchema, SANDBOX_RETIRED, targetSchema, UNCONNECTED, type RunnableTarget, type Target } from './target-schema.js';
export type ReleaseHook = NonNullable<Extract<Target, { kind: 'command' }>['release']>;
export interface ReleaseLog { command: string; exitCode: number | null; signal: string | null; stdout: string; stderr: string; startedAt: string; durationMs: number }
const releaseLogSchema = z.strictObject({ command: z.string().max(8000), exitCode: z.number().int().nullable(), signal: z.string().max(40).nullable(), stdout: z.string().max(4000), stderr: z.string().max(4000), startedAt: text, durationMs: z.number().nonnegative() });

export interface Source { id: string; name: string; content: string; hash: string; kind?: SourceKind }
/** A record's sources: the owner's materials in the order given, numbered, each with the hash of its text. */
export function materialSources(materials: readonly z.infer<typeof materialSchema>[]): Source[] {
  return materials.map((material, index) => ({ id: `source-${index + 1}`, name: material.name, content: material.content, hash: fingerprint(material.content),
    ...(material.kind ? { kind: material.kind } : {}) }));
}
/** Generated cards per run; owner cards come on top. */
export const SCENARIO_LIMIT = 20;
/**
 * A rule the agent is judged by: a sentence of the owner's materials, quoted verbatim. A card preparation makes one from
 * each sentence a card cites (card/proposal.ts); older preparations grounded them first, in a call of their own.
 */
export const requirementSchema = z.strictObject({
  id: identifier, text: text.max(2000), sourceId: identifier, quote: text.max(3000), critical: z.boolean(),
  /** Whether a user can see the rule kept or broken in a reply, as the preparation typed it. Requirements stored before the field existed lack it. */
  observable: z.boolean().optional(),
  /** Behaviour, knowledge or an operator procedure, as the preparation typed it (scenario-contracts.ts). Requirements stored before the field existed lack it. */
  kind: requirementKindSchema.optional(),
});
export type Requirement = z.infer<typeof requirementSchema>;
/**
 * How requirements were told apart before the grounding call typed `observable`: a JSON envelope, a named field,
 * a structured-output directive or a bare quoted key. It decodes only stored requirements without the field, so
 * the judge input of old records stays exactly as it was.
 */
const LEGACY_MACHINE_FORMAT = /\bjson\b|response_format|\{\s*"[a-z_]+"\s*:|^\s*"[a-z_]+"\s*$/i;
export const observableRule = (requirement: Requirement): boolean => requirement.observable ?? !LEGACY_MACHINE_FORMAT.test(requirement.quote);
/**
 * A rule of the agent's own prompt that no user can see kept or broken in a reply, such as its machine output
 * format: an internal interface between the agent's components. It is recorded, never judged or offered as an owner rule.
 */
export function internalPromptRule(sources: readonly Pick<Source, 'id' | 'kind'>[], requirement: Requirement): boolean {
  return sources.find(source => source.id === requirement.sourceId)?.kind === 'prompt' && !observableRule(requirement);
}
export const worldSchema = z.strictObject({
  records: z.record(identifier, z.record(identifier, scalarSchema)).refine(v => Object.keys(v).length <= 30, 'Too many records'),
  writableFields: z.array(identifier).max(16),
  transientFailures: z.number().int().min(0).max(2).default(0),
  /** Opaque state for the agent's own test environment (cards, contracts, tool fixtures): its adapter applies it and confirms that with resetConfirmed. */
  external: z.record(z.string().max(120), z.json()).optional(),
}).superRefine((v, ctx) => {
  if (v.external !== undefined && JSON.stringify(v.external).length > 20000) ctx.addIssue({ code: 'custom', message: 'External state exceeds 20,000 characters', path: ['external'] });
});
export type World = z.infer<typeof worldSchema>;
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
  /** Derived from a reference: the article (and chunk) is among the chunks retrieved for some reply. */
  z.strictObject({ ...checkBase, kind: z.literal('source_retrieved'), doc: text.max(500), chunk: text.max(500).optional() }),
  /** Derived from a reference: every value token of the expected fact appears in the assistant replies. */
  z.strictObject({ ...checkBase, kind: z.literal('answer_reference_tokens'), value: text.max(400) }),
]);
export type Check = z.infer<typeof checkSchema>;
export function describeCheck(check: Check): string {
  if (check.kind === 'state_equals') return `${check.recordId}.${check.field} = ${JSON.stringify(check.value)} в конце диалога`;
  if (check.kind === 'answer_equals') return `Последний ответ в точности: ${JSON.stringify(check.value)}`;
  if (check.kind === 'answer_contains') return `В ответах есть: ${JSON.stringify(check.value)} (без учёта регистра)`;
  if (check.kind === 'answer_omits') return `В ответах нет: ${JSON.stringify(check.value)} (без учёта регистра)`;
  if (check.kind === 'source_retrieved') return `Найдена статья ${check.doc}${check.chunk ? `, фрагмент ${check.chunk}` : ''}`;
  if (check.kind === 'answer_reference_tokens') return `В ответах есть значения эталона: ${[...valueTokens(check.value)].join(', ')}`;
  if (check.kind === 'tool_called') return `Есть вызов ${check.tool}`;
  if (check.kind === 'tool_not_called') return `Нет вызовов ${check.tool}`;
  if (check.kind === 'tool_count') return `${check.tool}: от ${check.min} до ${check.max} попыток вызова`;
  return 'Перед каждым изменением — успешное чтение той же записи';
}
export const REFERENCE_METRIC_ID = 'reference_match';
const DERIVED_CHECK_KINDS: ReadonlySet<Check['kind']> = new Set(['source_retrieved', 'answer_reference_tokens']);

/**
 * The checks and the judge rubric a card's references imply. Rebuilt from the references on every
 * validation, so the expectation lives only in `references` and an edit never leaves stale criteria.
 */
export function withReferenceCriteria<S extends Pick<Scenario, 'checks' | 'metrics' | 'references'>>(scenario: S): Pick<S, 'checks' | 'metrics'> {
  const references = scenario.references ?? [];
  const stale = scenario.checks.some(c => DERIVED_CHECK_KINDS.has(c.kind)) || !!scenario.metrics?.some(m => m.id === REFERENCE_METRIC_ID);
  if (!references.length && !stale) return { checks: scenario.checks, metrics: scenario.metrics };
  const checks = [...scenario.checks.filter(c => !DERIVED_CHECK_KINDS.has(c.kind)), ...references.flatMap(referenceChecks)];
  const kept = (scenario.metrics ?? []).filter(m => m.id !== REFERENCE_METRIC_ID);
  const texts = references.flatMap(r => r.text ? [r.text] : []);
  const metrics = texts.length ? [...kept, referenceMatch(texts)] : kept;
  return { checks, metrics: metrics.length || scenario.metrics ? metrics : undefined };
}

export function unconfirmedReferences(scenarios: Pick<Scenario, 'id' | 'references'>[]): string[] {
  return scenarios.flatMap(s => (s.references ?? []).filter(r => !r.confirmed).map(r => `${s.id}/${r.id}`));
}

function referenceChecks(reference: Reference): Check[] {
  const checks: Check[] = [];
  if (reference.source) checks.push({ id: `ref_${reference.id}_source`, kind: 'source_retrieved', stage: 'поиск',
    description: `Агент нашёл эталонную статью ${reference.source.doc}`, doc: reference.source.doc,
    ...(reference.source.chunk ? { chunk: reference.source.chunk } : {}) });
  if (reference.text && valueTokens(reference.text).size) checks.push({ id: `ref_${reference.id}_tokens`, kind: 'answer_reference_tokens', stage: 'ответ',
    description: 'Ответ содержит значения из эталона', value: reference.text });
  return checks;
}

function referenceMatch(texts: string[]): Rubric {
  const expected = texts.map(t => `«${t}»`).join('; ');
  return { id: REFERENCE_METRIC_ID, name: 'Совпадение с эталоном', subject: 'agent', stage: 'ответ',
    description: `Передают ли ответы агента факты эталона: ${expected}.`,
    passCriteria: `Ответы агента передают каждый факт эталона (${expected}) по смыслу, перефраз допустим, и ничему в нём не противоречат.`,
    failCriteria: `Хотя бы один факт эталона (${expected}) не передан, искажён или ответ ему противоречит.` };
}
const validationExclusionSchema = z.strictObject({
  dialogueId: identifier, kind: z.enum(['customer_data', 'masked', 'length', 'unconfirmed']), reason: text.max(1000),
});
export type ValidationExclusion = z.infer<typeof validationExclusionSchema>;
const userSchema = z.strictObject({
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
const tierSchema = z.enum(['smoke', 'regression', 'frontier']);
export type Tier = z.infer<typeof tierSchema>;
const goalObservationSchema = z.enum(['reply', 'tool', 'state']);
export type GoalObservation = z.infer<typeof goalObservationSchema>;
/** The evidence channel an external agent is judged on when the owner did not pick one. */
export const DEFAULT_GOAL_OBSERVATION: GoalObservation = 'reply';
/** The judged checkpoint protocol of compiled library cards; its role prompt is inside `checkpointHash`. */
export const CHECKPOINT_PROTOCOL = 'checkpoints-v1';
/** How a card compiled from a brief is judged: every expectation is its own rubric with its own verdict. */
export const EXPECTATIONS_PROTOCOL = 'expectations-v1';
const environmentViewSchema = z.strictObject({ mode: z.enum(['prompt', 'managed']), contract: z.strictObject({ operations: z.array(z.string()), reset: z.boolean(), observations: z.array(z.enum(['reply', 'tool', 'state'])), confirmed: z.boolean() }).optional() });
/** A first-format library variant compiled at acceptance: the customer's controlled view and the checkpoints its judge read. */
const executionV1Schema = z.strictObject({
  protocol: z.literal(USER_CONTROLLER_PROTOCOL), checkpointContext:z.literal('observed-tools-v1').optional(), checkpointProtocol: z.literal(CHECKPOINT_PROTOCOL), controllerHash: text, checkpointHash: text,
  userView: userViewSchema,
  environmentView: environmentViewSchema,
  evaluatorView: z.strictObject({ checkpoints: z.array(checkpointSchema).max(12), requirements: z.array(requirementSchema).max(80) }),
});
/**
 * A card compiled at acceptance (card/compile.ts): the customer's controlled view, and for the judge the
 * card's 1–3 expectations with the owner rules they cite. The controller prompt is not part of the card:
 * it belongs to the evaluator version. The two strict shapes exclude each other (`evaluation` is only here).
 */
const executionV2Schema = z.strictObject({
  protocol: z.literal(USER_CONTROLLER_PROTOCOL), evaluation: z.literal(EXPECTATIONS_PROTOCOL),
  userView: userViewSchema,
  environmentView: environmentViewSchema,
  evaluatorView: z.strictObject({ expectations: z.array(expectationSchema).min(1).max(3), requirements: z.array(requirementSchema).max(9) }),
});
const executionSchema = z.union([executionV1Schema, executionV2Schema]);
export type Execution = z.infer<typeof executionSchema>;
export type CardExecution = z.infer<typeof executionV2Schema>;
export type VariantExecution = z.infer<typeof executionV1Schema>;
/** A card judged by its expectations: compiled from a brief, or a first-format card projected for judging (card/legacy-v1.ts). */
export const isCardExecution = (execution: Execution | undefined): execution is CardExecution => execution !== undefined && 'evaluation' in execution;
export const scenarioSchema = z.strictObject({
  id: identifier, familyId: identifier, title: text.max(200),
  requirementIds: z.array(identifier).max(20),
  provenance: z.enum(['synthetic', 'curated', 'production']),
  tier: tierSchema.default('regression'),
  profileId: identifier.optional(),
  user: userSchema, initialState: worldSchema,
  execution: executionSchema.optional(),
  checks: z.array(checkSchema).max(12),
  /** Owner-selected evidence channel. Optional only for legacy/production records. */
  goalObservation: goalObservationSchema.optional(),
  successCriteria: text.max(3000).optional(), assumptions: z.array(text.max(1000)).max(12).optional(),
  metrics: z.array(rubricSchema).max(8).optional(),
  references: referencesSchema.optional(),
});
export type Scenario = z.infer<typeof scenarioSchema> & { split: 'dev' | 'control' };

/** Validate the conversation we will actually send, before spending any target calls. */
export function scriptIssue(user: Scenario['user'], maxTurns: number): string | undefined {
  const available = Math.min(user.maxFollowUps ?? maxTurns - 1, maxTurns - 1);
  if (user.script && user.script.length > available) {
    return `Скрипт содержит ${user.script.length} продолжения, но лимит допускает ${available}. script содержит только реплики после opening; уберите повтор первой реплики или увеличьте лимит.`;
  }
}

/** A de-identified production conversation supplied by the owner; it becomes an import batch for the scenario library. */
export const dialogueSchema = z.strictObject({
  id: identifier, goal: text.max(3000).optional(),
  messages: z.array(z.strictObject({ role: z.enum(['user', 'assistant']), content: dialogueContent })).min(1).max(60),
  outcome: z.enum(['success', 'failure', 'abandoned', 'unknown']).default('unknown'),
});
export type Dialogue = z.infer<typeof dialogueSchema>;

export const createInputSchema = z.strictObject({
  task: text.max(8000),
  originalImport: importBatchSchema.optional(),
  materials: z.array(materialSchema).min(1).max(MATERIAL_LIMIT),
  mode: z.enum(['demo', 'live']),
  settings: settingsSchema.default(() => settingsSchema.parse({})),
  /** A label for the agent under test; an external agent keeps its own instructions and tools. */
  existingAgent: agentSchema.optional(),
  workflow: z.literal('evaluate').default('evaluate'),
  /** Situations written from the owner's rules alone when there are no logs; one when 0. */
  scenarioCount: z.number().int().min(0).max(SCENARIO_LIMIT).default(5),
  target: draftTargetSchema,
  targetVersion: text.max(200).optional(),
  /** Converted into `originalImport` when no import is supplied. */
  dialogues: z.array(dialogueSchema).max(200).default([]),
}).superRefine((v, ctx) => {
  if (v.materials.reduce((n, m) => n + m.content.length, 0) > MATERIALS_TOTAL_CHARS) ctx.addIssue({ code: 'custom', message: `Materials exceed ${MATERIALS_TOTAL_CHARS.toLocaleString('en-US')} characters`, path: ['materials'] });
  if (v.dialogues.reduce((n, d) => n + d.messages.reduce((m, x) => m + x.content.length, 0), 0) > 2000000) ctx.addIssue({ code: 'custom', message: 'Dialogues exceed 2,000,000 characters', path: ['dialogues'] });
  if (!unique(v.dialogues.map(d => d.id))) ctx.addIssue({ code: 'custom', message: 'Duplicate dialogue IDs', path: ['dialogues'] });
  if (v.scenarioCount === 0 && !v.dialogues.length && !v.originalImport?.dialogues.length) {
    ctx.addIssue({ code: 'custom', message: 'scenarioCount 0 needs production dialogues to have anything to run', path: ['scenarioCount'] });
  }
});
export type CreateInput = z.infer<typeof createInputSchema>;

const preparationSchema = z.strictObject({
  // A record keeps the union of what every dialogue's reading yielded (RECORD_REQUIREMENT_LIMIT): the sentences its
  // cards cite, or what an older preparation grounded for each dialogue of a large knowledge base.
  requirements: z.array(requirementSchema).min(1).max(RECORD_REQUIREMENT_LIMIT),
  questions: z.array(text.max(2000)).max(12),
  scenarios: z.array(scenarioSchema).max(200),
});
export interface Preparation { requirements: Requirement[]; questions: string[]; scenarios: Scenario[] }
export interface Revision { id: string; parentId: string | null; spec: AgentSpec; hypothesis: string; createdAt: string }
export type Outcome = 'pass' | 'fail' | 'ungraded' | 'invalid' | 'cancelled';
export interface Usage { calls: number; inputTokens: number; outputTokens: number; costUsd: number | null }
export const emptyUsage = (): Usage => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
/** Adds `delta` into `target`. An unknown cost stays unknown: one call without a price makes the sum unknown. */
export function addUsage(target: Usage, delta: Omit<Usage, 'calls'> & { calls?: number }): void {
  target.calls += delta.calls ?? 0;
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.costUsd = target.costUsd === null || delta.costUsd === null ? null : target.costUsd + delta.costUsd;
}
export interface TraceEvent {
  seq: number; type: 'user' | 'assistant' | 'simulator' | 'observation' | 'retrieval' | 'tool_call' | 'tool_result' | 'error';
  text?: string; tool?: string; args?: unknown; result?: unknown; state?: World;
}
export interface CheckResult { id: string; description: string; passed: boolean; evidence: string }
export const SIMULATOR_PROTOCOL = 'simulator-2';
export const SIMULATOR_CHECK_IDS = ['simulator_leak', 'simulator_fabrication', 'simulator_loop'] as const;
export type SimulatorCheckId = typeof SIMULATOR_CHECK_IDS[number];
/** A code predicate over the simulated user's own replies. Never an agent grade; never shown to the judge. */
export interface SimulatorCheck { id: SimulatorCheckId; description: string; passed: boolean; evidence: string; seq?: number; heuristic: boolean }
export interface Trial {
  diagnosticReceipt?: unknown;
  id: string; revisionId: string; scenarioId: string; familyId: string; repeat: number; userMode: UserMode;
  split: 'dev' | 'control'; manifestHash: string; outcome: Outcome; reason: string;
  checkpoints?: CheckpointResult[]; checkpointReceipt?: z.infer<typeof checkpointReceiptSchema>;
  checks: CheckResult[]; simulatorChecks?: SimulatorCheck[]; events: TraceEvent[]; initialState: World; finalState: World;
  usage: Usage; elapsedMs: number;
  assessments?: MetricAssessment[]; assessmentError?: string; judgeAudit?: JudgeAudit; judgeReceipt?: JudgeReceipt;
  observation?: { state: 'sandbox' | 'reported' | 'missing'; tools: 'sandbox' | 'complete' | 'partial'; resetConfirmed?: boolean; version?: string; toolScope?: string[] };
  externalUsage?: Usage;
  /**
   * Why the dialogue could not be measured, typed where it broke. Records written before it carry only `reason` (run.ts
   * decodes them); records written before 'measurement' existed keep the cause they were stored with, without migration.
   */
  invalidCause?: InvalidCause;
  /** Why the judge left the attempt without a judgment, typed where it failed. Records written before it carry only `assessmentError`. */
  assessmentFailure?: AssessmentFailure;
  /**
   * The customer had written every message the run allows, so the conversation ended at that limit and not by the
   * customer's own choice: an observation, judged as it went, never a failed measurement (evaluation.ts). What the
   * judge could not decide in it is «не измерено» for this reason (run.ts). Absent on every other conversation and in
   * older records.
   */
  turnLimit?: true;
  /**
   * The edition of the counting rules this attempt is read by (card/expectations.ts COUNTING_VERSION), written when a
   * run or a re-assessment records it. Absent in attempts recorded before editions existed: they keep edition 1, so a
   * stored result never moves.
   */
  countingVersion?: 2 | 3;
}
/**
 * Where a dialogue broke: the turn budget ran out, the simulated client failed, the agent or its connection failed
 * to answer, a service text stood in for the agent's reply, or `measurement`: the agent's side answered but the
 * measurement could not be made — the adapter reported a measurementError, or the connection did not show the
 * state, tool log, reset or observed field the checks need; `no_reply`: the adapter said the turn gave the customer
 * nothing (a service status, a failed generation) — the agent's operability, never the Lab's error nor a failed duty.
 * Values are only ever appended, never renamed or reordered, so every stored cause stays valid.
 */
export const INVALID_CAUSES = ['turn_limit', 'simulator', 'agent', 'service_reply', 'measurement', 'no_reply'] as const;
export type InvalidCause = typeof INVALID_CAUSES[number];
/** Why an attempt has no judgment: only code checks were re-run, the run was stopped, the model provider did not answer, or the judge's answers were rejected. */
export const ASSESSMENT_FAILURES = ['code_only', 'stopped', 'unavailable', 'rejected'] as const;
export type AssessmentFailure = typeof ASSESSMENT_FAILURES[number];
export const simulatorWasUsed = (trial: Trial) => trial.userMode === 'reactive' && trial.events.some(e => e.type === 'simulator');
export interface Comparison {
  baselineId: string; candidateId: string; manifestHash: string; split: 'dev' | 'control';
  plannedPairs: number; validPairs: number; invalidPairs: number; families: number;
  baselinePasses: number; candidatePasses: number; fixed: number; regressed: number; tied: number;
  delta: number | null; interval: [number, number] | null;
  verdict: 'improved' | 'regressed' | 'no_change' | 'insufficient' | 'incomparable';
  reasons: string[]; cases: { scenarioId: string; baselinePasses: number; candidatePasses: number; repeats: number }[];
}
/** The judgment a human verdict refers to: the judge protocol and the exact input it was asked about. */
const judgeSnapshotSchema = z.strictObject({ protocolHash: text, inputHash: text });
export const humanReviewInputSchema = z.strictObject({
  trialId: identifier, metricId: identifier.optional(), checkId: identifier.optional(),
  verdict: z.enum(['pass', 'fail', 'unknown', 'invalid']), note: text.max(3000),
  durationMs: z.number().int().nonnegative().max(3600000).optional(),
  /**
   * `quick`: a one-key agreement mark on a metric that decided the situation (outcomes.ts markTargets). `blind`: the
   * owner's label of one expectation given without seeing the judge's verdict (blind.ts) — the judge's calibration.
   */
  source: z.enum(['quick', 'blind']).optional(),
  /** The recorded judge result the person saw; filled and checked by the lab, never trusted from a caller. */
  judgeVerdict: z.enum(['pass', 'fail', 'unknown']).optional(),
  /** The judgment the person agreed or disagreed with; absent when the trial has neither receipt nor audit (demo). */
  judge: judgeSnapshotSchema.optional(),
  /** The counting rule a quick mark was given under (COUNTING_RULES); filled by the lab, never trusted from a caller. */
  countingRules: text.optional(),
}).refine(v => !(v.metricId && v.checkId), 'Review either one metric, one check, or the whole trial')
  .refine(v => v.source !== 'quick' || (!!v.metricId && v.verdict !== 'invalid'), 'Быстрая отметка ставится на одну оценку судьи.')
  .refine(v => v.source !== 'blind' || !!v.metricId, 'Слепая оценка ставится на одно ожидание.');
export type HumanReviewInput = z.infer<typeof humanReviewInputSchema>;
/**
 * A stored verdict. `reviewedDialogue` marked, before cards, a whole-dialogue review whose note cited an event as `#N`.
 * Nothing reads the mark and nothing writes it any more, so stored reviews keep it verbatim and no note is ever parsed.
 */
export type HumanReview = HumanReviewInput & { id: string; createdAt: string; reviewedDialogue?: true };
const humanReviewSchema = humanReviewInputSchema.safeExtend({ id: identifier, createdAt: text, reviewedDialogue: z.literal(true).optional() });
/** What a draft may still change: run settings, the connection and the agent label. Situations change only in the library. */
export const draftPatchSchema = z.strictObject({
  agent: agentSchema.optional(), settings: settingsPatchSchema.optional(),
  target: runnableTargetSchema.optional(), targetVersion: text.max(200).optional(),
}).refine(v => Object.keys(v).length > 0, 'Supply a draft change');
export const reassessmentSchema = z.strictObject({
  criteria: z.array(z.strictObject({ scenarioId: identifier, successCriteria: text.max(3000).optional(),
    checks: z.array(checkSchema).max(12).optional(), metrics: z.array(rubricSchema).max(8).optional(),
    references: referencesSchema.optional(),
  })).max(200).refine(v => unique(v.map(c => c.scenarioId)), 'Duplicate scenario criteria').default([]),
  trialIds: z.array(identifier).min(1).max(3000).refine(unique, 'Duplicate trial IDs').optional(),
  judge: settingsSchema.shape.judge, codeOnly: z.boolean().default(false),
});
export type ReassessmentInput = z.input<typeof reassessmentSchema>;
export type DraftPatch = z.infer<typeof draftPatchSchema>;
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
  /** Fingerprint of the agent definition the source run evaluated (normalize.ts agentIdentity): the external agent's label, or a stored sandbox run's built-in agent. */
  agent: string;
  /** Fingerprint of the configured judge (provider, model, upstream). */
  judge: string;
  /** Scenario id → fingerprint of its normalized comparison identity. */
  scenarios: Record<string, string>;
}
/**
 * What the connection showed of the agent's tools before a preparation (connection.ts probeToolChannel): confirmed
 * when every reply declared its tool journal complete and named the tools; otherwise the reason the agent is judged
 * on its replies alone. Absent in records prepared before it existed and in drafts without a connection.
 */
export interface ToolChannel { confirmed: boolean; tools: string[]; reason?: string; checkedAt: string }
const toolChannelSchema = z.strictObject({ confirmed: z.boolean(), tools: z.array(z.string().min(1).max(200)).max(50),
  reason: z.string().max(300).optional(), checkedAt: z.string() });

/**
 * What the connection exam (exam.ts) saw before a run's first dialogue: each path and step, the turn the agent gave and
 * whether it was the one the path expects. `absent` — the connection has no exam: the run is measured, its percent is
 * not shown (result-view.ts). Absent in runs made before the exam existed; a re-assessment carries its run's.
 */
export const EXAM_TURNS = ['reply', 'buttons', 'handoff', 'no_reply', 'empty', 'service', 'missing'] as const;
export type ExamTurn = typeof EXAM_TURNS[number];
/**
 * How the customers Lab played compare with the logged ones of the same situations (realism.ts): the mean number of
 * customer messages after the opening a conversation, and the mean words of such a message. Never moves the number.
 */
const realismSideSchema = z.strictObject({ messages: z.number().nonnegative(), words: z.number().nonnegative() });
export const realismSchema = z.strictObject({ conversations: z.number().int().positive(), synthetic: realismSideSchema, logged: realismSideSchema });
export type Realism = z.infer<typeof realismSchema>;
export const examResultSchema = z.strictObject({
  checkedAt: z.string(), status: z.enum(['passed', 'failed', 'absent']),
  paths: z.array(z.strictObject({ name: z.string().max(200), passed: z.boolean(), steps: z.array(z.strictObject({
    said: z.string().max(3000), pressed: z.boolean(), expect: z.enum(['reply', 'buttons', 'handoff']), got: z.enum(EXAM_TURNS),
    passed: z.boolean(), problem: z.string().max(1000).optional(), status: z.string().max(200).optional(),
  })).max(8) })).max(10),
});
export type ExamResult = z.infer<typeof examResultSchema>;

export interface Experiment {
  generatorConfig?: unknown;
  generatorIdentity?: unknown;
  runKind?: 'evaluation' | 'diagnostic' | 'generator';
  librarySnapshot?: ScenarioLibrary;
  originalImport?: { id: string; contentHash: string };
  preparationProgress?: PreparationProgress;
  toolChannel?: ToolChannel;
  connectionExam?: ExamResult;
  realism?: Realism;
  schemaVersion: '1'; id: string; task: string; mode: 'demo' | 'live'; workflow: 'evaluate' | 'compare';
  createdAt: string; updatedAt: string; phase: Phase; message: string;
  sources: Source[]; settings: Settings; target: Target; requirements: Requirement[]; questions: string[];
  /** Retired owner golden cases and profiles: stored records keep them verbatim, nothing reads them. */
  goldenCases: unknown[]; dialogues: Dialogue[]; profiles: unknown[]; notes: string;
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
  /** Notes of what this record's result does not prove, as records wrote them before notes were typed; new records keep `caveats`. */
  usage: Usage; error: string | null; limitations: string[];
  /** What this record's result does not prove, typed and each once (caveats.ts): the owner reads them through caveatLines. Absent in older records. */
  caveats?: Caveat[];
  /**
   * How the last operation on this record was stopped before it ended by itself — the owner, the closing application,
   * its time or its budget — beside `error`, which keeps the line the owner reads. Absent when it ended by itself or
   * failed, and in records written before it existed (their `error` keeps the English label of the stop).
   */
  stop?: StopReason;
  humanReviews: HumanReview[]; resultsReviewedAt?: string; resultsReviewHash?: string;
  /**
   * The owner's labels of a blind check still under way (blind.ts): kept apart from `humanReviews` until the last one is
   * given, so neither the number nor anything else tells the owner how their labels compare with the judge before the
   * check is done; then they join `humanReviews` together. Absent in records without a check under way.
   */
  blindLabels?: HumanReview[];
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
  executionRunId?: string;
  assessmentOf?: string;
  assessmentTrialIds?: string[];
  evidenceHash?: string;
  discovery?: unknown;
  calibration?: Calibration; // the same situations judged on their recorded conversations (card/calibration.ts); never moves the number
}
export const usageSchema = z.strictObject({ calls: z.number().int().nonnegative(), inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), costUsd: z.number().finite().nonnegative().nullable() });
const revisionSchema = z.strictObject({ id: text, parentId: text.nullable(), spec: agentSchema, hypothesis: z.string(), createdAt: text });
export const trialSchema = z.strictObject({
  diagnosticReceipt: retired,
  checkpoints: z.array(checkpointResultSchema).max(12).optional(), checkpointReceipt: checkpointReceiptSchema.optional(),
  id: identifier, revisionId: text, scenarioId: identifier, familyId: identifier, repeat: z.number().int().nonnegative(),
  userMode: userModeSchema.default('reactive'),
  split: z.enum(['dev', 'control']), manifestHash: text, outcome: z.enum(['pass', 'fail', 'ungraded', 'invalid', 'cancelled']), reason: z.string(),
  checks: z.array(z.strictObject({ id: identifier, description: z.string(), passed: z.boolean(), evidence: z.string() })),
  simulatorChecks: z.array(z.strictObject({ id: z.enum(SIMULATOR_CHECK_IDS), description: z.string(), passed: z.boolean(), evidence: z.string(), seq: z.number().int().nonnegative().optional(), heuristic: z.boolean() })).max(12).optional(),
  events: z.array(z.strictObject({ seq: z.number().int().nonnegative(), type: z.enum(['user', 'assistant', 'simulator', 'observation', 'retrieval', 'tool_call', 'tool_result', 'error']), text: z.string().optional(), tool: z.string().max(200).optional(), args: z.unknown().optional(), result: z.unknown().optional(), state: worldSchema.optional() })),
  initialState: worldSchema, finalState: worldSchema, usage: usageSchema, elapsedMs: z.number().finite().nonnegative(),
  assessments: z.array(metricAssessmentSchema).max(12).optional(), assessmentError: z.string().max(4000).optional(),
  observation: z.strictObject({ state: z.enum(['sandbox', 'reported', 'missing']), tools: z.enum(['sandbox', 'complete', 'partial']), resetConfirmed: z.boolean().optional(), version: text.max(200).optional(), toolScope: z.array(z.string().max(200)).max(50).optional() }).optional(),
  externalUsage: usageSchema.optional(),
  judgeAudit: judgeAuditSchema.optional(),
  judgeReceipt: judgeReceiptSchema.optional(),
  invalidCause: z.enum(INVALID_CAUSES).optional(),
  assessmentFailure: z.enum(ASSESSMENT_FAILURES).optional(),
  turnLimit: z.literal(true).optional(),
  countingVersion: z.union([z.literal(2), z.literal(3)]).optional(),
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
  testId: identifier, scenarioId: identifier, definitionHash: sha256Schema, acceptedAt: text,
});
/** Files written by older versions load with defaults; the in-memory type is always complete. */
/*
 * FailureMode: a named cluster of dialogues that broke the same way. "Bad answer" is not a
 * failure mode; "found the article and still handed the client to the hotline" is. Naming the
 * failure precisely is what turns an evaluation into an improvement loop, so every cluster
 * must cite the dialogues it was drawn from and may name the stage where the chain broke.
 * Clusters cover the traces of this run only; they are not a picture of production traffic.
 */
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
    }
  }
}

export const experimentSchema: z.ZodType<Experiment> = z.strictObject({
  generatorConfig: retired, generatorIdentity: retired,
  runKind: z.enum(['evaluation', 'diagnostic', 'generator']).optional(),
  librarySnapshot: scenarioLibrarySchema.optional(),
  originalImport: z.strictObject({ id: identifier, contentHash: sha256Schema }).optional(),
  preparationProgress: preparationProgressSchema.optional(),
  toolChannel: toolChannelSchema.optional(),
  connectionExam: examResultSchema.optional(),
  realism: realismSchema.optional(),
  schemaVersion: z.literal('1'), id: identifier, task: text.max(8000), mode: z.enum(['demo', 'live']), createdAt: text, updatedAt: text,
  workflow: z.enum(['evaluate', 'compare']).default('compare'),
  phase: z.enum(PHASES), message: z.string(),
  sources: z.array(z.strictObject({ id: identifier, name: text, content: text, hash: text, kind: sourceKindSchema.optional() })).max(MATERIAL_LIMIT), settings: settingsSchema,
  target: targetSchema.default({ kind: 'sandbox' }),
  requirements: z.array(requirementSchema), questions: z.array(z.string()), scenarios: z.array(scenarioSchema.extend({ split: z.enum(['dev', 'control']) })),
  goldenCases: z.array(z.json()).max(40).default([]), dialogues: z.array(dialogueSchema).max(300).default([]), profiles: z.array(z.json()).max(12).default([]),
  notes: z.string().max(8000).default(''),
  revisions: z.array(revisionSchema), selectedRevisionId: text.nullable(), manifestHash: text.nullable(), reviewedAt: text.nullable(), reviewMode: z.enum(['human', 'expectations', 'automated']).nullable().default(null), controlConsumedAt: text.nullable(),
  acceptedDraftHash: sha256Schema.optional(),
  acceptedTests: z.array(acceptedTestSchema).max(200)
    .refine(tests => unique(tests.map(test => test.testId)) && unique(tests.map(test => test.scenarioId)), 'Accepted test identities must be unique').default([]),
  trials: z.array(trialSchema), comparisons: z.array(comparisonSchema), iterations: z.array(z.strictObject({ revisionId: text, accepted: z.boolean(), reason: z.string() })),
  usage: usageSchema, error: z.string().nullable(), limitations: z.array(z.string()), caveats: caveatsSchema.optional(), stop: z.enum(STOP_REASONS).optional(),
  humanReviews: z.array(humanReviewSchema).default([]), resultsReviewedAt: text.optional(), resultsReviewHash: text.optional(),
  blindLabels: z.array(humanReviewSchema).max(200).optional(),
  failureModes: z.array(failureModeSchema).max(30).optional(),
  releaseLog: releaseLogSchema.optional(),
  validationExclusions: z.array(validationExclusionSchema).max(300).optional(),
  parentRunId: identifier.optional(), selectedScenarioIds: z.array(identifier).min(1).max(200).optional(),
  positiveControlScenarioIds: z.array(identifier).min(1).max(5).refine(unique, 'Duplicate control IDs').optional(),
  ownerExpectationScenarioIds: z.array(identifier).min(1).max(40).refine(unique, 'Duplicate owner expectation IDs').optional(),
  targetVersion: text.max(200).optional(), targetFingerprint: text.optional(),
  clarifications: z.array(z.strictObject({ question: text.max(3000), answer: text.max(5000) })).max(100).optional(),
  executionRunId: identifier.optional(), assessmentOf: identifier.optional(), assessmentTrialIds: z.array(identifier).max(3000).optional(), evidenceHash: text.optional(),
  evaluatorVersion: text.optional(), targetRelease: text.max(200).optional(),
  sourceEvidence: z.strictObject({ runId: identifier, parentRunId: identifier.optional(), trials: z.array(trialSchema).max(600), humanReviews: z.array(humanReviewSchema).max(1000),
    identity: z.strictObject({ libraryHash: text.optional(), importHash: text.optional(), targetFingerprint: text.optional(), targetVersion: text.max(200).optional(), evaluatorVersion: text.optional(), manifestHash: text.nullable(),
      agent: text, judge: text, scenarios: z.record(identifier, text).refine(value => Object.keys(value).length <= 200, 'Too many scenario identities') }).optional() }).optional(),
  discovery: retired,
  calibration: calibrationSchema.optional(),
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
});

/** Stable JSON content identity; array order remains significant. */
export function fingerprint(value: unknown): string {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, normalize(x)])) : v;
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

/** Structural checks of an evaluate suite before it can run; every card gets the development split. */
export function validatePreparation(raw: unknown, sources: Source[]): Preparation {
  const p = preparationSchema.parse(raw);
  if (!p.scenarios.length) throw new Error('No cards to run: accept at least one situation');
  const requireUnique = (values: string[], name: string) => {
    if (!unique(values)) throw new Error(`Duplicate ${name}`);
  };
  requireUnique(p.requirements.map(r => r.id), 'requirement IDs');
  requireUnique(p.scenarios.map(s => s.id), 'scenario IDs');
  for (const r of p.requirements) {
    const source = sources.find(s => s.id === r.sourceId);
    if (!source?.content.includes(r.quote)) throw new Error(`Requirement ${r.id} has an ungrounded source quote`);
  }
  for (const s of p.scenarios) {
    const derived = withReferenceCriteria(s);
    s.checks = derived.checks;
    if (derived.metrics) s.metrics = derived.metrics; else delete s.metrics;
    if (s.checks.length > 12) throw new Error(`Карточка ${s.id}: вместе с проверками эталонов больше 12 проверок. Уберите лишние проверки или эталоны.`);
    if ((s.metrics?.length ?? 0) > 8) throw new Error(`Карточка ${s.id}: вместе с рубрикой эталона больше 8 рубрик.`);
    const synthetic = s.provenance === 'synthetic';
    if (synthetic && !s.requirementIds.length) throw new Error(`Scenario ${s.id} needs at least one grounded requirement`);
    if (synthetic) for (const answer of s.user.answers ?? []) {
      const known = valueTokens([s.user.opening, s.user.facts, ...(s.user.knows ?? [])].join('\n'));
      const unknown = [...valueTokens(answer.reply)].filter(token => !known.has(token));
      if (unknown.length) throw new Error(`Scenario ${s.id}: the reply to "${answer.ifAsked}" reveals a value the user does not know: ${unknown[0]}`);
    }
    // A card compiled from a brief is judged by its expectations alone: it carries no success criteria.
    if ((!s.successCriteria && !isCardExecution(s.execution)) || s.user.maxFollowUps === undefined) {
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
  return { ...p, scenarios: p.scenarios.map(s => ({ ...s, split: 'dev' as const })) };
}
