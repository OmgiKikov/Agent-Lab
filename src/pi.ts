import { InvalidGeneratorResponse } from './generator-errors.js';
import { checkpointResponseSchema } from './checkpoints.js';
import { CHECKPOINT_ROLE, LEGACY_CHECKPOINT_ROLE } from './prompts.js';
import { userDecisionSchema } from './user-controller.js';
import { USER_CONTROLLER_ROLE } from './prompts.js';
import { SCENARIO_OUTPUT_BYTES, SEMANTIC_BATCH_FIELDS, SEMANTIC_REASON_CHARS, serializedBytes, workInputIssue } from './scenario-work.js';
import { scenarioProposalSchema, semanticFindingSchema } from './scenario-contracts.js';
import { SCENARIO_PROPOSALS_ROLE, SCENARIO_SEMANTIC_ROLE, SOURCE_SELECTION_ROLE } from './prompts.js';
import { FOCUSED_REQUIREMENT_LIMIT } from './limits.js';
import {
  createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assessRepeated, JUDGE_PROTOCOL, JUDGE_RESPONSE_FORMAT } from './judge.js';
import { z } from 'zod';
import {
  checkSchema, failureModeSchema, requirementSchema, worldSchema,
  MACHINE_FORMAT, REQUIREMENT_LIMIT, VERSION, SIMULATOR_PROTOCOL, fingerprint, sourceSelectionSchema, userTurnSchema, verbatimSpan,
  type CallContext, type GroundingInput, type ScenarioProposalsInput, type Runtime, type Settings, type TargetSession,
} from './contracts.js';
import { ASSESS_ROLE, DATA_BOUNDARY, FAILURE_MODES_ROLE, REQUIREMENTS_ROLE, SIMULATOR_ROLE } from './prompts.js';

type Model = NonNullable<ReturnType<ModelRuntime['getModel']>>;
const groundingSchemaFor = (limit: number) => z.strictObject({
  requirements: z.array(requirementSchema).min(1).max(limit, { error: `Return at most ${limit} requirements: merge closely related rules into one requirement with one exact quote, and keep the rules a user can see violated in a reply` }),
  questions: z.array(z.string().trim().min(1).max(2000)).max(12),
});
const groundingSchema = groundingSchemaFor(REQUIREMENT_LIMIT);
const FOCUS_CLAUSE = `customerMessages holds what one real customer wrote in a dialogue these requirements must decide (the old agent's replies are withheld: they are not rules). Extract only the rules that determine the correct agent behaviour for that customer (the answer, the mandatory steps, what must not be said); skip rules the dialogue never touches. Start with the original request; later reactions to an instruction do not prove the service already exists. Preserve unknown product/channel/prerequisites as conditions and allow appropriate clarification or qualified alternatives. Do not require every channel or an unrequested follow-on operation. Return at most ${FOCUSED_REQUIREMENT_LIMIT} requirements.`;

