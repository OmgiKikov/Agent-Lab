import { z } from 'zod';
import { requirementSchema } from '../contracts.js';
import { businessScenarioSchema } from '../card/schema.js';
import { LOGGED_MODE, LOGGED_MODE_V3 } from '../card/calibration.js';
import { identifierSchema as id, sha256Schema as hash, text } from '../ids.js';
import { IMPORT_DIALOGUE_LIMIT, MATERIAL_LIMIT, RECORD_REQUIREMENT_LIMIT } from '../limits.js';
import { PLAN_EXPECTATIONS } from '../card/plan.js';
import { topicIdSchema, trafficSchema } from '../miner/schema.js';
import { FACT_PROTOCOL, factCheckSchema } from './facts.js';

/*
 * The stored shape of a log analysis (DISCOVER): what the agent did with real customers, judged against the owner's
 * rules, with no situation, no connected agent and no simulated customer. It is its own record — `analyses/{id}.json` —
 * and never a run: its result is observations about recorded conversations, not an experiment, so no run's number,
 * exam or comparison reads it.
 *
 *   logs ─► what was analysed and why the rest was not (selection) ─► the traffic of the import's topics
 *        ─► one plan per topic: the owner's rules that apply, each on a verbatim quote (card/plan.ts)
 *        ─► per conversation, each expectation of its variation judged on the log (card/log-judge.ts) ─► findings
 *        ─► the owner's word on a finding, kept apart from the judge's (reviews)
 *
 * Every schema here is stored: a new field is `.optional()`, never `.default()`; an enum only gains values and a bound only
 * grows, so every record written before still parses as it was. Findings are the judge's; a person's
 * verdict never overwrites one, and a new analysis is a new record — the old one keeps its history.
 */

/**
 * `discover-v4`: article-only inputs compare actual assistant claims with reference facts (`grounded-v1`), preserving
 * supported, contradicted and unknown claims separately. Existing rule-based records retain their original reading.
 * `discover-v3`: the judge is told the situation each expectation is for (`logged-v3`), and a conversation beyond a topic's
 * plan examples is judged only under the variation the planner says it fits — one no variation fits gets a plan of its own.
 * `discover-v2`: a finding's `criterionHash` is the kernel's (criterion.ts) — the criterion's own fields — and a criterion
 * seen on the tools or the state is judged only on a log that recorded that channel. `discover-v1` hashed what the judge
 * read of the criterion. Records of every protocol still read, and every surface derives a criterion from the plan, never
 * from that hash.
 */
export const ANALYSIS_PROTOCOL = 'discover-v3';
export const FACT_ANALYSIS_PROTOCOL = 'discover-v4';
const ANALYSIS_PROTOCOL_V2 = 'discover-v2';
const ANALYSIS_PROTOCOL_V1 = 'discover-v1';
/**
 * Conversations one round of an analysis selects at most — the first sample, or one continuation of it —, and the examples
 * of one topic its plan reads (card/prepare.ts): a bound of the plan call, never of the topic. A conversation of a topic
 * beyond its plan's examples is judged too, under the variation of the plan the planner says it fits (`fitted`).
 */
export const ANALYSIS_LIMIT = 128;
export const PER_TOPIC_LIMIT = 8;
/** Conversations analysed when the owner names no number. */
export const DEFAULT_ANALYSED = 24;
/** Conversations an analysis and its continuations select at most in all: every conversation one import holds. */
export const ANALYSIS_TOTAL_LIMIT = IMPORT_DIALOGUE_LIMIT;

export const ANALYSIS_STATUSES = ['running', 'done', 'stopped', 'failed', 'interrupted'] as const;
export type AnalysisStatus = typeof ANALYSIS_STATUSES[number];
/** Why an analysis ended before every conversation was judged. */
export const UNFINISHED = ['budget', 'stopped', 'time', 'closing', 'failed'] as const;
/**
 * What failed when an analysis ended on a failure (`unfinished: 'failed'`), typed where it was caught: the model provider
 * did not answer for a passing reason (`provider`: a connection that broke, a rate limit), refused in a way every call
 * would repeat (`provider_refused`: no access, no credit, a request it does not take), or anything else. The words of the
 * error stay in `error`; the owner is told by this kind.
 */
