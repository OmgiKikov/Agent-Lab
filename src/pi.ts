import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import {
  checkSchema, EXPECTATIONS_PROTOCOL, failureModeSchema, fingerprint, requirementSchema, REQUIREMENT_LIMIT, SIMULATOR_PROTOCOL, sourceSelectionSchema, userTurnSchema, VERSION, verbatimSpan, worldSchema,
  type CallContext, type FailureMode, type GroundingInput, type Requirement, type Runtime, type ScenarioProposalsInput, type Settings, type Source,
} from './contracts.js';
import { assessRepeated, JUDGE_PROTOCOL, JUDGE_RESPONSE_FORMAT } from './judge.js';
import { FOCUSED_REQUIREMENT_LIMIT } from './limits.js';
import { callModel, type Model } from './llm/model-call.js';
import { AUTH_HELP, resolveModels } from './llm/models.js';
import { runStructured, type StructuredTask } from './llm/structured.js';
import {
  FAILURE_MODES_ROLE, REQUIREMENTS_ROLE, SCENARIO_PROPOSALS_ROLE, SCENARIO_SEMANTIC_ROLE,
  SIMULATOR_ROLE, SOURCE_SELECTION_ROLE, USER_CONTROLLER_ROLE,
} from './prompts.js';
import { scenarioProposalSchema, semanticFindingSchema } from './scenario-contracts.js';
import { SCENARIO_OUTPUT_BYTES, SCENARIO_REQUEST_BYTES, SEMANTIC_BATCH_FIELDS, SEMANTIC_REASON_CHARS, workInputIssue } from './scenario-work.js';
import { USER_CONTROLLER_PROTOCOL, userDecisionSchema } from './user-controller.js';

/*
 * The Pi runtime of Agent Lab: every model step is a task descriptor (who answers, what it is told, the
 * exact shape of the answer and its domain check) run by the harness in ./llm. Routing reads only the
 * task's role; the models of the roles are resolved and checked once, before the first paid call.
 */

/**
 * Everything that decides how a run is judged besides its cards: the judge, both customer roles (the free
 * simulator of older cards and the controller of compiled ones, whose prompt is no longer inside a card's
 * definition), how card expectations are judged, and the models. Runs compare only under the same version.
 */
export const evaluatorVersion = (settings: Settings): string => fingerprint({ protocol: VERSION, judge: JUDGE_PROTOCOL, simulator: { role: SIMULATOR_ROLE, protocol: SIMULATOR_PROTOCOL },
  controller: { role: USER_CONTROLLER_ROLE, protocol: USER_CONTROLLER_PROTOCOL, decision: 'action-enum-v1' }, expectations: EXPECTATIONS_PROTOCOL,
  provider: settings.provider, model: settings.model, roles: settings.roles ?? {}, judgeModel: settings.judge });

const OBSERVABLE = 'true when a user can see this rule kept or broken in the agent\'s reply; false only for an internal interface of the agent\'s prompt, such as its machine output format: recorded, never judged';
const groundedRequirementSchema = requirementSchema.extend({ observable: z.boolean().describe(OBSERVABLE) });
const groundingSchemaFor = (limit: number) => z.strictObject({
  requirements: z.array(groundedRequirementSchema).min(1).max(limit, { error: `Return at most ${limit} requirements: merge closely related rules into one requirement with one exact quote, and keep the rules a user can see violated in a reply` }),
  questions: z.array(z.string().trim().min(1).max(2000)).max(12),
});
type Grounded = z.infer<ReturnType<typeof groundingSchemaFor>>;
const FOCUS_CLAUSE = `customerMessages holds what one real customer wrote in a dialogue these requirements must decide (the old agent's replies are withheld: they are not rules). Extract only the rules that determine the correct agent behaviour for that customer (the answer, the mandatory steps, what must not be said); skip rules the dialogue never touches. Start with the original request; later reactions to an instruction do not prove the service already exists. Preserve unknown product/channel/prerequisites as conditions and allow appropriate clarification or qualified alternatives. Do not require every channel or an unrequested follow-on operation. Return at most ${FOCUSED_REQUIREMENT_LIMIT} requirements.`;

