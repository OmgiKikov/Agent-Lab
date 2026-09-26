import { z } from 'zod';
import { requirementSchema } from '../contracts.js';
import { businessScenarioSchema } from '../card/schema.js';
import { LOGGED_MODE } from '../card/calibration.js';
import { identifierSchema as id, sha256Schema as hash, text } from '../ids.js';
import { IMPORT_DIALOGUE_LIMIT, MATERIAL_LIMIT, RECORD_REQUIREMENT_LIMIT } from '../limits.js';
import { topicIdSchema, trafficSchema } from '../miner/schema.js';

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
 * Every schema here is stored: a new field is `.optional()`, never `.default()`. Findings are the judge's; a person's
 * verdict never overwrites one, and a new analysis is a new record — the old one keeps its history.
 */

export const ANALYSIS_PROTOCOL = 'discover-v1';
/** Conversations one analysis reads at most, and from one topic: the examples one plan call reads (card/prepare.ts). */
export const ANALYSIS_LIMIT = 128;
export const PER_TOPIC_LIMIT = 8;
/** Conversations analysed when the owner names no number. */
export const DEFAULT_ANALYSED = 24;

export const ANALYSIS_STATUSES = ['running', 'done', 'stopped', 'failed', 'interrupted'] as const;
export type AnalysisStatus = typeof ANALYSIS_STATUSES[number];
/** Why an analysis ended before every conversation was judged. */
export const UNFINISHED = ['budget', 'stopped', 'time', 'closing', 'failed'] as const;

const verdict = z.enum(['pass', 'fail', 'unknown']);
const condition = z.enum(['met', 'not_met', 'unclear']);

/**
 * One expectation of a plan judged on one logged conversation. Addressed by content — the criterion as judged (its
 * words, the rules it cites and the sources they stand in), the import, the conversation and the judge's protocol — so
 * nothing of a card, an accepted definition or a run is in it. `evidence`: what the votes that decided cite, each quote
 * verbatim in the event it names (the judge's own check); `skipped`: the log could not show it and the judge was not asked.
 */
export const findingSchema = z.strictObject({
  key: hash,
  dialogueId: id, scenarioId: id, expectationId: id, variationId: id.optional(),
  criterionHash: hash,
  mode: z.literal(LOGGED_MODE), protocolHash: hash, inputHash: hash, auditHash: hash.optional(),
  provider: text(120), model: text(200),
  skipped: z.enum(['no_agent_reply']).optional(),
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

export const analysisSchema = z.strictObject({
  formatVersion: z.literal(1), protocol: z.literal(ANALYSIS_PROTOCOL),
  id, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  status: z.enum(ANALYSIS_STATUSES), message: z.string().max(2000),
  unfinished: z.enum(UNFINISHED).optional(),
  error: z.string().max(4000).optional(),
  mode: z.enum(['demo', 'live']),
  task: text(2000),
  /** The import read: its identity, the file's name, every conversation of the log and those the import could read. */
  logs: z.strictObject({ importId: id, contentHash: hash, file: text(300), conversations: z.number().int().nonnegative(), readable: z.number().int().nonnegative() }),
  /**
   * What was analysed and how it was chosen: `topics` — spread over the import's topics, at most `perTopic` from one;
   * `order` — the first ones, when the runtime maps no topics. The rest of the readable conversations are not analysed.
   */
  selection: z.strictObject({
    requested: z.number().int().positive().max(ANALYSIS_LIMIT), perTopic: z.number().int().positive().max(PER_TOPIC_LIMIT),
    method: z.enum(['topics', 'order']),
    picked: z.array(id).max(ANALYSIS_LIMIT),
    unjudgeable: z.array(z.strictObject({ dialogueId: id, reason: z.enum(UNJUDGEABLE) })).max(IMPORT_DIALOGUE_LIMIT),
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
    dialogueIds: z.array(id).min(1).max(PER_TOPIC_LIMIT),
    scenarioId: id.optional(),
    planFailure: z.enum(PLAN_FAILURES).optional(),
  })).max(20),
  requirements: z.array(requirementSchema).max(RECORD_REQUIREMENT_LIMIT),
  scenarios: z.array(businessScenarioSchema).max(20),
  /** The variation of its topic's plan each analysed conversation stands for; none — only the plan's shared expectations apply to it. */
  assignments: z.array(z.strictObject({ dialogueId: id, scenarioId: id, variationId: id.optional() })).max(ANALYSIS_LIMIT),
  findings: z.array(findingSchema).max(ANALYSIS_LIMIT * 8),
  reviews: z.array(findingReviewSchema).max(5000),
});
export type LogAnalysis = z.infer<typeof analysisSchema>;