/** One grounding call: the whole policy of the supplied sources, or, with a focus, only the rules that decide one customer's dialogue. */
export function groundingRequest(input: GroundingInput) {
  const focused = !!input.focus;
  return {
    limit: focused ? FOCUSED_REQUIREMENT_LIMIT : REQUIREMENT_LIMIT,
    role: focused ? `${REQUIREMENTS_ROLE}\n${FOCUS_CLAUSE}` : REQUIREMENTS_ROLE,
    schema: groundingSchemaFor(focused ? FOCUSED_REQUIREMENT_LIMIT : REQUIREMENT_LIMIT),
    payload: {
      task: input.task,
      sources: input.sources.map(({ id, name, content, kind }) => ({ id, name: kind === 'prompt' ? `${name} (промпт агента)` : name, content, ...(kind ? { kind } : {}) })),
      ...(input.focus ? { customerMessages: [...input.focus.customerMessages] } : {}),
    },
  };
}
function groundingProblem(value: z.infer<typeof groundingSchema>, sources: { id: string; name: string; content: string; kind?: 'knowledge' | 'prompt' }[]): string | undefined {
  const missing: string[] = [];
  for (const requirement of value.requirements) {
    const source = sources.find(candidate => candidate.id === requirement.sourceId);
    if (!source) return `Requirement ${requirement.id} cites source ${requirement.sourceId}, which was not supplied.`;
    const exact = verbatimSpan(source.content, requirement.quote);
    if (exact && source.kind === 'prompt' && MACHINE_FORMAT.test(exact)) {
      return `Requirement ${requirement.id} quotes a machine output format ("${exact.slice(0, 60)}"): a JSON envelope or a named field is an internal interface between the agent's components, not a rule a user can observe. Drop this requirement.`;
    }
    if (exact) { requirement.quote = exact; continue; }
    const elsewhere = sources.filter(candidate => candidate.id !== source.id && verbatimSpan(candidate.content, requirement.quote));
    if (elsewhere.length === 1) {
      requirement.sourceId = elsewhere[0]!.id;
      requirement.quote = verbatimSpan(elsewhere[0]!.content, requirement.quote)!;
      continue;
    }
    missing.push(`${requirement.id} (not in "${source.name}")`);
  }
  return missing.length
    ? `These quotes are not verbatim substrings of their sources: ${missing.join('; ')}. Copy the exact characters from the source instead of paraphrasing; a shorter contiguous fragment is safer than a long one. Keep every other requirement as it is.`
    : undefined;
}
const simulatorReplySchema = z.strictObject({ done: userTurnSchema.shape.done, message: userTurnSchema.shape.message.optional() })
  .refine(v => v.done || !!v.message?.trim(), 'A continuing user turn needs a message')
  .describe('To stop immediately, return done:true and omit message. A nonempty message is always delivered to the target. done:true with a nonempty message means deliver this final user message, receive the target response, then end. done:true with an empty message means stop now without another target response.');
const authHelp = 'Войдите в Pi через /login или задайте ключ выбранного провайдера, затем выберите доступную модель. Живой прогон никогда не подменяется демо.';

export const evaluatorVersion = (settings: Settings): string => fingerprint({ protocol: VERSION, judge: JUDGE_PROTOCOL, simulator: { role: SIMULATOR_ROLE, protocol: SIMULATOR_PROTOCOL },
  provider: settings.provider, model: settings.model, roles: settings.roles ?? {}, judgeModel: settings.judge });

