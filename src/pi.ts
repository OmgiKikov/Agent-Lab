import { CARD_CUSTOMER_PROTOCOL, customerDecisionProblem, customerDecisionSchema, customerMessageSchema, customerReplyProblem, customerSpeechInput } from './card-customer.js';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { simulatorFidelity } from './assessment.js';
import { EXPECTATIONS_PROTOCOL, failureModeSchema, fingerprint, SIMULATOR_PROTOCOL, VERSION, type FailureMode, type Settings } from './contracts.js';
import { verbatimSpan } from './verbatim.js';
import { sourceSelectionSchema, userTurnSchema, type CallContext, type Runtime } from './runtime.js';
import { assessCutOff, assessRepeated, JUDGE_PROTOCOL, JUDGE_RESPONSE_FORMAT, type Respond } from './judge.js';
import { MODEL_REQUEST_BYTES, workInputIssue } from './limits.js';
import { callModel, type Model } from './llm/model-call.js';
import { AUTH_HELP, resolveModels, roleChoices } from './llm/models.js';
import { endpointAnswers } from './llm/reach.js';
import { gatewayFailureText, gatewayUnavailableText, GIGA_PROVIDER_ID, processGateway, type GatewayFailure } from './giga-provider.js';
import { gatewayStatus, type GatewayStatus } from './giga-transport.js';
import { runStructured, type StructuredTask } from './llm/structured.js';
import { plantError } from './judge-check-task.js';
import {
  CARD_CUSTOMER_ROLE, CUSTOMER_DECISION_ROLE, CARD_REVIEW_ROLE, CARD_ROLE, FAILURE_MODES_ROLE, FIT_ROLE, SCENARIO_CHANNELS, SCENARIO_GAPS, SCENARIO_ROLE, SIMULATOR_ROLE, SOURCE_SELECTION_ROLE, USER_CONTROLLER_ROLE,
} from './prompts.js';
import { cardProposalProblem, cardProposalSchema, proposalBounds, proposalPayload, type CardProposal } from './card/proposal.js';
import { planPayload, planProposalSchema, planSlipKind, planSlips, type PlanProposal } from './card/plan.js';
import { fitAnswerSchema, fitProblem, type FitAnswer } from './discover/fit.js';
import { cardReviewSchema, laterMessages } from './card/review.js';
import { fillWithModel } from './card/unmask.js';
import { judgeLogged, logProtocolHash } from './card/log-judge.js';
import { buildTopicMap } from './miner/topic-map.js';
import { readTableWithModel } from './spreadsheet/reading-task.js';
import { readPurposesWithModel } from './prompt-purpose.js';
import { connectionReaderWith } from './connect.js';
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
 * `recordedCustomer`: the customer protocols of conversations recorded earlier and judged again (card-customer.ts
 * customerProtocolsOf) — a re-assessment is versioned by the customer that played its conversations, never by today's.
 */
export const evaluatorVersion = (settings: Settings, recordedCustomer: readonly string[] = []): string => fingerprint({ protocol: VERSION, judge: JUDGE_PROTOCOL, simulator: { role: SIMULATOR_ROLE, protocol: SIMULATOR_PROTOCOL },
  judgmentAcceptance: 'protocol-visible-evidence-v1',
  controller: { role: USER_CONTROLLER_ROLE, protocol: USER_CONTROLLER_PROTOCOL, decision: 'action-enum-v1' },
  customer: recordedCustomer.some(protocol => protocol !== CARD_CUSTOMER_PROTOCOL) ? { recorded: [...recordedCustomer].sort() }
    : { role: CARD_CUSTOMER_ROLE, decisionRole: CUSTOMER_DECISION_ROLE, protocol: CARD_CUSTOMER_PROTOCOL,
      speechInput: 'opening-known-facts-delivered-messages-move-v1', validation: 'semantic-fidelity-and-literal-checks-v1', fidelity: simulatorFidelity }, expectations: EXPECTATIONS_PROTOCOL,
  provider: settings.provider, model: settings.model, roles: settings.roles ?? {}, judgeModel: settings.judge });