export const FAILURES = ['provider', 'provider_refused', 'other'] as const;

const verdict = z.enum(['pass', 'fail', 'unknown']);
/**
 * Why a finding decided nothing with no call: the agent never replied; the conversation's record of the channel is
 * incomplete (or holds none of it); or — `call_unconfirmed` — the criterion requires a call of a tool, the conversation
 * holds no call of it, and no declared contract of the log (`logs.contract`) says the log records every call of that tool:
 * whether the call was made cannot be seen, so it is neither a violation nor kept.
 */
export const FINDING_SKIPS = ['no_agent_reply', 'channel_unobserved', 'call_unconfirmed'] as const;
export type FindingSkip = typeof FINDING_SKIPS[number];

/** A tool's name as a log and an adapter write it (targets.ts eventScope): an identifier, never a pattern. */
export const toolNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:/-]*$/).max(200);
/**
 * The owner's declaration of what the analysed import records beside the messages: the tools whose every call it writes
 * into each conversation it marks complete. Only under it does a complete conversation with no call of a required tool
 * show that the call was not made; without it — or for a tool it does not name — a missing call is never proved, and a
 * conversation the log marks incomplete proves nothing of the tools either way. `via`: how the owner said it.
 */
export const logContractSchema = z.strictObject({ tools: z.array(toolNameSchema).min(1).max(50), via: z.enum(['pi-confirm', 'cli-yes']), confirmedAt: z.iso.datetime() });
export type LogContract = z.infer<typeof logContractSchema>;
const condition = z.enum(['met', 'not_met', 'unclear']);

/**
 * One expectation of a plan judged on one logged conversation. Addressed by content — the criterion (criterion.ts) and
 * what the judge read of it (the rubric, the rules, the sources), the import, the conversation and the judge's protocol —
 * so nothing of a card, an accepted definition or a run is in it. `evidence`: what the votes that decided cite, each
 * quote verbatim in the event it names (the judge's own check); `skipped`: the log could not show it — the agent never
 * replied, or the criterion is seen on the tools or the state and the log did not record that channel completely — and
 * the judge was not asked.
 */
export const findingSchema = z.strictObject({
  key: hash,
  dialogueId: id, scenarioId: id, expectationId: id, variationId: id.optional(),
  criterionHash: hash,
  mode: z.enum([LOGGED_MODE, LOGGED_MODE_V3, FACT_PROTOCOL]), protocolHash: hash, inputHash: hash, auditHash: hash.optional(),
  provider: text(120), model: text(200),
  skipped: z.enum(FINDING_SKIPS).optional(),
  votes: z.array(z.strictObject({ pass: condition.optional(), fail: condition.optional(), result: verdict.optional(), error: z.literal(true).optional() })).max(4),
  result: verdict,
  complete: z.boolean(),
  evidence: z.array(z.strictObject({ seq: z.number().int().nonnegative(), quote: z.string().min(1).max(2000) })).max(12),
  rationale: z.string().max(4000).optional(),
});
export type Finding = z.infer<typeof findingSchema>;

/**
 * The owner's word on one finding: the violation holds (`confirmed`), it does not — with why (`disputed`), or they cannot
 * tell (`unsure`). `judgeVerdict` is the verdict they saw, filled from the finding and never trusted from a caller. Only
 * ever appended: the latest word per key holds, the earlier ones stay as history.
 */
export const findingReviewSchema = z.strictObject({
  id, createdAt: z.iso.datetime(), key: hash,
  verdict: z.enum(['confirmed', 'disputed', 'unsure']), note: z.string().max(3000),
  judgeVerdict: verdict, via: z.enum(['pi-confirm', 'cli-yes']),
});
export type FindingReview = z.infer<typeof findingReviewSchema>;