/** Where a requirement's quote is verbatim: its cited source, or else exactly one other supplied source, which then owns it. */
function located(requirement: Requirement, sources: readonly Source[]): { sourceId: string; quote: string } | undefined {
  const cited = sources.find(source => source.id === requirement.sourceId);
  const exact = cited && verbatimSpan(cited.content, requirement.quote);
  if (cited && exact) return { sourceId: cited.id, quote: exact };
  const elsewhere = sources.filter(source => source.id !== requirement.sourceId && verbatimSpan(source.content, requirement.quote));
  return elsewhere.length === 1 ? { sourceId: elsewhere[0]!.id, quote: verbatimSpan(elsewhere[0]!.content, requirement.quote)! } : undefined;
}
function groundingProblem(value: Grounded, sources: readonly Source[]): string | undefined {
  if (new Set(value.requirements.map(r => r.id)).size !== value.requirements.length) return 'Two requirements share an id; give every requirement a unique id.';
  const missing: string[] = [];
  for (const requirement of value.requirements) {
    const source = sources.find(candidate => candidate.id === requirement.sourceId);
    if (!source) return `Requirement ${requirement.id} cites source ${requirement.sourceId}, which was not supplied.`;
    if (!located(requirement, sources)) missing.push(`${requirement.id} (not in "${source.name}")`);
  }
  return missing.length
    ? `These quotes are not verbatim substrings of their sources: ${missing.join('; ')}. Copy the exact characters from the source instead of paraphrasing; a shorter contiguous fragment is safer than a long one. Keep every other requirement as it is.`
    : undefined;
}

/** One grounding call: the whole policy of the supplied sources, or, with a focus, only the rules that decide one customer's dialogue. */
export function groundingRequest(input: GroundingInput) {
  const limit = input.focus ? FOCUSED_REQUIREMENT_LIMIT : REQUIREMENT_LIMIT;
  const task: StructuredTask<Grounded> = {
    id: 'ground-requirements', label: 'Требования', role: 'builder',
    instructions: input.focus ? `${REQUIREMENTS_ROLE}\n${FOCUS_CLAUSE}` : REQUIREMENTS_ROLE,
    output: groundingSchemaFor(limit),
    check: value => groundingProblem(value, input.sources),
  };
  return {
    limit, task,
    payload: {
      task: input.task,
      sources: input.sources.map(({ id, name, content, kind }) => ({ id, name: kind === 'prompt' ? `${name} (промпт агента)` : name, content, ...(kind ? { kind } : {}) })),
      ...(input.focus ? { customerMessages: [...input.focus.customerMessages] } : {}),
    },
  };
}

/** Scenario work carries full chronologies: its answers and requests are capped, and a repair starts afresh. */
const SCENARIO_BOUNDS = { outputBytes: SCENARIO_OUTPUT_BYTES, requestBytes: SCENARIO_REQUEST_BYTES };
const proposalVariant = scenarioProposalSchema.shape.variant;
const proposalsOutput = z.strictObject({ proposals: z.array(scenarioProposalSchema.extend({ variant: proposalVariant.omit({ sourceCoverageRequired: true, sourceCoverageBasis: true }).extend({
  environmentFixture: proposalVariant.shape.environmentFixture.extend({ initialState: worldSchema }),
  evaluationSpec: proposalVariant.shape.evaluationSpec.extend({
    checkpoints: z.array(proposalVariant.shape.evaluationSpec.shape.checkpoints.element.extend({ check: checkSchema.optional() })).min(1).max(12),
  }),
}) })).max(1) });
function proposalProblem(value: z.infer<typeof proposalsOutput>, input: ScenarioProposalsInput): string | undefined {
  for (const { variant } of value.proposals) {
    const logs = input.dialogues.filter(d => variant.sourceDialogues.some(ref => ref.dialogueId === d.id));
    const oneRequest = logs.length === 1 && logs[0]!.messages.filter(m => m.role === 'user').length === 1;
    if (oneRequest && variant.sourceCoverage?.length) {
      return 'sourceCoverage accounts only for customer turns AFTER the first customer message. This source has one customer message: omit sourceCoverage or return an empty array. The opening is not a continuation.';
    }
    if (variant.provenance !== 'production' || variant.userState.facts.length) continue;
    if (oneRequest && (variant.behaviorPolicy.maxFollowUps !== 0 || variant.behaviorPolicy.actions.some(a => a.kind !== 'finish'))) {
      return 'This observed dialogue has one customer request and no grounded personal facts. Preserve that one-turn scope: maxFollowUps:0 and finish-only policy after the first agent reply. Do not invent an obstacle, a factual answer or customer inability to extend the observed test. Additional conditions belong in a separately proposed variant.';
    }
  }
  return undefined;
}
const findingsOutput = z.strictObject({ findings: z.array(semanticFindingSchema.extend({ reason: z.string().trim().min(1).max(SEMANTIC_REASON_CHARS) })).max(SEMANTIC_BATCH_FIELDS) });