const simulatorReplySchema = z.strictObject({ done: userTurnSchema.shape.done, message: userTurnSchema.shape.message.optional() })
  .refine(v => v.done || !!v.message?.trim(), 'A continuing user turn needs a message')
  .describe('To stop immediately, return done:true and omit message. A nonempty message is always delivered to the target. done:true with a nonempty message means deliver this final user message, receive the target response, then end. done:true with an empty message means stop now without another target response.');

/** A review answer is one short verdict per claim; its repair starts afresh, like every task that carries a whole dialogue. */
const reviewBounds = (claims: number) => ({ requestBytes: MODEL_REQUEST_BYTES + 700 * claims });

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
  temperature: judge.reasoning ? 'default' : 0, thinking: judge.reasoning ? 'medium' : 'off', maxTokens: judge.maxTokens });

/**
 * The personal model gateway in the status: what its setup lacks (without its variables or readable files the provider
 * simply does not appear, which from outside looks like a refused login), whether Pi lists its models and, when it is
 * set up but did not connect, why — by kind and in the owner's words.
 */
export type GatewayView = GatewayStatus & { registered?: boolean; failure?: GatewayFailure; reason?: string };

/**
 * The models Pi sees, and the gateway's own block. The gateway connects beside the listing under its own deadline, so a
 * gateway that does not answer neither delays the other providers' models nor hides them.
 */
export async function getPiStatus(injectedRuntime?: ModelRuntime): Promise<{
  models: Array<{ provider: string; id: string; name: string }>; giga: GatewayView; error?: string;
}> {
  const setup = gatewayStatus();
  const gateway = injectedRuntime ? undefined : processGateway();
  let runtime: ModelRuntime | undefined;
  let available: readonly Model[] = [];
  let listed = true;
  try {
    const signal = AbortSignal.timeout(10000);
    runtime = injectedRuntime ?? await ModelRuntime.create({ allowModelNetwork: false, signal });
    available = await runtime.getAvailable(undefined, { signal });
  } catch { listed = false; }
  const connection = await gateway;
  if (runtime && connection && 'provider' in connection) {
    runtime.registerProvider(GIGA_PROVIDER_ID, connection.provider);
    try { available = [...available, ...await runtime.getAvailable(GIGA_PROVIDER_ID)]; } catch { /* its block still says why not */ }
  }
  const failure = connection && 'failure' in connection && connection.failure.kind !== 'not configured' ? connection.failure : undefined;
  return {
    models: available.map(m => ({ provider: m.provider, id: m.id, name: m.name })),
    giga: { ...setup, registered: available.some(m => m.provider === GIGA_PROVIDER_ID), ...(failure ? { failure, reason: gatewayFailureText(failure) } : {}) },
    ...(!listed ? { error: `Не удалось прочитать список доступных моделей. ${AUTH_HELP}` } : available.length ? {} : { error: AUTH_HELP }),
  };
}

/** Whether the run's model or a role's comes from the gateway, by the rule resolveModels resolves the roles with (roleChoices). */
function usesGateway(settings: Settings): boolean {
  const { builder, simulator, judge } = roleChoices(settings);
  return [settings.provider, builder.provider, simulator.provider, judge.provider].includes(GIGA_PROVIDER_ID);
}