/** Explicit resources avoid global/project extensions, skills, AGENTS files and prompt discovery. */
function resources(systemPrompt: string): ResourceLoader {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/** One tool-less Pi session: a structured-output role, the judge or the free user simulator. */
async function controlledSession(
  modelRuntime: ModelRuntime, model: Model, systemPrompt: string,
  ctx: CallContext, maxTokens = 16384, temperature?: number, responseFormat?: Record<string, unknown>, thinkingLevel: 'off' | 'medium' = 'off', maxInputBytes?: number,
): Promise<TargetSession> {
  ctx.signal.throwIfAborted();
  const { session } = await createAgentSession({
    modelRuntime, model, thinkingLevel, resourceLoader: resources(systemPrompt),
    tools: [], noTools: 'builtin', customTools: [],
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
      enableAnalytics: false, enableInstallTelemetry: false, transport: 'sse',
    }),
  });
  let activeSignal = ctx.signal;
  let boundaryError: unknown;
  let closed = false;
  let responding = false;
  let pendingUsage = 0;
  const stream = session.agent.streamFunction;
  // Count every provider request. SDK/provider retries are disabled.
  session.agent.streamFunction = async (m, context, options) => {
    try {
      activeSignal.throwIfAborted();
      // Bytes and the provider token window are different units. This gate is the byte cap only; the provider rejects a prompt that does not fit its window.
      if (maxInputBytes && serializedBytes({ ...context, systemPrompt }) > maxInputBytes) {
        boundaryError = new Error('Запрос превышает безопасный контекст модели; полная хронология сохранена для меньшего пакета.');
        throw boundaryError;
      }
      try { ctx.beforeCall(); }
      catch (error) { boundaryError = error; throw error; }
      pendingUsage++;
      return await stream(m, { ...context, systemPrompt }, {
        ...options, signal: AbortSignal.any([activeSignal, ...(options?.signal ? [options.signal] : [])]),
        timeoutMs: ctx.timeoutMs, maxRetries: 0, maxTokens: Math.min(maxTokens, model.maxTokens), ...(temperature === undefined ? {} : { temperature }),
        ...(responseFormat ? { onPayload: (payload: unknown) => ({ ...(payload as Record<string, unknown>), response_format: responseFormat }) } : {}),
      });
    } catch (error) {
      // Preserve our own budget/cancellation error; provider errors are sanitized at the response boundary.
      if (activeSignal.aborted) boundaryError = activeSignal.reason;
      throw error;
    }
  };
  const unsubscribe = session.subscribe(event => {
    const emit = (value: Parameters<NonNullable<CallContext['onTargetEvent']>>[0]) => {
      try { ctx.onTargetEvent?.(value); }
      catch (error) { boundaryError = error; session.agent.abort(); throw error; }
    };
    if (event.type !== 'message_end' || event.message.role !== 'assistant') return;
    if (event.message.stopReason !== 'stop' || event.message.content.some(c => c.type === 'toolCall')) {
      const text = event.message.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (text.trim()) emit({ type: 'assistant', text });
    }
    if (!pendingUsage) return; // A rejected budget check can produce a synthetic SDK error, with no request dispatched.
    pendingUsage--;
    const usage = event.message.usage;
    const validCount = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    const cost = usage?.cost?.total;
    const hasUsage = usage && [usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(validCount);
    ctx.addUsage({
      inputTokens: hasUsage ? usage.input + usage.cacheRead + usage.cacheWrite : 0,
      outputTokens: hasUsage ? usage.output : 0,
      costUsd: hasUsage && validCount(cost) && usage.totalTokens > 0
        && Object.values(model.cost).some(n => typeof n === 'number' && n > 0)
        ? cost : null,
    });
  });
  return {
    async respond(message) {
      if (closed) throw new Error('Pi session is closed');
      if (responding) throw new Error('Pi session already has an active response');
      ctx.signal.throwIfAborted();
      responding = true;
      boundaryError = undefined;
      const deadline = new AbortController();
      activeSignal = AbortSignal.any([ctx.signal, deadline.signal]);
      const timer = setTimeout(() => deadline.abort(new Error('Pi request deadline exceeded')), ctx.timeoutMs);
      const start = session.messages.length;
      let onAbort: () => void = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => { session.agent.abort(); reject(activeSignal.reason); };
        activeSignal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        await Promise.race([session.prompt(message, { expandPromptTemplates: false }), aborted]);
        activeSignal.throwIfAborted();
        if (boundaryError) throw boundaryError;
        const last = session.messages.slice(start).findLast(m => m.role === 'assistant');
        if (!last || last.role !== 'assistant' || last.stopReason !== 'stop') {
          // Persist only a fixed diagnostic category; SDK errors can contain credentials and URLs.
          const detail = last?.role === 'assistant' ? last.errorMessage ?? '' : '';
          const category = /429|rate.?limit/i.test(detail) ? 'rate limit'
            : /402|credit|balance/i.test(detail) ? 'insufficient credit'
            : /401|403|unauthorized|forbidden/i.test(detail) ? 'access denied'
            : /timeout|timed out/i.test(detail) ? 'timeout'
            : /fetch failed|connection|socket|network/i.test(detail) ? 'connection failure'
            : /context.?length|too many tokens/i.test(detail) ? 'context limit'
            : last?.role === 'assistant' ? last.stopReason : 'missing response';
          throw new Error(`Pi provider response incomplete: ${category}`);
        }
        const output = last.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
        if (!output.trim()) throw new Error('Модель вернула пустой ответ.');
        return output;
      } catch (error) {
        if (activeSignal.aborted) throw activeSignal.reason;
        if (boundaryError) throw boundaryError;
        // Provider errors may contain request headers or secret-bearing URLs. Do not persist their raw text.
        if (error instanceof Error && error.message.startsWith('Pi ')) throw error;
        throw new Error(`Запрос к ${model.provider}/${model.id} не прошёл. Проверьте доступ, права на модель и доступность провайдера.`);
      } finally {
        clearTimeout(timer);
        activeSignal.removeEventListener('abort', onAbort);
        responding = false;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      session.agent.abort();
      unsubscribe();
      session.dispose();
      if (pendingUsage) {
        pendingUsage = 0;
        ctx.addUsage({ inputTokens: 0, outputTokens: 0, costUsd: null });
      }
    },
  };
}