const simulatorReplySchema = z.strictObject({ done: userTurnSchema.shape.done, message: userTurnSchema.shape.message.optional() })
  .refine(v => v.done || !!v.message?.trim(), 'A continuing user turn needs a message')
  .describe('To stop immediately, return done:true and omit message. A nonempty message is always delivered to the target. done:true with a nonempty message means deliver this final user message, receive the target response, then end. done:true with an empty message means stop now without another target response.');

/** A catalog up to this many articles is an enum of the answer's schema; a larger one would outweigh the request, so its ids are checked instead. */
const CATALOG_ENUM_LIMIT = 500;

function promptQuoteProblem(modes: readonly FailureMode[], prompt: string | undefined): string | undefined {
  for (const mode of modes) for (const quote of mode.promptQuotes ?? []) {
    if (prompt === undefined) return `No prompt was supplied; promptQuotes must be empty for cluster ${mode.id}.`;
    if (!verbatimSpan(prompt, quote)) return `Cluster ${mode.id} quotes "${quote.slice(0, 60)}", which is not a verbatim substring of the supplied prompt. Copy the exact characters.`;
  }
  return undefined;
}

/**
 * The judge's sampling policy is part of every receipt: temperature 0 and no thinking for an ordinary model,
 * the provider's default temperature and medium thinking for a reasoning one.
 */
const judgeConfiguration = (judge: Model) => fingerprint({ api: judge.api, baseUrl: judge.baseUrl, compat: judge.compat,
  temperature: judge.reasoning ? 'default' : 0, thinking: judge.reasoning ? 'medium' : 'off' });

export async function getPiStatus(injectedRuntime?: ModelRuntime): Promise<{
  models: Array<{ provider: string; id: string; name: string }>; error?: string;
}> {
  try {
    const signal = AbortSignal.timeout(10000);
    const runtime = injectedRuntime ?? await ModelRuntime.create({ allowModelNetwork: false, signal });
    const available = await runtime.getAvailable(undefined, { signal });
    return {
      models: available.map(m => ({ provider: m.provider, id: m.id, name: m.name })),
      ...(available.length ? {} : { error: AUTH_HELP }),
    };
  } catch { return { models: [], error: `Не удалось прочитать список доступных моделей. ${AUTH_HELP}` }; }
}