/** The optional SDK runtime is the integration seam for custom providers and offline SDK checks. */
export async function createPiRuntime(settings: Settings, injectedRuntime?: ModelRuntime): Promise<Runtime> {
  if (!settings.provider || !settings.model) throw new Error(`Выберите провайдера и модель. ${AUTH_HELP}`);
  const signal = AbortSignal.timeout(settings.timeoutMs);
  let runtime: ModelRuntime;
  try { runtime = injectedRuntime ?? await ModelRuntime.create({ allowModelNetwork: false, signal }); }
  catch { throw new Error(`Не удалось инициализировать Pi. ${AUTH_HELP}`); }
  // The internal gateway cannot be declared in models.json (it authenticates by a client certificate), so a runtime Lab
  // creates itself registers it — only when a role uses it, and from the process's one connection, so no operation
  // waits on the gateway for nothing and none asks it twice. An injected runtime carries its creator's providers.
  if (!injectedRuntime && usesGateway(settings)) {
    const connection = await processGateway(signal);
    if ('failure' in connection) throw new Error(gatewayUnavailableText(connection.failure));
    runtime.registerProvider(GIGA_PROVIDER_ID, connection.provider);
  }
  const models = await resolveModels(runtime, settings, signal);
  const run = <O>(task: StructuredTask<O>, input: unknown, ctx: CallContext): Promise<O> => runStructured(runtime, models, task, input, ctx);
  const builder = { provider: models.builder.provider, id: models.builder.id };
  const judge = models.judge;
  // One judge for the synthetic attempts and for the recorded conversations: the same model, sampling and transport.
  const judgeModel = { provider: judge.provider, id: judge.id, configurationHash: judgeConfiguration(judge), transport: models.judgeTransport };
  const respond = (ctx: CallContext): Respond => async (prompt, data, recordPartial) => (await callModel(runtime, judge, {
    system: prompt, messages: [{ role: 'user', content: data, timestamp: Date.now() }],
    ...(judge.reasoning ? { reasoning: true } : { temperature: 0 }),
    ...(models.judgeTransport.structured ? { responseFormat: JUDGE_RESPONSE_FORMAT } : {}),
  }, ctx, recordPartial)).text;
  return {
    generatorTransport: 'pi-model',
    // The logs' topics are the builder's work, like the situations prepared from them.
    topicMap: { builder, build: (plan, ctx, onProgress) => buildTopicMap(plan, { builder, run, ctx, onProgress }) },
    // So is the reading of a spreadsheet of those logs: the builder proposes it, the harness applies and checks it.
    tableReading: { builder, read: (request, ctx) => readTableWithModel(request, { run, ctx }) },
    // And which of the agent's prompts write the reply to the customer: a proposal the owner confirms.
    promptPurposes: { builder, read: (batch, ctx) => readPurposesWithModel(batch, { run, ctx }) },
    // And where the owner's agent takes the customer's message and puts its answer: a reading the owner confirms.
    connectionReading: connectionReaderWith(builder, run),
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
    async proposeCard(input, ctx) {
      const payload = proposalPayload(input);
      const oversize = workInputIssue(payload);
      if (oversize) throw new Error(oversize);
      // A binding slip, a quote not found verbatim or a kind of rule outside the rulebook goes back with its exact reason;
      // the answer's references are enums of this call.
      return run<CardProposal>({
        id: 'card-proposal', label: input.call.source.kind === 'rules' ? 'Ситуация по правилам владельца' : 'Ситуация из диалога', role: 'builder', instructions: CARD_ROLE,
        output: cardProposalSchema(input.call), check: value => cardProposalProblem(value, input.call), bounded: proposalBounds(input.call),
      }, payload, ctx);
    },
    async proposeScenario(input, ctx) {
      const payload = planPayload(input);
      const oversize = workInputIssue(payload);
      if (oversize) throw new Error(oversize);
      // A quote not found verbatim, a kind of rule outside the rulebook or an example named twice goes back with its exact reason.
      // A call whose topic's logs recorded tools or state reads how an expectation is seen on them; any other reads as it always did.
      // A call that may report a topic the sources say nothing for reads how (a log analysis asks it); the others read as before.
      const instructions = [SCENARIO_ROLE, ...input.call.channels ? [SCENARIO_CHANNELS] : [], ...input.call.gaps ? [SCENARIO_GAPS] : []].join('\n');
      // The harness's rejection is typed, so a plan no answer bound says which kind of slip it was (discover/analyze.ts).
      const check = (value: PlanProposal) => {
        const slips = planSlips(value, input.call);
        return slips.length ? { reason: slips.map(slip => slip.text).join('\n'), issue: planSlipKind(value, input.call)! } : undefined;
      };
      return run<PlanProposal>({ id: 'scenario-plan', label: 'План сценария', role: 'builder', instructions,
        output: planProposalSchema(input.call), check, bounded: { requestBytes: MODEL_REQUEST_BYTES + 16_000 } }, payload, ctx);
    },
    async fitConversations(input, ctx) {
      const oversize = workInputIssue(input);
      if (oversize) throw new Error(oversize);
      // Every conversation answered once, each by a variation of this plan or none: the harness's check, its exact reason back.
      return run<FitAnswer>({ id: 'fit-conversations', label: 'Разговоры и варианты плана', role: 'builder', instructions: FIT_ROLE,
        output: fitAnswerSchema(input), check: value => fitProblem(value, input) }, input, ctx);
    },
    async reviewCard(input, ctx) {
      const oversize = workInputIssue(input.payload);
      if (oversize) throw new Error(oversize);
      const reviewed = await run({ id: 'card-review', label: 'Проверка ситуации', role: 'judge', instructions: CARD_REVIEW_ROLE,
        output: cardReviewSchema(input.aliases, laterMessages(input)), bounded: reviewBounds(input.aliases.length) }, input.payload, ctx);
      return { verdicts: reviewed.claims, model: `${models.judge.provider}/${models.judge.id}` };
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
      return input.cutOff ? assessCutOff(input, input.cutOff, judgeModel, ctx, respond(ctx)) : assessRepeated(input, judgeModel, ctx, respond(ctx));
    },
    logJudge: { provider: judge.provider, model: judge.id, protocolHash: logProtocolHash(judgeModel.configurationHash),
      assess: (request, ctx) => judgeLogged(request, judgeModel, ctx, respond(ctx)) },
    // The errors a judge check plants are the builder's work too; the run's own judge then reads them.
    plantError: { builder, plant: (request, ctx) => plantError(request, { run, ctx }) },
    // So are the values written over a card's masking marks after it was made.
    maskFill: { builder, fill: (request, ctx) => fillWithModel(request, { run, ctx }) },
    // A key says the judge may be used, not that this network reaches it: its endpoint answers, or the run does not rely
    // on it (lab/run.ts start). The gateway's own connection was checked when this runtime was made.
    judgeReachable: signal => judge.provider === GIGA_PROVIDER_ID ? Promise.resolve(true) : endpointAnswers(judge.baseUrl, signal),
    async selectUserAction(input, ctx) {
      // The answer is an enum of exactly the moves allowed now, so a move outside the policy cannot be returned.
      return run({ id: 'user-action', label: 'Действие пользователя', role: 'simulator', instructions: USER_CONTROLLER_ROLE, output: userDecisionSchema(input.actions) }, input, ctx);
    },
    async speakAsCustomer(input, ctx) {
      const decision = await run({ id: 'card-customer-decision', label: 'Ход клиента', role: 'simulator', instructions: CUSTOMER_DECISION_ROLE, output: customerDecisionSchema,
        check: choice => customerDecisionProblem(choice, input.brief, input.turned) },
        { brief: input.brief, messages: input.messages.map(({ role, content }) => ({ role, content })), turn: input.turn, turned: input.turned }, ctx);
      if (decision.move === 'leave' || decision.move === 'turn') return { ...decision, message: '' };
      const spoken = await run({ id: 'card-customer-message', label: 'Реплика клиента', role: 'simulator', instructions: CARD_CUSTOMER_ROLE, output: customerMessageSchema,
        check: reply => customerReplyProblem({ ...decision, ...reply }, input.brief, input.messages, input.turned, input.buttons) },
        customerSpeechInput(input.brief, input.messages, decision.move), ctx);
      return { ...decision, ...spoken };
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