/**
 * The response must be exactly JSON, as requested from the provider. The text is parsed as written: broken quotes,
 * raw line breaks and a missing brace are a failed attempt, not a local rewrite.
 */
function parseJsonOutput(output: string): unknown {
  try { return JSON.parse(output.trim()); }
  catch (error) { throw new Error(`Output is not JSON: ${error instanceof Error ? error.message : 'unreadable'}`); }
}

/**
 * Repairing a nearly correct object is a much easier task for a model than writing one
 * from scratch, so a rejected answer goes back into the same session with the exact
 * reason. Attempts are bounded: after the last the run fails out loud instead of
 * spinning and spending the owner's budget. Rejection text is model-facing and stays
 * English, like the roles; what the owner reads is translated at the throw site.
 */
export const REPAIR_ATTEMPTS = 5;

async function jsonResponse<S extends z.ZodType>(
  modelRuntime: ModelRuntime, model: Model, label: string, role: string, input: unknown, schema: S, ctx: CallContext,
  review?: (value: z.infer<S>) => string | undefined,
): Promise<z.infer<S>> {
  const bounded = role === SCENARIO_PROPOSALS_ROLE || role === SCENARIO_SEMANTIC_ROLE;
  if (bounded && workInputIssue(input)) throw new Error(workInputIssue(input));
  const prompt = `${role}\n${DATA_BOUNDARY}\nReturn exactly one compact JSON object, without markdown fences or pretty-printing whitespace, matching this JSON schema:\n${JSON.stringify(z.toJSONSchema(schema))}\nInside strings, escape double quotes as \\" and line breaks as \\n; when copying source text, «» may stand for its straight double quotes.`;
  // Only target sessions contribute target trace events; simulator/planner events cannot affect target grades.
  ctx.onGeneratorTransport?.({ role: label, provider: model.provider, model: model.id, api: model.api, effectiveTemperature: 'provider-default' });
  let currentAttempt = 0;
  const open = () => controlledSession(modelRuntime, model, prompt, { ...ctx, onTargetEvent: event => {
    // Retain incomplete structured replies as evidence, without accepting or grading them.
    if (event.type === 'assistant' && event.text) ctx.onGeneratorOutput?.({ role, text: event.text, attempt: currentAttempt, incomplete: true });
  } }, bounded ? SCENARIO_OUTPUT_BYTES : 16384, undefined, model.provider === 'openrouter' ? { type: 'json_object' } : undefined, 'off', bounded ? 96000 : undefined);
  let session = await open();
  try {
    let message = JSON.stringify(input);
    let rejection = '';
    for (let attempt = 1; attempt <= REPAIR_ATTEMPTS; attempt++) {
      currentAttempt = attempt;
      const output = await session.respond(message);
      ctx.onGeneratorOutput?.({role,text:output,attempt});
      let parsed: unknown;
      let outcome: 'syntax' | 'schema' | 'domain' = 'domain';
      try {
        if (bounded && Buffer.byteLength(output, 'utf8') > SCENARIO_OUTPUT_BYTES) throw new Error('Ответ превышает 12000 байт; сократите его без потери обязательных полей');
        parsed = parseJsonOutput(output); rejection = ''; }
      catch (error) { rejection = `The reply was not a single JSON object (${error instanceof Error ? error.message : 'unreadable'}). Return one JSON object and nothing else; escape line breaks inside strings as \\n.`; outcome = 'syntax'; }
      if (!rejection) {
        const validated = schema.safeParse(parsed);
        if (!validated.success) {
          rejection = `These fields do not match the schema: ${validated.error.issues.map(i => `${i.path.join('.') || 'root'} (${i.message})`).join('; ')}.`;
          outcome = 'schema';
        } else {
          const problem = review?.(validated.data);
          if (!problem) {
            ctx.onGeneratorValidation?.({ attempt, accepted: true });
            return validated.data;
          }
          rejection = problem;
          outcome = 'domain';
        }
      }
      ctx.onGeneratorValidation?.({ attempt, accepted: false, reason: rejection, outcome });
      if (process.env['AGENT_LAB_DEBUG_DIR']) {
        await mkdir(process.env['AGENT_LAB_DEBUG_DIR'], { recursive: true });
        await writeFile(join(process.env['AGENT_LAB_DEBUG_DIR'], `${label.replace(/[^\p{L}\p{N}]+/gu, '_')}-${Date.now()}-${attempt}.txt`), `${rejection}\n\n${output}`, { mode: 0o600 });
      }
      message = `Your previous answer was rejected. ${rejection}\nReturn the corrected object in full, as one compact JSON object and nothing else.`;
      if (bounded && attempt < REPAIR_ATTEMPTS) {
        // Keep the original evidence and only the latest failure; accumulating invalid full drafts can exhaust the context.
        await session.close();
        session = await open();
        message = JSON.stringify({ input, repair: message,
          ...(Buffer.byteLength(output, 'utf8') <= SCENARIO_OUTPUT_BYTES ? { previousReply: output } : { previousReplyOmitted: 'Rejected reply exceeds the output limit; regenerate compactly from the original evidence.' }) });
      }
    }
    throw new InvalidGeneratorResponse(`модель ${REPAIR_ATTEMPTS} раза подряд вернула ответ, который не проходит проверку. Последняя причина: ${rejection}`);
  } catch (error) {
    const message = `${label}: ${error instanceof Error ? error.message : 'шаг не удался'}`;
    throw error instanceof InvalidGeneratorResponse ? new InvalidGeneratorResponse(message, { cause: error }) : new Error(message, { cause: error });
  } finally { await session.close(); }
}