/** The optional SDK runtime is the integration seam for custom providers and offline SDK checks. */
export async function createPiRuntime(settings: Settings, injectedRuntime?: ModelRuntime): Promise<Runtime> {
  if (!settings.provider || !settings.model) throw new Error(`Выберите провайдера и модель. ${AUTH_HELP}`);
  const signal = AbortSignal.timeout(settings.timeoutMs);
  let runtime: ModelRuntime;
  try { runtime = injectedRuntime ?? await ModelRuntime.create({ allowModelNetwork: false, signal }); }
  catch { throw new Error(`Не удалось инициализировать Pi. ${AUTH_HELP}`); }
  const models = await resolveModels(runtime, settings, signal);
  const run = <O>(task: StructuredTask<O>, input: unknown, ctx: CallContext): Promise<O> => runStructured(runtime, models, task, input, ctx);
  return {
    generatorTransport: 'pi-model',
    async selectSources(input, ctx) {
      const ids = input.catalog.map(item => item.id);
      const known = new Set(ids);
      const sourceIds = ids.length <= CATALOG_ENUM_LIMIT ? z.array(z.enum(ids, { error: 'Not a catalog id: return only ids from the catalog.' })) : sourceSelectionSchema.shape.sourceIds;
      return run({
        id: 'select-sources', label: 'Выбор статей под диалог', role: 'builder', instructions: SOURCE_SELECTION_ROLE,
        output: z.strictObject({ sourceIds: sourceIds.max(input.limit, { error: `Return at most ${input.limit} ids, the most important first.` }) }),
        // An enumerated catalog never reaches this check with an unknown id; a larger one is checked here.
        check: value => {
          const unknown = value.sourceIds.filter(id => !known.has(id));
          return unknown.length ? `Unknown source ids: ${unknown.join(', ')}. Return only ids from the catalog.` : undefined;
        },
      }, input, ctx);
    },
    async scenarioProposals(input, ctx) {
      if (input.preparationMode === 'owner_requirements') {
        if (input.batchId !== undefined || input.dialogues.length) throw new Error('Подготовка без логов не может ссылаться на импорт или диалоги.');
      } else if (!input.batchId?.trim() || !input.dialogues.length) throw new Error('Для извлечения из импорта нужны batchId и исходные диалоги.');
      const oversize = workInputIssue(input);
      if (oversize) throw new Error(oversize);
      // A correction of the judge's semantic findings is written by the judge's model; an ordinary proposal by the builder.
      const semanticRepair = !!input.feedback?.issues.some(issue => issue.code === 'semantic_finding');
      return (await run({
        id: 'scenario-proposals', label: 'Варианты из полной хронологии', role: semanticRepair ? 'judge' : 'builder', instructions: SCENARIO_PROPOSALS_ROLE,
        output: proposalsOutput, check: value => proposalProblem(value, input), bounded: SCENARIO_BOUNDS,
      }, input, ctx)).proposals;
    },
    async assessScenarioProposals(input, ctx) {
      const oversize = workInputIssue(input);
      if (oversize) throw new Error(oversize);
      const expected = input.fields.flatMap(f => f.paths.map(path => `${f.variantId}/${path}`));
      return (await run({
        id: 'semantic-review', label: 'Смысловая проверка вариантов', role: 'judge', instructions: SCENARIO_SEMANTIC_ROLE,
        output: findingsOutput, bounded: SCENARIO_BOUNDS,
        check: value => {
          const actual = value.findings.map(f => `${f.variantId}/${f.path}`);
          return expected.length !== actual.length || expected.some(id => actual.filter(other => other === id).length !== 1) ? 'Return exactly one finding for each requested field, and no other fields.' : undefined;
        },
      }, input, ctx)).findings;
    },
    async groundRequirements(input, ctx) {
      const { task, payload } = groundingRequest(input);
      const grounded = await run(task, payload, ctx);
      // Every quote is stored in its source's own characters, attributed to the source that holds it.
      return { questions: grounded.questions, requirements: grounded.requirements.map(requirement => ({ ...requirement, ...located(requirement, input.sources)! })) };
    },
    async failureModes(input, ctx) {
      const ids = input.failures.map(failure => failure.trialId);
      const result = await run({
        id: 'failure-modes', label: 'Разбор провалов', role: 'builder', instructions: FAILURE_MODES_ROLE,
        output: z.strictObject({ modes: z.array(failureModeSchema.extend({
          trialIds: z.array(z.enum(ids, { error: 'Not in the supplied failures: cite only their trialIds.' })).min(1).max(200),
        })).min(1).max(12) }),
        check: value => promptQuoteProblem(value.modes, input.prompt),
      }, { task: input.task, failures: input.failures, ...(input.prompt !== undefined ? { prompt: input.prompt } : {}) }, ctx);
      return result.modes.map(mode => mode.promptQuotes ? { ...mode, promptQuotes: mode.promptQuotes.map(quote => verbatimSpan(input.prompt!, quote)!) } : mode);
    },
    async assess(input, ctx) {
      const judge = models.judge;
      return assessRepeated(input, { provider: judge.provider, id: judge.id, configurationHash: judgeConfiguration(judge), transport: models.judgeTransport }, ctx,
        async (prompt, data, recordPartial) => (await callModel(runtime, judge, {
          system: prompt, messages: [{ role: 'user', content: data, timestamp: Date.now() }], maxTokens: 16384,
          ...(judge.reasoning ? { reasoning: true } : { temperature: 0 }),
          ...(models.judgeTransport.structured ? { responseFormat: JUDGE_RESPONSE_FORMAT } : {}),
        }, ctx, recordPartial)).text);
    },
    async selectUserAction(input, ctx) {
      // The answer is an enum of exactly the moves allowed now, so a move outside the policy cannot be returned.
      return run({ id: 'user-action', label: 'Действие пользователя', role: 'simulator', instructions: USER_CONTROLLER_ROLE, output: userDecisionSchema(input.actions) }, input, ctx);
    },
    async userTurn(input, ctx) {
      const reply = await run({ id: 'user-turn', label: 'Реплика пользователя', role: 'simulator', instructions: SIMULATOR_ROLE, output: simulatorReplySchema }, {
        user: {
          goal: input.user.goal, persona: input.user.persona, characteristics: input.user.characteristics,
          facts: input.user.facts, behavior: input.user.behavior, opening: input.user.opening, maxFollowUps: input.user.maxFollowUps,
          knows: input.user.knows ?? [], cannotKnow: input.user.cannotKnow ?? [], answers: input.user.answers ?? [],
        },
        messages: input.messages.map(({ role, content }) => ({ role, content })), turn: input.turn,
      }, ctx);
      return { ...reply, message: reply.message ?? '' };
    },
  };
}
