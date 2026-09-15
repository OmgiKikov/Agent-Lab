import {
  createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
  type ResourceLoader, type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import { assessRepeated, JUDGE_PROTOCOL, JUDGE_RESPONSE_FORMAT } from './judge.js';
import { z } from 'zod';
import {
  agentSchema, failureModeSchema, observedGoalSchema, observedProfileSchema, preparationSchema, proposalSchema, requirementSchema, scenarioSchema,
  MACHINE_FORMAT, REQUIREMENT_LIMIT, SCENARIO_LIMIT, TOOL_NAMES, VERSION, SIMULATOR_PROTOCOL, fingerprint, promptCompliance, simulatorFidelity, userTurnSchema, validateObservedGoals, valueTokens, verbatimSpan,
  type CallContext, type Runtime, type Settings, type TargetSession, type Tool,
} from './contracts.js';
import { AGENT_ROLE, ASSESS_ROLE, DATA_BOUNDARY, EXTERNAL_CARDS_CLAUSE, FAILURE_MODES_ROLE, FAMILY_PLAN_ROLE, GOALS_ROLE, IMPROVE_ROLE, PROFILES_ROLE, REQUIREMENTS_ROLE, SIMULATOR_ROLE, TOOL_GUIDE, cardsRole } from './prompts.js';

type Model = NonNullable<ReturnType<ModelRuntime['getModel']>>;
const groundingSchema = z.strictObject({
  requirements: z.array(requirementSchema).min(1).max(REQUIREMENT_LIMIT, { error: `Return at most ${REQUIREMENT_LIMIT} requirements: merge closely related rules into one requirement with one exact quote, and keep the rules a user can see violated in a reply` }),
  questions: z.array(z.string().trim().min(1).max(2000)).max(12),
});
const familyPlanSchema = z.strictObject({ families: z.array(z.strictObject({
  familyId: scenarioSchema.shape.familyId,
  mechanism: z.string().trim().min(1).max(300),
  requirementIds: scenarioSchema.shape.requirementIds,
})).min(4).max(16) });
// New generated cards require an explicit interaction budget; older saved cards keep their original semantics.
// With observed profiles the model may only choose a profileId; persona text is copied from the profile later.
const RUBRIC_LIMIT = 8;
// ponytail: conservative serialized-input cap; derive it from model token metadata if legitimate score inputs regularly hit it.
const GOALS_INPUT_LIMIT = 120_000;
const scoredGoalSchema = observedGoalSchema.extend({ requirementIds: observedGoalSchema.shape.requirementIds.unwrap().min(1) });
/** Instructions about the shape of a machine reply: an envelope the user never sees. */
/** external cards get harness rubrics after generation (fidelity, and prompt compliance when a prompt source exists); the model may use only what is left. */
const generatedScenarioSchema = (external: boolean, harnessRubrics = 0, confirmed = false) => scenarioSchema.required({ successCriteria: true, assumptions: true, metrics: true })
  // Models like to label the whole card with a stage; stages belong to criteria, so the label is accepted here and dropped in the review.
  .extend({ user: scenarioSchema.shape.user.required({ maxFollowUps: true }), stage: z.string().max(80).optional() })
  .refine(s => confirmed || (external ? s.checks.length > 0 || s.metrics.some(m => m.subject === 'agent')
    : s.metrics.some(m => m.subject === 'agent') && s.metrics.some(m => m.subject === 'simulator')),
    'Provide an agent-goal rubric, or literal answer checks for an external goal; sandbox cards also need simulator fidelity')
  .refine(s => !external || confirmed || s.checks.every(c => ['answer_equals', 'answer_contains', 'answer_omits'].includes(c.kind))
    && !Object.keys(s.initialState.records).length && !s.initialState.writableFields.length && !s.initialState.transientFailures,
    'Without an external state/tool contract use only source-grounded answer checks and an empty initialState; assess semantic answers with agent rubrics')
  .refine(s => !external || s.metrics.length <= RUBRIC_LIMIT - harnessRubrics && s.metrics.every(m => m.subject === 'agent' && m.id !== simulatorFidelity.id && m.id !== promptCompliance.id),
    `External generation uses at most ${RUBRIC_LIMIT - harnessRubrics} agent rubrics only; the harness adds user_fidelity for the simulator${harnessRubrics > 1 ? ' and prompt_compliance for the supplied prompt source' : ' and prompt_compliance when a prompt source is supplied'}`)
  .refine(s => !confirmed || s.metrics.length === 1 && s.metrics[0]?.id === 'goal_attainment' && s.metrics[0].subject === 'agent'
    && s.metrics[0].passCriteria === s.successCriteria,
    'A confirmed test must contain exactly one generated agent rubric: goal_attainment, with passCriteria equal to successCriteria verbatim');
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

async function controlledSession(
  modelRuntime: ModelRuntime, model: Model, systemPrompt: string, tools: Tool[],
  ctx: CallContext, maxTokens = 16384, temperature?: number, structuredJudge = false, thinkingLevel: 'off' | 'medium' = 'off',
): Promise<TargetSession> {
  ctx.signal.throwIfAborted();
  if (new Set(tools.map(t => t.name)).size !== tools.length
    || tools.some(t => !TOOL_NAMES.includes(t.name))) throw new Error('Unapproved or duplicate target tool');
  const executedCalls = new Set<string>();
  const pendingCalls = new Map<string, { tool: string; args: unknown }>();
  const customTools: ToolDefinition[] = tools.map(tool => ({
    name: tool.name, label: tool.name, description: tool.description,
    parameters: Type.Unsafe(tool.parameters), executionMode: 'sequential',
    async execute(id, args, signal) {
      ctx.signal.throwIfAborted();
      signal?.throwIfAborted();
      executedCalls.add(id);
      const result = await tool.execute(args);
      return { content: [{ type: 'text', text: JSON.stringify(result) ?? 'null' }], details: {} };
    },
  }));
  const { session } = await createAgentSession({
    modelRuntime, model, thinkingLevel, resourceLoader: resources(systemPrompt),
    tools: tools.map(t => t.name), noTools: 'builtin', customTools,
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
  // Count every provider request, including continuations after tool calls. SDK/provider retries are disabled.
  session.agent.streamFunction = async (m, context, options) => {
    try {
      activeSignal.throwIfAborted();
      try { ctx.beforeCall(); }
      catch (error) { boundaryError = error; throw error; }
      pendingUsage++;
      return await stream(m, { ...context, systemPrompt }, {
        ...options, signal: AbortSignal.any([activeSignal, ...(options?.signal ? [options.signal] : [])]),
        timeoutMs: ctx.timeoutMs, maxRetries: 0, maxTokens: Math.min(maxTokens, model.maxTokens), ...(temperature === undefined ? {} : { temperature }),
        ...(structuredJudge ? { onPayload: (payload: unknown) => ({ ...(payload as Record<string, unknown>), response_format: JUDGE_RESPONSE_FORMAT }) } : {}),
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
    if (event.type === 'tool_execution_start') {
      pendingCalls.set(event.toolCallId, { tool: event.toolName, args: event.args });
    }
    if (event.type === 'tool_execution_end') {
      const call = pendingCalls.get(event.toolCallId);
      // Trusted tools record their own state snapshots. Record only attempts rejected before execution here.
      if (call && !executedCalls.has(event.toolCallId)) {
        emit({ type: 'tool_call', ...call });
        emit({ type: 'tool_result', tool: call.tool, result: { ok: false, rejected: true, detail: event.result } });
      }
      pendingCalls.delete(event.toolCallId);
      executedCalls.delete(event.toolCallId);
    }
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
 * Models routinely wrap the object in a markdown fence, often after a sentence of
 * preamble, despite the instruction. A fence is an explicit delimiter, so the first
 * fenced block is taken as the answer. Bare JSON buried in prose stays a failure:
 * guessing where an object starts is not the same as reading a delimiter. The schema
 * still decides what is valid.
 */
/** Models put raw line breaks and tabs inside JSON strings, which JSON forbids. Escape control characters inside string literals only. */
function escapeControlCharacters(text: string): string {
  let out = '', inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === '\\') { out += ch + (text[i + 1] ?? ''); i++; continue; }
      if (ch === '"') inString = false;
      else if (ch < ' ') { out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`; continue; }
    } else if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}
/**
 * Models copy source text with straight double quotes into JSON strings without escaping them.
 * A quote can close a string only where the container allows: a key is followed by ':', an
 * object value by '}' or by ',' and another key, an array item by ',' or ']'. Every other
 * double quote inside a string is escaped. Runs only after a plain parse has failed.
 */
function repairUnescapedQuotes(text: string): string {
  const out: string[] = [], stack: Array<'{' | '['> = [];
  let expectKey = false;
  const skipSpace = (j: number) => { while (j < text.length && /\s/.test(text[j]!)) j++; return j; };
  const keyFollows = (j: number) => {
    if (text[j] !== '"') return false;
    const end = text.indexOf('"', j + 1);
    return end > 0 && text[skipSpace(end + 1)] === ':';
  };
  for (let i = 0; i < text.length;) {
    const ch = text[i]!;
    if (ch === '{' || ch === '[') { stack.push(ch); expectKey = ch === '{'; out.push(ch); i++; continue; }
    if (ch === '}' || ch === ']') { stack.pop(); expectKey = false; out.push(ch); i++; continue; }
    if (ch === ',') { expectKey = stack[stack.length - 1] === '{'; out.push(ch); i++; continue; }
    if (ch === ':') { expectKey = false; out.push(ch); i++; continue; }
    if (ch !== '"') { out.push(ch); i++; continue; }
    const isKey = expectKey, container = stack[stack.length - 1];
    out.push('"'); i++;
    while (i < text.length) {
      const c = text[i]!;
      if (c === '\\') { out.push(c, text[i + 1] ?? ''); i += 2; continue; }
      if (c !== '"') { out.push(c); i++; continue; }
      const next = text[skipSpace(i + 1)] ?? '';
      const closes = isKey ? next === ':'
        : container === '{' ? next === '}' || (next === ',' && keyFollows(skipSpace(skipSpace(i + 1) + 1)))
        : next === ',' || next === ']' || next === '';
      if (closes) { out.push('"'); i++; break; }
      out.push('\\"'); i++;
    }
    expectKey = false;
  }
  return out.join('');
}
/** The raw reply, then its fenced form, each as written and with control characters and quotes repaired. The first parse error is the one worth showing the model. */
function parseJsonOutput(output: string): unknown {
  const candidates = [output];
  const fenced = /```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```/.exec(output);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  let failure: unknown;
  for (const candidate of candidates) {
    const escaped = escapeControlCharacters(candidate);
    for (const text of [candidate, escaped, repairUnescapedQuotes(escaped)]) {
      try { return JSON.parse(text); } catch (error) { failure ??= error; }
    }
  }
  throw new Error(`Output is not JSON: ${failure instanceof Error ? failure.message : 'unreadable'}`);
}

/**
 * Repairing a nearly correct object is a much easier task for a model than writing one
 * from scratch, so a rejected answer goes back into the same session with the exact
 * reason. Attempts are bounded: after the third the run fails out loud instead of
 * spinning and spending the owner's budget. Rejection text is model-facing and stays
 * English, like the roles; what the owner reads is translated at the throw site.
 */
export const REPAIR_ATTEMPTS = 5;

async function jsonResponse<S extends z.ZodType>(
  modelRuntime: ModelRuntime, model: Model, label: string, role: string, input: unknown, schema: S, ctx: CallContext,
  review?: (value: z.infer<S>) => string | undefined,
): Promise<z.infer<S>> {
  const prompt = `${role}\n${DATA_BOUNDARY}\nReturn exactly one compact JSON object, without markdown fences or pretty-printing whitespace, matching this JSON schema:\n${JSON.stringify(z.toJSONSchema(schema))}\nInside strings, escape double quotes as \\" and line breaks as \\n; when copying source text, «» may stand for its straight double quotes.`;
  // Only target sessions contribute target trace events; simulator/planner events cannot affect target grades.
  const session = await controlledSession(modelRuntime, model, prompt, [], { ...ctx, onTargetEvent: undefined });
  try {
    let message = JSON.stringify(input);
    let rejection = '';
    for (let attempt = 1; attempt <= REPAIR_ATTEMPTS; attempt++) {
      const output = await session.respond(message);
      let parsed: unknown;
      try { parsed = parseJsonOutput(output); rejection = ''; }
      catch (error) { rejection = `The reply was not a single JSON object (${error instanceof Error ? error.message : 'unreadable'}). Return one JSON object and nothing else; escape line breaks inside strings as \\n.`; }
      if (!rejection) {
        const validated = schema.safeParse(parsed);
        if (!validated.success) {
          rejection = `These fields do not match the schema: ${validated.error.issues.map(i => `${i.path.join('.') || 'root'} (${i.message})`).join('; ')}.`;
        } else {
          const problem = review?.(validated.data);
          if (!problem) return validated.data;
          rejection = problem;
        }
      }
      if (process.env['AGENT_LAB_DEBUG_DIR']) {
        await mkdir(process.env['AGENT_LAB_DEBUG_DIR'], { recursive: true });
        await writeFile(join(process.env['AGENT_LAB_DEBUG_DIR'], `${label.replace(/[^\p{L}\p{N}]+/gu, '_')}-${Date.now()}-${attempt}.txt`), `${rejection}\n\n${output}`, { mode: 0o600 });
      }
      message = `Your previous answer was rejected. ${rejection}\nReturn the corrected object in full, as one compact JSON object and nothing else.`;
    }
    throw new Error(`модель ${REPAIR_ATTEMPTS} раза подряд вернула ответ, который не проходит проверку. Последняя причина: ${rejection}`);
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : 'шаг не удался'}`);
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
  const model = modelRuntime.getModel(settings.provider, settings.model);
  if (!model) throw new Error(`Выбранная модель недоступна: ${settings.provider}/${settings.model}. ${authHelp}`);
  let available: Awaited<ReturnType<ModelRuntime['getAvailable']>>;
  try { available = await modelRuntime.getAvailable(settings.provider, { signal }); }
  catch { throw new Error(`Не удалось проверить доступ к моделям. ${authHelp}`); }
  if (!available.some(m => m.id === model.id)) throw new Error(authHelp);
  const ask = async <S extends z.ZodType>(label: string, role: string, input: unknown, schema: S, ctx: CallContext,
    review?: (value: z.infer<S>) => string | undefined): Promise<z.infer<S>> => {
    const choice = settings.roles?.[role === ASSESS_ROLE ? 'judge' : role === SIMULATOR_ROLE ? 'simulator' : 'builder'];
    let selected = model;
    if (choice) {
      const override = modelRuntime.getModel(choice.provider, choice.model);
      const models = await modelRuntime.getAvailable(choice.provider, { signal: ctx.signal });
      if (!override || !models.some(m => m.id === override.id)) throw new Error(`Модель роли недоступна: ${choice.provider}/${choice.model}. ${authHelp}`);
      selected = override;
    }
    return jsonResponse(modelRuntime, selected, label, role, input, schema, ctx, review);
  };
  return {
    async prepare(input, ctx) {
      const grounding = await ask(
        'Требования',
        REQUIREMENTS_ROLE,
        { task: input.task, sources: input.sources.map(({ id, name, content, kind }) => ({ id, name: kind === 'prompt' ? `${name} (промпт агента)` : name, content, ...(kind ? { kind } : {}) })) },
        groundingSchema, ctx,
        value => {
          // Name every bad quote at once: a model fixes what it is told about, and attempts are few.
          const missing: string[] = [];
          for (const requirement of value.requirements) {
            const source = input.sources.find(s => s.id === requirement.sourceId);
            if (!source) return `Requirement ${requirement.id} cites source ${requirement.sourceId}, which was not supplied.`;
            const exact = verbatimSpan(source.content, requirement.quote);
            if (exact && source.kind === 'prompt' && MACHINE_FORMAT.test(exact)) {
              return `Requirement ${requirement.id} quotes a machine output format ("${exact.slice(0, 60)}"): a JSON envelope or a named field is an internal interface between the agent's components, not a rule a user can observe. Drop this requirement.`;
            }
            if (exact) { requirement.quote = exact; continue; }
            // The words are real but the attribution is wrong: a quote found in exactly one other source belongs to it.
            const elsewhere = input.sources.filter(s => s.id !== source.id && verbatimSpan(s.content, requirement.quote));
            if (elsewhere.length === 1) { requirement.sourceId = elsewhere[0]!.id; requirement.quote = verbatimSpan(elsewhere[0]!.content, requirement.quote)!; continue; }
            missing.push(`${requirement.id} (not in "${source.name}")`);
          }
          if (missing.length) return `These quotes are not verbatim substrings of their sources: ${missing.join('; ')}. Copy the exact characters from the source instead of paraphrasing; a shorter contiguous fragment is safer than a long one. Keep every other requirement as it is.`;
          return undefined;
        },
      );
      const evidence = { task: input.task, requirements: grounding.requirements, questions: grounding.questions };
      const requirementIds = new Set(grounding.requirements.map(r => r.id));
      if (requirementIds.size !== grounding.requirements.length) throw new Error('Requirements: duplicate requirement IDs');
      const compare = input.workflow === 'compare';
      const confirmed = !!input.confirmedHypothesis;
      const groundedValues = confirmed ? valueTokens([
        ...input.sources.map(source => source.content),
        ...(input.dialogues ?? []).flatMap(dialogue => dialogue.messages.filter(message => message.role === 'user').map(message => message.content)),
      ].join('\n')) : undefined;
      const external = !!input.targetKind && input.targetKind !== 'sandbox';
      const hasPrompt = input.sources.some(s => s.kind === 'prompt');
      const simulatorCapable = (input.userModes ?? ['reactive']).includes('reactive');
      const harnessRubrics = confirmed ? Number(hasPrompt) + Number(simulatorCapable)
        : external ? 1 + Number(hasPrompt) : 0;
      const plan = compare ? await ask(
        'План семейств сценариев',
        FAMILY_PLAN_ROLE,
        evidence, familyPlanSchema, ctx,
        value => {
          if (new Set(value.families.map(f => f.familyId)).size !== value.families.length) return 'Two families share the same familyId; each family must be distinct.';
          for (const family of value.families) {
            if (new Set(family.requirementIds).size !== family.requirementIds.length) return `Family "${family.familyId}" lists the same requirement twice.`;
            const unknown = family.requirementIds.filter(id => !requirementIds.has(id));
            if (unknown.length) return `Family "${family.familyId}" references requirements that do not exist: ${unknown.join(', ')}.`;
          }
          return undefined;
        },
      ) : undefined;
      const scenarios: z.infer<typeof scenarioSchema>[] = [];
      const scenarioIds = new Set<string>();
      const total = plan?.families.length ?? input.scenarioCount ?? 5;
      const batchLimit = compare ? 4 : 3;
      // Evaluation needs only the requested goals; a separate family plan is reserved for version comparison.
      for (let offset = 0; offset < total;) {
        const requestedFamilies = plan?.families.slice(offset, offset + batchLimit);
        const batchSize = Math.min(batchLimit, total - offset);
        // A reply may carry more than its batch: without a family plan the surplus fills the suite, with one it is cut to the requested families.
        const keep = plan ? batchSize : total - offset;
        const batchLabel = `Карточки, партия ${Math.floor(offset / batchLimit) + 1}${requestedFamilies ? ` (${requestedFamilies.map(f => f.familyId).join(', ')})` : ''}`;
        const profiles = input.profiles ?? [];
        const observedGoals = input.observedGoals ?? [];
        const cards = await ask(
          batchLabel,
          cardsRole(compare, profiles.length > 0, observedGoals.length > 0) + (external ? `\n${EXTERNAL_CARDS_CLAUSE}` : ''),
          {
            ...evidence,
            ...(confirmed ? {
              confirmedHypothesis: input.confirmedHypothesis,
              dialogueEvidence: (input.dialogues ?? []).map(dialogue => ({
                id: dialogue.id,
                userMessages: dialogue.messages.filter(message => message.role === 'user').map(message => message.content),
              })),
            } : {}),
            ...(input.notes ? { ownerNotes: input.notes } : {}),
            ...(profiles.length ? { observedProfiles: profiles } : {}),
            ...(observedGoals.length ? { observedGoals: observedGoals.map(g => ({ id: g.id, goal: g.goal, profileId: g.profileId })) } : {}),
            ...(plan ? { familyPlan: plan.families, requestedFamilies } : {
              requestedCount: batchSize, plannedTotal: total,
              earlierGoals: scenarios.map(s => ({ id: s.id, familyId: s.familyId, goal: s.user.goal })),
            }),
          },
          z.strictObject({ scenarios: confirmed
            ? z.tuple([generatedScenarioSchema(external, harnessRubrics, true)])
            : z.array(generatedScenarioSchema(external, harnessRubrics)).min(batchSize).max(SCENARIO_LIMIT) }), ctx,
          // Pure review: attribution problems are a reason for the model to rewrite the
          // batch, not a reason to lose the whole run. Nothing is recorded until it passes.
          value => {
            // Surplus cards are the model overshooting a count, not a defect worth an attempt.
            if (!confirmed && value.scenarios.length > keep) value.scenarios.splice(keep);
            const seen = new Set<string>();
            for (const scenario of value.scenarios) {
              // A profile invented where none were supplied carries nothing; the card keeps its own persona.
              if (scenario.profileId !== undefined && !profiles.length) delete scenario.profileId;
              delete (scenario as { stage?: string }).stage;
              const family = requestedFamilies?.find(f => f.familyId === scenario.familyId);
              if (requestedFamilies && !family) return `Card ${scenario.id} claims family "${scenario.familyId}", which was not requested in this batch.`;
              if (requestedFamilies && seen.has(scenario.familyId)) return `Family "${scenario.familyId}" is used by two cards in this batch; each requested family needs exactly one card.`;
              if (scenarioIds.has(scenario.id)) return `Card id "${scenario.id}" was already used by an earlier card; ids must be unique across the suite.`;
              if (scenario.profileId !== undefined && !profiles.some(p => p.id === scenario.profileId)) {
                return `Card ${scenario.id} references profile "${scenario.profileId}", which does not exist. Choose one of: ${profiles.map(p => p.id).join(', ') || 'none supplied'}.`;
              }
              if (new Set(scenario.requirementIds).size !== scenario.requirementIds.length) return `Card ${scenario.id} lists the same requirement twice.`;
              const unknown = scenario.requirementIds.filter(id => !requirementIds.has(id));
              if (unknown.length) return `Card ${scenario.id} references requirements that do not exist: ${unknown.join(', ')}.`;
              const missing = family?.requirementIds.filter(id => !scenario.requirementIds.includes(id)) ?? [];
              if (missing.length) return `Card ${scenario.id} must cover the requirements of its family: ${missing.join(', ')}.`;
              if (external) {
                if (input.sources.some(s => s.kind === 'prompt')) {
                  // The agent's JSON envelope or a named field is an interface between its components: a criterion that pins it measures the adapter, not the agent. Dropping it is deterministic and costs no attempt.
                  scenario.checks = scenario.checks.filter(c => !MACHINE_FORMAT.test(`${(c as { value?: unknown }).value ?? ''}`) && !MACHINE_FORMAT.test(c.description));
                  scenario.metrics = scenario.metrics?.filter(m => m.subject !== 'agent' || !MACHINE_FORMAT.test(`${m.name}\n${m.description}\n${m.passCriteria}\n${m.failCriteria}`));
                }
                // A literal check on an external agent may only pin wording the source itself mandates or the user literally asked for; everything else is a rubric's job.
                const literal = scenario.checks.filter(c => c.kind === 'answer_equals' || c.kind === 'answer_contains' || c.kind === 'answer_omits');
                // Wording a source mandates or forbids appears in that source; the user's own opening may also be echoed.
                const grounds = [...input.sources.map(s => s.content), scenario.user.opening];
                for (const check of literal) {
                  if (!grounds.some(ground => verbatimSpan(ground, check.value))) {
                    return `Card ${scenario.id}: check ${check.id} requires the wording "${check.value.slice(0, 80)}", which is not a verbatim fragment of any supplied source or the user's opening. Literal checks only pin wording a source mandates or forbids; assess everything else with an agent rubric and drop this check.`;
                  }
                }
                if (literal.length > 2) return `Card ${scenario.id} has ${literal.length} literal checks; keep at most two literal checks per card and express the rest as agent rubrics.`;
              }
              if (confirmed) {
                const stateChecks = scenario.checks.filter(check => check.kind === 'state_equals');
                const seeded = Object.keys(scenario.initialState.records).length > 0
                  || scenario.initialState.writableFields.length > 0
                  || scenario.initialState.transientFailures > 0
                  || Object.keys(scenario.initialState.external ?? {}).length > 0;
                if (seeded && !stateChecks.length) return `Card ${scenario.id}: non-empty seeded state needs at least one exact state_equals check.`;
                const unresolved = stateChecks.filter(check => !Object.hasOwn(scenario.initialState.records, check.recordId)
                  || !Object.hasOwn(scenario.initialState.records[check.recordId]!, check.field));
                if (unresolved.length) return `Card ${scenario.id}: state_equals paths do not resolve in the seeded state: ${unresolved.map(check => `${check.recordId}.${check.field}`).join(', ')}.`;
              }
              const known = valueTokens([scenario.user.opening, scenario.user.facts, ...(scenario.user.knows ?? [])].join('\n'));
              if (groundedValues) {
                const answerValues = new Set((scenario.user.answers ?? []).flatMap(answer => [...valueTokens(answer.reply)]));
                const unsupported = [...answerValues].filter(token => !groundedValues.has(token)).sort();
                if (unsupported.length) return `Card ${scenario.id}: answer values are not grounded in owner sources or user-authored dialogue evidence: ${unsupported.join(', ')}.`;
                const additions = [...answerValues].filter(token => !known.has(token)).sort();
                const next = [...(scenario.user.knows ?? []), ...additions];
                if (next.length > 20) return `Card ${scenario.id}: answer enrichment produces ${next.length} known values; maximum is 20. Nothing was truncated.`;
                if (additions.length) scenario.user.knows = next;
              } else for (const answer of scenario.user.answers ?? []) {
                const unknown = [...valueTokens(answer.reply)].find(token => !known.has(token));
                if (unknown) return `Card ${scenario.id}: the reply to "${answer.ifAsked}" contains "${unknown}", which is not in knows, facts or opening. Either add that value to user.knows when the user really knows it, or answer with a value already in knows, facts or opening; a reply must never contradict the card's facts.`;
              }
              seen.add(scenario.familyId);
            }
            return undefined;
          },
        );
        for (const scenario of cards.scenarios) {
          if (confirmed ? simulatorCapable : external) scenario.metrics.push({ ...simulatorFidelity });
          if ((confirmed || external) && hasPrompt) scenario.metrics.unshift({ ...promptCompliance });
          scenarioIds.add(scenario.id); scenarios.push(scenario);
        }
        offset += cards.scenarios.length;
      }
      // An external target answers with its own agent, so a sandbox AgentSpec would be
      // built, paid for and never used.
      const agent = input.existingAgent
        ?? (input.targetKind && input.targetKind !== 'sandbox'
          ? { name: 'External agent', instructions: 'The agent under evaluation runs outside Agent Lab and keeps its own instructions and tools.', tools: [] }
          : await ask('Сборка агента', AGENT_ROLE, evidence, agentSchema, ctx));
      return preparationSchema.parse({ ...grounding, scenarios, agent });
    },
    async goals(input, ctx) {
      if (!input.sources.length) throw new Error('Observed goals: без материалов владельца ожидаемое поведение остаётся неизвестным.');
      const sources = input.sources.map(({ id, name, content, kind }) => ({ id, name, content, ...(kind ? { kind } : {}) }));
      const profiles = input.profiles.map(({ id, persona, characteristics }) => ({ id, persona, characteristics }));
      if (!input.requirements) {
        const result = await ask(
          'Цели из реальных диалогов', GOALS_ROLE,
          { task: input.task, sources, profiles, dialogues: input.dialogues.map(dialogue => ({ id: dialogue.id, userMessages: dialogue.messages.filter(message => message.role === 'user').map(message => message.content) })) },
          z.strictObject({ goals: z.array(observedGoalSchema).min(1).max(20) }), ctx,
        );
        try { validateObservedGoals(result.goals, input.dialogues, input.profiles); }
        catch (error) { throw new Error(`Observed goals: ${error instanceof Error ? error.message : String(error)}`); }
        return result.goals;
      }
      if (!input.requirements.length) throw new Error('Observed goals: нет требований владельца, на которые можно сослаться.');
      const knownRequirements = new Set(input.requirements.map(requirement => requirement.id));
      const goals = [];
      for (const dialogue of input.dialogues) {
        const payload = {
          task: input.task,
          sources, ownerRequirements: input.requirements.map(({ id, text, sourceId, quote, critical }) => ({ id, text, sourceId, quote, critical })), profiles,
          dialogues: [{ id: dialogue.id, userMessages: dialogue.messages.filter(message => message.role === 'user').map(message => message.content) }],
        };
        if (JSON.stringify(payload).length > GOALS_INPUT_LIMIT) {
          throw new Error(`Неизвестно: полный диалог ${dialogue.id} и материалы владельца не помещаются в контекст; критерий не опубликован.`);
        }
        const result = await ask(
          `Цель из реального диалога ${dialogue.id}`,
          GOALS_ROLE,
          payload,
          z.strictObject({ goals: z.array(scoredGoalSchema).length(1) }), ctx,
          value => {
            const goal = value.goals[0]!;
            if (goal.evidenceDialogueIds.length !== 1 || goal.evidenceDialogueIds[0] !== dialogue.id) return `Goal ${goal.id} must cite only dialogue ${dialogue.id}.`;
            const unknown = goal.requirementIds.filter(id => !knownRequirements.has(id));
            if (unknown.length) return `Goal ${goal.id} cites unknown owner requirements: ${unknown.join(', ')}.`;
            try { validateObservedGoals([goal], [dialogue], input.profiles); }
            catch (error) { return error instanceof Error ? error.message : String(error); }
            return undefined;
          },
        );
        goals.push(result.goals[0]!);
      }
      try { validateObservedGoals(goals, input.dialogues, input.profiles); }
      catch (error) { throw new Error(`Observed goals: ${error instanceof Error ? error.message : String(error)}`); }
      return goals;
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
    async profiles(input, ctx) {
      const supplied = new Set(input.dialogues.map(d => d.id));
      const result = await ask(
        'Профили пользователей',
        PROFILES_ROLE,
        // Assistant turns stay out: a profile describes how the user writes, not what the business answered.
        { task: input.task, dialogues: input.dialogues.map(d => ({ id: d.id, outcome: d.outcome, userMessages: d.messages.filter(m => m.role === 'user').map(m => m.content) })) },
        z.strictObject({ profiles: z.array(observedProfileSchema).max(6) }), ctx,
      );
      for (const profile of result.profiles) for (const id of profile.evidenceDialogueIds) if (!supplied.has(id)) throw new Error(`User profiles: profile ${profile.id} cites evidence dialogue ${id} that was not supplied`);
      return result.profiles;
    },
    async improve(input, ctx) {
      if (input.feedback.some(f => f.scenario.split !== 'dev' || f.trials.some(t => t.split !== 'dev'))) {
        throw new Error('Builder input must contain development evidence only');
      }
      return ask(
        'Улучшение агента',
        IMPROVE_ROLE,
        { task: input.task, requirements: input.requirements, agent: input.agent, feedback: input.feedback },
        proposalSchema, ctx,
      );
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
        const session = await controlledSession(modelRuntime, judgeModel, prompt, [], { ...ctx, onTargetEvent: event => {
          if (event.type === 'assistant' && event.text) recordPartial(event.text);
        } }, 16384, judgeModel.reasoning ? undefined : 0, judge.provider === 'openrouter', judgeModel.reasoning ? 'medium' : 'off');
        try { return await session.respond(data); } finally { await session.close(); }
      });
    },
    async openTarget(agent, sources, tools, ctx) {
      agentSchema.parse(agent);
      const allowed = tools.filter(t => agent.tools.includes(t.name));
      if (agent.tools.some(name => !allowed.some(t => t.name === name))) throw new Error('Target requested an unregistered tool');
      return controlledSession(modelRuntime, model,
        `${agent.instructions}\n\n${DATA_BOUNDARY}\n${TOOL_GUIDE}\nAvailable material names: ${JSON.stringify(sources.map(s => s.name))}. Use search_materials when needed.`,
        allowed, ctx, 4096,
      );
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
}