export async function getPiStatus(injectedRuntime?: ModelRuntime): Promise<{
  models: Array<{ provider: string; id: string; name: string }>; error?: string;
}> {
  try {
    const signal = AbortSignal.timeout(10000);
    const runtime = injectedRuntime ?? await ModelRuntime.create({ allowModelNetwork: false, signal });
    const available = await runtime.getAvailable(undefined, { signal });
    return {
      models: available.map(m => ({ provider: m.provider, id: m.id, name: m.name })),
      ...(available.length ? {} : { error: authHelp }),
    };
  } catch { return { models: [], error: `Не удалось прочитать список доступных моделей. ${authHelp}` }; }
}

/** The optional SDK runtime is the integration seam for custom providers and offline SDK checks. */
export async function createPiRuntime(settings: Settings, injectedRuntime?: ModelRuntime): Promise<Runtime> {
  if (!settings.provider || !settings.model) throw new Error(`Выберите провайдера и модель. ${authHelp}`);
  const signal = AbortSignal.timeout(settings.timeoutMs);
  let modelRuntime: ModelRuntime;
  try { modelRuntime = injectedRuntime ?? await ModelRuntime.create({ allowModelNetwork: false, signal }); }
  catch { throw new Error(`Не удалось инициализировать Pi. ${authHelp}`); }
  const configuredModel = (choice: { provider: string; model: string }) => {
    const model = modelRuntime.getModel(choice.provider, choice.model);
    if (model) return model;
    const joined = `${choice.provider}/${choice.model}`;
    const suggested = modelRuntime.getModels().find(candidate => `${candidate.provider}/${candidate.id}` === joined || `${candidate.provider}/${candidate.id}` === choice.provider);
    throw new Error(`Модель не найдена в конфигурации Pi: provider=${choice.provider}, model=${choice.model}.${suggested
      ? ` Укажите provider="${suggested.provider}", model="${suggested.id}"; это разные поля.`
      : ' Прочитайте доступные модели через agent-lab status и выберите точную пару provider/model.'}`);
  };
  const model = configuredModel(settings);
  let available: Awaited<ReturnType<ModelRuntime['getAvailable']>>;
  try { available = await modelRuntime.getAvailable(settings.provider, { signal }); }
  catch { throw new Error(`Не удалось проверить доступ к моделям. ${authHelp}`); }
  if (!available.some(m => m.id === model.id)) throw new Error(authHelp);
  // Validate every requested role before the first paid builder call, not only when the judge is eventually reached.
  const roles = [...Object.values(settings.roles ?? {}), ...(!settings.roles?.judge && settings.judge ? [settings.judge] : [])];
  const checkedProviders = new Map([[settings.provider, available]]);
  for (const choice of roles) {
    if (!choice) continue;
    const selected = configuredModel(choice);
    let models = checkedProviders.get(choice.provider);
    if (!models) {
      try { models = await modelRuntime.getAvailable(choice.provider, { signal }); }
      catch { throw new Error(`Не удалось проверить доступ к модели роли ${choice.provider}/${choice.model}. ${authHelp}`); }
      checkedProviders.set(choice.provider, models);
    }
    if (!models.some(m => m.id === selected.id)) throw new Error(`Модель роли недоступна: ${choice.provider}/${choice.model}. ${authHelp}`);
  }
  const ask = async <S extends z.ZodType>(label: string, role: string, input: unknown, schema: S, ctx: CallContext,
    review?: (value: z.infer<S>) => string | undefined): Promise<z.infer<S>> => {
    const semanticRepair = role === SCENARIO_PROPOSALS_ROLE && (input as ScenarioProposalsInput).feedback?.issues.some(i => i.code === 'semantic_finding');
    const choice = settings.roles?.[(role === ASSESS_ROLE || role === CHECKPOINT_ROLE || role === LEGACY_CHECKPOINT_ROLE || role === SCENARIO_SEMANTIC_ROLE || semanticRepair) ? 'judge' : (role === SIMULATOR_ROLE || role === USER_CONTROLLER_ROLE) ? 'simulator' : 'builder'] ?? (role === CHECKPOINT_ROLE || role===LEGACY_CHECKPOINT_ROLE || role === SCENARIO_SEMANTIC_ROLE || semanticRepair ? settings.judge : undefined);
    let selected = model;
    if (choice) {
      const override = modelRuntime.getModel(choice.provider, choice.model);
      const models = await modelRuntime.getAvailable(choice.provider, { signal: ctx.signal });
      if (!override || !models.some(m => m.id === override.id)) throw new Error(`Модель роли недоступна: ${choice.provider}/${choice.model}. ${authHelp}`);
      selected = override;
    }
    if ((role === CHECKPOINT_ROLE || role===LEGACY_CHECKPOINT_ROLE) && selected.provider === 'openrouter') {
      const upstream = settings.roles?.judge ? undefined : settings.judge?.upstream;
      selected = { ...selected, api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', compat: { ...selected.compat, supportsDeveloperRole: false, maxTokensField: 'max_tokens', ...(upstream ? { openRouterRouting: { only: [upstream], allow_fallbacks: false } } : {}) } };
    }
    return jsonResponse(modelRuntime, selected, label, role, input, schema, ctx, review);
  };
  const runtime:Runtime = {
    generatorTransport:'pi-model',
    async selectSources(input, ctx) {
      const known = new Set(input.catalog.map(item => item.id));
      return ask('Выбор статей под диалог', SOURCE_SELECTION_ROLE, input, sourceSelectionSchema, ctx, value => {
        const unknown = value.sourceIds.filter(id => !known.has(id));
        if (unknown.length) return `Unknown source ids: ${unknown.join(', ')}. Return only ids from the catalog.`;
        if (value.sourceIds.length > input.limit) return `Return at most ${input.limit} ids, the most important first.`;
        return undefined;
      });
    },
    async scenarioProposals(input, ctx) {
      if (input.preparationMode === 'owner_requirements') {
        if (input.batchId !== undefined || input.dialogues.length) throw new Error('Подготовка без логов не может ссылаться на импорт или диалоги.');
      } else if (!input.batchId?.trim() || !input.dialogues.length) throw new Error('Для извлечения из импорта нужны batchId и исходные диалоги.');
      return (await ask('Варианты из полной хронологии', SCENARIO_PROPOSALS_ROLE, input,
        z.strictObject({ proposals: z.array(scenarioProposalSchema.extend({ variant: scenarioProposalSchema.shape.variant.omit({ sourceCoverageRequired: true, sourceCoverageBasis: true }).extend({
          environmentFixture: scenarioProposalSchema.shape.variant.shape.environmentFixture.extend({ initialState: worldSchema }),
          evaluationSpec: scenarioProposalSchema.shape.variant.shape.evaluationSpec.extend({
            checkpoints: z.array(scenarioProposalSchema.shape.variant.shape.evaluationSpec.shape.checkpoints.element.extend({ check: checkSchema.optional() })).min(1).max(12),
          }),
        }) })).max(1) }), ctx, value => {
          for (const proposal of value.proposals) {
            const variant = proposal.variant;
            const logs = input.dialogues.filter(d => variant.sourceDialogues.some(ref => ref.dialogueId === d.id));
            if (logs.length === 1 && logs[0]!.messages.filter(m => m.role === 'user').length === 1 && variant.sourceCoverage?.length) {
              return 'sourceCoverage accounts only for customer turns AFTER the first customer message. This source has one customer message: omit sourceCoverage or return an empty array. The opening is not a continuation.';
            }
            if (variant.provenance !== 'production' || variant.userState.facts.length) continue;
            if (logs.length === 1 && logs[0]!.messages.filter(m => m.role === 'user').length === 1
              && (variant.behaviorPolicy.maxFollowUps !== 0 || variant.behaviorPolicy.actions.some(a => a.kind !== 'finish'))) {
              return 'This observed dialogue has one customer request and no grounded personal facts. Preserve that one-turn scope: maxFollowUps:0 and finish-only policy after the first agent reply. Do not invent an obstacle, a factual answer or customer inability to extend the observed test. Additional conditions belong in a separately proposed variant.';
            }
          }
          return undefined;
        })).proposals;
    },
    async assessScenarioProposals(input, ctx) {
      return (await ask('Смысловая проверка вариантов', SCENARIO_SEMANTIC_ROLE, input,
        z.strictObject({ findings: z.array(semanticFindingSchema.extend({ reason: z.string().trim().min(1).max(SEMANTIC_REASON_CHARS) })).max(SEMANTIC_BATCH_FIELDS) }), ctx, value => {
          const expected = input.fields.flatMap(f => f.paths.map(path => `${f.variantId}/${path}`));
          const actual = value.findings.map(f => `${f.variantId}/${f.path}`);
          return expected.length !== actual.length || expected.some(id => actual.filter(value => value === id).length !== 1) ? 'Return exactly one finding for each requested field, and no other fields.' : undefined;
        })).findings;
    },
    async groundRequirements(input, ctx) {
      const request = groundingRequest(input);
      return ask('Требования', request.role, request.payload, request.schema, ctx, value =>
        new Set(value.requirements.map(r => r.id)).size !== value.requirements.length
          ? 'Two requirements share an id; give every requirement a unique id.' : groundingProblem(value, input.sources));
    },
    async failureModes(input, ctx) {
      const known = new Set(input.failures.map(f => f.trialId));
      const result = await ask(
        'Разбор провалов',
        FAILURE_MODES_ROLE,
        { task: input.task, failures: input.failures, ...(input.prompt !== undefined ? { prompt: input.prompt } : {}) },
        z.strictObject({ modes: z.array(failureModeSchema).min(1).max(12) }), ctx,
        value => {
          for (const mode of value.modes) {
            const unknown = mode.trialIds.filter(id => !known.has(id));
            if (unknown.length) return `Cluster ${mode.id} cites dialogues that are not in the supplied failures: ${unknown.join(', ')}.`;
            if (/^(bad|poor|wrong|incorrect|quality|agent failed|плохой|неверный)/i.test(mode.name.trim())) {
              return `Cluster ${mode.id} is named "${mode.name}", which does not say what went wrong. Name the specific behaviour visible in the traces.`;
            }
            for (const [index, quote] of (mode.promptQuotes ?? []).entries()) {
              if (input.prompt === undefined) return `No prompt was supplied; promptQuotes must be empty for cluster ${mode.id}.`;
              const exact = verbatimSpan(input.prompt, quote);
              if (!exact) return `Cluster ${mode.id} quotes "${quote.slice(0, 60)}", which is not a verbatim substring of the supplied prompt. Copy the exact characters.`;
              mode.promptQuotes![index] = exact;
            }
          }
          return undefined;
        },
      );
      return result.modes;
    },
    async assess(input, ctx) {
      const judge = settings.roles?.judge ?? settings.judge ?? { provider: settings.provider, model: settings.model };
      const upstream = settings.roles?.judge ? undefined : settings.judge?.upstream;
      const resolved = modelRuntime.getModel(judge.provider, judge.model);
      if (!resolved) throw new Error(`Judge model unavailable: ${judge.provider}/${judge.model}`);
      // Pi's catalog selects the Anthropic-native endpoint for Sonnet. OpenRouter
      // routing options belong to the Chat Completions adapter; use that adapter
      // explicitly instead of recording a routing preference the transport ignores.
      const judgeModel: Model = judge.provider === 'openrouter' ? {
        ...resolved, api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1',
        compat: { ...resolved.compat, supportsDeveloperRole: false, maxTokensField: 'max_tokens', ...(upstream ? {
          openRouterRouting: { only: [upstream], allow_fallbacks: false },
        } : {}) },
      } : resolved;
      return assessRepeated(input, { ...judgeModel,
        configurationHash: fingerprint({ api: judgeModel.api, baseUrl: judgeModel.baseUrl, compat: judgeModel.compat,
          temperature: judgeModel.reasoning ? 'default' : 0, thinking: judgeModel.reasoning ? 'medium' : 'off' }),
        transport: { api: judgeModel.api, upstream, structured: judge.provider === 'openrouter' },
      }, ctx, async (prompt, data, recordPartial) => {
        const session = await controlledSession(modelRuntime, judgeModel, prompt, { ...ctx, onTargetEvent: event => {
          if (event.type === 'assistant' && event.text) recordPartial(event.text);
        } }, 16384, judgeModel.reasoning ? undefined : 0, judge.provider === 'openrouter' ? JUDGE_RESPONSE_FORMAT : undefined, judgeModel.reasoning ? 'medium' : 'off');
        try { return await session.respond(data); } finally { await session.close(); }
      });
    },
    async assessCheckpoints(input, ctx) {
      return (await ask('Контрольные точки', input.checkpoints.some(c=>Object.hasOwn(c,'context'))?CHECKPOINT_ROLE:LEGACY_CHECKPOINT_ROLE, input, checkpointResponseSchema(input.checkpoints.map(item => item.checkpoint)), ctx)).results;
    },
    async selectUserAction(input, ctx) {
      return ask('Действие пользователя', USER_CONTROLLER_ROLE, input, userDecisionSchema, ctx);
    },
    async userTurn(input, ctx) {
      const reply = await ask(
        'Реплика пользователя',
        SIMULATOR_ROLE,
        {
          user: {
            goal: input.user.goal, persona: input.user.persona, characteristics: input.user.characteristics,
            facts: input.user.facts, behavior: input.user.behavior, opening: input.user.opening, maxFollowUps: input.user.maxFollowUps,
            knows: input.user.knows ?? [], cannotKnow: input.user.cannotKnow ?? [], answers: input.user.answers ?? [],
          },
          messages: input.messages.map(({ role, content }) => ({ role, content })), turn: input.turn,
        }, simulatorReplySchema, ctx,
      );
      return { ...reply, message: reply.message ?? '' };
    },
  };
  return runtime;
}