/** Why a readable conversation of the logs is not judged: nothing the customer wrote, or nothing the agent answered. */
export const UNJUDGEABLE = ['no_customer', 'no_agent_reply'] as const;
/** Why a topic has no plan: no answer bound to the owner's rules, its call died in flight, or the analysis stopped before it. */
export const PLAN_FAILURES = ['unusable', 'interrupted', 'not_reached'] as const;
/**
 * Why Lab's own work on a topic's plan did not finish (`unusable`), typed where it was seen — never a gap in the owner's
 * rules: the model's answers failed the output schema, or failed the harness's check of their content (a quote not verbatim
 * in its source; another slip — a rule of a kind the rulebook does not bind, a variation with nothing to check), the request
 * did not fit the model's window, the articles for the topic could not be chosen, the runtime has no planner, or the model
 * provider did not answer (`provider_failed`: the call is not made again silently — a continuation asks again).
 */
export const PLAN_ISSUES = ['answer_schema', 'quote_not_verbatim', 'answer_check', 'context_window', 'source_selection', 'planner_unavailable', 'provider_failed'] as const;
export type PlanIssue = typeof PLAN_ISSUES[number];

export const analysisSchema = z.strictObject({
  formatVersion: z.literal(1), protocol: z.enum([ANALYSIS_PROTOCOL_V1, ANALYSIS_PROTOCOL_V2, ANALYSIS_PROTOCOL, FACT_ANALYSIS_PROTOCOL]),
  id, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  status: z.enum(ANALYSIS_STATUSES), message: z.string().max(2000),
  unfinished: z.enum(UNFINISHED).optional(),
  error: z.string().max(4000).optional(),
  /** What failed, typed, when the analysis ended on a failure; absent on an analysis made before it was typed. */
  failure: z.enum(FAILURES).optional(),
  mode: z.enum(['demo', 'live']),
  /** Absent on existing analyses: their original rule-based interpretation remains readable. */
  checking: z.literal('facts').optional(),
  factChecks: z.array(factCheckSchema).max(ANALYSIS_TOTAL_LIMIT).optional(),
  task: text(2000),
  /**
   * The import read: its identity, the file's name, every conversation of the log and those the import could read;
   * `contract` — what the owner declared the log records beside the messages (logContractSchema).
   */
  logs: z.strictObject({ importId: id, contentHash: hash, file: text(300), conversations: z.number().int().nonnegative(), readable: z.number().int().nonnegative(),
    contract: logContractSchema.optional() }),
  /**
   * An analysis that continues an earlier one of the same import and materials: the earlier's selection, plans and every
   * finding whose key still holds were carried over — `reused` findings, no call made for them — and the next conversations
   * not selected before were added. The earlier analysis is never changed.
   */
  continues: z.strictObject({ analysisId: id, picked: z.number().int().nonnegative(), reused: z.number().int().nonnegative() }).optional(),
  /**
   * What was analysed and how it was chosen: `topics` — seats by each topic's share of the read conversations, at most
   * `perTopic` from one, the seats rounding leaves first to topics with none (miner/sample.ts allocate); `order` — the
   * first ones, when the runtime maps no topics. The rest of the readable conversations are not analysed.
   */
  selection: z.strictObject({
    requested: z.number().int().positive().max(ANALYSIS_LIMIT), perTopic: z.number().int().positive().max(PER_TOPIC_LIMIT),
    method: z.enum(['topics', 'order', 'sample']),
    picked: z.array(id).max(ANALYSIS_TOTAL_LIMIT),
    unjudgeable: z.array(z.strictObject({ dialogueId: id, reason: z.enum(UNJUDGEABLE) })).max(IMPORT_DIALOGUE_LIMIT),
    /**
     * `perTopic` bounds only the examples a topic's plan reads; the topic's other selected conversations (`topics[].extra`)
     * are judged — `fitted`: under the variation of the plan the planner says each fits, and one no variation fits gets a
     * plan of its own (`topics[].others`); `shared`: on the expectations every variation of the plan shares, fitting or not.
     * Absent — an analysis made before either: `perTopic` bounded the topic's conversations.
     */
    beyond: z.enum(['shared', 'fitted']).optional(),
  }),
  sources: z.array(z.strictObject({ id, name: text(180), content: z.string().min(1), hash, kind: z.enum(['knowledge', 'prompt']).optional() })).min(1).max(MATERIAL_LIMIT),
  models: z.strictObject({ builder: z.strictObject({ provider: z.string().max(120), model: z.string().max(200) }),
    judge: z.strictObject({ provider: z.string().max(120), model: z.string().max(200) }) }),
  /** The calls the owner agreed to at most, and the calls made. */
  budget: z.strictObject({ ceiling: z.number().int().nonnegative(), spent: z.number().int().nonnegative() }),
  /** Where the customers come with, over every conversation of the import: the typical traffic, apart from the violations. */
  traffic: trafficSchema.optional(),
  topics: z.array(z.strictObject({
    title: text(120), topicId: topicIdSchema.optional(),
    /** The topic's conversations its plan reads as examples; each is judged on the expectations of its variation. */
    dialogueIds: z.array(id).min(1).max(PER_TOPIC_LIMIT),
    /**
     * The topic's other selected conversations: no plan read them. Under `fitted` each is judged under the variation the
     * planner says it fits (`assignments`) or none (`unfit`); under `shared`, on the plan's shared expectations.
     */
    extra: z.array(id).max(ANALYSIS_TOTAL_LIMIT).optional(),
    /**
     * Extra conversations the planner said no variation of this plan fits: never judged on it. Of a topic's first group they
     * become the examples of the topic's `others` group; of an `others` group they stay unjudged, and are said so.
     */
    unfit: z.array(id).max(ANALYSIS_TOTAL_LIMIT).optional(),
    /** Why the extra conversations were not fitted to the plan: Lab's own work not finishing, typed; a continuation fits them again. */
    fitIssue: z.enum(PLAN_ISSUES).optional(),
    /** A group of the conversations of a topic its first plan did not fit, with a plan of its own. */
    others: z.literal(true).optional(),
    scenarioId: id.optional(),
    planFailure: z.enum(PLAN_FAILURES).optional(),
    /** Why Lab's own work on the plan did not finish (`unusable`): never the owner's gap. Absent on an analysis made before it was typed. */
    planIssue: z.enum(PLAN_ISSUES).optional(),
    /**
     * The planner found no rule of the materials for the topic's customers (`asks`, in its words). A gap in the owner's
     * rules only when the reviewer confirmed that no sentence of what the planner read says what the agent must do
     * (`confirmed`, card/review.ts gapRequest, as a preparation checks a gap); otherwise Lab's reading, not the owner's gap.
     */
    rulesGap: z.strictObject({ asks: text(300), confirmed: z.boolean(), reason: z.string().max(600).optional(), reviewer: z.string().max(200).optional() }).optional(),
  })).max(ANALYSIS_TOTAL_LIMIT),
  requirements: z.array(requirementSchema).max(Math.max(RECORD_REQUIREMENT_LIMIT, ANALYSIS_TOTAL_LIMIT * PLAN_EXPECTATIONS)),
  scenarios: z.array(businessScenarioSchema).max(ANALYSIS_TOTAL_LIMIT),
  /** The variation of its topic's plan each analysed conversation stands for; none — only the plan's shared expectations apply to it. */
  assignments: z.array(z.strictObject({ dialogueId: id, scenarioId: id, variationId: id.optional() })).max(ANALYSIS_TOTAL_LIMIT),
  findings: z.array(findingSchema).max(ANALYSIS_TOTAL_LIMIT * PLAN_EXPECTATIONS),
  reviews: z.array(findingReviewSchema).max(5000),
});
export type LogAnalysis = z.infer<typeof analysisSchema>;
